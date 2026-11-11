import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  Actor,
  CommandSpec,
  CriterionCheck,
  DiffStats,
  MissionPlan,
  MissionRepoStatus,
  MissionState,
  RepoSelection,
  RepoSummary,
  BlockedCommand,
  MissionSuggestion,
  ReviewFinding,
  SnapshotComment,
} from '@orbit/shared';

const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: updatedAt(),
});

export const repos = sqliteTable('repos', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  localPath: text('local_path').notNull().unique(),
  remoteUrl: text('remote_url'),
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  defaultBranch: text('default_branch').notNull(),
  allowModify: integer('allow_modify', { mode: 'boolean' }).notNull().default(true),
  /** False for plain folders: they can be read as references but never changed. */
  isGit: integer('is_git', { mode: 'boolean' }).notNull().default(true),
  setupCommands: text('setup_commands', { mode: 'json' }).$type<CommandSpec[]>().notNull().default(sql`'[]'`),
  verifyCommands: text('verify_commands', { mode: 'json' }).$type<CommandSpec[]>().notNull().default(sql`'[]'`),
  summary: text('summary', { mode: 'json' }).$type<RepoSummary>(),
  summaryHeadSha: text('summary_head_sha'),
  summaryUpdatedAt: text('summary_updated_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  displayName: text('display_name').notNull(),
  accountUserId: text('account_user_id'),
  accountName: text('account_name'),
  accountEmail: text('account_email'),
  authType: text('auth_type').$type<'pat' | 'oauth'>().notNull(),
  secretRef: text('secret_ref').notNull(),
  status: text('status').$type<'connected' | 'error' | 'revoked'>().notNull(),
  statusMessage: text('status_message'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authorizedUsers = sqliteTable(
  'authorized_users',
  {
    id: text('id').primaryKey(),
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    externalUserId: text('external_user_id').notNull(),
    displayName: text('display_name'),
    email: text('email'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('authorized_users_unique').on(t.integrationId, t.externalUserId)],
);

export const externalProjects = sqliteTable(
  'external_projects',
  {
    id: text('id').primaryKey(),
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    workspaceId: text('workspace_id'),
    workspaceName: text('workspace_name'),
    name: text('name').notNull(),
    url: text('url'),
    triggersEnabled: integer('triggers_enabled', { mode: 'boolean' }).notNull().default(true),
    syncToken: text('sync_token'),
    lastPolledAt: text('last_polled_at'),
    lastEventAt: text('last_event_at'),
    lastReconciledAt: text('last_reconciled_at'),
    pollError: text('poll_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('external_projects_unique').on(t.integrationId, t.externalId)],
);

export const projectRepos = sqliteTable(
  'project_repos',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => externalProjects.id, { onDelete: 'cascade' }),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.repoId] })],
);

export const missions = sqliteTable(
  'missions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: text('status').$type<MissionState>().notNull(),
    sourceProvider: text('source_provider').notNull(),
    sourceTaskId: text('source_task_id'),
    sourceProjectId: text('source_project_id'),
    sourceUrl: text('source_url'),
    integrationId: text('integration_id'),
    entryPoint: text('entry_point').notNull(),
    triggeredBy: text('triggered_by', { mode: 'json' }).$type<Actor>(),
    triggerVerified: integer('trigger_verified', { mode: 'boolean' }).notNull().default(false),
    currentRevision: integer('current_revision').notNull().default(1),
    requirementsChangedAt: text('requirements_changed_at'),
    plan: text('plan', { mode: 'json' }).$type<MissionPlan>(),
    blockedReason: text('blocked_reason'),
    /** Machine-readable cause, so the dashboard can offer the exact fix (e.g. `needs_consent`). */
    blockedCode: text('blocked_code'),
    lastError: text('last_error'),
    iteration: integer('iteration').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    runtime: text('runtime'),
    /** Set while the mission is not terminal; a partial unique index prevents duplicate active missions per task. */
    activeKey: text('active_key'),
    requestedRepoIds: text('requested_repo_ids', { mode: 'json' }).$type<string[]>(),
    /** Connected projects the agents may read (never change) for this mission. */
    referenceRepoIds: text('reference_repo_ids', { mode: 'json' }).$type<string[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (t) => [index('missions_status').on(t.status), index('missions_source').on(t.sourceProvider, t.sourceTaskId)],
);

export const missionRevisions = sqliteTable(
  'mission_revisions',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    comments: text('comments', { mode: 'json' }).$type<SnapshotComment[]>().notNull(),
    extraInstructions: text('extra_instructions'),
    sourceUpdatedAt: text('source_updated_at'),
    contentHash: text('content_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mission_revisions_unique').on(t.missionId, t.revision)],
);

export const missionRepos = sqliteTable(
  'mission_repos',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    status: text('status').$type<MissionRepoStatus>().notNull(),
    selection: text('selection', { mode: 'json' }).$type<RepoSelection>(),
    branch: text('branch'),
    baseBranch: text('base_branch'),
    baseSha: text('base_sha'),
    worktreePath: text('worktree_path'),
    headSha: text('head_sha'),
    commitSha: text('commit_sha'),
    diffStats: text('diff_stats', { mode: 'json' }).$type<DiffStats>(),
    engineerSummary: text('engineer_summary'),
    /** Paths created by setup commands (e.g. a lockfile from an install). Never staged. */
    setupArtifacts: text('setup_artifacts', { mode: 'json' }).$type<string[]>(),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    prTitle: text('pr_title'),
    prBody: text('pr_body'),
    prBase: text('pr_base'),
    prState: text('pr_state'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('mission_repos_unique').on(t.missionId, t.repoId)],
);

export const missionEvents = sqliteTable(
  'mission_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    missionRepoId: text('mission_repo_id'),
    ts: text('ts').notNull(),
    kind: text('kind').notNull(),
    actor: text('actor').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    data: text('data', { mode: 'json' }),
  },
  (t) => [index('mission_events_mission').on(t.missionId, t.id)],
);

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    missionRepoId: text('mission_repo_id'),
    role: text('role').$type<'planner' | 'engineer' | 'reviewer' | 'security'>().notNull(),
    runtime: text('runtime').notNull(),
    model: text('model'),
    iteration: integer('iteration').notNull().default(0),
    status: text('status').$type<'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'>().notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
    costUsd: real('cost_usd'),
    usage: text('usage', { mode: 'json' }),
    numTurns: integer('num_turns'),
    sessionId: text('session_id'),
    summary: text('summary'),
    error: text('error'),
  },
  (t) => [index('agent_runs_mission').on(t.missionId)],
);

