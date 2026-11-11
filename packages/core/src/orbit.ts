import path from 'node:path';
import { ClaudeAgentSdkRuntime, ClaudeCodeCliRuntime, CodexCliRuntime, CursorCliRuntime, ScriptedRuntime, type AgentRuntime } from '@orbit/agents';
import { and, eq, inArray, isNotNull, agentRuns, conversations, missionRepos, missions, openDatabase, verifications, type DatabaseHandle } from '@orbit/database';
import { defaultRunner, Git, GhCliClient, type CommandRunner, type GitHubClient } from '@orbit/git';
import { AsanaProvider } from '@orbit/integrations-asana';
import { DEFAULT_PORT, OrbitError, type PastSessionsDTO, type RuntimeId, type TeamDTO } from '@orbit/shared';
import { consoleLogger, EventBus, type Logger } from './bus';
import { ChatService } from './chat';
import { PromptEngineer } from './prompter';
import { SkillsService } from './skills';
import { nowIso, recordMissionEvent, SettingsService, type OrbitContext, type ProviderFactory } from './context';
import { runDoctor } from './doctor';
import { IntegrationService } from './integrations';
import { MissionService } from './missions';
import { Notifier } from './notifier';
import { Outbox } from './outbox';
import { OverviewService } from './overview';
import { ensureOrbitHome, orbitPaths, resolveOrbitHome } from './paths';
import { CursorService } from './cursor';
import { HuggingFaceService } from './huggingface';
import { OpenRouterService } from './openrouter';
import { PastSessions, pastSessionsDirs } from './past-sessions';
import { Pipeline } from './pipeline';
import { JobQueue, Worker } from './queue';
import { buildReceipt } from './receipts';
import { RepoService } from './repos';
import { FileSecretStore, type SecretStore } from './secrets';
import { teamStatus, worktreeRoot } from './team';
import { commitRepoChanges, repoChanges, repoFiles } from './workspace';
import { TriggerService } from './triggers';

export interface CreateOrbitOptions {
  /** Defaults to ORBIT_HOME or ~/.orbit. */
  home?: string;
  /** Defaults to <home>/orbit.db. Use ':memory:' in tests. */
  dbFile?: string;
  env?: NodeJS.ProcessEnv;
  runtimes?: AgentRuntime[];
  github?: GitHubClient;
  git?: Git;
  runner?: CommandRunner;
  secrets?: SecretStore;
  providerFactory?: ProviderFactory;
  now?: () => Date;
  logger?: Logger;
  dashboardUrl?: string | (() => string);
  workerPollMs?: number;
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export const defaultProviderFactory: ProviderFactory = (row, token, settings) => {
  if (row.provider !== 'asana') throw new Error(`Unsupported provider ${row.provider}`);
  return new AsanaProvider({ token, requestsPerMinute: settings.asana.requestsPerMinute });
};

/** The Orbit engine: one instance per process, shared by the API server, CLI and MCP bridge. */
export class Orbit {
  readonly ctx: OrbitContext;
  readonly queue: JobQueue;
  readonly outbox: Outbox;
  readonly integrations: IntegrationService;
  readonly repos: RepoService;
  readonly notifier: Notifier;
  readonly missions: MissionService;
  readonly pipeline: Pipeline;
  readonly triggers: TriggerService;
  readonly overview: OverviewService;
  readonly chat: ChatService;
  readonly prompter: PromptEngineer;
  readonly skills: SkillsService;
  /** Your Claude Code and Codex sessions from outside Orbit, for session agents to draw on. */
  readonly past: PastSessions;
  /** Other models (DeepSeek, Hermes…) through OpenRouter, inside Claude Code sessions. */
  readonly openrouter: OpenRouterService;
  /** Your own models on rented GPUs (Hugging Face Inference Endpoints). */
  readonly huggingface: HuggingFaceService;
  /** Your Cursor subscription, through the Cursor CLI. */
  readonly cursor: CursorService;
  readonly worker: Worker;
  private readonly handle: DatabaseHandle;
  private running = false;

