import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { and, desc, eq, gt, inArray, isNotNull, notInArray, agentRuns, approvals, externalProjects, missionEvents, missionRepos, missionRevisions, missions, repos, reviews, sideEffects, verifications, type MissionRepoRow, type MissionRow, type RepoRow } from '@orbit/database';
import { parseGitHubRemote } from '@orbit/git';
import { ProviderError } from '@orbit/integrations';
import {
  ACTIVE_STATES,
  ATTENTION_STATES,
  assertTransition,
  errorMessage,
  isTerminal,
  MISSION_STATE_META,
  newId,
  OrbitError,
  redactSecrets,
  TERMINAL_STATES,
  truncate,
  type Actor,
  type AgentRunDTO,
  type ApprovalDTO,
  type DiffStats,
  type EntryPoint,
  type MissionAction,
  type MissionDetailDTO,
  type MissionEventActor,
  type MissionEventDTO,
  type MissionEventKind,
  type MissionRepoDTO,
  type MissionState,
  type MissionSummaryDTO,
  type ReviewDTO,
  type BlockedCode,
  type MissionPreflight,
  type SnapshotComment,
  type VerificationDTO,
} from '@orbit/shared';
import { audit, nowIso, recordMissionEvent, type OrbitContext } from './context';
import { providerErrorToOrbit, type IntegrationService } from './integrations';
import type { Notifier } from './notifier';
import type { Outbox } from './outbox';
import type { JobQueue } from './queue';
import type { RepoService } from './repos';
import { buildPrDraft, scanForSecrets } from './pr';

export interface CreateMissionInput {
  title?: string;
  description?: string;
  source?: { provider: 'asana'; integrationId: string; taskId: string; projectId?: string | null };
  repoIds?: string[];
  entryPoint: EntryPoint;
  triggeredBy: Actor;
  triggerVerified: boolean;
  extraInstructions?: string | null;
  /** Connected projects the agents may read (never change) for this mission. */
  referenceRepoIds?: string[];
}

export interface EngineHooks {
  abortMission(missionId: string): void;
  isMissionRunning(missionId: string): boolean;
  wake(): void;
}

