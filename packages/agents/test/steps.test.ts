import { describe, expect, it } from 'vitest';
import { describeToolCall, emitAssistantContent, emitToolResults, type AgentEvent } from '../src';

describe('describeToolCall', () => {
  it('classifies common tools with a short target', () => {
    expect(describeToolCall('Read', { file_path: '/work/orbit-wt/abc/src/cart.ts' })).toMatchObject({ summary: 'Read cart.ts', step: 'read', target: 'src/cart.ts' });
    expect(describeToolCall('Edit', { file_path: 'C:\\wt\\src\\cart.ts' })).toMatchObject({ step: 'edit', target: 'src/cart.ts' });
    expect(describeToolCall('Bash', { command: 'pnpm test' })).toMatchObject({ summary: 'Run pnpm test', step: 'run', target: 'pnpm test' });
    expect(describeToolCall('Grep', { pattern: 'cartTotal' })).toMatchObject({ step: 'search', target: 'cartTotal' });
    expect(describeToolCall('Mystery', null)).toEqual({ summary: 'Mystery', step: 'other', target: null });
  });

  it('extracts the to-do list from TodoWrite', () => {
    const d = describeToolCall('TodoWrite', {
      todos: [
        { content: 'Add discount param', status: 'completed', activeForm: 'Adding' },
        { content: 'Write tests', status: 'in_progress' },
        { content: 'Update docs', status: 'weird' },
        { nope: true },
      ],
    });
    expect(d.step).toBe('plan');
    expect(d.summary).toBe('Update plan (1/3 done)');
    expect(d.plan).toEqual([
      { text: 'Add discount param', status: 'completed' },
      { text: 'Write tests', status: 'in_progress' },
      { text: 'Update docs', status: 'pending' },
    ]);
  });
});

describe('Claude stream translation', () => {
  it('emits text and tool steps with ids, and returns the last text', () => {
    const events: AgentEvent[] = [];
    const last = emitAssistantContent(
      [
        { type: 'text', text: 'Looking at the cart.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } },
      ],
      (e) => events.push(e),
    );
    expect(last).toBe('Looking at the cart.');
    expect(events).toEqual([
      { type: 'text', text: 'Looking at the cart.' },
      { type: 'tool', tool: 'Bash', id: 'toolu_1', summary: 'Run pnpm test', step: 'run', target: 'pnpm test', plan: undefined },
    ]);
  });

  it('reports failed results linked to their call, and skips successful ones', () => {
    const events: AgentEvent[] = [];
    emitToolResults(
      [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'ok' },
        { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: '1 test failed' },
      ],
      (e) => events.push(e),
      { detectDenied: true },
    );
    expect(events).toEqual([{ type: 'tool_result', isError: true, id: 'toolu_2', summary: '1 test failed' }]);
  });

  it('ignores malformed content', () => {
    const events: AgentEvent[] = [];
    expect(emitAssistantContent(undefined, (e) => events.push(e))).toBeNull();
    emitToolResults('nope', (e) => events.push(e), { detectDenied: false });
    expect(events).toEqual([]);
  });
});
