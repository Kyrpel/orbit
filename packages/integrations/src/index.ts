/**
 * Provider-neutral model for project-management tools. Orbit's core only
 * talks to `TaskProvider`; Asana, GitHub Issues, Linear and Jira are adapters.
 */
import type { OrbitCommandName } from '@orbit/shared';

export type ProviderId = 'asana' | 'github-issues' | 'linear' | 'jira';

export interface ExternalUser {
  id: string;
  name: string | null;
  email: string | null;
}

export interface ExternalWorkspace {
  id: string;
  name: string;
}

export interface ExternalProject {
  id: string;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  url: string | null;
  archived: boolean;
}

export interface ExternalComment {
  id: string;
  text: string;
  author: ExternalUser | null;
  createdAt: string;
  /** System stories (e.g. "moved this task") as opposed to human comments. */
  isSystem: boolean;
}

export interface ExternalTask {
  provider: ProviderId;
  id: string;
  projectIds: string[];
  title: string;
  description: string;
  url: string | null;
  completed: boolean;
  assignee: ExternalUser | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A `/orbit ...` command found in a task comment. */
export interface TriggerCandidate {
  provider: ProviderId;
  /** Stable across duplicate deliveries (e.g. `asana:story:<gid>`). */
  dedupeKey: string;
  taskId: string;
  projectExternalId: string;
  commentId: string;
  author: ExternalUser | null;
  command: OrbitCommandName;
  extraInstructions: string | null;
  createdAt: string;
  /** How Orbit found it: a live event or a reconciliation scan. */
  via: 'event' | 'reconcile';
}

export interface TaskChange {
  taskId: string;
  kind: 'changed' | 'deleted';
}

export interface ProjectSyncState {
  syncToken: string | null;
  lastPolledAt: string | null;
  lastEventAt: string | null;
  lastReconciledAt: string | null;
}

export interface PollResult {
  triggers: TriggerCandidate[];
  taskChanges: TaskChange[];
  state: ProjectSyncState;
  /** True when a full sync was needed (first poll, or the sync token expired). */
  resynced: boolean;
  /** True when a reconciliation scan ran during this poll. */
  reconciled: boolean;
  warnings: string[];
}

export interface PollOptions {
  /** Run a reconciliation scan even if the sync token is still valid. */
  reconcile?: boolean;
  reconcileTaskLimit?: number;
  /** Comment ids Orbit itself posted; never treated as triggers. */
  ignoreCommentIds?: ReadonlySet<string>;
}

export interface TaskProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  verify(): Promise<ExternalUser>;
  listWorkspaces(): Promise<ExternalWorkspace[]>;
  listProjects(workspaceId: string): Promise<ExternalProject[]>;
  getProject(projectId: string): Promise<ExternalProject>;
  listTasks(projectId: string, opts?: { includeCompleted?: boolean; limit?: number }): Promise<ExternalTask[]>;
  getTask(taskId: string): Promise<ExternalTask>;
  listComments(taskId: string, opts?: { limit?: number }): Promise<ExternalComment[]>;
  postComment(taskId: string, text: string): Promise<ExternalComment>;
  /** Used to check whether an uncertain comment post already succeeded. */
  findCommentContaining(taskId: string, marker: string): Promise<ExternalComment | null>;
  /** Rewrites a task's title and/or description (the Prompt engineer, after your approval). */
  updateTask?(taskId: string, patch: { title?: string; description?: string }): Promise<ExternalTask>;
  pollTriggers(projectId: string, state: ProjectSyncState, opts?: PollOptions): Promise<PollResult>;
}

/** Errors every provider maps its failures onto. */
export type ProviderErrorKind = 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'payment_required' | 'invalid' | 'unavailable' | 'network';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly retryAfterSec: number | null;
  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number | null; retryAfterSec?: number | null; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
  }
}

export function emptySyncState(): ProjectSyncState {
  return { syncToken: null, lastPolledAt: null, lastEventAt: null, lastReconciledAt: null };
}
