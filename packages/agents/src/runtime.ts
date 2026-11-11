import type { AgentPlanItem, AgentStepKind, EffortLevel, ExecutionMode, RuntimeId, StepOutput, TeamSeat } from '@orbit/shared';

export interface ExecutionPolicy {
  /** `sandbox`: the runtime must enforce OS-level isolation or fail. `trusted-local`: runs directly on this machine. */
  mode: ExecutionMode;
  allowNetworkTools: boolean;
}

export interface AgentRunRequest {
  role: TeamSeat;
  /** The task-specific prompt (contains untrusted task text inside clearly delimited blocks). */
  prompt: string;
  /** Role instructions appended to the runtime's coding system prompt. */
  systemAppend: string;
  /** Working directory. For the engineer this is the mission worktree. */
  cwd: string;
  /** Extra directories the agent may read (never write). */
  readRoots: string[];
  access: 'read-only' | 'workspace-write';
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd: number | null;
  model: string | null;
  /** Reasoning effort (`xhigh` is recommended for coding). Null leaves the model default. */
  effort: EffortLevel | null;
  /** JSON Schema for the final structured answer. */
  outputSchema: Record<string, unknown> | null;
  execution: ExecutionPolicy;
  /**
   * Working sessions keep the agent's own session on disk and continue it on the next
   * message, like a terminal that stays open. Missions leave this unset (one-shot runs).
   */
  session?: { resumeId: string | null; persist: boolean } | null;
  /**
   * Which shell commands may run without asking. Unset or `any`: missions, where the
   * sandbox is the guard. `allowlist`: working sessions in "Ask first", where every other
   * command is blocked and reported so the developer can approve it. `auto`: working
   * sessions in "Auto", Claude Code's auto mode: commands run on their own and a safety
   * classifier blocks risky ones. In every mode Orbit's deny rules still apply.
   */
  commands?: { mode: 'any' } | { mode: 'allowlist'; allowed: string[] } | { mode: 'auto'; allowed: string[] } | null;
  /**
   * Load the developer's own Claude Code user settings and skills (their design skills,
   * their permission rules), as their terminal would. Settings files inside the project are
   * still ignored, so a repository cannot loosen Orbit's rules. Off for missions, which act
   * on task text from trackers.
   */
  userEnvironment?: boolean;
  /**
   * Working sessions: the agent may commit and push itself when the developer asks (through
   * the normal command approval). Force pushes, history rewrites, git settings and publishing
   * stay blocked. Off for Autopilot, where Orbit commits and pushes after your approval.
   */
  allowGit?: boolean;
  /** Images the developer attached to the message (saved by Orbit; the agent sees them). */
  images?: AgentImage[];
  /**
   * Run Claude Code against another Anthropic-compatible API (OpenRouter) with this key,
   * instead of your Claude login; `model` is that API's model id. `tools: false` is for models
   * that cannot use tools: the agent then has none and can only answer. Claude Code CLI only.
   */
  gateway?: AgentGateway | null;
  /**
   * A folder that belongs to this session, where a runtime may keep its own state between
   * messages (Cursor: its settings with this session's allow list, and its chats).
   */
  stateDir?: string | null;
}

export interface AgentGateway {
  name: string;
  baseUrl: string;
  token: string;
  model: string;
  tools: boolean;
  /** Normalize Claude Code's mid-conversation system turns for strict llama.cpp templates. */
  compatibility?: 'llamacpp';
}

/**
 * The environment Claude Code needs to talk to a gateway instead of Anthropic: its address and
 * key, and the gateway's model everywhere Claude Code would pick one of Claude's own (background
 * calls, subagents), so nothing silently goes to another model.
 */
export function gatewayEnv(g: AgentGateway): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: g.baseUrl,
    ANTHROPIC_AUTH_TOKEN: g.token,
    ANTHROPIC_MODEL: g.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: g.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: g.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: g.model,
    ANTHROPIC_SMALL_FAST_MODEL: g.model,
    CLAUDE_CODE_SUBAGENT_MODEL: g.model,
    // Claude Code asks for Claude's own "adaptive" thinking otherwise, which other models may refuse
    // (checked with Claude Code 2.1.322: with 0 the request carries no thinking setting at all).
    MAX_THINKING_TOKENS: '0',
    // No update checks, telemetry or error reports: only the model calls leave.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/** An image attached to a message, as a file Orbit saved. */
export interface AgentImage {
  path: string;
  mediaType: string;
}