export const verifications = sqliteTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    missionRepoId: text('mission_repo_id').notNull(),
    iteration: integer('iteration').notNull(),
    kind: text('kind').$type<'setup' | 'verify'>().notNull(),
    label: text('label').notNull(),
    command: text('command').notNull(),
    status: text('status').$type<'passed' | 'failed' | 'error' | 'timeout' | 'skipped' | 'running'>().notNull(),
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms'),
    outputTail: text('output_tail').notNull().default(''),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('verifications_mission').on(t.missionId)],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    missionRepoId: text('mission_repo_id').notNull(),
    iteration: integer('iteration').notNull(),
    kind: text('kind').$type<'quality' | 'security'>().notNull().default('quality'),
    verdict: text('verdict').$type<'approve' | 'request_changes'>().notNull(),
    summary: text('summary').notNull(),
    findings: text('findings', { mode: 'json' }).$type<ReviewFinding[]>().notNull(),
    criteria: text('criteria', { mode: 'json' }).$type<CriterionCheck[]>().notNull(),
    agentRunId: text('agent_run_id'),
    createdAt: createdAt(),
  },
  (t) => [index('reviews_mission').on(t.missionId)],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    missionRepoId: text('mission_repo_id'),
    kind: text('kind').$type<'scope' | 'changes' | 'publish' | 'trigger'>().notNull(),
    decision: text('decision').$type<'approved' | 'rejected' | 'changes_requested'>().notNull(),
    decidedBy: text('decided_by', { mode: 'json' }).$type<Actor>().notNull(),
    notes: text('notes'),
    data: text('data', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (t) => [index('approvals_mission').on(t.missionId)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    missionId: text('mission_id'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>().notNull(),
    priority: integer('priority').notNull().default(0),
    runAt: text('run_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: text('lease_expires_at'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('jobs_claim').on(t.status, t.runAt, t.priority)],
);

export const triggers = sqliteTable('triggers', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  integrationId: text('integration_id'),
  projectId: text('project_id'),
  dedupeKey: text('dedupe_key').notNull().unique(),
  externalTaskId: text('external_task_id').notNull(),
  externalUserId: text('external_user_id'),
  externalUserName: text('external_user_name'),
  command: text('command').notNull(),
  verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
  status: text('status').$type<'accepted' | 'rejected' | 'duplicate' | 'needs_approval' | 'error' | 'ignored'>().notNull(),
  reason: text('reason'),
  missionId: text('mission_id'),
  createdAt: createdAt(),
});

export const sideEffects = sqliteTable('side_effects', {
  id: text('id').primaryKey(),
  missionId: text('mission_id'),
  missionRepoId: text('mission_repo_id'),
  kind: text('kind').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: text('status').$type<'pending' | 'in_flight' | 'succeeded' | 'failed' | 'unknown'>().notNull(),
  request: text('request', { mode: 'json' }),
  result: text('result', { mode: 'json' }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: text('ts').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    summary: text('summary').notNull(),
    details: text('details', { mode: 'json' }),
  },
  (t) => [index('audit_log_ts').on(t.ts)],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    /** Empty means every connected project. */
    repoIds: text('repo_ids', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    mode: text('mode').$type<'edit' | 'ask'>().notNull().default('ask'),
    provider: text('provider').$type<'auto' | 'claude' | 'codex' | 'openrouter' | 'huggingface'>().notNull().default('auto'),
    agentSessionId: text('agent_session_id'),
    agentRuntime: text('agent_runtime'),
    allowedCommands: text('allowed_commands', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    /** Which agent seat runs this session: the session agent, or the security reviewer for security checks. */
    seat: text('seat').$type<'assistant' | 'security'>().notNull().default('assistant'),
    /** `ask`: commands need approval. `auto`: Claude Code's auto mode decides. */
    permissionMode: text('permission_mode').$type<'ask' | 'auto' | 'plan'>().notNull().default('ask'),
    /** The message holding the agent's /compact summary: everything before it is out of the agent's context. */
    compactFrom: text('compact_from'),
    /** This session's own model (overrides the session agent's model for that AI); null = default. */
    model: text('model'),
    /** This session's own reasoning effort; null = the session agent's effort. */
    effort: text('effort').$type<'low' | 'medium' | 'high' | 'xhigh' | 'max'>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('conversations_updated').on(t.updatedAt)],
);

export const conversationMessages = sqliteTable(
  'conversation_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    status: text('status').$type<'running' | 'done' | 'failed' | 'cancelled' | 'queued' | 'steered'>().notNull(),
    runtime: text('runtime'),
    model: text('model'),
    error: text('error'),
    suggestion: text('suggestion', { mode: 'json' }).$type<MissionSuggestion | null>(),
    blocked: text('blocked', { mode: 'json' }).$type<BlockedCommand[] | null>(),
    /** Images attached to a user message; the files live in ORBIT_HOME/uploads/<conversation>/. */
    attachments: text('attachments', { mode: 'json' }).$type<StoredAttachment[] | null>(),
    /** What the answer used (tokens, cost, context size), for /cost and /context. */
    usage: text('usage', { mode: 'json' }).$type<MessageUsage | null>(),
    /** Whether this answer was actually generated in plan mode. */
    kind: text('kind').$type<'chat' | 'plan'>().notNull().default('chat'),
    /** A saved copy of the project's files from just before this message was handled (/rewind). */
    checkpoint: text('checkpoint'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('conversation_messages_conv').on(t.conversationId, t.createdAt)],
);

export const conversationEvents = sqliteTable(
  'conversation_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    ts: text('ts').notNull(),
    kind: text('kind').notNull(),
    actor: text('actor').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    data: text('data', { mode: 'json' }),
  },
  (t) => [index('conversation_events_conv').on(t.conversationId, t.id)],
);

/** What an answer used, as stored with its message. */
export interface MessageUsage {
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number | null;
  contextWindow: number | null;
}

/** An attached image as stored: `file` is its name inside the conversation's upload folder. */
export interface StoredAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  file: string;
}

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type RepoRow = typeof repos.$inferSelect;
export type IntegrationRow = typeof integrations.$inferSelect;
export type ExternalProjectRow = typeof externalProjects.$inferSelect;
export type MissionRow = typeof missions.$inferSelect;
export type MissionRevisionRow = typeof missionRevisions.$inferSelect;
export type MissionRepoRow = typeof missionRepos.$inferSelect;
export type MissionEventRow = typeof missionEvents.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type VerificationRow = typeof verifications.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type TriggerRow = typeof triggers.$inferSelect;
export type SideEffectRow = typeof sideEffects.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
