import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import { redactSecrets, type AgentPlanItem } from '@orbit/shared';
import { runCodexAppServer } from './codex-app-server';
import { buildAgentEnv } from './env';
import { outputPreview } from './output';
import {
  emptyResult,
  extractJson,
  imageNote,
  isUsageLimitError,
  type AgentEvent,
  type AgentRunContext,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunStatus,
  type AgentRuntime,
  type RuntimeAvailability,
} from './runtime';

/** Environment Codex itself needs, on top of the shared agent allowlist. Never includes API keys. */
const CODEX_ENV = ['CODEX_HOME'];

/** Strips the shell wrapper Codex puts around commands, so the step shows what actually runs. */
/** The shell Codex ran a command in, named the way Claude Code names its shell tools. */
export function shellName(command: string): string {
  return /powershell|pwsh/i.test(command) ? 'PowerShell' : 'Bash';
}

export function unwrapShellCommand(command: string): string {
  const ps = /-Command\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  if (ps?.[2]) return ps[2].replace(/''/g, "'").trim();
  const sh = /^(?:\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  if (sh?.[2]) return sh[2].trim();
  return command.trim();
}

function shortPath(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return p.split(/[\\/]+/).slice(-2).join('/');
}

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path: string; kind: string }[];
  query?: string;
  server?: string;
  tool?: string;
  items?: { text: string; completed: boolean }[];
  message?: string;
};

/**
 * Translates one Codex `--json` event into Orbit agent events. Codex reports
 * both the start and the end of each step, so failures carry the real exit code.
 */
export function translateCodexEvent(event: { type?: string; item?: CodexItem }, cwd: string, onEvent: (e: AgentEvent) => void): void {
  const item = event.item;
  if (!item?.type) return;
  const id = item.id;
  if (event.type === 'item.started') {
    if (item.type === 'command_execution' && item.command) {
      const cmd = redactSecrets(unwrapShellCommand(item.command));
      onEvent({ type: 'tool', tool: shellName(item.command), id, summary: `Run ${cmd.slice(0, 140)}`, step: 'run', target: cmd.slice(0, 300) });
    } else if (item.type === 'file_change' && item.changes?.length) {
      for (const c of item.changes) {
        const file = shortPath(c.path, cwd);
        const verb = c.kind === 'add' ? 'Write' : c.kind === 'delete' ? 'Delete' : 'Edit';
        onEvent({ type: 'tool', tool: verb === 'Write' ? 'Write' : 'Edit', id, summary: `${verb} ${path.basename(c.path)}`, step: 'edit', target: file });
      }
    } else if (item.type === 'web_search') {
      onEvent({ type: 'tool', tool: 'WebSearch', id, summary: `Search the web for ${JSON.stringify(item.query ?? '').slice(0, 80)}`, step: 'web', target: item.query ?? null });
    } else if (item.type === 'mcp_tool_call') {
      onEvent({ type: 'tool', tool: item.tool ?? 'tool', id, summary: `${item.server ?? 'mcp'}: ${item.tool ?? 'tool'}`, step: 'other', target: null });
    }
    return;
  }
  if (event.type === 'item.updated' || event.type === 'item.completed') {
    if (item.type === 'todo_list' && item.items) {
      const plan: AgentPlanItem[] = item.items.slice(0, 40).map((t, i, all) => ({
        text: redactSecrets(String(t.text).slice(0, 200)),
        // Codex marks items done or not; the first open item is the one in progress.
        status: t.completed ? 'completed' : all.findIndex((x) => !x.completed) === i ? 'in_progress' : 'pending',
      }));
      const done = plan.filter((p) => p.status === 'completed').length;
      onEvent({ type: 'tool', tool: 'TodoWrite', id, summary: `Update plan (${done}/${plan.length} done)`, step: 'plan', target: null, plan });
      return;
    }
  }
  if (event.type !== 'item.completed') return;
  if (item.type === 'agent_message' && item.text) {
    onEvent({ type: 'text', text: redactSecrets(item.text) });
  } else if (item.type === 'command_execution' && (item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0))) {
    const out = redactSecrets(String(item.aggregated_output ?? '').slice(-1500));
    onEvent({ type: 'tool_result', isError: true, id, summary: `Exit code ${item.exit_code ?? '?'}${out ? `\n${out}` : ''}` });
  } else if (item.type === 'command_execution') {
    onEvent({ type: 'tool_result', isError: false, id, summary: '', output: outputPreview(String(item.aggregated_output ?? '')) });
  } else if (item.type === 'file_change' && item.status === 'failed') {
    onEvent({ type: 'tool_result', isError: true, id, summary: 'The file change was not applied.' });
  } else if (item.type === 'error' && item.message) {
    onEvent({ type: 'status', message: redactSecrets(item.message) });
  }
}

