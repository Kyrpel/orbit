import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { redactSecrets, ORBIT_VERSION } from '@orbit/shared';
import { buildAgentEnv, hasSupportedClaudeCredentials } from './env';
import { ENGINEER_TOOLS, evaluateToolUse, READ_ONLY_TOOLS, type ToolPolicy } from './policy';
import {
  emptyResult,
  extractJson,
  commandParts,
  imageNote,
  isAllowableCommand,
  isUsageLimitError,
  type AgentRunContext,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunStatus,
  type AgentRuntime,
  type RuntimeAvailability,
} from './runtime';
import { emitAssistantContent, emitToolResults, type ToolCallLog } from './claude-stream';

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

/** The SDK does not export its package.json, so find it next to the resolved entry point. */
function sdkVersion(): string | null {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
    for (let i = 0; i < 5; i++) {
      const file = path.join(dir, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === '@anthropic-ai/claude-agent-sdk') return pkg.version ?? null;
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* version is informational only */
  }
  return null;
}

/**
 * Runs agents with the official Claude Agent SDK.
 *
 * Authentication: an Anthropic API key or a supported cloud provider (Bedrock,
 * Vertex, Foundry). Orbit never collects or proxies claude.ai subscription
 * credentials; if none of the supported credentials are present, this runtime
 * reports itself unavailable.
 */
export class ClaudeAgentSdkRuntime implements AgentRuntime {
  readonly id = 'claude-agent-sdk' as const;
  readonly displayName = 'Claude Agent SDK';
  readonly kind = 'ai' as const;
  readonly resumable = true;
  private sdk: SdkModule | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private async load(): Promise<SdkModule> {
    if (!this.sdk) this.sdk = await import('@anthropic-ai/claude-agent-sdk');
    return this.sdk;
  }

  async checkAvailability(): Promise<RuntimeAvailability> {
    const details: Record<string, string> = {};
    try {
      await this.load();
      const version = sdkVersion();
      if (version) details.sdkVersion = version;
    } catch (err) {
      return { available: false, reason: `The Claude Agent SDK could not be loaded: ${(err as Error).message}`, sandbox: 'unknown', details };
    }
    const creds = hasSupportedClaudeCredentials(this.env);
    if (creds.via) details.auth = creds.via;
    const sandbox = process.platform === 'darwin' ? 'available' : 'unknown';
    if (!creds.ok) {
      return {
        available: false,
        reason: 'Set ANTHROPIC_API_KEY (or configure Bedrock, Vertex AI or Microsoft Foundry) before starting Orbit.',
        sandbox,
        details,
      };
    }
    return { available: true, reason: null, sandbox, details };
  }