  constructor(opts: CreateOrbitOptions = {}) {
    const env = opts.env ?? process.env;
    const home = opts.home ?? resolveOrbitHome(env);
    const paths = orbitPaths(home);
    ensureOrbitHome(paths);
    this.handle = openDatabase(opts.dbFile ?? paths.db);
    const now = opts.now ?? (() => new Date());
    const bus = new EventBus();
    const runner = opts.runner ?? defaultRunner;
    const runtimes = new Map<RuntimeId, AgentRuntime>();
    for (const rt of opts.runtimes ?? [
      new ClaudeAgentSdkRuntime(env),
      new ClaudeCodeCliRuntime(env.ORBIT_CLAUDE_BIN || 'claude', env),
      new CodexCliRuntime(env.ORBIT_CODEX_BIN || 'codex', env),
      new CursorCliRuntime(env.ORBIT_CURSOR_BIN || null, env),
      new ScriptedRuntime(),
    ]) {
      runtimes.set(rt.id, rt);
    }
    const dashboard = opts.dashboardUrl ?? `http://127.0.0.1:${env.ORBIT_PORT || DEFAULT_PORT}`;
    this.ctx = {
      db: this.handle.db,
      sqlite: this.handle.sqlite,
      paths,
      bus,
      log: opts.logger ?? consoleLogger((env.ORBIT_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info'),
      git: opts.git ?? new Git(runner),
      github: opts.github ?? new GhCliClient(runner),
      runner,
      secrets: opts.secrets ?? new FileSecretStore(paths.secrets),
      settings: new SettingsService(this.handle.db, bus, now),
      runtimes,
      providerFactory: opts.providerFactory ?? defaultProviderFactory,
      now,
      dashboardUrl: typeof dashboard === 'function' ? dashboard : () => dashboard,
      env,
      platform: opts.platform ?? process.platform,
    };

    this.queue = new JobQueue(this.ctx.db, now);
    this.outbox = new Outbox(this.ctx);
    this.integrations = new IntegrationService(this.ctx);
    this.repos = new RepoService(this.ctx);
    this.notifier = new Notifier(this.ctx, this.queue, this.integrations, this.outbox);
    this.missions = new MissionService(this.ctx, this.queue, this.notifier, this.integrations, this.repos, this.outbox, {
      abortMission: (id) => this.worker.abortMission(id),
      isMissionRunning: (id) => this.worker.isMissionRunning(id),
      wake: () => this.worker.wake(),
    });
    this.pipeline = new Pipeline(this.ctx, this.missions, this.repos, this.notifier, this.outbox, this.queue);
    this.triggers = new TriggerService(this.ctx, this.integrations, this.missions, this.notifier, this.outbox);
    this.overview = new OverviewService(this.ctx, this.missions, this.integrations);
    this.past = new PastSessions(
      pastSessionsDirs(env),
      paths.pastSessions,
      () => this.ownSessionIds(),
      () => [worktreeRoot(this.ctx), paths.worktrees, paths.home],
    );
    this.openrouter = new OpenRouterService(this.ctx);
    this.huggingface = new HuggingFaceService(this.ctx);
    this.cursor = new CursorService(this.ctx, (this.ctx.runtimes.get('cursor-cli') as CursorCliRuntime | undefined) ?? null);
    this.chat = new ChatService(this.ctx, this.repos, this.past, [this.openrouter, this.huggingface, this.cursor]);
    this.prompter = new PromptEngineer(this.ctx, this.integrations, this.repos, [this.openrouter, this.huggingface, this.cursor]);
    this.skills = new SkillsService(this.ctx);
    this.worker = new Worker(
      this.queue,
      {
        'mission.analyze': this.pipeline.analyze,
        'mission.execute': this.pipeline.execute,
        'mission.publish': (job) => this.pipeline.publish(job),
        'mission.notify': (job) => this.notifier.handle(job),
      },
      [
        { name: 'agent', types: ['mission.analyze', 'mission.execute'], concurrency: () => this.ctx.settings.get().execution.maxConcurrentMissions },
        { name: 'io', types: ['mission.publish', 'mission.notify'], concurrency: () => 2 },
      ],
      this.ctx.log,
      { pollMs: opts.workerPollMs ?? 1000 },
    );
  }

  /**
   * Restart recovery. Jobs that were running when the process died go back to
   * the queue; outward operations that were in flight are marked "unknown" so
   * the outbox checks GitHub/Asana before repeating them.
   */
  recover(): { requeuedJobs: number; unknownSideEffects: number; repairedMissions: number; interruptedAnswers: number } {
    const db = this.ctx.db;
    const ts = nowIso(this.ctx);
    const orphaned = this.queue.requeueOrphaned();
    for (const job of orphaned) {
      if (job.missionId) recordMissionEvent(this.ctx, job.missionId, { kind: 'note', actor: 'system', title: `Resuming ${job.type.replace('mission.', '')} after Orbit restarted` });
    }
    const unknownSideEffects = this.outbox.markInFlightUnknown();
    db.update(agentRuns).set({ status: 'failed', error: 'Interrupted by an Orbit restart', finishedAt: ts }).where(eq(agentRuns.status, 'running')).run();
    db.update(verifications).set({ status: 'error', outputTail: 'Interrupted by an Orbit restart', finishedAt: ts }).where(eq(verifications.status, 'running')).run();

    let repaired = 0;
    const needsJob = db.select().from(missions).where(inArray(missions.status, ['DRAFT', 'ANALYZING', 'QUEUED', 'RUNNING', 'VERIFYING'])).all();
    for (const m of needsJob) {
      const active = this.queue.activeForMission(m.id);
      const type = m.status === 'DRAFT' || m.status === 'ANALYZING' ? 'mission.analyze' : 'mission.execute';
      if (!active.some((j) => j.type === type)) {
        this.queue.enqueue({ type, missionId: m.id, dedupeKey: `${type === 'mission.analyze' ? 'analyze' : 'execute'}:${m.id}` });
        repaired++;
      }
    }
    const publishing = db.select().from(missionRepos).where(eq(missionRepos.status, 'publishing')).all();
    for (const mr of publishing) {
      const active = this.queue.activeForMission(mr.missionId).some((j) => j.type === 'mission.publish');
      const m = db.select().from(missions).where(and(eq(missions.id, mr.missionId), eq(missions.status, 'AWAITING_PR_APPROVAL'))).get();
      if (!active && m) {
        this.queue.enqueue({ type: 'mission.publish', missionId: mr.missionId, payload: { missionRepoId: mr.id }, dedupeKey: `publish:${mr.id}` });
        repaired++;
      }
    }
    const interruptedAnswers = this.chat.recover();
    return { requeuedJobs: orphaned.length, unknownSideEffects, repairedMissions: repaired, interruptedAnswers };
  }

  start(opts: { triggers?: boolean } = {}): void {
    if (this.running) return;
    this.running = true;
    const r = this.recover();
    if (r.requeuedJobs || r.repairedMissions || r.unknownSideEffects) this.ctx.log.info('recovered after restart', r);
    this.worker.start();
    if (opts.triggers !== false) this.triggers.start();
    // Read your other sessions in the background, so the first message does not wait for it.
    if (this.ctx.settings.get().execution.pastSessions) void this.past.sync();
  }

  /** Session ids Orbit's own agents used (they run on the same CLIs): never shown as "your" sessions. */
  private ownSessionIds(): Set<string> {
    const db = this.ctx.db;
    const ids = new Set<string>();
    for (const r of db.select({ id: conversations.agentSessionId }).from(conversations).where(isNotNull(conversations.agentSessionId)).all()) if (r.id) ids.add(r.id);
    for (const r of db.select({ id: agentRuns.sessionId }).from(agentRuns).where(isNotNull(agentRuns.sessionId)).all()) if (r.id) ids.add(r.id);
    return ids;
  }

  async stop(): Promise<void> {
    this.triggers.stop();
    this.chat.stopAll();
    await this.worker.stop();
    this.running = false;
  }

  close(): void {
    this.handle.close();
  }

  doctor() {
    return runDoctor(this.ctx);
  }

  /** The AI team: which providers are connected and where worktrees live. */
  async team(): Promise<TeamDTO> {
    const [team, openrouter, huggingface, cursor] = await Promise.all([teamStatus(this.ctx), this.openrouter.status(), this.huggingface.status(), this.cursor.status()]);
    return { ...team, openrouter, huggingface, cursor };
  }

  /** Uncommitted changes in a project (the workspace's Changes panel). */
  changes(repoId: string) {
    return repoChanges(this.ctx, this.repos.getRow(repoId));
  }

  /** Files and folders matching what you typed after `@` in the prompt. */
  files(repoId: string, query: string) {
    return repoFiles(this.ctx, this.repos.getRow(repoId), query);
  }

  /**
   * Your Claude Code and Codex sessions from outside Orbit, newest first: `repoId` puts that
   * project's folder first, `q` also searches inside them. For `/past` and `/resume` in the prompt.
   */
  async pastSessions(opts: { q?: string; repoId?: string | null; limit?: number } = {}): Promise<PastSessionsDTO> {
    if (!this.ctx.settings.get().execution.pastSessions) return { enabled: false, sessions: [], indexing: false };
    await this.past.ready(1500);
    const repos = this.repos.list();
    const folder = opts.repoId ? (repos.find((r) => r.id === opts.repoId)?.localPath ?? null) : null;
    const norm = (p: string) => {
      const r = path.resolve(p).replace(/[\\/]+$/, '');
      return this.ctx.platform === 'win32' ? r.toLowerCase() : r;
    };
    const byFolder = new Map(repos.map((r) => [norm(r.localPath), r.id]));
    const sessions = this.past.list({ query: opts.q ?? '', cwd: folder, limit: Math.min(Math.max(opts.limit ?? 30, 1), 100) }).map(({ file: _file, ...s }) => ({ ...s, repoId: s.cwd ? (byFolder.get(norm(s.cwd)) ?? null) : null }));
    return { enabled: true, sessions, indexing: this.past.indexing };
  }

  /** Commits a project's changes, unless an agent is still editing it. */
  commit(repoId: string, message: string) {
    if (this.chat.isEditing(repoId)) throw new OrbitError('CONFLICT', 'An agent is still working in this project.', { hint: 'Wait for it to finish, or stop it, before committing.' });
    return commitRepoChanges(this.ctx, this.repos.getRow(repoId), message);
  }

  receipt(missionId: string) {
    return buildReceipt(this.missions.detail(missionId));
  }
}

export function createOrbit(opts: CreateOrbitOptions = {}): Orbit {
  return new Orbit(opts);
}