/**
 * Runs agents through the developer's locally installed OpenAI Codex CLI
 * (`codex exec --json`). Like the Claude Code runtime, Orbit never touches the
 * CLI's credentials: Codex uses whatever `codex login` set up.
 *
 * Codex always runs inside its own sandbox here: read-only for planning,
 * reviewing and answering; workspace-write (no network, .git read-only) for the
 * engineer. The user's Codex config is ignored so their personal MCP servers,
 * plugins and approval settings never leak into Orbit's agents.
 */
export class CodexCliRuntime implements AgentRuntime {
  readonly id = 'codex-cli' as const;
  readonly displayName = 'Codex CLI (your ChatGPT login)';
  readonly kind = 'ai' as const;
  readonly resumable = true;

  constructor(
    private readonly bin: string = process.env.ORBIT_CODEX_BIN || 'codex',
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async checkAvailability(): Promise<RuntimeAvailability> {
    const details: Record<string, string> = {};
    const version = await execa(this.bin, ['--version'], { reject: false, timeout: 20_000, windowsHide: true });
    if (version.exitCode !== 0) {
      return { available: false, reason: 'Codex CLI (`codex`) was not found. Install it with `npm install -g @openai/codex`.', sandbox: 'unknown', details };
    }
    details.version = String(version.stdout).trim();
    const status = await execa(this.bin, ['login', 'status'], { reject: false, timeout: 20_000, windowsHide: true });
    const out = `${String(status.stdout)}\n${String(status.stderr)}`.trim();
    if (status.exitCode !== 0 || /not logged in/i.test(out)) {
      return { available: false, reason: 'Codex is installed but not logged in. Run `codex login` once.', sandbox: 'available', details };
    }
    const how = /logged in using (.+)/i.exec(out)?.[1]?.trim();
    if (how) details.authMethod = how;
    return { available: true, reason: null, sandbox: 'available', details };
  }

  /** Models from Codex's own cache (what your account can use). Empty if unknown. */
  listModels(): { id: string; label: string }[] {
    const home = this.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    try {
      const raw = JSON.parse(readFileSync(path.join(home, 'models_cache.json'), 'utf8')) as { models?: { slug?: string; display_name?: string; visibility?: string }[] };
      return (raw.models ?? []).filter((m) => m.slug && m.visibility !== 'hide').map((m) => ({ id: m.slug as string, label: m.display_name || (m.slug as string) }));
    } catch {
      return [];
    }
  }

  buildArgs(req: AgentRunRequest, schemaFile: string | null): string[] {
    const sandbox = req.access === 'workspace-write' ? 'workspace-write' : 'read-only';
    const resumeId = req.session?.resumeId;
    // `exec resume` has no -C/-s flags: the working folder is the process cwd, the sandbox a config value.
    const args = resumeId
      ? ['exec', 'resume', resumeId, '--json', '--ignore-user-config', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`]
      : ['exec', '--json', ...(req.session?.persist ? [] : ['--ephemeral']), '--ignore-user-config', '--skip-git-repo-check', '-C', req.cwd, '-s', sandbox];
    // Without the user's config, Codex on Windows refuses every command unless the sandbox mode is set.
    // "unelevated" still blocks network, .git writes and writes outside the project, and unlike
    // "elevated" it lets tools installed in the user folder run (Python, Node, npm under C:/Users).
    if (this.platform === 'win32') args.push('-c', 'windows.sandbox="unelevated"');
    if (req.access === 'workspace-write' && req.execution.allowNetworkTools) args.push('-c', 'sandbox_workspace_write.network_access=true');
    if (req.model) args.push('-m', req.model);
    if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort}"`);
    if (schemaFile && !resumeId) args.push('--output-schema', schemaFile);
    if (!resumeId) for (const img of req.images ?? []) args.push('-i', img.path);
    args.push('-');
    return args;
  }

  /** Codex has no separate system prompt flag, so role instructions lead the prompt. */
  buildPrompt(req: AgentRunRequest): string {
    // A resumed session already has its instructions; send only the new message.
    // Resumed runs cannot take -i, so they get the image paths in the message instead.
    if (req.session?.resumeId) return `${req.prompt}${imageNote(req.images)}`;
    const extra = req.readRoots.length ? `\n\nYou may also read (never modify) these directories:\n${req.readRoots.map((r) => `- ${r}`).join('\n')}` : '';
    return `<orbit_role_instructions>\n${req.systemAppend}${extra}\n</orbit_role_instructions>\n\n${req.prompt}`;
  }

  async run(req: AgentRunRequest, ctx: AgentRunContext): Promise<AgentRunResult> {
    // Working sessions talk to Codex through its app-server, so messages can steer it mid-answer.
    if (ctx.onSteerReady && !req.outputSchema) {
      const env = buildAgentEnv(this.env, {}, false);
      for (const k of CODEX_ENV) if (this.env[k]) env[k] = this.env[k] as string;
      return runCodexAppServer({ bin: this.bin, env, platform: this.platform }, req, ctx);
    }
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    const onAbort = () => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });

    let tmp: string | null = null;
    let schemaFile: string | null = null;
    if (req.outputSchema) {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-'));
      schemaFile = path.join(tmp, 'schema.json');
      writeFileSync(schemaFile, JSON.stringify(req.outputSchema), 'utf8');
    }

    const stderr: string[] = [];
    let text = '';
    let threadId: string | null = null;
    let usage: AgentRunResult['usage'] = null;
    let turnError: string | null = null;
    let completed = false;
    let turns = 0;

    // No Claude credentials: Codex authenticates with its own login.
    const env = buildAgentEnv(this.env, {}, false);
    for (const k of CODEX_ENV) if (this.env[k]) env[k] = this.env[k];

    try {
      ctx.onEvent({ type: 'status', message: `Session started${req.model ? ` (${req.model})` : ' (Codex default model)'}` });
      const sub = execa(this.bin, this.buildArgs(req, schemaFile), {
        cwd: req.cwd,
        env,
        extendEnv: false,
        input: this.buildPrompt(req),
        reject: false,
        windowsHide: true,
        cancelSignal: controller.signal,
        forceKillAfterDelay: 5000,
        buffer: false,
        stderr: 'pipe',
        stdout: 'pipe',
      });
      sub.stderr?.on('data', (d: Buffer) => {
        stderr.push(d.toString());
        if (stderr.length > 60) stderr.shift();
      });
      if (sub.stdout) {
        const rl = createInterface({ input: sub.stdout });
        for await (const line of rl) {
          if (!line.trim().startsWith('{')) continue;
          let ev: { type?: string; thread_id?: string; item?: CodexItem; usage?: Record<string, number>; error?: { message?: string }; message?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id;
          else if (ev.type === 'turn.started') turns++;
          else if (ev.type === 'turn.completed') {
            completed = true;
            const u = ev.usage ?? {};
            usage = { inputTokens: u.input_tokens ?? 0, outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cacheReadTokens: u.cached_input_tokens ?? 0, cacheWriteTokens: u.cache_write_input_tokens ?? 0 };
          } else if (ev.type === 'turn.failed') turnError = ev.error?.message ?? 'Codex reported a failed turn.';
          else if (ev.type === 'error') turnError = ev.message ?? ev.error?.message ?? 'Codex reported an error.';
          else {
            if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) text = ev.item.text;
            translateCodexEvent(ev, req.cwd, ctx.onEvent);
          }
        }
      }
      await sub;
    } catch (err) {
      const msg = `${(err as Error).message}\n${stderr.join('').slice(-1500)}`;
      return emptyResult({
        status: timedOut ? 'timeout' : ctx.signal.aborted ? 'cancelled' : isUsageLimitError(msg) ? 'rate_limited' : 'failed',
        durationMs: Date.now() - started,
        text: redactSecrets(text),
        sessionId: threadId,
        error: redactSecrets(msg),
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }

    const errText = turnError ?? (completed ? null : stderr.join('').slice(-2000) || 'Codex exited without finishing its turn.');
    const status: AgentRunStatus = timedOut
      ? 'timeout'
      : ctx.signal.aborted
        ? 'cancelled'
        : completed && !turnError
          ? 'succeeded'
          : isUsageLimitError(errText)
            ? 'rate_limited'
            : 'failed';
    return {
      status,
      text: redactSecrets(text),
      structured: req.outputSchema ? extractJson(text) : null,
      // Codex reports tokens, not money. Runs through a ChatGPT plan are not billed per token.
      costUsd: null,
      usage,
      numTurns: turns || null,
      durationMs: Date.now() - started,
      sessionId: threadId,
      model: req.model,
      error: status === 'succeeded' ? null : redactSecrets(errText ?? 'Codex failed.'),
      deniedTools: [],
    };
  }
}
