import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import { redactSecrets } from '@orbit/shared';
import { buildAgentEnv } from './env';
import { outputPreview, unifiedDiff } from './output';
import { emptyResult, extractJson, imageNote, isUsageLimitError, type AgentEvent, type AgentRunContext, type AgentRunRequest, type AgentRunResult, type AgentRuntime, type RuntimeAvailability } from './runtime';

/*
  Cursor through its own terminal agent (`cursor-agent`), on your Cursor subscription and login.

  Checked with Cursor Agent 2026.11.11: `-p --output-format stream-json` prints one JSON event per
  line (init, thinking, assistant messages, tool calls with their results, a final result with
  token usage); the prompt can come on stdin; `--resume <id>` keeps the chat's memory; `--mode ask`
  is read-only; `--auto-review` lets Cursor's own safety check run safe commands. Without it,
  shell commands only run when the settings' allow list has them (`Shell(<exact command>)`); file
  edits always run. Settings come from CURSOR_CONFIG_DIR, and the login does not live there, so
  each Orbit session gets its own folder with its own allow and deny lists and its chats.
*/

/** Orbit's hard limits, in Cursor's rule format: denied in every mode, whatever the allow list says. */
export const CURSOR_DENY = [
  'Shell(git push --force)',
  'Shell(git push -f)',
  'Shell(git push --force-with-lease)',
  'Shell(git reset --hard)',
  'Shell(git rebase)',
  'Shell(git filter-branch)',
  'Shell(git filter-repo)',
  'Shell(git remote)',
  'Shell(git config --global)',
  'Shell(git config --system)',
  'Shell(gh)',
  'Shell(sudo)',
  'Shell(ssh)',
  'Shell(scp)',
  'Shell(sftp)',
  'Shell(npm publish)',
  'Shell(pnpm publish)',
  'Shell(yarn publish)',
  'Shell(printenv)',
  'Read(**/.env)',
  'Read(**/.env.local)',
  'Read(**/*.pem)',
  'Read(**/id_rsa*)',
];

