import { and, desc, eq, externalProjects, integrations, triggers, type ExternalProjectRow } from '@orbit/database';
import { ProviderError, type TaskChange, type TriggerCandidate } from '@orbit/integrations';
import { errorMessage, MISSION_STATE_META, newId, OrbitError, truncate } from '@orbit/shared';
import { audit, nowIso, type OrbitContext } from './context';
import type { IntegrationService } from './integrations';
import { contentHash, type MissionService } from './missions';
import type { Notifier } from './notifier';
import type { Outbox } from './outbox';

export interface PollSummary {
  projectId: string;
  triggers: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  error: string | null;
  resynced: boolean;
  reconciled: boolean;
}

/**
 * Watches connected projects for `/orbit` comments through the provider's
 * event feed (Asana Events API with persisted sync tokens). Delivery is
 * at-most-once and may repeat across polls, so every comment is deduplicated
 * by its id before anything happens, and only authorized authors can start work.
 */
export class TriggerService {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = true;

  constructor(
    private readonly ctx: OrbitContext,
    private readonly integrationService: IntegrationService,
    private readonly missions: MissionService,
    private readonly notifier: Notifier,
    private readonly outbox: Outbox,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(2000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.pollAll().catch((err) => this.ctx.log.error('trigger poll failed', errorMessage(err)));
      this.schedule(this.ctx.settings.get().asana.pollIntervalSeconds * 1000);
    }, ms);
    this.timer.unref?.();
  }

  async pollAll(): Promise<PollSummary[]> {
    if (this.polling) return [];
    this.polling = true;
    try {
      const rows = this.ctx.db
        .select({ p: externalProjects, status: integrations.status })
        .from(externalProjects)
        .innerJoin(integrations, eq(integrations.id, externalProjects.integrationId))
        .where(eq(externalProjects.triggersEnabled, true))
        .all();
      const out: PollSummary[] = [];
      for (const { p, status } of rows) {
        if (status !== 'connected') continue;
        out.push(await this.pollProject(p));
      }
      return out;
    } finally {
      this.polling = false;
    }
  }

  async pollProject(project: ExternalProjectRow): Promise<PollSummary> {
    const settings = this.ctx.settings.get();
    const summary: PollSummary = { projectId: project.id, triggers: 0, accepted: 0, rejected: 0, duplicates: 0, error: null, resynced: false, reconciled: false };
    const everyMs = settings.asana.reconcileEveryMinutes * 60_000;
    const due = everyMs > 0 && (!project.lastReconciledAt || this.ctx.now().getTime() - Date.parse(project.lastReconciledAt) > everyMs);
    try {
      const provider = this.integrationService.providerFor(project.integrationId);
      const result = await provider.pollTriggers(
        project.externalId,
        { syncToken: project.syncToken, lastPolledAt: project.lastPolledAt, lastEventAt: project.lastEventAt, lastReconciledAt: project.lastReconciledAt },
        { reconcile: due && !!project.syncToken, reconcileTaskLimit: settings.asana.reconcileTaskLimit, ignoreCommentIds: this.outbox.postedCommentIds() },
      );
      this.ctx.db
        .update(externalProjects)
        .set({
          syncToken: result.state.syncToken,
          lastPolledAt: result.state.lastPolledAt,
          lastEventAt: result.state.lastEventAt,
          lastReconciledAt: result.state.lastReconciledAt,
          pollError: null,
          updatedAt: nowIso(this.ctx),
        })
        .where(eq(externalProjects.id, project.id))
        .run();
      summary.resynced = result.resynced;
      summary.reconciled = result.reconciled;
      for (const w of result.warnings) audit(this.ctx, { actor: 'orbit', action: 'asana.sync_warning', target: project.id, summary: w });
      this.integrationService.setStatus(project.integrationId, 'connected', null);
      for (const t of result.triggers) {
        summary.triggers++;
        const outcome = await this.handleTrigger(project, t);
        if (outcome === 'accepted' || outcome === 'needs_approval') summary.accepted++;
        else if (outcome === 'duplicate') summary.duplicates++;
        else if (outcome === 'rejected') summary.rejected++;
      }
      for (const change of result.taskChanges) await this.handleTaskChange(project, change);
    } catch (err) {
      const msg = errorMessage(err);
      summary.error = msg;
      this.integrationService.noteProviderError(project.integrationId, err);
      this.ctx.db.update(externalProjects).set({ pollError: truncate(msg, 500), updatedAt: nowIso(this.ctx) }).where(eq(externalProjects.id, project.id)).run();
      if (!(err instanceof ProviderError && err.kind === 'rate_limited')) this.ctx.log.warn(`polling ${project.name} failed`, msg);
    }
    return summary;
  }

  /** Records the trigger exactly once, authorizes the author, then creates (or reuses) a mission. */
  async handleTrigger(project: ExternalProjectRow, t: TriggerCandidate): Promise<'accepted' | 'rejected' | 'duplicate' | 'needs_approval' | 'ignored' | 'error'> {
    const ts = nowIso(this.ctx);
    const triggerId = newId('trg');
    const inserted = this.ctx.db
      .insert(triggers)
      .values({
        id: triggerId,
        provider: t.provider,
        integrationId: project.integrationId,
        projectId: project.id,
        dedupeKey: t.dedupeKey,
        externalTaskId: t.taskId,
        externalUserId: t.author?.id ?? null,
        externalUserName: t.author?.name ?? null,
        command: t.command,
        verified: false,
        status: 'ignored',
        reason: 'processing',
        createdAt: ts,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!inserted) return 'duplicate';

    const setTrigger = (status: 'accepted' | 'rejected' | 'duplicate' | 'needs_approval' | 'error' | 'ignored', reason: string | null, extra: { missionId?: string; verified?: boolean } = {}) => {
      this.ctx.db
        .update(triggers)
        .set({ status, reason, ...(extra.missionId ? { missionId: extra.missionId } : {}), ...(extra.verified !== undefined ? { verified: extra.verified } : {}) })
        .where(eq(triggers.id, triggerId))
        .run();
      this.ctx.bus.publish({ type: 'trigger.received', provider: t.provider, taskId: t.taskId, status, reason });
    };

    const authorized = this.integrationService.isAuthorized(project.integrationId, t.author?.id);
    const authorName = t.author?.name ?? t.author?.id ?? 'unknown user';

    if (t.author && !authorized) {
      setTrigger('rejected', `${authorName} is not authorized to run Orbit missions.`);
      audit(this.ctx, {
        actor: `asana:${t.author.id}`,
        action: 'trigger.rejected',
        target: t.taskId,
        summary: `Ignored /orbit ${t.command} from ${authorName}: not an authorized Orbit user. Authorize them in Integrations if this was intended.`,
      });
      return 'rejected';
    }

    if (t.command === 'cancel' || t.command === 'status') {
      if (!t.author) {
        setTrigger('rejected', 'Commands other than run require a verified author.');
        return 'rejected';
      }
      const active = this.missions.findActiveForTask(t.provider, t.taskId);
      if (!active) {
        setTrigger('ignored', 'No active mission for this task.');
        return 'ignored';
      }
      if (t.command === 'cancel') {
        try {
          await this.missions.cancel(active.id, { reason: `Cancelled from Asana by ${authorName}` }, { type: 'external', provider: 'asana', id: t.author.id, name: authorName, verified: true });
          setTrigger('accepted', 'Mission cancelled.', { missionId: active.id, verified: true });
        } catch (err) {
          setTrigger('error', errorMessage(err), { missionId: active.id });
          return 'error';
        }
      } else {
        this.notifier.notify(active.id, 'status', [`Status: ${MISSION_STATE_META[active.status].label}. ${MISSION_STATE_META[active.status].description}`], t.commentId);
        setTrigger('accepted', 'Status posted.', { missionId: active.id, verified: true });
      }
      return 'accepted';
    }

    const verified = !!t.author && authorized;
    try {
      const { mission, created } = await this.missions.create({
        source: { provider: 'asana', integrationId: project.integrationId, taskId: t.taskId, projectId: project.id },
        entryPoint: 'asana-comment',
        triggeredBy: t.author
          ? { type: 'external', provider: 'asana', id: t.author.id, name: authorName, verified }
          : { type: 'external', provider: 'asana', name: 'unknown Asana user', verified: false },
        triggerVerified: verified,
        extraInstructions: t.extraInstructions,
      });
      if (!created) {
        setTrigger('duplicate', `Mission ${mission.id} is already active for this task.`, { missionId: mission.id, verified });
        return 'duplicate';
      }
      setTrigger(verified ? 'accepted' : 'needs_approval', verified ? null : 'Author could not be verified; waiting for approval in Orbit.', { missionId: mission.id, verified });
      audit(this.ctx, { actor: `asana:${t.author?.id ?? 'unknown'}`, action: 'trigger.accepted', target: mission.id, summary: `/orbit run from ${authorName} started mission ${mission.id}` });
      return verified ? 'accepted' : 'needs_approval';
    } catch (err) {
      setTrigger('error', errorMessage(err));
      audit(this.ctx, { actor: 'orbit', action: 'trigger.error', target: t.taskId, summary: `Could not start a mission from /orbit run: ${errorMessage(err)}` });
      return 'error';
    }
  }

  async handleTaskChange(project: ExternalProjectRow, change: TaskChange): Promise<void> {
    const active = this.missions.activeMissionsForTask(project.provider, change.taskId);
    if (active.length === 0) return;
    for (const m of active) {
      if (change.kind === 'deleted') {
        if (m.status === 'DRAFT' || m.status === 'AWAITING_SCOPE_APPROVAL') {
          await this.missions.cancel(m.id, { reason: 'The source task was deleted.' }, { type: 'system', name: 'Orbit' }).catch(() => undefined);
        } else {
          this.missions.markRequirementsChanged(m.id, 'The source task was deleted in Asana.');
        }
        continue;
      }
      try {
        const task = await this.integrationService.providerFor(project.integrationId).getTask(change.taskId);
        const rev = this.missions.currentRevision(m);
        if (contentHash(task.title, task.description) !== rev.contentHash) {
          this.missions.markRequirementsChanged(m.id, 'The title or description changed. Replan to use the new version, or continue with the snapshot taken at start.');
        }
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'not_found') this.missions.markRequirementsChanged(m.id, 'The source task is no longer accessible.');
      }
    }
  }

  recent(limit = 50) {
    return this.ctx.db.select().from(triggers).orderBy(desc(triggers.createdAt)).limit(limit).all();
  }

  /** Runs one poll for a project right away (dashboard "Check now"). */
  async pollNow(projectId: string): Promise<PollSummary> {
    const p = this.ctx.db.select().from(externalProjects).where(and(eq(externalProjects.id, projectId))).get();
    if (!p) throw new OrbitError('NOT_FOUND', 'Project is not connected.');
    return this.pollProject(p);
  }
}
