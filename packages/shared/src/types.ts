import type { EntryPoint, MissionRepoStatus, MissionState } from './mission';

/** Who did something. Never contains credentials. */
export interface Actor {
  type: 'user' | 'system' | 'agent' | 'external';
  id?: string;
  name?: string;
  provider?: string;
  /** For external actors: whether Orbit verified them against the authorized-user list. */
  verified?: boolean;
}

/** Agents that take part in a mission. `security` reviews every change for security problems. */
export type AgentRole = 'planner' | 'engineer' | 'reviewer' | 'security';
/** A seat on the AI team: the three mission roles plus the Assistant that answers questions. */
export type TeamSeat = AgentRole | 'prompter' | 'assistant';
export const TEAM_SEATS: readonly TeamSeat[] = ['planner', 'engineer', 'reviewer', 'security', 'prompter', 'assistant'];
/** The AI behind a runtime. */
export type AiProvider = 'claude' | 'codex' | 'scripted';
export type RuntimeId = 'claude-agent-sdk' | 'claude-code-cli' | 'codex-cli' | 'scripted';
export type ExecutionMode = 'sandbox' | 'trusted-local';

/** A verification or setup command configured for a repository. Executed without a shell. */
export interface CommandSpec {
  id: string;
  label: string;
  command: string;
  timeoutSec: number;
  enabled: boolean;
  source: 'detected' | 'user';
}

export interface RepoSummary {
  name: string;
  description?: string;
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  topLevel: string[];
  keyFiles: string[];
  scripts: Record<string, string>;
  workspaces: string[];
  dependencies: string[];
  keywords: string[];
  instructionsExcerpt?: string;
  readmeExcerpt?: string;
  headSha?: string;
  generatedAt: string;
}

export interface RepoHealth {
  exists: boolean;
  isGitRepo: boolean;
  currentBranch?: string;
  headSha?: string;
  clean?: boolean;
  error?: string;
}

export interface RepoDTO {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  github: { owner: string; repo: string } | null;
  defaultBranch: string;
  allowModify: boolean;
  /** False for a plain folder: readable as a reference, never changed. */
  isGit: boolean;
  setupCommands: CommandSpec[];
  verifyCommands: CommandSpec[];
  summary: RepoSummary | null;
  summaryUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  projectIds: string[];
  health?: RepoHealth;
}

export interface RepoSelection {
  repoId: string;
  repoName: string;
  /** How this repository entered the mission scope. */
  source: 'mapping' | 'router' | 'planner' | 'user';
  reason: string;
  evidence: string[];
  likelyFiles: string[];
  changeSummary: string;
  risks: string[];
  /** Plain-language description of what is unknown. Never a made-up number. */
  uncertainty: string;
}

export interface MissionPlan {
  summary: string;
  steps: string[];
  acceptanceCriteria: string[];
  repositories: RepoSelection[];
  questions: string[];
  routingNotes: string[];
  ambiguous: boolean;
  generatedBy: 'planner' | 'heuristic';
  agentRunId?: string;
  /** Repositories the planner mentioned that are not authorized for this mission. They are never used. */
  droppedRepositories: { name: string; reason: string }[];
  /** Connected projects the task mentions that could be read for context. Only used once you approve them. */
  referenceSuggestions?: { repoId: string; repoName: string; reason: string }[];
}

export interface MissionReference {
  repoId: string;
  name: string;
  localPath: string;
}

export interface SnapshotComment {
  id: string;
  author?: string;
  text: string;
  createdAt: string;
}

export interface RequirementRevisionDTO {
  revision: number;
  title: string;
  body: string;
  comments: SnapshotComment[];
  extraInstructions: string | null;
  sourceUpdatedAt: string | null;
  contentHash: string;
  createdAt: string;
}

export interface DiffFileStat {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  fileList: DiffFileStat[];
}

export interface PullRequestInfo {
  number: number;
  url: string;
  state: string;
  title?: string;
}

export interface MissionRepoDTO {
  id: string;
  repoId: string;
  repoName: string;
  status: MissionRepoStatus;
  selection: RepoSelection | null;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  worktreePath: string | null;
  headSha: string | null;
  commitSha: string | null;
  diffStats: DiffStats | null;
  pr: PullRequestInfo | null;
  prDraft: { title: string; body: string; base: string } | null;
  lastError: string | null;
  remote: { hasGitHubRemote: boolean; owner?: string; repo?: string; visibility?: string };
}

