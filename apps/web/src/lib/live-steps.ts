import type { AgentEventData, AgentPlanItem, AgentStepKind, CommandEventData, MissionEventDTO, StepOutput, TeamSeat } from '@orbit/shared';

/** The fields the live view reads; mission events and Ask conversation events both fit. */
export type LiveEvent = Pick<MissionEventDTO, 'id' | 'ts' | 'kind' | 'title' | 'detail' | 'data'> & { actor: string };

/**
 * Turns the mission event log into the "Live" view: agent runs with their
 * steps, check runs, and the milestones between them.
 *
 * Runtimes report a tool call when it starts and only report the result when
 * it fails, so a step counts as done as soon as the agent does something else
 * (or its run ends). Only the latest step of an open run can be running.
 */

export type StepStatus = 'running' | 'done' | 'failed' | 'stopped';
export type LiveStepKind = AgentStepKind | 'say' | 'blocked' | 'note';

export interface LiveStep {
  id: number;
  ts: string;
  kind: LiveStepKind;
  /** Plain-language label without the object, e.g. `Edited` / `Editing`. */
  verb: { done: string; doing: string };
  /** What the step acted on (file, command, pattern) or the message text. */
  object: string;
  status: StepStatus;
  /** Full message text, or the error output of a failed step. */
  detail: string | null;
  toolUseId: string | null;
  /** The runtime's tool name (`Bash`, `Edit`…), when recorded. */
  tool?: string | null;
  /** What the step produced (command output, an edit's lines), when recorded. */
  output?: StepOutput | null;
  /** On `plan` steps (only with `planSteps`): the to-do list at that moment. */
  plan?: AgentPlanItem[] | null;
}

export interface LiveModelOptions {
  /** Also keep each to-do list update as a step, where it happened (the terminal view). */
  planSteps?: boolean;
}

export type RunOutcome = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stopped';

export interface LiveRun {
  type: 'run';
  key: string;
  role: TeamSeat;
  runId: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: RunOutcome;
  /** The boundary event titles, e.g. "Engineer started (…)" and "Engineer finished after 3m". */
  startTitle: string;
  endTitle: string | null;
  model: string | null;
  plan: AgentPlanItem[] | null;
  steps: LiveStep[];
}

export type CheckStatus = 'running' | 'passed' | 'failed' | 'timeout' | 'error' | 'stopped';

export interface LiveCheck {
  id: string;
  label: string;
  command: string;
  status: CheckStatus;
  startedAt: string;
  endedAt: string | null;
  detail: string | null;
}

export interface LiveChecks {
  type: 'checks';
  key: string;
  startedAt: string;
  items: LiveCheck[];
}

export interface LiveMilestone {
  type: 'milestone';
  key: string;
  ts: string;
  title: string;
  detail: string | null;
  tone: 'state' | 'good' | 'bad' | 'neutral';
}

export type LiveBlock = LiveRun | LiveChecks | LiveMilestone;

export interface LiveNow {
  /** Who is acting: an agent role, or `system` for Orbit's own checks. */
  actor: TeamSeat | 'system';
  verb: string;
  object: string;
  kind: LiveStepKind | 'check' | 'starting';
  /** When the current step started. */
  since: string;
  /** When the current agent run (or check) started. */
  runStartedAt: string;
  /** The item the agent marked in progress on its own to-do list. */
  focus: string | null;
}

export interface LiveModel {
  blocks: LiveBlock[];
  now: LiveNow | null;
  stepCount: number;
}

const ROLES = new Set<string>(['planner', 'engineer', 'reviewer', 'security', 'prompter', 'assistant']);