/** A session model is `cursor:<id>`; Cursor itself wants just the id. */
export const cursorModelId = (model: string | null | undefined) => (model ? model.replace(/^cursor:/, '') : 'auto') || 'auto';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class CursorCliRuntime implements AgentRuntime {
  readonly id = 'cursor-cli' as const;
  readonly displayName = 'Cursor CLI (your Cursor subscription)';
  readonly kind = 'ai' as const;
  readonly resumable = true;
  private modelCache: { at: number; list: { id: string; label: string }[] } | null = null;

  constructor(
    private readonly bin: string | null = null,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** `cursor-agent`, or on Windows its launcher in your user folder (Orbit may have started before you installed it). */
  binary(): string {
    if (this.bin) return this.bin;
    const local = this.env.LOCALAPPDATA ? path.join(this.env.LOCALAPPDATA, 'cursor-agent', 'cursor-agent.cmd') : null;
    if (process.platform === 'win32' && local && existsSync(local)) return local;
    const home = path.join(this.env.HOME || this.env.USERPROFILE || os.homedir(), '.local', 'bin', 'cursor-agent');
    if (process.platform !== 'win32' && existsSync(home)) return home;
    return 'cursor-agent';
  }

  async checkAvailability(): Promise<RuntimeAvailability> {
    const details: Record<string, string> = {};
    const version = await execa(this.binary(), ['--version'], { reject: false, timeout: 30_000, windowsHide: true, env: buildAgentEnv(this.env, {}, false), extendEnv: false });
    if (version.exitCode !== 0) {
      return { available: false, reason: 'The Cursor CLI (cursor-agent) is not installed. Install it from cursor.com/cli, then sign in with `cursor-agent login`.', sandbox: 'unknown', details };
    }
    details.version = String(version.stdout).trim().split('\n')[0] ?? '';
    const status = await execa(this.binary(), ['status'], { reject: false, timeout: 30_000, windowsHide: true, env: buildAgentEnv(this.env, {}, false), extendEnv: false });
    const out = `${status.stdout}\n${status.stderr}`;
    if (/not logged in/i.test(out) || !/logged in/i.test(out)) {
      return { available: false, reason: 'The Cursor CLI is installed but not signed in. Run `cursor-agent login` (you can type `! cursor-agent login` in any session).', sandbox: 'unknown', details };
    }
    details.authMethod = 'Cursor login';
    return { available: true, reason: null, sandbox: 'unknown', details };
  }

  /** The models your Cursor account offers (`cursor-agent models`), cached for ten minutes. */
  async listModels(): Promise<{ id: string; label: string }[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.list;
    const res = await execa(this.binary(), ['models'], { reject: false, timeout: 60_000, windowsHide: true, env: buildAgentEnv(this.env, {}, false), extendEnv: false });
    const list = parseCursorModels(String(res.stdout));
    if (list.length) this.modelCache = { at: Date.now(), list };
    return list;
  }

  /** The command line. Long text (instructions, the message) goes on stdin, never here. */
  buildArgs(req: AgentRunRequest): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--trust', '--disable-project-configs', '--model', cursorModelId(req.model)];
    if (req.access === 'read-only') args.push('--mode', 'ask');
    else if (req.commands?.mode === 'auto') args.push('--auto-review');
    else if (!req.commands || req.commands.mode === 'any') args.push('--force');
    if (req.session?.resumeId) args.push('--resume', req.session.resumeId);
    for (const dir of req.readRoots) args.push('--add-dir', dir);
    return args;
  }

  /** What Cursor reads: Orbit's instructions on a new chat (a resumed one already has them), then the message. */
  buildPrompt(req: AgentRunRequest): string {
    const schema = req.outputSchema ? `\n\nAnswer with only one JSON object that matches this JSON Schema, and no other text:\n${JSON.stringify(req.outputSchema)}` : '';
    const message = `${req.prompt}${imageNote(req.images)}${schema}`;
    if (req.session?.resumeId || !req.systemAppend.trim()) return message;
    return `<orbit_instructions>\n${req.systemAppend}\n</orbit_instructions>\n\n${message}`;
  }

  /**
   * The session's own Cursor settings: your Cursor settings, with the allow list of commands you
   * allowed in this session (and your own allow list), Orbit's hard deny list, and the web only
   * when agents may use it.
   */
  writeSettings(dir: string, req: AgentRunRequest): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const userDir = this.env.CURSOR_CONFIG_DIR?.trim() || path.join(this.env.USERPROFILE || this.env.HOME || os.homedir(), '.cursor');
    let base: Obj = { version: 1 };
    try {
      base = obj(JSON.parse(readFileSync(path.join(userDir, 'cli-config.json'), 'utf8')));
    } catch {
      /* no Cursor settings yet: Cursor's defaults */
    }
    const own = obj(base.permissions);
    const ownAllow = Array.isArray(own.allow) ? own.allow.filter((x): x is string => typeof x === 'string') : [];
    const ownDeny = Array.isArray(own.deny) ? own.deny.filter((x): x is string => typeof x === 'string') : [];
    const allowed = req.commands && req.commands.mode !== 'any' ? req.commands.allowed.map((c) => `Shell(${c})`) : [];
    const web = req.execution.allowNetworkTools ? ['WebFetch(*)'] : [];
    const permissions = {
      allow: [...new Set([...ownAllow, ...allowed, ...web])],
      deny: [...new Set([...ownDeny, ...CURSOR_DENY, ...(!req.execution.allowNetworkTools ? ['WebFetch(*)'] : [])])],
    };
    writeFileSync(path.join(dir, 'cli-config.json'), JSON.stringify({ ...base, permissions, approvalMode: 'allowlist' }, null, 1), { mode: 0o600 });
  }

  async run(req: AgentRunRequest, ctx: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now();
    if (req.execution.mode === 'sandbox') {
      return emptyResult({ status: 'failed', durationMs: Date.now() - started, error: 'Cursor does not provide Orbit with verified OS-level isolation. Use a sandbox-capable runtime for sandboxed runs.' });
    }
    let temporaryState: string | null = null;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    const onAbort = () => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });

    const stderr: string[] = [];
    const denied: AgentRunResult['deniedTools'] = [];
    let sessionId: string | null = null;
    let model: string | null = req.model;
    let result: Obj | null = null;
    let replyParts: string[] = [];
    let steps = 0;

    try {
      const stateDir = req.stateDir || (temporaryState = mkdtempSync(path.join(os.tmpdir(), 'orbit-cursor-state-')));
      this.writeSettings(stateDir, req);
      const sub = execa(this.binary(), this.buildArgs(req), {
        cwd: req.cwd,
        // Your Cursor login only: no other AI's key reaches Cursor or the commands it runs.
        env: buildAgentEnv(this.env, { CURSOR_CONFIG_DIR: stateDir }, false),
        extendEnv: false,
        input: this.buildPrompt(req),
        reject: false,
        windowsHide: true,
        cancelSignal: controller.signal,
        forceKillAfterDelay: 5000,
        buffer: false,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      sub.stderr?.on('data', (d: Buffer) => {
        stderr.push(d.toString());
        if (stderr.length > 60) stderr.shift();
      });
      if (sub.stdout) {
        for await (const line of createInterface({ input: sub.stdout })) {
          if (!line.trim().startsWith('{')) continue;
          let e: Obj;
          try {
            e = JSON.parse(line) as Obj;
          } catch {
            continue;
          }
          if (e.type === 'system' && e.subtype === 'init') {
            sessionId = str(e.session_id) ?? sessionId;
            model = str(e.model) ?? model;
            ctx.onEvent({ type: 'status', message: `Session started (${model ?? 'Cursor'})` });
          } else if (e.type === 'assistant') {
            const text = textOf(e.message);
            if (text.trim()) {
              replyParts.push(text.trim());
              ctx.onEvent({ type: 'text', text: redactSecrets(text) });
            }
          } else if (e.type === 'tool_call') {
            // What the agent says after its last step is the answer; what came before was narration.
            replyParts = [];
            const event = translateCursorToolCall(e, denied);
            if (event) {
              if (event.type === 'tool') steps++;
              ctx.onEvent(event);
            }
          } else if (e.type === 'result') {
            result = e;
            sessionId = str(e.session_id) ?? sessionId;
          }
        }
      }
      await sub;
    } catch (err) {
      return emptyResult({ status: timedOut ? 'timeout' : ctx.signal.aborted ? 'cancelled' : 'failed', durationMs: Date.now() - started, sessionId, error: redactSecrets(`${(err as Error).message}\n${stderr.join('').slice(-1500)}`), deniedTools: denied });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (temporaryState) rmSync(temporaryState, { recursive: true, force: true });
    }

    const durationMs = Date.now() - started;
    const errText = stderr.join('');
    if (!result) {
      return emptyResult({
        status: timedOut ? 'timeout' : ctx.signal.aborted ? 'cancelled' : isUsageLimitError(errText) ? 'rate_limited' : 'failed',
        durationMs,
        sessionId,
        model,
        numTurns: steps || null,
        error: redactSecrets(errText.slice(-2000) || 'Cursor exited without an answer.'),
        deniedTools: denied,
      });
    }
    const r = result as { is_error?: boolean; result?: unknown; usage?: Obj };
    const text = redactSecrets(replyParts.join('\n\n') || str(r.result) || '');
    const u = obj(r.usage);
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    const usage = r.usage ? { inputTokens: n('inputTokens'), outputTokens: n('outputTokens'), cacheReadTokens: n('cacheReadTokens'), cacheWriteTokens: n('cacheWriteTokens') } : null;
    const failed = r.is_error === true;
    return emptyResult({
      status: failed ? (isUsageLimitError(text) ? 'rate_limited' : 'failed') : 'succeeded',
      durationMs,
      text,
      structured: req.outputSchema ? extractJson(text) : null,
      usage,
      sessionId,
      model,
      // At least one: a run that answered counts as a turn (a failed resume has none).
      numTurns: steps + 1,
      error: failed ? text || 'Cursor reported an error.' : null,
      context: usage ? { tokens: n('inputTokens') + n('cacheReadTokens') + n('cacheWriteTokens') + n('outputTokens'), window: null } : null,
      deniedTools: denied,
    });
  }
}

