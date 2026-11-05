/**
 * The mission state machine. Every mission state change in Orbit goes through
 * `assertTransition`, so the allowed transitions below are the single source of
 * truth for the engine, the API and the dashboard.
 */
export const MISSION_STATES = [
  'DRAFT',
  'ANALYZING',
  'AWAITING_SCOPE_APPROVAL',
  'QUEUED',
  'RUNNING',
  'VERIFYING',
  'AWAITING_REVIEW',
  'AWAITING_PR_APPROVAL',
  'PR_CREATED',
  'COMPLETED',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;

export type MissionState = (typeof MISSION_STATES)[number];

export const MISSION_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> = {
  DRAFT: ['ANALYZING', 'CANCELLED'],
  ANALYZING: ['AWAITING_SCOPE_APPROVAL', 'QUEUED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  AWAITING_SCOPE_APPROVAL: ['QUEUED', 'ANALYZING', 'CANCELLED'],
  QUEUED: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  RUNNING: ['VERIFYING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['RUNNING', 'AWAITING_REVIEW', 'BLOCKED', 'FAILED', 'CANCELLED'],
  AWAITING_REVIEW: ['QUEUED', 'AWAITING_PR_APPROVAL', 'CANCELLED'],
  AWAITING_PR_APPROVAL: ['PR_CREATED', 'QUEUED', 'COMPLETED', 'CANCELLED'],
  PR_CREATED: ['COMPLETED'],
  COMPLETED: [],
  BLOCKED: ['ANALYZING', 'QUEUED', 'AWAITING_REVIEW', 'CANCELLED'],
  FAILED: ['ANALYZING', 'QUEUED', 'CANCELLED'],
  CANCELLED: [],
};

export const TERMINAL_STATES: readonly MissionState[] = ['COMPLETED', 'CANCELLED'];

/** States in which the mission is waiting for a human decision. */
export const ATTENTION_STATES: readonly MissionState[] = [
  'AWAITING_SCOPE_APPROVAL',
  'AWAITING_REVIEW',
  'AWAITING_PR_APPROVAL',
  'BLOCKED',
  'FAILED',
];

/** States in which Orbit (not a human) is actively doing work. */
export const ACTIVE_STATES: readonly MissionState[] = ['ANALYZING', 'QUEUED', 'RUNNING', 'VERIFYING'];

export function canTransition(from: MissionState, to: MissionState): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: MissionState;
  readonly to: MissionState;
  constructor(from: MissionState, to: MissionState) {
    super(`Mission cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: MissionState, to: MissionState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(state: MissionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function needsAttention(state: MissionState): boolean {
  return ATTENTION_STATES.includes(state);
}

export type StateTone = 'neutral' | 'active' | 'attention' | 'success' | 'danger';

export const MISSION_STATE_META: Readonly<Record<MissionState, { label: string; description: string; tone: StateTone }>> = {
  DRAFT: { label: 'Draft', description: 'Created, waiting to be analyzed.', tone: 'neutral' },
  ANALYZING: { label: 'Analyzing', description: 'The planner is reading the task and choosing repositories.', tone: 'active' },
  AWAITING_SCOPE_APPROVAL: { label: 'Scope approval', description: 'Confirm the plan and repositories before any code changes.', tone: 'attention' },
  QUEUED: { label: 'Queued', description: 'Approved and waiting for a free agent slot.', tone: 'active' },
  RUNNING: { label: 'Implementing', description: 'The engineer is changing code in an isolated worktree.', tone: 'active' },
  VERIFYING: { label: 'Verifying', description: 'Running your checks and reviewing the diff.', tone: 'active' },
  AWAITING_REVIEW: { label: 'Ready for review', description: 'Changes are ready. Review the diff, checks and findings.', tone: 'attention' },
  AWAITING_PR_APPROVAL: { label: 'PR approval', description: 'Changes are committed locally. Approve publishing the pull request.', tone: 'attention' },
  PR_CREATED: { label: 'PR open', description: 'Pull request created. Orbit never merges for you.', tone: 'success' },
  COMPLETED: { label: 'Completed', description: 'Mission finished.', tone: 'success' },
  BLOCKED: { label: 'Blocked', description: 'Orbit needs your input to continue.', tone: 'danger' },
  FAILED: { label: 'Failed', description: 'Something went wrong. Retry or cancel.', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', description: 'Mission cancelled.', tone: 'neutral' },
};

/** Per-repository status of a mission work item. */
export const MISSION_REPO_STATUSES = [
  'proposed',
  'selected',
  'excluded',
  'in_progress',
  'ready_for_review',
  'changes_approved',
  'publishing',
  'pr_created',
  'local_only',
  'no_changes',
  'failed',
  'discarded',
] as const;

export type MissionRepoStatus = (typeof MISSION_REPO_STATUSES)[number];

export const ENTRY_POINTS = ['dashboard', 'asana-comment', 'cli', 'mcp', 'api', 'project-batch'] as const;
export type EntryPoint = (typeof ENTRY_POINTS)[number];