  async run(req: AgentRunRequest, ctx: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now();
    const creds = hasSupportedClaudeCredentials(this.env);
    if (!creds.ok) {
      return emptyResult({ status: 'failed', durationMs: 0, error: 'No supported Claude credentials (ANTHROPIC_API_KEY, Bedrock, Vertex or Foundry).' });
    }
    const { query } = await this.load();
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, req.timeoutMs);
    const onAbort = () => abort.abort();
    if (ctx.signal.aborted) abort.abort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });

    const policy: ToolPolicy = {
      cwd: req.cwd,
      readRoots: req.readRoots,
      access: req.access,
      allowNetworkTools: req.execution.allowNetworkTools,
      // "Ask first": only allowed command parts run. "Auto": the SDK's auto mode classifier decides.
      allowedCommands: req.commands?.mode === 'allowlist' ? [...new Set(req.commands.allowed.filter(isAllowableCommand).flatMap(commandParts))] : null,
      allowGit: !!req.allowGit && req.access === 'workspace-write',
    };
    const calls: ToolCallLog = new Map();
    const tools: string[] = req.access === 'workspace-write' ? [...ENGINEER_TOOLS] : [...READ_ONLY_TOOLS];
    if (req.execution.allowNetworkTools) tools.push('WebFetch', 'WebSearch');
    const denied: { tool: string; reason: string; command?: string }[] = [];
    const stderrTail: string[] = [];

    let text = '';
    let structured: unknown = null;
    let result: AgentRunResult | null = null;

    try {
      const stream = query({
        prompt: `${req.prompt}${imageNote(req.images)}`,
        options: {
          abortController: abort,
          cwd: req.cwd,
          // Attached images are opened with the Read tool, so their folder is readable too.
          additionalDirectories: [...req.readRoots, ...new Set((req.images ?? []).map((i) => path.dirname(i.path)))],
          tools,
          // In Auto, shell commands are left to the auto-mode classifier rather than pre-approved.
          allowedTools: req.access === 'workspace-write' && req.commands?.mode === 'auto' ? tools.filter((t) => t !== 'Bash' && t !== 'PowerShell') : tools,
          // Anything not pre-approved is denied instead of prompting: there is no human at the terminal.
          // Working sessions set to Auto use the SDK's auto mode, where a classifier approves or denies.
          permissionMode: req.access === 'workspace-write' && req.commands?.mode === 'auto' ? 'auto' : 'dontAsk',
          // Ignore project settings so repository files cannot loosen Orbit's policy. Working
          // sessions load the developer's own user settings and skills, as their terminal would.
          settingSources: req.userEnvironment ? ['user'] : [],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemAppend },
          maxTurns: req.maxTurns,
          ...(req.maxBudgetUsd != null ? { maxBudgetUsd: req.maxBudgetUsd } : {}),
          ...(req.model ? { model: req.model } : {}),
          ...(req.effort ? { effort: req.effort } : {}),
          ...(req.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: req.outputSchema } } : {}),
          ...(req.execution.mode === 'sandbox'
            ? {
                sandbox: {
                  enabled: true,
                  failIfUnavailable: true,
                  autoAllowBashIfSandboxed: true,
                  allowUnsandboxedCommands: false,
                  ...(req.execution.allowNetworkTools ? {} : { network: { allowedDomains: [] as string[] } }),
                },
              }
            : {}),
          persistSession: req.session?.persist ?? false,
          ...(req.session?.resumeId ? { resume: req.session.resumeId } : {}),
          env: buildAgentEnv(this.env, { CLAUDE_AGENT_SDK_CLIENT_APP: `orbit/${ORBIT_VERSION}` }),
          stderr: (data: string) => {
            stderrTail.push(data);
            if (stderrTail.length > 40) stderrTail.shift();
          },
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    if (input.hook_event_name !== 'PreToolUse') return {};
                    const decision = evaluateToolUse(input.tool_name, input.tool_input, policy);
                    if (decision.allow) return {};
                    const raw = (input.tool_input as { command?: unknown } | undefined)?.command;
                    const command = decision.needsApproval && typeof raw === 'string' ? redactSecrets(raw) : undefined;
                    denied.push({ tool: input.tool_name, reason: decision.reason, ...(command ? { command } : {}) });
                    ctx.onEvent({ type: 'denied', tool: input.tool_name, reason: decision.reason, ...(command ? { command } : {}) });
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: decision.reason,
                      },
                    };
                  },
                ],
              },
            ],
          },
        },
      });

      for await (const message of stream) {
        if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
          const m = message as { model?: string };
          ctx.onEvent({ type: 'status', message: `Session started${m.model ? ` (${m.model})` : ''}` });
        } else if (message.type === 'assistant') {
          const last = emitAssistantContent(message.message?.content, ctx.onEvent, calls);
          if (last) text = last;
        } else if (message.type === 'user') {
          emitToolResults((message.message as { content?: unknown })?.content, ctx.onEvent, { detectDenied: false, calls });
        } else if (message.type === 'result') {
          const r = message as {
            subtype: string;
            is_error: boolean;
            result?: string;
            structured_output?: unknown;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
            num_turns?: number;
            session_id?: string;
            errors?: string[];
            terminal_reason?: string;
          };
          if (typeof r.result === 'string' && r.result) text = r.result;
          structured = r.structured_output ?? (req.outputSchema ? extractJson(text) : null);
          const status: AgentRunStatus =
            r.subtype === 'success' && !r.is_error
              ? 'succeeded'
              : r.subtype === 'error_max_turns'
                ? 'max_turns'
                : r.subtype === 'error_max_budget_usd'
                  ? 'budget_exceeded'
                  : isUsageLimitError([...(r.errors ?? []), r.result ?? ''].join(' '))
                    ? 'rate_limited'
                    : 'failed';
          result = {
            status,
            text: redactSecrets(text),
            structured,
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
            model: req.model,
            error: status === 'succeeded' ? null : redactSecrets([...(r.errors ?? []), r.terminal_reason ?? ''].filter(Boolean).join('; ') || r.subtype),
            deniedTools: denied,
          };
        }
      }
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      const status: AgentRunStatus = timedOut ? 'timeout' : ctx.signal.aborted ? 'cancelled' : isUsageLimitError(msg) ? 'rate_limited' : 'failed';
      return emptyResult({
        status,
        durationMs: Date.now() - started,
        text: redactSecrets(text),
        error: `${msg}${stderrTail.length ? `\n${redactSecrets(stderrTail.join('').slice(-1500))}` : ''}`,
        deniedTools: denied,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }

    if (!result) {
      return emptyResult({
        status: timedOut ? 'timeout' : ctx.signal.aborted ? 'cancelled' : 'failed',
        durationMs: Date.now() - started,
        text: redactSecrets(text),
        error: 'The agent ended without a result message.',
        deniedTools: denied,
      });
    }
    return result;
  }
}
