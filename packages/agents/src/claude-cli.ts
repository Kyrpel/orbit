import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import { redactSecrets } from '@orbit/shared';
import { emitAssistantContent, emitToolResults, permissionDenials, type ToolCallLog } from './claude-stream';
import { buildAgentEnv } from './env';
import { ENGINEER_TOOLS, READ_ONLY_TOOLS } from './policy';
import {
  emptyResult,
  extractJson,
  commandRules,
  imageNote,
  isUsageLimitError,
  type AgentImage,
  type AgentRunContext,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunStatus,
  type AgentRuntime,
  type RuntimeAvailability,
} from './runtime';

/**
 * A user message for Claude Code's stream-json input: plain text, or the images first and
 * then the text (as Claude Code sends a pasted screenshot). Exported for tests.
 */
export function userContent(text: string, images?: AgentImage[]): string | Record<string, unknown>[] {
  if (!images?.length) return text;
  const blocks: Record<string, unknown>[] = [];
  for (const img of images) {
    try {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: readFileSync(img.path).toString('base64') } });
    } catch {
      /* a deleted upload: send the rest */
    }
  }
  return [...blocks, { type: 'text', text }];
}

/** Shell commands Claude Code refuses everywhere (Orbit's own policy checks them too). */
const DENY_ALWAYS = [
  'git push --force*',
  'git push -f*',
  'git push * --force*',
  'git push * -f',
  'git push * -f *',
  'git remote add *',
  'git remote remove *',
  'git remote set-url *',
  'git rebase *',
  'git reset --hard *',
  'git config --global *',
  'gh *',
  'npm publish *',
  'pnpm publish *',
  'yarn publish *',
  'sudo *',
  'ssh *',
  'scp *',
];
/** Autopilot only: there Orbit commits and pushes itself, after your approval. */
const DENY_MISSIONS = ['git push *', 'git push', 'git remote *', 'git commit *'];
const DENY_READS = ['Read(**/.env)', 'Read(**/.env.local)', 'Read(**/*.pem)', 'Read(**/id_rsa*)'];

/** Claude Code deny rules; working sessions may commit and push when the developer asks. */
export function denyRules(allowGit: boolean): string[] {
  const shell = [...DENY_ALWAYS, ...(allowGit ? [] : DENY_MISSIONS)];
  return [...shell.flatMap((c) => [`Bash(${c})`, `PowerShell(${c})`]), ...DENY_READS];
}

/**
 * Runs agents through the developer's locally installed Claude Code CLI in
 * headless print mode (`claude -p --output-format stream-json`). Orbit never
 * reads, stores or forwards the CLI's credentials; the CLI authenticates with
 * whatever the developer configured. `--restricted` confines file tools to the
 * working directories and ignores repository settings files.
 */
export class ClaudeCodeCliRuntime implements AgentRuntime {
  readonly id = 'claude-code-cli' as const;
  readonly displayName = 'Claude Code CLI (your local login)';
  readonly kind = 'ai' as const;
  readonly resumable = true;

