import { describe, expect, it } from 'vitest';
import type { MissionEventDTO } from '@orbit/shared';
import { buildLiveModel, type LiveChecks, type LiveRun } from '../src/lib/live-steps';

let id = 0;
function ev(p: Partial<MissionEventDTO> & Pick<MissionEventDTO, 'kind' | 'actor' | 'title'>): MissionEventDTO {
  id++;
  return { id, missionId: 'm1', missionRepoId: null, ts: new Date(Date.UTC(2026, 10, 5, 10, 0, id)).toISOString(), detail: null, data: null, ...p };
}

function engineerRun(): MissionEventDTO[] {
  return [
    ev({ kind: 'state', actor: 'system', title: 'Implementation started' }),
    ev({ kind: 'agent', actor: 'engineer', title: 'Engineer started (claude-opus-5-5, xhigh effort)', data: { runId: 'run1', phase: 'start', runtime: 'claude-code-cli', model: 'claude-opus-5-5' } }),
    ev({ kind: 'tool', actor: 'engineer', title: 'Read cart.ts', data: { runId: 'run1', toolUseId: 't1', step: 'read', target: 'src/cart.ts' } }),
    ev({ kind: 'tool', actor: 'engineer', title: 'Update plan (0/2 done)', data: { runId: 'run1', toolUseId: 't2', step: 'plan', target: null, plan: [{ text: 'Add param', status: 'in_progress' }, { text: 'Tests', status: 'pending' }] } }),
    ev({ kind: 'tool', actor: 'engineer', title: 'Run pnpm test', data: { runId: 'run1', toolUseId: 't3', step: 'run', target: 'pnpm test' } }),
  ];
}

describe('buildLiveModel', () => {
  it('groups steps under their run and marks only the latest as running', () => {
    const m = buildLiveModel(engineerRun(), true);
    const run = m.blocks.find((b) => b.type === 'run') as LiveRun;
    expect(run.model).toBe('claude-opus-5-5');
    expect(run.plan?.map((p) => p.text)).toEqual(['Add param', 'Tests']);
    expect(run.steps.map((s) => [s.kind, s.object, s.status])).toEqual([
      ['read', 'src/cart.ts', 'done'],
      ['run', 'pnpm test', 'running'],
    ]);
    expect(m.now).toMatchObject({ actor: 'engineer', verb: 'Running', object: 'pnpm test', focus: 'Add param' });
  });

  it('marks a failed tool call by id and shows the agent as thinking afterwards', () => {
    const events = [...engineerRun(), ev({ kind: 'tool', actor: 'engineer', title: 'Tool error', detail: '1 test failed', data: { runId: 'run1', toolUseId: 't3', failed: true } })];
    const m = buildLiveModel(events, true);
    const run = m.blocks.find((b) => b.type === 'run') as LiveRun;
    expect(run.steps[1]).toMatchObject({ status: 'failed', detail: '1 test failed' });
    expect(m.now?.verb).toBe('Thinking');
  });

  it('settles steps when the run ends and reports no current activity', () => {
    const events = [...engineerRun(), ev({ kind: 'agent', actor: 'engineer', title: 'Engineer finished after 2m', data: { runId: 'run1', phase: 'end', status: 'succeeded' } })];
    const m = buildLiveModel(events, true);
    const run = m.blocks.find((b) => b.type === 'run') as LiveRun;
    expect(run.outcome).toBe('succeeded');
    expect(run.steps.every((s) => s.status === 'done')).toBe(true);
    expect(m.now).toBeNull();
  });

  it('shows interrupted work when the mission is no longer active', () => {
    const m = buildLiveModel(engineerRun(), false);
    const run = m.blocks.find((b) => b.type === 'run') as LiveRun;
    expect(run.outcome).toBe('stopped');
    expect(run.steps[1]?.status).toBe('stopped');
    expect(m.now).toBeNull();
  });

  it('tracks verification checks, including events recorded before structured data', () => {
    const events = [
      ev({ kind: 'command', actor: 'system', title: 'Running Tests: pnpm test', data: { verificationId: 'v1', phase: 'start', label: 'Tests', command: 'pnpm test' } }),
      ev({ kind: 'error', actor: 'system', title: 'Tests failed in 4s', detail: 'boom', data: { verificationId: 'v1', phase: 'end', label: 'Tests', command: 'pnpm test', status: 'failed' } }),
      ev({ kind: 'command', actor: 'system', title: 'Running Lint: pnpm lint' }),
    ];
    const m = buildLiveModel(events, true);
    const checks = m.blocks[0] as LiveChecks;
    expect(m.blocks).toHaveLength(1);
    expect(checks.items.map((i) => [i.label, i.status])).toEqual([
      ['Tests', 'failed'],
      ['Lint', 'running'],
    ]);
    expect(m.now).toMatchObject({ actor: 'system', verb: 'Running Lint', object: 'pnpm lint' });
  });

  it('understands runs recorded before phase markers existed', () => {
    const events = [
      ev({ kind: 'agent', actor: 'planner', title: 'Planner started', data: { runId: 'old', runtime: 'claude-code-cli', model: null, effort: null } }),
      ev({ kind: 'tool', actor: 'planner', title: 'Search for "cartTotal"' }),
      ev({ kind: 'agent', actor: 'planner', title: 'Planner finished after 30s', data: { runId: 'old', numTurns: 4, deniedTools: 0 } }),
      ev({ kind: 'agent', actor: 'reviewer', title: 'Review: approve (0 blocker)', detail: 'Looks good.' }),
    ];
    const m = buildLiveModel(events, false);
    const run = m.blocks[0] as LiveRun;
    expect(run.outcome).toBe('succeeded');
    expect(run.steps[0]).toMatchObject({ kind: 'search', verb: { done: 'Searched for' }, object: '"cartTotal"', status: 'done' });
    expect(m.blocks[1]).toMatchObject({ type: 'milestone', title: 'Review: approve (0 blocker)' });
  });

  it('turns a refused command into one step that waits for you', () => {
    const events = [
      ev({ kind: 'agent', actor: 'assistant', title: 'Agent started', data: { runId: 'r9', phase: 'start', runtime: 'claude-code-cli' } }),
      ev({ kind: 'tool', actor: 'assistant', title: 'Run npm install x', data: { runId: 'r9', toolUseId: 'u1', step: 'run', target: 'npm install x' } }),
      ev({ kind: 'error', actor: 'assistant', title: 'Needs your OK: npm install x', detail: 'denied', data: { runId: 'r9', failed: true, step: 'run', target: 'npm install x' } }),
      ev({ kind: 'agent', actor: 'assistant', title: 'Agent finished', data: { runId: 'r9', phase: 'end', status: 'succeeded' } }),
    ];
    const run = buildLiveModel(events, false).blocks[0] as LiveRun;
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ kind: 'blocked', status: 'failed', object: 'npm install x' });
  });
});