/** For runtimes that cannot attach images directly: where the agent can open them. */
export function imageNote(images: AgentImage[] | undefined): string {
  if (!images?.length) return '';
  return `\n\nThe developer attached ${images.length === 1 ? 'an image' : `${images.length} images`} ([Image #1] and so on, in order). Look at ${images.length === 1 ? 'it' : 'them'} with your file-reading tool:\n${images.map((i, n) => `[Image #${n + 1}] ${i.path}`).join('\n')}`;
}

/**
 * Splits a shell line into the commands Claude Code checks one by one
 * (`cd x && npm test` is two commands), respecting quotes.
 */
export function commandParts(command: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n' || c === '\r') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** True when a command can be turned into exact permission rules, one per part. */
export function isAllowableCommand(command: string): boolean {
  const c = command.trim();
  if (!c || c.length > 4000) return false;
  const parts = commandParts(c);
  // eslint-disable-next-line no-control-regex
  return parts.length > 0 && parts.every((p) => p.length <= 1000 && !/[\u0000-\u0008\u000b-\u001f]/.test(p));
}

/** Exact Claude Code permission rules for allowed commands (both shell tools, every part). */
export function commandRules(commands: string[]): string[] {
  const parts = [...new Set(commands.filter(isAllowableCommand).flatMap(commandParts))];
  return parts.flatMap((p) => [`Bash(${p})`, `PowerShell(${p})`]);
}

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      tool: string;
      summary: string;
      /** Runtime's id for this call, so a later error can be linked back to it. */
      id?: string;
      step?: AgentStepKind;
      target?: string | null;
      plan?: AgentPlanItem[];
      /** Known when the call starts, e.g. an edit's changed lines. */
      output?: StepOutput;
    }
  | { type: 'tool_result'; isError: boolean; summary: string; id?: string; output?: StepOutput }
  | { type: 'denied'; tool: string; reason: string; command?: string };

/** `rate_limited`: the AI's plan or account hit its usage limit; another AI may still be able to run. */
export type AgentRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout' | 'budget_exceeded' | 'max_turns' | 'refused' | 'rate_limited';

const USAGE_LIMIT = /usage limit|rate limit|hit your limit|limit reached|quota|too many requests|429/i;

/** True when an error message means the account is out of usage for now (not a bug in the task). */
export function isUsageLimitError(message: string | null | undefined): boolean {
  return !!message && USAGE_LIMIT.test(message);
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  /** Final text answer (agent prose; never treated as evidence of success). */
  text: string;
  /** Parsed structured output, if a schema was requested and the agent produced it. */
  structured: unknown;
  costUsd: number | null;
  usage: AgentUsage | null;
  numTurns: number | null;
  durationMs: number;
  sessionId: string | null;
  model: string | null;
  error: string | null;
  /**
   * How full the agent's context is after this answer: the size of its last request and the
   * model's window (null when unknown). Working sessions show it as /context.
   */
  context?: { tokens: number; window: number | null } | null;
  /** Tool calls that were refused; `command` is set for shell commands that need approval. */
  deniedTools: { tool: string; reason: string; command?: string }[];
}

export interface RuntimeAvailability {
  available: boolean;
  reason: string | null;
  sandbox: 'available' | 'unavailable' | 'unknown';
  details: Record<string, string>;
}

/** Delivers a message (and any images with it) while the agent works; false when it can no longer take one. */
export type SteerFn = (text: string, images?: AgentImage[]) => boolean;

/** An agent asking, mid-answer, to run something its sandbox blocks (Codex's on-request approvals). */
export interface ApprovalRequest {
  kind: 'command' | 'file';
  /** The command, already unwrapped from its shell and redacted. */
  command: string | null;
  reason: string | null;
  network: boolean;
}

/** `acceptForSession`: also run similar requests in this agent session without asking. `cancel` stops the answer. */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface AgentRunContext {
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /**
   * Set by callers that want to talk to the agent mid-answer, like typing into Claude Code
   * while it works. A runtime that supports it calls this with a function once it can take
   * messages, and with null when it no longer can (the answer is finishing).
   */
  onSteerReady?: (steer: SteerFn | null) => void;
  /**
   * Set by callers that can answer approval requests (working sessions). A runtime that
   * supports them lets the agent ask instead of failing; without it, such requests are refused.
   */
  onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

/** A pluggable agent backend. Orbit ships Claude Agent SDK, Claude Code CLI, Codex CLI and a scripted test runtime. */
export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly displayName: string;
  /** `scripted` runtimes make deterministic changes without AI and are labeled as such everywhere. */
  readonly kind: 'ai' | 'scripted';
  /** True when `request.session.resumeId` continues an earlier session with its full context. */
  readonly resumable?: boolean;
  checkAvailability(): Promise<RuntimeAvailability>;
  run(request: AgentRunRequest, ctx: AgentRunContext): Promise<AgentRunResult>;
}

export function emptyResult(partial: Partial<AgentRunResult> & Pick<AgentRunResult, 'status' | 'durationMs'>): AgentRunResult {
  return {
    text: '',
    structured: null,
    costUsd: null,
    usage: null,
    numTurns: null,
    sessionId: null,
    model: null,
    error: null,
    deniedTools: [],
    ...partial,
  };
}

/** Extracts a JSON object from free text: a ```json fence first, then the outermost braces. */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(c.slice(start, end + 1));
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