const VERBS: [prefix: string, done: string, doing: string, kind: AgentStepKind][] = [
  ['Search the web for ', 'Searched the web for', 'Searching the web for', 'web'],
  ['Find files', 'Found files', 'Finding files', 'search'],
  ['Search for ', 'Searched for', 'Searching for', 'search'],
  ['Read ', 'Read', 'Reading', 'read'],
  ['List ', 'Listed', 'Listing', 'read'],
  ['Edit ', 'Edited', 'Editing', 'edit'],
  ['Write ', 'Wrote', 'Writing', 'edit'],
  ['Run ', 'Ran', 'Running', 'run'],
  ['Fetch ', 'Fetched', 'Fetching', 'web'],
  ['Delegate: ', 'Delegated', 'Delegating', 'delegate'],
];

function describeTool(title: string, data: AgentEventData): { kind: AgentStepKind; verb: LiveStep['verb']; object: string } {
  for (const [prefix, done, doing, kind] of VERBS) {
    if (title.startsWith(prefix)) {
      return { kind: data.step ?? kind, verb: { done, doing }, object: (data.target ?? title.slice(prefix.length)).trim() };
    }
  }
  return { kind: data.step ?? 'other', verb: { done: 'Used', doing: 'Using' }, object: data.target ?? title };
}

function dataOf<T>(e: LiveEvent): Partial<T> {
  return e.data && typeof e.data === 'object' ? (e.data as Partial<T>) : {};
}

function isRunStart(d: AgentEventData & { numTurns?: unknown }): boolean {
  if (d.phase) return d.phase === 'start';
  // Events recorded before `phase` existed: the start carries the runtime id.
  return !!d.runId && typeof d.runtime === 'string';
}

function isRunEnd(d: AgentEventData & { numTurns?: unknown }): boolean {
  if (d.phase) return d.phase === 'end';
  return !!d.runId && 'numTurns' in d;
}

function outcomeOf(e: LiveEvent, d: { status?: unknown }): RunOutcome {
  if (d.status === 'succeeded') return 'succeeded';
  if (d.status === 'cancelled') return 'cancelled';
  if (typeof d.status === 'string') return 'failed';
  if (e.kind !== 'error') return 'succeeded';
  return /cancelled/i.test(e.title) ? 'cancelled' : 'failed';
}

/** Marks every running step of a run done (the agent has moved on). */
function settle(run: LiveRun) {
  for (const s of run.steps) if (s.status === 'running') s.status = 'done';
}