/** `id - Label` lines from `cursor-agent models`. */
export function parseCursorModels(out: string): { id: string; label: string }[] {
  const list: { id: string; label: string }[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][\w.\-[\]=,]*)\s+-\s+(.+?)\s*$/.exec(raw.replace(/[​-‍﻿]/g, ''));
    if (m) list.push({ id: m[1]!, label: m[2]!.replace(/\s+/g, ' ').trim() });
  }
  return list;
}

function textOf(message: unknown): string {
  const content = obj(message).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (obj(b).type === 'text' ? (str(obj(b).text) ?? '') : ''))
    .join('');
}

/** One Cursor tool event as Orbit's step (started) or its result (completed); refused commands are recorded. */
export function translateCursorToolCall(e: Obj, denied: AgentRunResult['deniedTools']): AgentEvent | null {
  const call = obj(e.tool_call);
  const key = Object.keys(call).find((k) => k.endsWith('ToolCall'));
  if (!key) return null;
  const tc = obj(call[key]);
  const args = obj(tc.args);
  const id = str(e.call_id) ?? undefined;
  const kind = key.replace(/ToolCall$/, '');
  const file = str(args.path) ?? str(args.filePath) ?? str(args.targetFile);
  const command = str(args.command);
  if (e.subtype === 'started') {
    if (kind === 'shell' && command) return { type: 'tool', tool: 'Bash', id, summary: `Run ${command.slice(0, 140)}`, step: 'run', target: command.slice(0, 300) };
    if ((kind === 'edit' || kind === 'write') && file) return { type: 'tool', tool: kind === 'write' ? 'Write' : 'Edit', id, summary: `${kind === 'write' ? 'Write' : 'Edit'} ${path.basename(file)}`, step: 'edit', target: file };
    if (kind === 'read' && file) return { type: 'tool', tool: 'Read', id, summary: `Read ${path.basename(file)}`, step: 'read', target: file };
    if (kind === 'delete' && file) return { type: 'tool', tool: 'Delete', id, summary: `Delete ${path.basename(file)}`, step: 'edit', target: file };
    const step = /grep|glob|ls|search|find/i.test(kind) ? 'search' : /web|fetch/i.test(kind) ? 'web' : 'other';
    const what = str(args.pattern) ?? str(args.query) ?? str(args.globPattern) ?? file ?? str(args.url) ?? '';
    return { type: 'tool', tool: kind.charAt(0).toUpperCase() + kind.slice(1), id, summary: `${kind}${what ? ` ${what.slice(0, 120)}` : ''}`, step, target: what || null };
  }
  if (e.subtype !== 'completed') return null;
  const res = obj(tc.result);
  if (res.rejected) {
    const rej = obj(res.rejected);
    const cmd = str(rej.command) ?? command ?? '';
    if (kind === 'shell' && cmd) denied.push({ tool: 'Bash', reason: 'Cursor needs your OK to run this command.', command: cmd });
    return { type: 'denied', tool: kind === 'shell' ? 'Bash' : kind, reason: str(rej.reason) || 'Needs your OK', ...(cmd ? { command: cmd } : {}) };
  }
  const ok = obj(res.success);
  if (res.success) {
    if (kind === 'shell') {
      const out = str(ok.interleavedOutput) ?? `${str(ok.stdout) ?? ''}${str(ok.stderr) ?? ''}`;
      const code = typeof ok.exitCode === 'number' ? ok.exitCode : 0;
      return { type: 'tool_result', id, isError: code !== 0, summary: code !== 0 ? `Exit code ${code}` : 'Done', output: outputPreview(out) };
    }
    if ((kind === 'edit' || kind === 'write') && str(ok.diffString)) return { type: 'tool_result', id, isError: false, summary: 'Done', output: unifiedDiff(str(ok.diffString)!) };
    if (kind === 'read') {
      const lines = typeof ok.totalLines === 'number' ? ok.totalLines : null;
      return { type: 'tool_result', id, isError: false, summary: 'Done', output: { text: lines != null ? `Read ${lines} lines` : 'Read' } };
    }
    return { type: 'tool_result', id, isError: false, summary: 'Done' };
  }
  const err = str(obj(res.error).message) ?? str(res.error) ?? 'Failed';
  return { type: 'tool_result', id, isError: true, summary: redactSecrets(err).slice(0, 300) };
}