export function contentHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n\0${body}`).digest('hex');
}

const ORBIT_FOOTER = /—\s*Orbit\s*·\s*orbit:/;
const MAX_DIFF_CHARS = 1_500_000;

function actorLabel(a: Actor): string {
  return a.name ?? a.id ?? a.type;
}

function eventActor(a: Actor): MissionEventActor {
  return a.type === 'external' ? 'asana' : a.type === 'system' ? 'system' : 'user';
}

export class MissionService {
  constructor(
    private readonly ctx: OrbitContext,
    private readonly queue: JobQueue,
    private readonly notifier: Notifier,
    private readonly integrations: IntegrationService,
    private readonly repoService: RepoService,
    private readonly outbox: Outbox,
    private readonly hooks: EngineHooks,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  row(id: string): MissionRow {
    const row = this.ctx.db.select().from(missions).where(eq(missions.id, id)).get();
    if (!row) throw new OrbitError('NOT_FOUND', `Mission ${id} not found.`);
    return row;
  }

  missionRepoRows(missionId: string): MissionRepoRow[] {
    return this.ctx.db.select().from(missionRepos).where(eq(missionRepos.missionId, missionId)).orderBy(missionRepos.createdAt).all();
  }

  missionRepoRow(id: string): MissionRepoRow {
    const row = this.ctx.db.select().from(missionRepos).where(eq(missionRepos.id, id)).get();
    if (!row) throw new OrbitError('NOT_FOUND', 'Mission repository not found.');
    return row;
  }

  currentRevision(m: MissionRow) {
    const rev = this.ctx.db
      .select()
      .from(missionRevisions)
      .where(and(eq(missionRevisions.missionId, m.id), eq(missionRevisions.revision, m.currentRevision)))
      .get();
    if (!rev) throw new OrbitError('INTERNAL', `Mission ${m.id} has no requirement snapshot.`);
    return rev;
  }

  private summarize(rows: MissionRow[]): MissionSummaryDTO[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const mrs = this.ctx.db
      .select({ mr: missionRepos, name: repos.name })
      .from(missionRepos)
      .innerJoin(repos, eq(repos.id, missionRepos.repoId))
      .where(inArray(missionRepos.missionId, ids))
      .all();
    const projectIds = [...new Set(rows.map((r) => r.sourceProjectId).filter((x): x is string => !!x))];
    const projectNames = new Map(
      projectIds.length ? this.ctx.db.select({ id: externalProjects.id, name: externalProjects.name }).from(externalProjects).where(inArray(externalProjects.id, projectIds)).all().map((p) => [p.id, p.name]) : [],
    );
    return rows.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      source: { provider: m.sourceProvider, taskId: m.sourceTaskId, url: m.sourceUrl, projectName: m.sourceProjectId ? (projectNames.get(m.sourceProjectId) ?? null) : null },
      entryPoint: m.entryPoint as EntryPoint,
      triggeredBy: m.triggeredBy ?? null,
      triggerVerified: m.triggerVerified,
      repos: mrs
        .filter((x) => x.mr.missionId === m.id && x.mr.status !== 'excluded')
        .map((x) => ({ id: x.mr.id, repoId: x.mr.repoId, name: x.name, status: x.mr.status, prUrl: x.mr.prUrl, branch: x.mr.branch })),
      costUsd: m.costUsd,
      iteration: m.iteration,
      runtime: m.runtime,
      requirementsChanged: m.requirementsChangedAt !== null,
      blockedReason: m.blockedReason,
      blockedCode: (m.blockedCode as BlockedCode | null) ?? null,
      lastError: m.lastError,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      startedAt: m.startedAt,
      completedAt: m.completedAt,
    }));
  }

  summary(id: string): MissionSummaryDTO {
    return this.summarize([this.row(id)])[0] as MissionSummaryDTO;
  }

  list(opts: { status?: MissionState[]; limit?: number; attention?: boolean; active?: boolean } = {}): MissionSummaryDTO[] {
    const filters = [];
    if (opts.status?.length) filters.push(inArray(missions.status, opts.status));
    if (opts.attention) filters.push(inArray(missions.status, [...ATTENTION_STATES]));
    if (opts.active) filters.push(inArray(missions.status, ['DRAFT', ...ACTIVE_STATES]));
    const rows = this.ctx.db
      .select()
      .from(missions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(missions.updatedAt))
      .limit(Math.min(opts.limit ?? 100, 500))
      .all();
    return this.summarize(rows);
  }

  allowedActions(m: MissionRow, mrs: MissionRepoRow[]): MissionAction[] {
    switch (m.status) {
      case 'DRAFT':
      case 'ANALYZING':
      case 'QUEUED':
      case 'RUNNING':
      case 'VERIFYING':
        return ['cancel'];
      case 'AWAITING_SCOPE_APPROVAL':
        return ['approve_scope', 'replan', 'cancel'];
      case 'AWAITING_REVIEW':
        return mrs.some((r) => r.status === 'ready_for_review') ? ['approve_changes', 'request_changes', 'cancel'] : ['request_changes', 'cancel'];
      case 'AWAITING_PR_APPROVAL': {
        const repoRows = this.repoService.rowsByIds(mrs.map((r) => r.repoId));
        const publishable = mrs.some((r) => r.status === 'changes_approved' && repoRows.find((x) => x.id === r.repoId)?.githubOwner);
        return [...(publishable ? (['publish'] as const) : []), 'finish_local', 'request_changes', 'cancel'];
      }
      case 'PR_CREATED':
        return ['complete'];
      case 'BLOCKED':
      case 'FAILED':
        return ['retry', 'replan', 'cancel'];
      default:
        return [];
    }
  }

  private missionRepoDTO(mr: MissionRepoRow, repo: RepoRow | undefined): MissionRepoDTO {
    const gh = repo?.githubOwner && repo.githubRepo ? { owner: repo.githubOwner, repo: repo.githubRepo } : parseGitHubRemote(repo?.remoteUrl);
    return {
      id: mr.id,
      repoId: mr.repoId,
      repoName: repo?.name ?? mr.repoId,
      status: mr.status,
      selection: mr.selection ?? null,
      branch: mr.branch,
      baseBranch: mr.baseBranch,
      baseSha: mr.baseSha,
      worktreePath: mr.worktreePath,
      headSha: mr.headSha,
      commitSha: mr.commitSha,
      diffStats: mr.diffStats ?? null,
      pr: mr.prUrl && mr.prNumber ? { number: mr.prNumber, url: mr.prUrl, state: mr.prState ?? 'OPEN', title: mr.prTitle ?? '' } : null,
      prDraft: mr.prTitle && !mr.prUrl ? { title: mr.prTitle, body: mr.prBody ?? '', base: mr.prBase ?? mr.baseBranch ?? 'main' } : null,
      lastError: mr.lastError,
      remote: gh ? { hasGitHubRemote: true, owner: gh.owner, repo: gh.repo } : { hasGitHubRemote: false },
    };
  }

  detail(id: string): MissionDetailDTO {
    const m = this.row(id);
    const summary = this.summarize([m])[0] as MissionSummaryDTO;
    const rev = this.currentRevision(m);
    const revisionCount = this.ctx.db.select({ id: missionRevisions.id }).from(missionRevisions).where(eq(missionRevisions.missionId, id)).all().length;
    const mrs = this.missionRepoRows(id);
    const repoRows = this.repoService.rowsByIds(mrs.map((r) => r.repoId));
    const runs = this.ctx.db.select().from(agentRuns).where(eq(agentRuns.missionId, id)).orderBy(agentRuns.startedAt).all();
    const vers = this.ctx.db.select().from(verifications).where(eq(verifications.missionId, id)).orderBy(verifications.startedAt).all();
    const revs = this.ctx.db.select().from(reviews).where(eq(reviews.missionId, id)).orderBy(reviews.createdAt).all();
    const apprs = this.ctx.db.select().from(approvals).where(eq(approvals.missionId, id)).orderBy(approvals.createdAt).all();
    const fx = this.ctx.db.select().from(sideEffects).where(eq(sideEffects.missionId, id)).orderBy(sideEffects.createdAt).all();
    return {
      ...summary,
      revision: {
        revision: rev.revision,
        title: rev.title,
        body: rev.body,
        comments: rev.comments,
        extraInstructions: rev.extraInstructions,
        sourceUpdatedAt: rev.sourceUpdatedAt,
        contentHash: rev.contentHash,
        createdAt: rev.createdAt,
      },
      revisionCount,
      plan: m.plan ?? null,
      missionRepos: mrs.map((mr) => this.missionRepoDTO(mr, repoRows.find((r) => r.id === mr.repoId))),
      agentRuns: runs.map(
        (r): AgentRunDTO => ({
          id: r.id,
          missionId: r.missionId,
          missionRepoId: r.missionRepoId,
          role: r.role,
          runtime: r.runtime,
          model: r.model,
          iteration: r.iteration,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          durationMs: r.durationMs,
          costUsd: r.costUsd,
          numTurns: r.numTurns,
          summary: r.summary,
          error: r.error,
        }),
      ),
      verifications: vers.map(
        (v): VerificationDTO => ({
          id: v.id,
          missionRepoId: v.missionRepoId,
          iteration: v.iteration,
          kind: v.kind,
          label: v.label,
          command: v.command,
          status: v.status,
          exitCode: v.exitCode,
          durationMs: v.durationMs,
          outputTail: v.outputTail,
          startedAt: v.startedAt,
          finishedAt: v.finishedAt,
        }),
      ),
      reviews: revs.map(
        (r): ReviewDTO => ({
          id: r.id,
          kind: r.kind,
          missionRepoId: r.missionRepoId,
          iteration: r.iteration,
          verdict: r.verdict,
          summary: r.summary,
          findings: r.findings,
          criteria: r.criteria,
          agentRunId: r.agentRunId,
          createdAt: r.createdAt,
        }),
      ),
      approvals: apprs.map(
        (a): ApprovalDTO => ({ id: a.id, missionRepoId: a.missionRepoId, kind: a.kind, decision: a.decision, decidedBy: a.decidedBy, notes: a.notes, createdAt: a.createdAt }),
      ),
      sideEffects: fx.map((f) => ({ id: f.id, kind: f.kind, status: f.status, idempotencyKey: f.idempotencyKey, lastError: f.lastError, updatedAt: f.updatedAt })),
      allowedActions: this.allowedActions(m, mrs),
      preflight: this.preflight(mrs, repoRows),
      references: this.repoService.rowsByIds(m.referenceRepoIds ?? []).map((r) => ({ repoId: r.id, name: r.name, localPath: r.localPath })),
    };
  }

  events(id: string, afterId = 0, limit = 500): MissionEventDTO[] {
    this.row(id);
    return this.ctx.db
      .select()
      .from(missionEvents)
      .where(and(eq(missionEvents.missionId, id), gt(missionEvents.id, afterId)))
      .orderBy(missionEvents.id)
      .limit(Math.min(limit, 2000))
      .all()
      .map((e) => ({ ...e, kind: e.kind as MissionEventKind, actor: e.actor as MissionEventActor }));
  }

  /** The actual git diff for a mission repository (committed diff once approved). */
  async diff(id: string, missionRepoId: string): Promise<{ diff: string; truncated: boolean; stats: DiffStats | null }> {
    const mr = this.missionRepoRow(missionRepoId);
    if (mr.missionId !== id) throw new OrbitError('NOT_FOUND', 'Mission repository not found.');
    if (!mr.baseSha || !mr.worktreePath) return { diff: '', truncated: false, stats: null };
    const dir = existsSync(mr.worktreePath) ? mr.worktreePath : this.repoService.getRow(mr.repoId).localPath;
    let diff: string;
    let stats: DiffStats | null;
    if (mr.commitSha) {
      diff = await this.ctx.git.diffCommits(dir, mr.baseSha, mr.commitSha);
      stats = await this.ctx.git.diffStatsCommits(dir, mr.baseSha, mr.commitSha);
    } else {
      if (!existsSync(mr.worktreePath)) return { diff: '', truncated: false, stats: mr.diffStats ?? null };
      await this.ctx.git.stageAll(mr.worktreePath, mr.setupArtifacts ?? []);
      diff = await this.ctx.git.diffStaged(mr.worktreePath, mr.baseSha);
      stats = await this.ctx.git.diffStatsStaged(mr.worktreePath, mr.baseSha);
    }
    const truncated = diff.length > MAX_DIFF_CHARS;
    return { diff: truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff, truncated, stats };
  }

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  transition(
    id: string,
    to: MissionState,
    opts: { title?: string; detail?: string | null; actor?: MissionEventActor; patch?: Partial<MissionRow> } = {},
  ): MissionRow {
    const m = this.row(id);
    assertTransition(m.status, to);
    const ts = nowIso(this.ctx);
    const terminal = isTerminal(to);
    const updated = this.ctx.db
      .update(missions)
      .set({
        status: to,
        updatedAt: ts,
        ...(to === 'BLOCKED' || to === 'FAILED' ? {} : { blockedReason: null, blockedCode: null }),
        ...(terminal ? { activeKey: null, completedAt: ts } : {}),
        ...(to === 'RUNNING' && !m.startedAt ? { startedAt: ts } : {}),
        ...opts.patch,
      })
      .where(and(eq(missions.id, id), eq(missions.status, m.status)))
      .returning()
      .get();
    if (!updated) throw new OrbitError('CONFLICT', 'The mission changed while this action was running. Refresh and try again.');
    recordMissionEvent(this.ctx, id, {
      kind: 'state',
      actor: opts.actor ?? 'system',
      title: opts.title ?? `${MISSION_STATE_META[m.status].label} → ${MISSION_STATE_META[to].label}`,
      detail: opts.detail ?? null,
      data: { from: m.status, to },
    });
    this.ctx.bus.publish({ type: 'mission.updated', missionId: id, status: to });
    return updated;
  }

  /**
   * What this machine must allow before the mission can build, so the dashboard can
   * ask before the user approves instead of failing afterwards.
   */
  preflight(mrs: MissionRepoRow[], repoRows: RepoRow[]): MissionPreflight {
    const settings = this.ctx.settings.get().execution;
    const active = mrs.filter((r) => !['excluded', 'discarded', 'pr_created', 'local_only'].includes(r.status));
    const commands = [
      ...new Set(
        active.flatMap((mr) => {
          const repo = repoRows.find((r) => r.id === mr.repoId);
          return [...(repo?.setupCommands ?? []), ...(repo?.verifyCommands ?? [])].filter((c) => c.enabled).map((c) => c.command);
        }),
      ),
    ];
    const aiRuntime = settings.runtime === 'auto' || this.ctx.runtimes.get(settings.runtime)?.kind === 'ai';
    return {
      needsConsent: !settings.localExecutionConsentAt && (commands.length > 0 || (aiRuntime && settings.mode === 'trusted-local')),
      // Claude Code's OS sandbox is not active on native Windows today.
      sandboxUnavailable: aiRuntime && settings.mode === 'sandbox' && process.platform === 'win32',
      commands,
    };
  }

  block(id: string, reason: string, detail?: string | null, code?: BlockedCode | null): MissionRow {
    const m = this.row(id);
    this.notifier.notify(id, 'blocked', [`Orbit is blocked on this task: ${truncate(reason, 400)}`], `${m.iteration}:${createHash('md5').update(reason).digest('hex').slice(0, 6)}`);
    return this.transition(id, 'BLOCKED', { title: `Blocked: ${truncate(reason, 160)}`, detail: detail ?? reason, patch: { blockedReason: reason, blockedCode: code ?? null } });
  }

  fail(id: string, error: string): MissionRow {
    this.notifier.notify(id, 'failed', [`Orbit could not finish this task: ${truncate(error, 400)}`]);
    return this.transition(id, 'FAILED', { title: 'Mission failed', detail: error, patch: { lastError: redactSecrets(error).slice(0, 4000), blockedReason: null } });
  }

  addCost(id: string, usd: number | null): void {
    if (!usd) return;
    const m = this.row(id);
    this.ctx.db.update(missions).set({ costUsd: m.costUsd + usd }).where(eq(missions.id, id)).run();
  }

  updateMissionRepo(id: string, patch: Partial<MissionRepoRow>): MissionRepoRow {
    const row = this.ctx.db.update(missionRepos).set({ ...patch, updatedAt: nowIso(this.ctx) }).where(eq(missionRepos.id, id)).returning().get();
    if (!row) throw new OrbitError('NOT_FOUND', 'Mission repository not found.');
    return row;
  }

  private recordApproval(
    missionId: string,
    kind: 'scope' | 'changes' | 'publish' | 'trigger',
    decision: 'approved' | 'rejected' | 'changes_requested',
    actor: Actor,
    notes: string | null,
    data?: unknown,
    missionRepoId?: string | null,
  ): void {
    this.ctx.db
      .insert(approvals)
      .values({
        id: newId('apr'),
        missionId,
        missionRepoId: missionRepoId ?? null,
        kind,
        decision,
        decidedBy: actor,
        notes: notes ? redactSecrets(notes).slice(0, 8000) : null,
        data: data ?? null,
        createdAt: nowIso(this.ctx),
      })
      .run();
    recordMissionEvent(this.ctx, missionId, {
      kind: 'approval',
      actor: eventActor(actor),
      title: `${actorLabel(actor)} ${decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'requested changes to'} the ${kind}`,
      detail: notes,
      missionRepoId: missionRepoId ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  findActiveForTask(provider: string, taskId: string): MissionRow | null {
    return this.ctx.db.select().from(missions).where(eq(missions.activeKey, `${provider}:${taskId}`)).get() ?? null;
  }

  async create(input: CreateMissionInput): Promise<{ mission: MissionSummaryDTO; created: boolean }> {
    let title: string;
    let body: string;
    let comments: SnapshotComment[] = [];
    let sourceUrl: string | null = null;
    let sourceUpdatedAt: string | null = null;
    let activeKey: string | null = null;
    let sourceProjectId: string | null = null;
    let integrationId: string | null = null;
    let sourceTaskId: string | null = null;
    let provider = 'local';

    if (input.source) {
      const integration = this.integrations.get(input.source.integrationId);
      provider = integration.provider;
      integrationId = integration.id;
      sourceTaskId = input.source.taskId;
      activeKey = `${provider}:${input.source.taskId}`;
      const existing = this.findActiveForTask(provider, input.source.taskId);
      if (existing) return { mission: this.summary(existing.id), created: false };
      const p = this.integrations.providerFor(integration.id);
      try {
        const task = await p.getTask(input.source.taskId);
        const raw = await p.listComments(input.source.taskId, { limit: 25 });
        title = task.title;
        body = task.description;
        sourceUrl = task.url;
        sourceUpdatedAt = task.updatedAt;
        comments = raw
          .filter((c) => !ORBIT_FOOTER.test(c.text) && !/^\s*\/orbit\s/i.test(c.text))
          .slice(-15)
          .map((c) => ({ id: c.id, ...(c.author?.name ? { author: c.author.name } : {}), text: redactSecrets(c.text).slice(0, 4000), createdAt: c.createdAt }));
        if (input.source.projectId) sourceProjectId = input.source.projectId;
        else {
          const projects = this.ctx.db.select().from(externalProjects).where(eq(externalProjects.integrationId, integration.id)).all();
          sourceProjectId = projects.find((pr) => task.projectIds.includes(pr.externalId))?.id ?? null;
        }
      } catch (err) {
        this.integrations.noteProviderError(integration.id, err);
        if (err instanceof ProviderError) providerErrorToOrbit(err);
        throw err;
      }
    } else {
      title = (input.title ?? '').trim();
      body = (input.description ?? '').trim();
      if (!title) throw new OrbitError('VALIDATION', 'Give the mission a title.');
    }

    let requested: string[] | null = null;
    if (input.repoIds?.length) {
      const rows = this.repoService.rowsByIds(input.repoIds);
      if (rows.length !== new Set(input.repoIds).size) throw new OrbitError('VALIDATION', 'One or more repositories are not connected to Orbit.');
      const folders = rows.filter((r) => !r.isGit);
      if (folders.length) throw new OrbitError('FORBIDDEN', `${folders.map((r) => r.name).join(', ')} is a folder without git, so Orbit can only read it. Add it as a reference project instead.`);
      const locked = rows.filter((r) => !r.allowModify);
      if (locked.length) throw new OrbitError('FORBIDDEN', `Orbit is not allowed to modify ${locked.map((r) => r.name).join(', ')}. Enable it in Projects first.`);
      requested = rows.map((r) => r.id);
    } else if (!input.source) {
      const modifiable = this.ctx.db.select().from(repos).where(eq(repos.allowModify, true)).all();
      if (modifiable.length === 1) requested = [modifiable[0]!.id];
      else throw new OrbitError('VALIDATION', modifiable.length === 0 ? 'Connect a repository first.' : 'Choose which repository this mission should change.');
    }

    const id = newId('msn');
    const ts = nowIso(this.ctx);
    try {
      this.ctx.db.transaction((tx) => {
        tx.insert(missions)
          .values({
            id,
            title: truncate(redactSecrets(title), 300),
            status: 'DRAFT',
            sourceProvider: provider,
            sourceTaskId,
            sourceProjectId,
            sourceUrl,
            integrationId,
            entryPoint: input.entryPoint,
            triggeredBy: input.triggeredBy,
            triggerVerified: input.triggerVerified,
            currentRevision: 1,
            iteration: 0,
            costUsd: 0,
            activeKey,
            requestedRepoIds: requested,
            referenceRepoIds: this.validateReferences(input.referenceRepoIds ?? [], requested ?? []),
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
        tx.insert(missionRevisions)
          .values({
            id: newId('rev'),
            missionId: id,
            revision: 1,
            title: redactSecrets(title),
            body: redactSecrets(body),
            comments,
            extraInstructions: input.extraInstructions ? redactSecrets(input.extraInstructions) : null,
            sourceUpdatedAt,
            contentHash: contentHash(title, body),
            createdAt: ts,
          })
          .run();
      });
    } catch (err) {
      if (activeKey && /UNIQUE/i.test(errorMessage(err))) {
        const existing = this.ctx.db.select().from(missions).where(eq(missions.activeKey, activeKey)).get();
        if (existing) return { mission: this.summary(existing.id), created: false };
      }
      throw err;
    }

    recordMissionEvent(this.ctx, id, {
      kind: 'note',
      actor: eventActor(input.triggeredBy),
      title: `Mission created from ${input.entryPoint} by ${actorLabel(input.triggeredBy)}`,
      detail: input.triggerVerified ? null : 'The trigger author could not be verified. Orbit will wait for your approval in the dashboard.',
    });
    audit(this.ctx, { actor: actorLabel(input.triggeredBy), action: 'mission.created', target: id, summary: `Created mission "${truncate(title, 80)}" via ${input.entryPoint}` });
    this.queue.enqueue({ type: 'mission.analyze', missionId: id, dedupeKey: `analyze:${id}` });
    if (input.entryPoint === 'asana-comment') this.notifier.notify(id, 'received', ['Orbit received /orbit run and is analyzing this task.'], 0);
    this.ctx.bus.publish({ type: 'mission.updated', missionId: id, status: 'DRAFT' });
    this.hooks.wake();
    return { mission: this.summary(id), created: true };
  }

  // ---------------------------------------------------------------------------
  // Human decisions
  // ---------------------------------------------------------------------------

  /** References must be connected projects and are never the projects being changed. Reading is allowed even where changing is not. */
  validateReferences(ids: string[], changeRepoIds: string[]): string[] {
    const unique = [...new Set(ids)].filter((id) => !changeRepoIds.includes(id));
    if (unique.length === 0) return [];
    const rows = this.repoService.rowsByIds(unique);
    if (rows.length !== unique.length) throw new OrbitError('VALIDATION', 'A reference project is not connected to Orbit.');
    if (unique.length > 10) throw new OrbitError('VALIDATION', 'Choose at most 10 reference projects.');
    return unique;
  }

  approveScope(id: string, input: { repoIds?: string[]; notes?: string | null; referenceRepoIds?: string[] }, actor: Actor): MissionSummaryDTO {
    const m = this.row(id);
    if (m.status !== 'AWAITING_SCOPE_APPROVAL') throw new OrbitError('INVALID_TRANSITION', 'This mission is not waiting for scope approval.');
    const mrs = this.missionRepoRows(id);
    const chosen = input.repoIds ?? mrs.filter((r) => r.status === 'selected').map((r) => r.repoId);
    if (chosen.length === 0) throw new OrbitError('VALIDATION', 'Select at least one repository.');
    const rows = this.repoService.rowsByIds(chosen);
    if (rows.length !== new Set(chosen).size) throw new OrbitError('VALIDATION', 'Unknown repository in selection.');
    const folders = rows.filter((r) => !r.isGit);
    if (folders.length) throw new OrbitError('FORBIDDEN', `${folders.map((r) => r.name).join(', ')} is a folder without git, so Orbit can only read it. Add it as a reference project instead.`);
    const locked = rows.filter((r) => !r.allowModify);
    if (locked.length) throw new OrbitError('FORBIDDEN', `Orbit is not allowed to modify ${locked.map((r) => r.name).join(', ')}.`);
    const ts = nowIso(this.ctx);
    this.ctx.db.transaction((tx) => {
      for (const mr of mrs) {
        tx.update(missionRepos)
          .set({ status: chosen.includes(mr.repoId) ? 'selected' : 'excluded', updatedAt: ts })
          .where(eq(missionRepos.id, mr.id))
          .run();
      }
      for (const repo of rows) {
        if (mrs.some((mr) => mr.repoId === repo.id)) continue;
        tx.insert(missionRepos)
          .values({
            id: newId('mr'),
            missionId: id,
            repoId: repo.id,
            status: 'selected',
            selection: {
              repoId: repo.id,
              repoName: repo.name,
              source: 'user',
              reason: 'Added by you during scope approval.',
              evidence: [],
              likelyFiles: [],
              changeSummary: '',
              risks: [],
              uncertainty: '',
            },
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }
    });
    if (input.referenceRepoIds) {
      const references = this.validateReferences(input.referenceRepoIds, chosen);
      this.ctx.db.update(missions).set({ referenceRepoIds: references, updatedAt: nowIso(this.ctx) }).where(eq(missions.id, id)).run();
    }
    this.recordApproval(id, 'scope', 'approved', actor, input.notes ?? null, { repoIds: chosen, referenceRepoIds: input.referenceRepoIds ?? m.referenceRepoIds ?? [] });
    this.transition(id, 'QUEUED', { actor: eventActor(actor), title: 'Scope approved, queued for implementation' });
    this.queue.enqueue({ type: 'mission.execute', missionId: id, dedupeKey: `execute:${id}` });
    this.hooks.wake();
    return this.summary(id);
  }

  async replan(id: string, input: { refreshSource?: boolean }, actor: Actor): Promise<MissionSummaryDTO> {
    const m = this.row(id);
    if (!['AWAITING_SCOPE_APPROVAL', 'BLOCKED', 'FAILED'].includes(m.status)) {
      throw new OrbitError('INVALID_TRANSITION', 'Replanning is available while waiting for scope approval, or after a block or failure.');
    }
    let revision = m.currentRevision;
    if (input.refreshSource && m.integrationId && m.sourceTaskId) {
      const p = this.integrations.providerFor(m.integrationId);
      try {
        const task = await p.getTask(m.sourceTaskId);
        const current = this.currentRevision(m);
        const hash = contentHash(task.title, task.description);
        if (hash !== current.contentHash) {
          revision = m.currentRevision + 1;
          this.ctx.db
            .insert(missionRevisions)
            .values({
              id: newId('rev'),
              missionId: id,
              revision,
              title: redactSecrets(task.title),
              body: redactSecrets(task.description),
              comments: current.comments,
              extraInstructions: current.extraInstructions,
              sourceUpdatedAt: task.updatedAt,
              contentHash: hash,
              createdAt: nowIso(this.ctx),
            })
            .run();
        }
      } catch (err) {
        this.integrations.noteProviderError(m.integrationId, err);
        providerErrorToOrbit(err);
      }
    }
    // Repositories that never got a worktree are re-proposed by the planner.
    for (const mr of this.missionRepoRows(id)) {
      if (!mr.branch && ['proposed', 'selected', 'excluded'].includes(mr.status)) this.ctx.db.delete(missionRepos).where(eq(missionRepos.id, mr.id)).run();
    }
    this.transition(id, 'ANALYZING', {
      actor: eventActor(actor),
      title: revision !== m.currentRevision ? `Replanning with requirement revision ${revision}` : 'Replanning',
      patch: { currentRevision: revision, requirementsChangedAt: null, plan: null, blockedReason: null },
    });
    this.queue.enqueue({ type: 'mission.analyze', missionId: id, dedupeKey: `analyze:${id}` });
    this.hooks.wake();
    return this.summary(id);
  }

  retry(id: string, actor: Actor): MissionSummaryDTO {
    const m = this.row(id);
    if (m.status !== 'BLOCKED' && m.status !== 'FAILED') throw new OrbitError('INVALID_TRANSITION', 'Only blocked or failed missions can be retried.');
    const selected = this.missionRepoRows(id).filter((r) => !['excluded', 'discarded', 'proposed'].includes(r.status));
    if (!m.plan || selected.length === 0) {
      this.transition(id, 'ANALYZING', { actor: eventActor(actor), title: 'Retrying analysis', patch: { lastError: null } });
      this.queue.enqueue({ type: 'mission.analyze', missionId: id, dedupeKey: `analyze:${id}` });
    } else {
      for (const mr of selected) if (mr.status === 'failed' || mr.status === 'no_changes') this.updateMissionRepo(mr.id, { status: 'selected', lastError: null });
      this.transition(id, 'QUEUED', { actor: eventActor(actor), title: 'Retrying implementation', patch: { lastError: null } });
      this.queue.enqueue({ type: 'mission.execute', missionId: id, dedupeKey: `execute:${id}` });
    }
    this.hooks.wake();
    return this.summary(id);
  }

  requestChanges(id: string, input: { notes: string }, actor: Actor): MissionSummaryDTO {
    const m = this.row(id);
    if (m.status !== 'AWAITING_REVIEW' && m.status !== 'AWAITING_PR_APPROVAL') throw new OrbitError('INVALID_TRANSITION', 'Changes can be requested while reviewing.');
    const notes = input.notes?.trim();
    if (!notes) throw new OrbitError('VALIDATION', 'Describe what should change.');
    this.recordApproval(id, 'changes', 'changes_requested', actor, notes);
    for (const mr of this.missionRepoRows(id)) {
      if (['ready_for_review', 'changes_approved', 'no_changes'].includes(mr.status)) this.updateMissionRepo(mr.id, { status: 'in_progress', prTitle: null, prBody: null });
    }
    this.transition(id, 'QUEUED', { actor: eventActor(actor), title: 'Changes requested, sent back to the engineer' });
    this.queue.enqueue({ type: 'mission.execute', missionId: id, dedupeKey: `execute:${id}` });
    this.hooks.wake();
    return this.summary(id);
  }

  /** Commits the reviewed changes locally and prepares pull request drafts. Nothing leaves the machine yet. */
  async approveChanges(id: string, actor: Actor): Promise<MissionSummaryDTO> {
    const m = this.row(id);
    if (m.status !== 'AWAITING_REVIEW') throw new OrbitError('INVALID_TRANSITION', 'This mission is not waiting for review.');
    const rev = this.currentRevision(m);
    const settings = this.ctx.settings.get();
    const mrs = this.missionRepoRows(id).filter((r) => r.status === 'ready_for_review');
    if (mrs.length === 0) throw new OrbitError('PRECONDITION', 'There are no changes ready to approve.');
    for (const mr of mrs) {
      if (!mr.worktreePath || !mr.baseSha || !existsSync(mr.worktreePath)) throw new OrbitError('PRECONDITION', 'The mission worktree is missing. Retry the mission.');
      const repo = this.repoService.getRow(mr.repoId);
      await this.ctx.git.stageAll(mr.worktreePath, mr.setupArtifacts ?? []);
      const diff = await this.ctx.git.diffStaged(mr.worktreePath, mr.baseSha);
      const leaks = scanForSecrets(diff);
      if (leaks.length) {
        this.updateMissionRepo(mr.id, { lastError: `Possible secrets in the changes: ${leaks.join(', ')}` });
        throw new OrbitError('PRECONDITION', `Orbit found what looks like secrets in the changes (${leaks.join(', ')}). Remove them (request changes) before approving.`);
      }
      let commitSha: string;
      const staged = await this.ctx.git.raw(mr.worktreePath, ['diff', '--cached', '--quiet']);
      if (staged.exitCode === 0) {
        const head = await this.ctx.git.headSha(mr.worktreePath);
        if (head === mr.baseSha) {
          this.updateMissionRepo(mr.id, { status: 'no_changes' });
          continue;
        }
        commitSha = head;
      } else {
        const summary = mr.engineerSummary ? `\n\n${truncate(mr.engineerSummary, 1500)}` : '';
        const message = `${truncate(m.title, 72)}${summary}\n\nOrbit-Mission: ${m.id}${m.sourceUrl ? `\nOrbit-Source: ${m.sourceProvider}` : ''}\n`;
        try {
          commitSha = await this.ctx.git.commit(mr.worktreePath, redactSecrets(message));
        } catch (err) {
          const msg = errorMessage(err);
          this.updateMissionRepo(mr.id, { lastError: msg });
          recordMissionEvent(this.ctx, id, { kind: 'error', actor: 'git', title: `Commit failed in ${repo.name}`, detail: msg, missionRepoId: mr.id });
          throw new OrbitError('PRECONDITION', `Commit failed in ${repo.name}: ${truncate(msg, 600)}`, {
            hint: /user\.(name|email)|identity/i.test(msg) ? 'Set your git identity: git config --global user.name "You" && git config --global user.email you@example.com' : 'Check the repository hooks and try again.',
          });
        }
      }
      const stats = await this.ctx.git.diffStatsCommits(mr.worktreePath, mr.baseSha, commitSha);
      let visibility: string | null = null;
      if (repo.githubOwner && repo.githubRepo) {
        visibility = await this.ctx.github
          .repoView(`${repo.githubOwner}/${repo.githubRepo}`)
          .then((r) => r.visibility)
          .catch(() => null);
      }
      const includeSource = visibility === 'PRIVATE' || visibility === 'INTERNAL' || settings.github.includeSourceInPublicRepos;
      const draft = buildPrDraft({
        missionId: m.id,
        title: m.title,
        requirement: rev.body,
        sourceUrl: includeSource ? m.sourceUrl : null,
        sourceProvider: m.sourceProvider,
        includeRequirement: includeSource,
        engineerSummary: mr.engineerSummary,
        planSummary: m.plan?.summary ?? null,
        stats,
        verifications: this.ctx.db.select().from(verifications).where(and(eq(verifications.missionRepoId, mr.id), eq(verifications.kind, 'verify'))).all(),
        review: this.ctx.db.select().from(reviews).where(eq(reviews.missionRepoId, mr.id)).orderBy(desc(reviews.createdAt)).limit(1).get() ?? null,
      });
      this.updateMissionRepo(mr.id, {
        status: 'changes_approved',
        commitSha,
        headSha: commitSha,
        diffStats: stats,
        prTitle: draft.title,
        prBody: draft.body,
        prBase: repo.defaultBranch,
        lastError: null,
      });
      recordMissionEvent(this.ctx, id, { kind: 'note', actor: 'git', title: `Committed ${stats.files} files to ${mr.branch} in ${repo.name}`, detail: commitSha, missionRepoId: mr.id });
    }
    this.recordApproval(id, 'changes', 'approved', actor, null);
    const remaining = this.missionRepoRows(id).filter((r) => r.status === 'changes_approved');
    if (remaining.length === 0) {
      return this.summary(this.block(id, 'No changes remained to commit after review.').id);
    }
    this.transition(id, 'AWAITING_PR_APPROVAL', { actor: eventActor(actor), title: 'Changes approved and committed locally' });
    return this.summary(id);
  }

  /** Records approval to publish and queues the push + pull request. */
  async publish(id: string, input: { missionRepoId: string; title?: string; body?: string; draft?: boolean }, actor: Actor): Promise<MissionSummaryDTO> {
    const m = this.row(id);
    if (m.status !== 'AWAITING_PR_APPROVAL') throw new OrbitError('INVALID_TRANSITION', 'This mission is not waiting for pull request approval.');
    const mr = this.missionRepoRow(input.missionRepoId);
    if (mr.missionId !== id) throw new OrbitError('NOT_FOUND', 'Mission repository not found.');
    if (mr.status !== 'changes_approved') throw new OrbitError('PRECONDITION', mr.status === 'publishing' ? 'Publishing is already in progress.' : 'These changes are not approved yet.');
    const repo = this.repoService.getRow(mr.repoId);
    if (!repo.githubOwner || !repo.githubRepo) throw new OrbitError('PRECONDITION', `${repo.name} has no GitHub remote. Use "Finish locally" instead.`);
    const auth = await this.ctx.github.authStatus();
    if (!auth.installed) throw new OrbitError('NOT_CONFIGURED', 'GitHub CLI (gh) is not installed.', { hint: 'Install it from https://cli.github.com and run gh auth login.' });
    if (!auth.loggedIn) throw new OrbitError('NOT_CONFIGURED', 'GitHub CLI is not logged in.', { hint: 'Run gh auth login in a terminal.' });
    const title = (input.title ?? mr.prTitle ?? m.title).trim();
    if (!title) throw new OrbitError('VALIDATION', 'The pull request needs a title.');
    const body = redactSecrets(input.body ?? mr.prBody ?? '');
    const leaks = scanForSecrets(`${title}\n${body}`, 'text');
    if (leaks.length) throw new OrbitError('PRECONDITION', `The pull request text looks like it contains secrets (${leaks.join(', ')}).`);
    this.recordApproval(id, 'publish', 'approved', actor, null, { repo: `${repo.githubOwner}/${repo.githubRepo}`, base: mr.prBase ?? repo.defaultBranch, branch: mr.branch, draft: input.draft ?? this.ctx.settings.get().github.draftPullRequests }, mr.id);
    this.updateMissionRepo(mr.id, { status: 'publishing', prTitle: truncate(redactSecrets(title), 250), prBody: body, lastError: null });
    this.queue.enqueue({
      type: 'mission.publish',
      missionId: id,
      payload: { missionRepoId: mr.id, draft: input.draft ?? this.ctx.settings.get().github.draftPullRequests },
      dedupeKey: `publish:${mr.id}`,
      maxAttempts: 3,
    });
    this.hooks.wake();
    return this.summary(id);
  }

  finishLocal(id: string, actor: Actor): MissionSummaryDTO {
    const m = this.row(id);
    if (m.status !== 'AWAITING_PR_APPROVAL') throw new OrbitError('INVALID_TRANSITION', 'Only approved changes can be finished locally.');
    const mrs = this.missionRepoRows(id);
    if (mrs.some((r) => r.status === 'publishing')) throw new OrbitError('PRECONDITION', 'A pull request is being published. Wait for it to finish.');
    const branches: string[] = [];
    for (const mr of mrs) {
      if (mr.status === 'changes_approved') {
        this.updateMissionRepo(mr.id, { status: 'local_only' });
        if (mr.branch) branches.push(mr.branch);
      }
    }
    this.recordApproval(id, 'publish', 'approved', actor, 'Kept the commits on a local branch. No pull request.', { localOnly: true });
    const target = mrs.some((r) => r.status === 'pr_created') ? 'PR_CREATED' : 'COMPLETED';
    this.transition(id, target === 'PR_CREATED' ? 'PR_CREATED' : 'COMPLETED', { actor: eventActor(actor), title: 'Finished locally' });
    this.notifier.notify(id, 'completed', [`Orbit finished this task. The changes are committed locally on ${branches.join(', ') || 'a local branch'} (no pull request).`]);
    return this.summary(id);
  }

  complete(id: string, actor: Actor): MissionSummaryDTO {
    const m = this.row(id);
    if (m.status !== 'PR_CREATED') throw new OrbitError('INVALID_TRANSITION', 'Only missions with an open pull request can be marked complete.');
    this.transition(id, 'COMPLETED', { actor: eventActor(actor), title: 'Marked complete' });
    return this.summary(id);
  }

  async cancel(id: string, input: { reason?: string | null }, actor: Actor): Promise<MissionSummaryDTO> {
    const m = this.row(id);
    if (isTerminal(m.status)) throw new OrbitError('INVALID_TRANSITION', 'This mission already finished.');
    if (m.status === 'PR_CREATED') throw new OrbitError('INVALID_TRANSITION', 'The pull request is already open. Close it on GitHub, then mark the mission complete.');
    if (m.status === 'AWAITING_SCOPE_APPROVAL') this.recordApproval(id, 'scope', 'rejected', actor, input.reason ?? null);
    else if (m.status === 'AWAITING_REVIEW' || m.status === 'AWAITING_PR_APPROVAL') this.recordApproval(id, 'changes', 'rejected', actor, input.reason ?? null);
    this.queue.cancelForMission(id);
    this.transition(id, 'CANCELLED', { actor: eventActor(actor), title: 'Mission cancelled', detail: input.reason ?? null });
    this.hooks.abortMission(id);
    if (!this.hooks.isMissionRunning(id)) await this.cleanupWorktrees(id);
    this.notifier.notify(id, 'cancelled', [`Orbit stopped working on this task${input.reason ? `: ${truncate(input.reason, 300)}` : '.'}`]);
    return this.summary(id);
  }

  /** Removes mission worktrees and unpushed branches after a cancel. Repositories themselves are untouched. */
  async cleanupWorktrees(id: string): Promise<void> {
    for (const mr of this.missionRepoRows(id)) {
      if (mr.prUrl) continue;
      const repo = this.ctx.db.select().from(repos).where(eq(repos.id, mr.repoId)).get();
      if (!repo) continue;
      try {
        if (mr.worktreePath && existsSync(mr.worktreePath)) await this.ctx.git.worktreeRemove(repo.localPath, mr.worktreePath, true);
        await this.ctx.git.worktreePrune(repo.localPath);
        const pushed = this.outbox.get(`git.push:${mr.id}:${mr.commitSha ?? ''}`)?.status === 'succeeded';
        if (mr.branch && !pushed) await this.ctx.git.deleteBranch(repo.localPath, mr.branch);
      } catch (err) {
        recordMissionEvent(this.ctx, id, { kind: 'error', actor: 'git', title: `Could not clean up the worktree for ${repo.name}`, detail: errorMessage(err), missionRepoId: mr.id });
      }
      if (!['pr_created', 'local_only'].includes(mr.status)) this.updateMissionRepo(mr.id, { status: 'discarded' });
    }
  }

  markRequirementsChanged(id: string, detail: string): void {
    const m = this.row(id);
    if (m.requirementsChangedAt) return;
    this.ctx.db.update(missions).set({ requirementsChangedAt: nowIso(this.ctx), updatedAt: nowIso(this.ctx) }).where(eq(missions.id, id)).run();
    recordMissionEvent(this.ctx, id, { kind: 'external', actor: 'asana', title: 'The source task changed after this mission started', detail });
    this.ctx.bus.publish({ type: 'mission.updated', missionId: id, status: m.status });
  }

  activeMissionsForTask(provider: string, taskId: string): MissionRow[] {
    return this.ctx.db
      .select()
      .from(missions)
      .where(and(eq(missions.sourceProvider, provider), eq(missions.sourceTaskId, taskId), notInArray(missions.status, [...TERMINAL_STATES]), isNotNull(missions.activeKey)))
      .all();
  }
}