  constructor(
    private readonly bin: string = process.env.ORBIT_CLAUDE_BIN || 'claude',
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async checkAvailability(): Promise<RuntimeAvailability> {
    const details: Record<string, string> = {};
    const version = await execa(this.bin, ['--version'], { reject: false, timeout: 20_000, windowsHide: true });
    if (version.exitCode !== 0) {
      return { available: false, reason: 'Claude Code CLI (`claude`) was not found on PATH.', sandbox: 'unknown', details };
    }
    details.version = String(version.stdout).trim();
    const status = await execa(this.bin, ['auth', 'status', '--json'], { reject: false, timeout: 20_000, windowsHide: true });
    if (status.exitCode === 0) {
      try {
        const s = JSON.parse(String(status.stdout)) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
        if (s.authMethod) details.authMethod = s.authMethod;
        if (s.apiProvider) details.apiProvider = s.apiProvider;
        if (s.loggedIn === false) {
          return { available: false, reason: 'Claude Code is installed but not logged in. Run `claude` once to sign in.', sandbox: 'unknown', details };
        }
      } catch {
        /* older CLI without JSON status */
      }
    }
    return { available: true, reason: null, sandbox: process.platform === 'darwin' ? 'available' : 'unknown', details };
  }

  /** `live`: keep the input open (stream-json) so messages can be added while the agent works. */
  buildArgs(req: AgentRunRequest, live = false): string[] {
    const tools: string[] = req.access === 'workspace-write' ? [...ENGINEER_TOOLS] : [...READ_ONLY_TOOLS];
    if (req.execution.allowNetworkTools) tools.push('WebFetch', 'WebSearch');
    // Working sessions never pre-approve the shell tools as a whole. "Ask first" (dontAsk):
    // only commands the developer allowed run, plus those Claude Code knows are read-only;
    // everything else is refused and reported. "Auto": Claude Code's auto mode decides, with
    // its safety classifier. Allowed commands become exact rules, one per command part,
    // passed as settings JSON so commas and quotes inside them stay intact.
    const session = req.access === 'workspace-write' && (req.commands?.mode === 'allowlist' || req.commands?.mode === 'auto') ? req.commands : null;
    const allowed = session ? tools.filter((t) => t !== 'Bash' && t !== 'PowerShell') : tools;
    const rules = session ? commandRules(session.allowed) : [];
    const permissionMode = session?.mode === 'auto' ? 'auto' : 'dontAsk';
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      live ? 'stream-json' : 'text',
      // Missions: --restricted ignores every settings file. Working sessions: the developer's own
      // user settings and skills load (as in their terminal), project and local files still do not.
      ...(req.userEnvironment ? ['--setting-sources', 'user'] : ['--restricted']),
      '--tools',
      tools.join(','),
      '--allowedTools',
      // One argv element per rule: rules may contain spaces and quotes.
      ...allowed,
      '--disallowedTools',
      denyRules(!!req.allowGit && req.access === 'workspace-write').join(','),
      '--permission-mode',
      permissionMode,
      '--max-turns',
      String(req.maxTurns),
      '--append-system-prompt',
      req.systemAppend,
      '--strict-mcp-config',
    ];
    if (!req.session?.persist) args.push('--no-session-persistence');
    if (req.session?.resumeId) args.push('--resume', req.session.resumeId);
    if (req.maxBudgetUsd != null) args.push('--max-budget-usd', String(req.maxBudgetUsd));
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.outputSchema) args.push('--json-schema', JSON.stringify(req.outputSchema));
    if (req.readRoots.length) args.push('--add-dir', ...req.readRoots);
    const settings: Record<string, unknown> = {};
    if (req.execution.mode === 'sandbox') settings.sandbox = { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false };
    if (rules.length) settings.permissions = { allow: rules };
    if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));
    return args;
  }

  async run(req: AgentRunRequest, ctx: AgentRunContext): Promise<AgentRunResult> {
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

    const stderr: string[] = [];
    let text = '';
    let resultMsg: Record<string, unknown> | null = null;
    let closeInput: () => void = () => undefined;
    const calls: ToolCallLog = new Map();
    let model: string | null = req.model;

    try {
      const live = !!ctx.onSteerReady;
      const sub = execa(this.bin, this.buildArgs(req, live), {
        cwd: req.cwd,
        env: buildAgentEnv(this.env),
        extendEnv: false,
        ...(live ? { stdin: 'pipe' as const } : { input: `${req.prompt}${imageNote(req.images)}` }),
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
      // Live input: the prompt is the first message; later ones arrive while the agent works and
      // Claude Code folds them in at its next step, as when you type into its terminal.
      let inputOpen = live && !!sub.stdin;
      const writeMessage = (text: string, images?: AgentImage[]): boolean => {
        if (!inputOpen || !sub.stdin || sub.stdin.destroyed) return false;
        sub.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: userContent(text, images) } })}\n`);
        return true;
      };
      closeInput = () => {
        if (!inputOpen) return;
        inputOpen = false;
        ctx.onSteerReady?.(null);
        sub.stdin?.end();
      };
      if (live) {
        writeMessage(req.prompt, req.images);
        ctx.onSteerReady?.(writeMessage);
      }
      if (sub.stdout) {
        const rl = createInterface({ input: sub.stdout });
        for await (const line of rl) {
          if (!line.trim().startsWith('{')) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = msg.type;
          if (type === 'system' && msg.subtype === 'init') {
            if (typeof msg.model === 'string') model = msg.model;
            ctx.onEvent({ type: 'status', message: `Session started${model ? ` (${model})` : ''}` });
          } else if (type === 'assistant') {
            const last = emitAssistantContent((msg.message as { content?: unknown } | undefined)?.content, ctx.onEvent, calls);
            if (last) text = last;
          } else if (type === 'user') {
            emitToolResults((msg.message as { content?: unknown } | undefined)?.content, ctx.onEvent, { detectDenied: true, calls });
          } else if (type === 'result') {
            resultMsg = msg;
            // The answer is done: stop taking messages so the process can exit.
            closeInput();
          }
        }
      }
      await sub;
    } catch (err) {
      return emptyResult({
        status: timedOut ? 'timeout' : ctx.signal.aborted ? 'cancelled' : 'failed',
        durationMs: Date.now() - started,
        text: redactSecrets(text),
        error: redactSecrets(`${(err as Error).message}\n${stderr.join('').slice(-1500)}`),
      });
    } finally {
      closeInput();
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }

    if (!resultMsg) {
      return emptyResult({
        status: timedOut ? 'timeout' : ctx.signal.aborted ? 'cancelled' : isUsageLimitError(stderr.join('')) ? 'rate_limited' : 'failed',
        durationMs: Date.now() - started,
        text: redactSecrets(text),
        error: redactSecrets(stderr.join('').slice(-2000) || 'Claude Code exited without a result.'),
      });
    }

    const r = resultMsg as {
      subtype?: string;
      is_error?: boolean;
      result?: string;
      structured_output?: unknown;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      num_turns?: number;
      session_id?: string;
      errors?: string[];
      terminal_reason?: string;
      permission_denials?: unknown;
    };
    if (typeof r.result === 'string' && r.result) text = r.result;
    const subtype = String(r.subtype ?? '');
    const status: AgentRunStatus =
      subtype === 'success' && !r.is_error
        ? 'succeeded'
        : subtype === 'error_max_turns'
          ? 'max_turns'
          : subtype === 'error_max_budget_usd'
            ? 'budget_exceeded'
            : /refusal/.test(subtype)
              ? 'refused'
              : isUsageLimitError([...(r.errors ?? []), r.result ?? ''].join(' '))
                ? 'rate_limited'
                : 'failed';
    return {
      status,
      text: redactSecrets(text),
      structured: r.structured_output ?? (req.outputSchema ? extractJson(text) : null),
      costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
      usage: r.usage
        ? {
            inputTokens: r.usage.input_tokens ?? 0,
            outputTokens: r.usage.output_tokens ?? 0,
            cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0,
          }
        : null,
      numTurns: r.num_turns ?? null,
      durationMs: Date.now() - started,
      sessionId: r.session_id ?? null,
      model,
      error: status === 'succeeded' ? null : redactSecrets([...(r.errors ?? []), r.terminal_reason ?? '', subtype].filter(Boolean).join('; ')),
      deniedTools: permissionDenials(r.permission_denials),
    };
  }
}
