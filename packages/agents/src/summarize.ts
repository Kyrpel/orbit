import path from 'node:path';
import type { AgentPlanItem, AgentStepKind } from '@orbit/shared';

export interface ToolCallDescription {
  /** One line for the timeline, e.g. `Edit cart.ts`. */
  summary: string;
  step: AgentStepKind;
  /** What the step acts on, e.g. `src/cart.ts` or the command line. */
  target: string | null;
  /** Present when the call updates the agent's to-do list. */
  plan?: AgentPlanItem[];
}

/** The last two path segments: enough to recognise a file without the worktree prefix. */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/') || path.basename(p);
}

function planItems(input: Record<string, unknown>): AgentPlanItem[] | undefined {
  if (!Array.isArray(input.todos)) return undefined;
  const items: AgentPlanItem[] = [];
  for (const t of input.todos as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object') continue;
    const text = typeof t.content === 'string' ? t.content : typeof t.text === 'string' ? t.text : '';
    if (!text) continue;
    const status = t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending';
    items.push({ text: text.slice(0, 200), status });
  }
  return items.slice(0, 40);
}

/** Classifies a tool call for the live steps view. Never throws on unexpected input. */
export function describeToolCall(tool: string, input: unknown): ToolCallDescription {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const file = str('file_path') || str('notebook_path') || str('path');
  const fileTarget = file ? shortPath(file) : null;
  switch (tool) {
    case 'Read':
      return { summary: `Read ${file ? path.basename(file) : 'file'}`, step: 'read', target: fileTarget };
    case 'LS':
      return { summary: `List ${file ? path.basename(file) : 'folder'}`, step: 'read', target: fileTarget };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { summary: `Edit ${file ? path.basename(file) : 'file'}`, step: 'edit', target: fileTarget };
    case 'Write':
      return { summary: `Write ${file ? path.basename(file) : 'file'}`, step: 'edit', target: fileTarget };
    case 'Glob':
      return { summary: `Find files ${str('pattern')}`.trim(), step: 'search', target: str('pattern') || null };
    case 'Grep':
      return { summary: `Search for ${JSON.stringify(str('pattern')).slice(0, 80)}`, step: 'search', target: str('pattern').slice(0, 200) || null };
    case 'Bash':
    case 'PowerShell':
      return { summary: `Run ${str('command').slice(0, 140)}`, step: 'run', target: str('command').slice(0, 300) || null };
    case 'WebFetch':
      return { summary: `Fetch ${str('url').slice(0, 140)}`, step: 'web', target: str('url').slice(0, 300) || null };
    case 'WebSearch':
      return { summary: `Search the web for ${JSON.stringify(str('query')).slice(0, 80)}`, step: 'web', target: str('query').slice(0, 200) || null };
    case 'TodoWrite': {
      const plan = planItems(i);
      const done = plan?.filter((p) => p.status === 'completed').length ?? 0;
      return { summary: plan?.length ? `Update plan (${done}/${plan.length} done)` : 'Update plan', step: 'plan', target: null, plan };
    }
    case 'Task':
    case 'Agent':
      return { summary: `Delegate: ${str('description') || 'subtask'}`.slice(0, 160), step: 'delegate', target: str('description').slice(0, 200) || null };
    default:
      return { summary: tool, step: 'other', target: null };
  }
}

/** One-line description of a tool call for the live activity feed. */
export function summarizeToolInput(tool: string, input: unknown): string {
  return describeToolCall(tool, input).summary;
}
