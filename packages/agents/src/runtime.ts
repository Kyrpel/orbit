import type { AgentPlanItem, AgentStepKind, EffortLevel, ExecutionMode, RuntimeId, TeamSeat } from '@orbit/shared';

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
    }
  | { type: 'tool_result'; isError: boolean; summary: string; id?: string }
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
  /** Tool calls that were refused; `command` is set for shell commands that need approval. */
  deniedTools: { tool: string; reason: string; command?: string }[];
}

export interface RuntimeAvailability {
  available: boolean;
  reason: string | null;
  sandbox: 'available' | 'unavailable' | 'unknown';
  details: Record<string, string>;
}

/** Delivers a message to the agent while it is working; false when it can no longer take one. */
export type SteerFn = (text: string) => boolean;

export interface AgentRunContext {
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /**
   * Set by callers that want to talk to the agent mid-answer, like typing into Claude Code
   * while it works. A runtime that supports it calls this with a function once it can take
   * messages, and with null when it no longer can (the answer is finishing).
   */
  onSteerReady?: (steer: SteerFn | null) => void;
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