export function buildLiveModel(events: LiveEvent[], missionActive: boolean, options: LiveModelOptions = {}): LiveModel {
  const blocks: LiveBlock[] = [];
  const runsById = new Map<string, LiveRun>();
  const openByRole = new Map<string, LiveRun>();
  const checksById = new Map<string, LiveCheck>();
  let currentChecks: LiveChecks | null = null;
  let stepCount = 0;

  const milestone = (e: LiveEvent, tone: LiveMilestone['tone']) => {
    blocks.push({ type: 'milestone', key: `m${e.id}`, ts: e.ts, title: e.title, detail: e.detail && e.detail !== e.title ? e.detail : null, tone });
  };

  for (const e of events) {
    // --- Orbit's own verification commands -------------------------------
    if (e.actor === 'system' && (e.kind === 'command' || e.kind === 'error')) {
      const d = dataOf<CommandEventData>(e);
      const legacyStart = !d.phase && e.kind === 'command' ? /^Running (.+?): (.+)$/.exec(e.title) : null;
      if (d.phase === 'start' || legacyStart) {
        if (!currentChecks || blocks[blocks.length - 1] !== currentChecks) {
          currentChecks = { type: 'checks', key: `c${e.id}`, startedAt: e.ts, items: [] };
          blocks.push(currentChecks);
        }
        const item: LiveCheck = {
          id: d.verificationId ?? `legacy-${e.id}`,
          label: d.label ?? legacyStart?.[1] ?? 'Check',
          command: d.command ?? legacyStart?.[2] ?? '',
          status: 'running',
          startedAt: e.ts,
          endedAt: null,
          detail: null,
        };
        currentChecks.items.push(item);
        checksById.set(item.id, item);
        continue;
      }
      const target = d.verificationId ? checksById.get(d.verificationId) : currentChecks?.items.find((i) => i.status === 'running');
      if (target && (d.phase === 'end' || (!d.phase && target.status === 'running'))) {
        const status = d.status ?? (e.kind === 'command' ? 'passed' : /timeout/.test(e.title) ? 'timeout' : 'failed');
        target.status = status;
        target.endedAt = e.ts;
        target.detail = e.detail;
        continue;
      }
    }

    // --- Agent runs --------------------------------------------------------
    if (ROLES.has(e.actor) && (e.kind === 'agent' || e.kind === 'tool' || e.kind === 'error')) {
      const role = e.actor as TeamSeat;
      const d = dataOf<AgentEventData & { numTurns?: unknown; status?: unknown }>(e);

      if (isRunStart(d)) {
        const prev = openByRole.get(role);
        if (prev && prev.outcome === 'running') {
          settle(prev);
          prev.outcome = 'stopped';
        }
        const run: LiveRun = {
          type: 'run',
          key: `r${e.id}`,
          role,
          runId: d.runId ?? null,
          startedAt: e.ts,
          endedAt: null,
          outcome: 'running',
          startTitle: e.title,
          endTitle: null,
          model: typeof d.model === 'string' ? d.model : null,
          plan: null,
          steps: [],
        };
        blocks.push(run);
        if (run.runId) runsById.set(run.runId, run);
        openByRole.set(role, run);
        continue;
      }

      const run = (d.runId ? runsById.get(d.runId) : undefined) ?? (openByRole.get(role)?.outcome === 'running' ? openByRole.get(role) : undefined);

      // A step's successful result: its output, and the step is done.
      if (e.kind === 'tool' && d.result) {
        const step = d.toolUseId ? run?.steps.find((s) => s.toolUseId === d.toolUseId) : undefined;
        if (step) {
          if (d.output) step.output = d.output;
          if (step.status === 'running') step.status = 'done';
        }
        continue;
      }

      if (run && isRunEnd(d)) {
        run.endedAt = e.ts;
        run.endTitle = e.title;
        run.outcome = outcomeOf(e, d);
        const last = run.steps[run.steps.length - 1];
        if (last?.status === 'running' && run.outcome !== 'succeeded') last.status = 'stopped';
        settle(run);
        openByRole.delete(role);
        continue;
      }

      // Agent output after its run ended (e.g. the reviewer's verdict) reads as a milestone.
      if (!run || run.outcome !== 'running') {
        milestone(e, e.kind === 'error' ? 'bad' : 'neutral');
        continue;
      }

      if (e.kind === 'tool' && d.failed) {
        const step = (d.toolUseId ? run.steps.find((s) => s.toolUseId === d.toolUseId) : undefined) ?? [...run.steps].reverse().find((s) => s.kind !== 'say');
        if (step) {
          step.status = 'failed';
          step.detail = e.detail;
        }
        continue;
      }

      if (e.kind === 'tool' && d.plan) {
        run.plan = d.plan;
        if (options.planSteps) {
          settle(run);
          stepCount++;
          run.steps.push({ id: e.id, ts: e.ts, kind: 'plan', verb: { done: 'Updated plan', doing: 'Updating plan' }, object: e.title, status: 'done', detail: null, toolUseId: d.toolUseId ?? null, tool: d.tool ?? 'TodoWrite', output: null, plan: d.plan });
        }
        continue;
      }

      // A refused tool call: the step that asked for it becomes the "needs your OK" step.
      if (e.kind === 'error' && d.failed) {
        const object = (d.target ?? e.title.replace(/^(Blocked\s*|Needs your OK:\s*)/, '')).trim();
        const asked = [...run.steps].reverse().find((s) => s.status === 'running' && s.kind !== 'say');
        if (asked && (asked.kind === 'run' || asked.kind === 'other')) {
          asked.kind = 'blocked';
          asked.status = 'failed';
          asked.verb = { done: 'Blocked', doing: 'Blocked' };
          asked.object = object || asked.object;
          asked.detail = e.detail;
          continue;
        }
        settle(run);
        stepCount++;
        run.steps.push({ id: e.id, ts: e.ts, kind: 'blocked', verb: { done: 'Blocked', doing: 'Blocked' }, object, status: 'failed', detail: e.detail, toolUseId: null });
        continue;
      }

      if (e.kind === 'agent' && !e.detail && /^Session (started|continued)/.test(e.title)) {
        const m = /\((.+)\)$/.exec(e.title);
        if (m && !run.model) run.model = m[1] ?? null;
        continue;
      }

      // The same call reported again (Codex re-runs a command once you approve it): one step.
      if (e.kind === 'tool' && d.toolUseId) {
        const t = describeTool(e.title, d);
        const same = run.steps.find((s) => s.toolUseId === d.toolUseId && s.kind === t.kind && s.object === t.object);
        if (same) {
          same.status = 'running';
          continue;
        }
      }

      settle(run);
      stepCount++;
      if (e.kind === 'tool') {
        const t = describeTool(e.title, d);
        run.steps.push({ id: e.id, ts: e.ts, kind: t.kind, verb: t.verb, object: t.object, status: 'running', detail: null, toolUseId: d.toolUseId ?? null, tool: d.tool ?? null, output: d.output ?? null });
      } else if (e.kind === 'error') {
        run.steps.push({ id: e.id, ts: e.ts, kind: 'blocked', verb: { done: 'Blocked', doing: 'Blocked' }, object: e.title.replace(/^Blocked\s*/, ''), status: 'failed', detail: e.detail, toolUseId: null });
      } else if (e.detail) {
        run.steps.push({ id: e.id, ts: e.ts, kind: 'say', verb: { done: 'Said', doing: 'Saying' }, object: e.title, status: 'done', detail: e.detail, toolUseId: null });
      } else {
        run.steps.push({ id: e.id, ts: e.ts, kind: 'note', verb: { done: '', doing: '' }, object: e.title, status: 'done', detail: null, toolUseId: null });
      }
      continue;
    }

    // --- Everything else: state changes, approvals, git, Asana, GitHub -----
    milestone(e, e.kind === 'state' ? 'state' : e.kind === 'error' ? 'bad' : e.kind === 'approval' || e.actor === 'github' ? 'good' : 'neutral');
  }

  // A run or check left open while the mission is no longer working was interrupted.
  for (const b of blocks) {
    if (b.type === 'run' && b.outcome === 'running' && !missionActive) {
      b.outcome = 'stopped';
      for (const s of b.steps) if (s.status === 'running') s.status = 'stopped';
    }
    if (b.type === 'checks' && !missionActive) for (const i of b.items) if (i.status === 'running') i.status = 'stopped';
  }

  return { blocks, now: missionActive ? findNow(blocks) : null, stepCount };
}

function findNow(blocks: LiveBlock[]): LiveNow | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === 'milestone') continue;
    if (b.type === 'checks') {
      const running = b.items.find((x) => x.status === 'running');
      if (!running) return null;
      return { actor: 'system', verb: `Running ${running.label}`, object: running.command, kind: 'check', since: running.startedAt, runStartedAt: b.startedAt, focus: null };
    }
    if (b.outcome !== 'running') return null;
    const focus = b.plan?.find((p) => p.status === 'in_progress')?.text ?? null;
    const step = b.steps[b.steps.length - 1];
    if (!step) return { actor: b.role, verb: 'Starting up', object: '', kind: 'starting', since: b.startedAt, runStartedAt: b.startedAt, focus };
    if (step.status === 'running') return { actor: b.role, verb: step.verb.doing, object: step.object, kind: step.kind, since: step.ts, runStartedAt: b.startedAt, focus };
    // Last thing was a message or a failed step: the agent is deciding what to do next.
    return { actor: b.role, verb: 'Thinking', object: '', kind: 'say', since: step.ts, runStartedAt: b.startedAt, focus };
  }
  return null;
}
