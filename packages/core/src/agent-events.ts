import type { AgentEvent } from '@orbit/agents';
import { firstLine, truncate, type AgentEventData, type MissionEventKind } from '@orbit/shared';

export interface AgentEventRecord {
  kind: MissionEventKind;
  title: string;
  detail?: string | null;
  data: AgentEventData;
}

/**
 * How a live agent event is stored, shared by missions and Ask conversations so
 * both feed the same step-by-step view.
 */
export function agentEventRecord(e: AgentEvent, runId: string): AgentEventRecord {
  switch (e.type) {
    case 'text':
      return { kind: 'agent', title: truncate(firstLine(e.text), 200) || 'Message', detail: e.text, data: { runId } };
    case 'tool':
      return {
        kind: 'tool',
        title: e.summary,
        data: { runId, toolUseId: e.id ?? null, tool: e.tool, step: e.step ?? 'other', target: e.target ?? null, ...(e.plan ? { plan: e.plan } : {}), ...(e.output ? { output: e.output } : {}) },
      };
    case 'tool_result':
      return e.isError
        ? { kind: 'tool', title: 'Tool error', detail: e.summary, data: { runId, toolUseId: e.id ?? null, failed: true } }
        : { kind: 'tool', title: 'Tool output', data: { runId, toolUseId: e.id ?? null, result: true, ...(e.output ? { output: e.output } : {}) } };
    case 'denied':
      return {
        kind: 'error',
        title: e.command ? `Needs your OK: ${truncate(e.command, 160)}` : `Blocked ${e.tool}`,
        detail: e.reason,
        data: { runId, failed: true, ...(e.command ? { step: 'run' as const, target: e.command } : {}) },
      };
    case 'status':
      return { kind: 'agent', title: e.message, data: { runId } };
  }
}