describe('step results for the terminal view', () => {
  it('attaches outputs to their steps, keeps edit diffs, and can keep to-do updates as steps', () => {
    const events = [
      ev({ kind: 'agent', actor: 'assistant', title: 'Agent started', data: { runId: 'r9', phase: 'start', runtime: 'claude-code-cli', model: null } }),
      ev({ kind: 'tool', actor: 'assistant', title: 'Run npm test', data: { runId: 'r9', toolUseId: 'b1', tool: 'Bash', step: 'run', target: 'npm test' } }),
      ev({ kind: 'tool', actor: 'assistant', title: 'Tool output', data: { runId: 'r9', toolUseId: 'b1', result: true, output: { text: 'ok', lines: 12 } } }),
      ev({ kind: 'tool', actor: 'assistant', title: 'Update plan (0/1 done)', data: { runId: 'r9', toolUseId: 'p1', tool: 'TodoWrite', step: 'plan', target: null, plan: [{ text: 'Fix', status: 'in_progress' }] } }),
      ev({ kind: 'tool', actor: 'assistant', title: 'Edit a.ts', data: { runId: 'r9', toolUseId: 'e1', tool: 'Edit', step: 'edit', target: 'src/a.ts', output: { diff: ['-a', '+b'], added: 1, removed: 1 } } }),
    ];
    const plain = buildLiveModel(events, true).blocks[0] as LiveRun;
    expect(plain.steps.map((s) => s.kind)).toEqual(['run', 'edit']);
    expect(plain.steps[0]).toMatchObject({ tool: 'Bash', status: 'done', output: { text: 'ok', lines: 12 } });
    expect(plain.steps[1]).toMatchObject({ tool: 'Edit', status: 'running', output: { diff: ['-a', '+b'] } });
    const terminal = buildLiveModel(events, true, { planSteps: true }).blocks[0] as LiveRun;
    expect(terminal.steps.map((s) => s.kind)).toEqual(['run', 'plan', 'edit']);
    expect(terminal.steps[1]).toMatchObject({ plan: [{ text: 'Fix', status: 'in_progress' }] });
  });
});

describe('repeated calls', () => {
  it('shows a command that is reported again after your approval as one step', () => {
    const events = [
      ev({ kind: 'agent', actor: 'assistant', title: 'Agent started', data: { runId: 'r7', phase: 'start', runtime: 'codex-cli', model: null } }),
      ev({ kind: 'tool', actor: 'assistant', title: 'Run git commit -m x', data: { runId: 'r7', toolUseId: 'c1', tool: 'PowerShell', step: 'run', target: 'git commit -m x' } }),
      ev({ kind: 'agent', actor: 'assistant', title: 'You allowed: git commit -m x', data: { runId: 'r7' } }),
      ev({ kind: 'tool', actor: 'assistant', title: 'Run git commit -m x', data: { runId: 'r7', toolUseId: 'c1', tool: 'PowerShell', step: 'run', target: 'git commit -m x' } }),
      ev({ kind: 'tool', actor: 'assistant', title: 'Tool output', data: { runId: 'r7', toolUseId: 'c1', result: true, output: { text: '[main b9a9725] x' } } }),
    ];
    const run = buildLiveModel(events, true).blocks[0] as LiveRun;
    expect(run.steps.filter((s) => s.kind === 'run')).toHaveLength(1);
    expect(run.steps.find((s) => s.kind === 'run')).toMatchObject({ status: 'done', output: { text: '[main b9a9725] x' } });
  });
});
