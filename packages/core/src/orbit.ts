import { ClaudeAgentSdkRuntime, ClaudeCodeCliRuntime, CodexCliRuntime, ScriptedRuntime, type AgentRuntime } from '@orbit/agents';
import { and, eq, inArray, agentRuns, missionRepos, missions, openDatabase, verifications, type DatabaseHandle } from '@orbit/database';
import { defaultRunner, Git, GhCliClient, type CommandRunner, type GitHubClient } from '@orbit/git';
import { AsanaProvider } from '@orbit/integrations-asana';
import { DEFAULT_PORT, OrbitError, type RuntimeId } from '@orbit/shared';
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
import { Pipeline } from './pipeline';
import { JobQueue, Worker } from './queue';
import { buildReceipt } from './receipts';
import { RepoService } from './repos';
import { FileSecretStore, type SecretStore } from './secrets';
import { teamStatus } from './team';
import { commitRepoChanges, repoChanges } from './workspace';
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
    this.chat = new ChatService(this.ctx, this.repos);
    this.prompter = new PromptEngineer(this.ctx, this.integrations, this.repos);
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
  team() {
    return teamStatus(this.ctx);
  }

  /** Uncommitted changes in a project (the workspace's Changes panel). */
  changes(repoId: string) {
    return repoChanges(this.ctx, this.repos.getRow(repoId));
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