export interface MissionSummaryDTO {
  id: string;
  title: string;
  status: MissionState;
  source: { provider: string; taskId: string | null; url: string | null; projectName: string | null };
  entryPoint: EntryPoint;
  triggeredBy: Actor | null;
  triggerVerified: boolean;
  repos: { id: string; repoId: string; name: string; status: MissionRepoStatus; prUrl: string | null; branch: string | null }[];
  costUsd: number;
  iteration: number;
  runtime: string | null;
  requirementsChanged: boolean;
  blockedReason: string | null;
  /** Why the mission is blocked, when Orbit knows the fix: see `BlockedCode`. */
  blockedCode: BlockedCode | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type BlockedCode = 'needs_consent' | 'sandbox_unavailable' | 'runtime_unavailable';

/** What the mission will need from this machine before it can build, shown before you approve. */
export interface MissionPreflight {
  /** Setup/verification commands will run, or agents run trusted-local, and consent is missing. */
  needsConsent: boolean;
  /** Sandbox mode is selected on a platform where Claude Code's sandbox is not available. */
  sandboxUnavailable: boolean;
  /** The commands Orbit will run in the mission worktree. */
  commands: string[];
}

export interface AgentRunDTO {
  id: string;
  missionId: string;
  missionRepoId: string | null;
  role: AgentRole;
  runtime: string;
  model: string | null;
  iteration: number;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  numTurns: number | null;
  summary: string | null;
  error: string | null;
}

export type VerificationStatus = 'passed' | 'failed' | 'error' | 'timeout' | 'skipped' | 'running';

export interface VerificationDTO {
  id: string;
  missionRepoId: string;
  iteration: number;
  kind: 'setup' | 'verify';
  label: string;
  command: string;
  status: VerificationStatus;
  exitCode: number | null;
  durationMs: number | null;
  outputTail: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  file?: string;
  line?: number | null;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface CriterionCheck {
  criterion: string;
  status: 'met' | 'not_met' | 'unclear';
  notes: string;
}

export interface ReviewDTO {
  id: string;
  /** `quality`: the reviewer (does it meet the task). `security`: the security reviewer. */
  kind: 'quality' | 'security';
  missionRepoId: string;
  iteration: number;
  verdict: 'approve' | 'request_changes';
  summary: string;
  findings: ReviewFinding[];
  criteria: CriterionCheck[];
  agentRunId: string | null;
  createdAt: string;
}

export interface ApprovalDTO {
  id: string;
  missionRepoId: string | null;
  kind: 'scope' | 'changes' | 'publish' | 'trigger';
  decision: 'approved' | 'rejected' | 'changes_requested';
  decidedBy: Actor;
  notes: string | null;
  createdAt: string;
}

export type MissionEventKind = 'state' | 'agent' | 'tool' | 'command' | 'approval' | 'external' | 'error' | 'note';
export type MissionEventActor = 'system' | 'planner' | 'engineer' | 'reviewer' | 'security' | 'user' | 'asana' | 'github' | 'git';

/** What kind of thing an agent step does, for icons and plain-language labels in the live view. */
export type AgentStepKind = 'read' | 'edit' | 'search' | 'run' | 'web' | 'plan' | 'delegate' | 'other';

export interface AgentPlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Structured `data` on mission events written while an agent runs. Every field
 * is optional because events recorded before this shape existed lack it.
 */
export interface AgentEventData {
  runId?: string;
  /** Which AI ran this step (`claude`, `codex` or `scripted`), on start events. */
  provider?: string;
  /** `start` and `end` mark the agent run's own boundary events. */
  phase?: 'start' | 'end';
  runtime?: string;
  model?: string | null;
  /** Tool call id from the runtime, linking a tool error back to its call. */
  toolUseId?: string | null;
  step?: AgentStepKind;
  /** File, command, pattern or URL the step acts on (already redacted). */
  target?: string | null;
  /** The agent's own to-do list, when the step updated it. */
  plan?: AgentPlanItem[];
  /** Set on the event that reports a failed tool call. */
  failed?: boolean;
  /** The runtime's own tool name (`Bash`, `Edit`, `Read`…), on tool events. */
  tool?: string;
  /** What the step produced. Edits know it when they start; other steps when they end. */
  output?: StepOutput;
  /** Set on the event that reports a step's successful result. */
  result?: boolean;
}

/**
 * What a step produced, shown under it in the terminal view (Claude Code's `⎿` lines).
 * Always short and redacted: the first lines of some output, or an edit's changed lines.
 */
export interface StepOutput {
  /** The first lines of the output, or a one-line result such as `Read 120 lines`. */
  text?: string;
  /** How many lines the full output (or diff) had, when only the start is kept. */
  lines?: number;
  /** An edit's lines, each starting with `+` (added), `-` (removed) or a space (unchanged). */
  diff?: string[];
  added?: number;
  removed?: number;
}

/** Structured `data` on verification command events. */
export interface CommandEventData {
  verificationId: string;
  phase: 'start' | 'end';
  label: string;
  command: string;
  status?: 'passed' | 'failed' | 'timeout' | 'error';
}

export interface MissionEventDTO {
  id: number;
  missionId: string;
  missionRepoId: string | null;
  ts: string;
  kind: MissionEventKind;
  actor: MissionEventActor;
  title: string;
  detail: string | null;
  data: unknown;
}

export interface SideEffectDTO {
  id: string;
  kind: string;
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'unknown';
  idempotencyKey: string;
  lastError: string | null;
  updatedAt: string;
}

export type MissionAction =
  | 'approve_scope'
  | 'replan'
  | 'request_changes'
  | 'approve_changes'
  | 'publish'
  | 'finish_local'
  | 'cancel'
  | 'retry'
  | 'complete';

export interface MissionDetailDTO extends MissionSummaryDTO {
  revision: RequirementRevisionDTO;
  revisionCount: number;
  plan: MissionPlan | null;
  missionRepos: MissionRepoDTO[];
  agentRuns: AgentRunDTO[];
  verifications: VerificationDTO[];
  reviews: ReviewDTO[];
  approvals: ApprovalDTO[];
  sideEffects: SideEffectDTO[];
  allowedActions: MissionAction[];
  preflight: MissionPreflight;
  /** Projects the agents may read, but never change, for this mission. */
  references: MissionReference[];
}

export interface IntegrationDTO {
  id: string;
  provider: string;
  displayName: string;
  account: { id: string | null; name: string | null; email: string | null };
  authType: 'pat' | 'oauth';
  status: 'connected' | 'error' | 'revoked';
  statusMessage: string | null;
  authorizedUsers: { externalUserId: string; displayName: string | null; email: string | null }[];
  createdAt: string;
}

export interface ExternalProjectDTO {
  id: string;
  integrationId: string;
  provider: string;
  externalId: string;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  url: string | null;
  triggersEnabled: boolean;
  repoIds: string[];
  lastPolledAt: string | null;
  lastEventAt: string | null;
  lastReconciledAt: string | null;
  pollError: string | null;
  createdAt: string;
}

export interface ExternalTaskDTO {
  provider: string;
  id: string;
  projectId: string | null;
  title: string;
  description: string;
  url: string | null;
  completed: boolean;
  assignee: string | null;
  updatedAt: string | null;
  mission: { id: string; status: MissionState } | null;
}

export interface WorkspaceDTO {
  id: string;
  name: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error' | 'info';
  detail: string;
  fix?: string;
}

export interface RuntimeStatusDTO {
  id: RuntimeId;
  displayName: string;
  kind: 'ai' | 'scripted';
  available: boolean;
  reason: string | null;
  sandbox: 'available' | 'unavailable' | 'unknown';
  details: Record<string, string>;
}

export interface DoctorReport {
  version: string;
  orbitHome: string;
  platform: string;
  checks: DoctorCheck[];
  runtimes: RuntimeStatusDTO[];
  ready: { localMissions: boolean; githubPullRequests: boolean; asana: boolean; ai: boolean };
}

export interface ActivityItem {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  summary: string;
}

export interface OverviewDTO {
  counts: { repos: number; projects: number; activeMissions: number; attention: number; completed7d: number; prsOpened: number };
  attention: MissionSummaryDTO[];
  active: MissionSummaryDTO[];
  recent: MissionSummaryDTO[];
  runningAgents: { runId: string; missionId: string; missionTitle: string; role: AgentRole; startedAt: string; lastEvent: string | null }[];
  suggestions: (ExternalTaskDTO & { projectName: string })[];
  setup: { hasRepos: boolean; hasAsana: boolean; runtimeReady: boolean; firstMissionDone: boolean; onboardingComplete: boolean };
}

/** Which AI a seat will use right now, and why. */
export interface SeatResolutionDTO {
  runtimeId: RuntimeId | null;
  provider: AiProvider | null;
  /** E.g. "Claude Code" or "Codex". */
  label: string;
  /** The model that will run, or null for the provider's default. */
  model: string | null;
  available: boolean;
  /** Plain-language reason for the choice, or why nothing is available. */
  why: string;
  /** What Orbit switches to if this one is not ready or hits its usage limit. */
  fallback: { runtimeId: RuntimeId; provider: AiProvider; label: string; model: string | null } | null;
}

export interface ProviderStatusDTO {
  provider: 'claude' | 'codex';
  runtimeId: RuntimeId;
  label: string;
  available: boolean;
  reason: string | null;
  details: Record<string, string>;
  /** Models this provider offers, for the model picker. */
  models: { id: string; label: string }[];
}

export interface TeamDTO {
  providers: ProviderStatusDTO[];
  fallback: boolean;
  worktrees: {
    root: string;
    custom: boolean;
    /** Windows only: Codex's sandbox cannot run Node in worktrees inside the user folder. */
    codexBlocked: boolean;
    suggestedRoot: string | null;
  };
}

export interface AgentRoleDTO {
  role: TeamSeat;
  title: string;
  description: string;
  /** Claude model for this seat. */
  model: string;
  /** Codex model for this seat (null: Codex's default). */
  codexModel: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  runtime: RuntimeId | 'auto';
  provider: 'auto' | 'claude' | 'codex';
  resolved: SeatResolutionDTO;
  stats: { runs: number; succeeded: number; failed: number; avgDurationMs: number | null; totalCostUsd: number };
  recentRuns: (AgentRunDTO & { missionTitle: string })[];
}

export interface ReceiptDTO {
  missionId: string;
  markdown: string;
  share: { markdown: string; svg: string };
}

/** Events pushed to the dashboard over Server-Sent Events. */
// ---------------------------------------------------------------------------
// Ask: conversations with the Assistant about your projects
// ---------------------------------------------------------------------------

/** A change the Assistant proposes; the dashboard can start it as a mission in one click. */
export interface MissionSuggestion {
  title: string;
  description: string;
  /** Repository ids, resolved from the names the Assistant used. */
  repoIds: string[];
}

/**
 * `steered`: you sent it while the agent was working and it was delivered right away; the
 * agent took it in at its next step (like typing into Claude Code while it works).
 * `queued`: the agent could not take it mid-answer, so it goes out when the answer ends.
 */
export type ChatMessageStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'queued' | 'steered';

export interface ChatMessageDTO {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  status: ChatMessageStatus;
  runtime: string | null;
  model: string | null;
  error: string | null;
  suggestion: MissionSuggestion | null;
  /** Commands the agent wanted to run but that need your approval first. */
  blocked: BlockedCommand[];
  /** Images you attached to this message (pasted or dropped), shown as `[Image #1]` in its text. */
  attachments: ChatAttachmentDTO[];
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/** A Claude Code plugin (skills, agents, commands, hooks or MCP servers) from a marketplace. */
export interface PluginDTO {
  /** `name@marketplace`. */
  id: string;
  name: string;
  marketplace: string;
  marketplaceLabel: string;
  description: string | null;
  version: string | null;
  installs: number | null;
  sourceUrl: string | null;
  /** Installs by running a command the marketplace declares: do that in Claude Code itself. */
  needsCommand: boolean;
  installed: boolean;
  enabled: boolean | null;
}

/** A skill folder of your own in Claude Code's skills folder. */
export interface UserSkillDTO {
  name: string;
  description: string | null;
  path: string;
}

export interface SkillsDTO {
  /** False when Claude Code is missing or could not list its plugins (`reason` says why). */
  available: boolean;
  reason: string | null;
  installed: PluginDTO[];
  skills: UserSkillDTO[];
  /** Search results, popular first. */
  results: PluginDTO[];
  /** How many plugins match, beyond the ones shown. */
  total: number;
  marketplaces: { name: string; label: string; count: number }[];
  updatedAt: string | null;
}

/** What an installed plugin contains and costs, as Claude Code reports it. */
export interface PluginDetailsDTO {
  id: string;
  text: string;
  skills: string[];
  agents: number;
  /** Hooks run commands on their own; MCP servers are programs. Both deserve trust. */
  hooks: number;
  mcpServers: number;
  alwaysOn: string | null;
}

export interface PluginActionDTO {
  ok: boolean;
  message: string;
}

/** An image attached to a message. `url` serves it to the signed-in dashboard. */
export interface ChatAttachmentDTO {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  url: string;
}

export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ChatImageType = (typeof CHAT_IMAGE_TYPES)[number];
/** Claude takes images up to 5 MB each; a message carries a handful, like a pasted screenshot or two. */
export const CHAT_IMAGE_LIMITS = { maxImages: 6, maxBytes: 5 * 1024 * 1024 } as const;
/** Long pastes (logs, files) are welcome: Claude Code takes them too. */
export const MAX_CHAT_MESSAGE = 200_000;

/** An image sent with a message: base64 data without the `data:` prefix. */
export interface ChatImageInput {
  name: string;
  mediaType: ChatImageType;
  data: string;
}

export interface BlockedCommand {
  tool: string;
  command: string;
  /** False when the command cannot be expressed as a permission rule (run it yourself instead). */
  allowable: boolean;
}

/**
 * `edit`: a working session in one project, like Claude Code in a terminal. The agent
 * changes the project's files directly; commands need your approval once.
 * `ask`: read-only questions, possibly across several projects.
 */
export type SessionMode = 'edit' | 'ask';
export type SessionPermissionMode = 'ask' | 'auto';

/** What the Assistant did while answering: same shape as mission events, so the live view can render it. */
export interface ChatEventDTO {
  id: number;
  conversationId: string;
  messageId: string;
  ts: string;
  kind: MissionEventKind;
  actor: TeamSeat | 'system';
  title: string;
  detail: string | null;
  data: unknown;
}

export interface ConversationSummaryDTO {
  id: string;
  title: string;
  /** Empty means every connected project. A working session has exactly one. */
  repoIds: string[];
  mode: SessionMode;
  /** The agent in this session: the session agent, or the security reviewer for a security check. */
  seat: 'assistant' | 'security';
  /** Which AI this session asks for; `auto` follows the AI team settings. */
  provider: 'auto' | 'claude' | 'codex';
  /** The runtime that holds the live agent session (resumed on the next message). */
  agentRuntime: string | null;
  /** Commands you allowed in this session. */
  allowedCommands: string[];
  /**
   * How commands are handled, like Shift+Tab in Claude Code. `ask`: the agent asks before
   * running anything new. `auto`: it runs commands on its own, and a safety check blocks
   * risky ones (Claude Code's auto mode). Orbit's hard limits apply in both.
   */
  permissionMode: SessionPermissionMode;
  /** The model picked for this session (Claude ids start with `claude-`); null = the agent's default. */
  model: string | null;
  /** The reasoning effort picked for this session; null = the session agent's effort. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  lastMessage: string | null;
  running: boolean;
  /** How the agent's last turn ended (null before the first answer). */
  lastStatus: ChatMessageStatus | null;
  /** The agent is waiting for your OK on a command. */
  needsYou: boolean;
  /** The agent is working and takes new messages right away (otherwise they are queued). */
  steerable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetailDTO extends ConversationSummaryDTO {
  messages: ChatMessageDTO[];
  events: ChatEventDTO[];
  /** The agent is waiting for your answer before it runs something (Codex, outside its sandbox). */
  approval: SessionApprovalDTO | null;
  /** Your likely next message, suggested after the last answer (Tab puts it in the prompt). */
  nextPrompt: string | null;
}

/** Codex asking, mid-answer, to run something its sandbox blocks (a push, a commit, a download). */
export interface SessionApprovalDTO {
  id: string;
  kind: 'command' | 'file';
  /** The command, already redacted; null for a file change. */
  command: string | null;
  reason: string | null;
  /** True when it asks for network access. */
  network: boolean;
  createdAt: string;
}

/** The Prompt engineer's rewrite of a rough task into a clear, complete one. */
export interface TaskImprovementDTO {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /** What the developer should decide before work starts. */
  openQuestions: string[];
  /** One or two sentences on what was improved. */
  whatChanged: string;
  /** The task as written in the tracker, for a before/after view. */
  original: { title: string; description: string } | null;
  runtime: string | null;
  model: string | null;
}

/** Uncommitted changes in a project, for the workspace's Changes panel. */
export interface RepoChangesDTO {
  repoId: string;
  isGit: boolean;
  branch: string | null;
  files: { path: string; code: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' }[];
  /** Unified diff of every change, including new files. */
  diff: string;
  truncated: boolean;
}

export type ServerEvent =
  | { type: 'chat.updated'; conversationId: string }
  | { type: 'repo.changed'; repoId: string }
  | { type: 'chat.event'; conversationId: string; event: ChatEventDTO }
  | { type: 'mission.updated'; missionId: string; status: MissionState }
  | { type: 'mission.event'; missionId: string; event: MissionEventDTO }
  | { type: 'agent.output'; missionId: string; runId: string; role: AgentRole; text: string }
  | { type: 'repos.updated' }
  | { type: 'integrations.updated' }
  | { type: 'settings.updated' }
  | { type: 'trigger.received'; provider: string; taskId: string; status: string; reason: string | null }
  | { type: 'heartbeat'; ts: string };
