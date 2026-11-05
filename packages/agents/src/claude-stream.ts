import { redactSecrets } from '@orbit/shared';
import type { AgentEvent } from './runtime';
import { describeToolCall } from './summarize';

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown };

/** Tool calls seen so far in a run, so a refusal can name the command that was refused. */
export type ToolCallLog = Map<string, { name: string; input: unknown }>;

/** What Claude Code says when it refuses a tool call under its permission rules. */
const PERMISSION_REFUSAL = /permission to use \S+.*has been denied|haven't granted|requested permissions? to use|not allowed by your permission/i;

function commandOf(input: unknown): string | undefined {
  const c = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined;
  return typeof c === 'string' ? c : undefined;
}

/**
 * Turns the content of a Claude `assistant` message into live events. Shared by
 * the Agent SDK and CLI runtimes so both describe steps identically.
 * Returns the last text block, if any (the caller keeps it as the running answer).
 */
export function emitAssistantContent(content: unknown, onEvent: (e: AgentEvent) => void, calls?: ToolCallLog): string | null {
  if (!Array.isArray(content)) return null;
  let last: string | null = null;
  for (const block of content as Block[]) {
    if (block.type === 'text' && block.text) {
      last = block.text;
      onEvent({ type: 'text', text: redactSecrets(block.text) });
    } else if (block.type === 'tool_use' && block.name) {
      if (calls && block.id) calls.set(block.id, { name: block.name, input: block.input });
      const d = describeToolCall(block.name, block.input);
      onEvent({
        type: 'tool',
        tool: block.name,
        id: block.id,
        summary: redactSecrets(d.summary),
        step: d.step,
        target: d.target == null ? null : redactSecrets(d.target),
        plan: d.plan?.map((p) => ({ ...p, text: redactSecrets(p.text) })),
      });
    }
  }
  return last;
}

/**
 * Reports failed tool results from a Claude `user` message. Successful results
 * are not reported: a step counts as done once the agent moves on, which keeps
 * the event log at one row per step.
 */
export function emitToolResults(content: unknown, onEvent: (e: AgentEvent) => void, opts: { detectDenied: boolean; calls?: ToolCallLog }): void {
  if (!Array.isArray(content)) return;
  for (const block of content as Block[]) {
    if (block.type !== 'tool_result' || !block.is_error) continue;
    const t = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
    if (opts.detectDenied && PERMISSION_REFUSAL.test(t)) {
      const call = block.tool_use_id ? opts.calls?.get(block.tool_use_id) : undefined;
      const command = commandOf(call?.input);
      onEvent({ type: 'denied', tool: call?.name ?? 'tool', reason: redactSecrets(t.slice(0, 200)), ...(command ? { command: redactSecrets(command) } : {}) });
    } else onEvent({ type: 'tool_result', isError: true, id: block.tool_use_id, summary: redactSecrets(t.slice(0, 300)) });
  }
}

/** Shell commands Claude Code refused, from the result message's `permission_denials`. */
export function permissionDenials(raw: unknown): { tool: string; reason: string; command?: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { tool: string; reason: string; command?: string }[] = [];
  for (const d of raw as { tool_name?: unknown; tool_input?: unknown }[]) {
    const tool = typeof d?.tool_name === 'string' ? d.tool_name : 'tool';
    const command = commandOf(d?.tool_input);
    out.push({ tool, reason: 'Needs your approval', ...(command ? { command: redactSecrets(command) } : {}) });
  }
  return out;
}
