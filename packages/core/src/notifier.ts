import { eq, missions, type JobRow } from '@orbit/database';
import { ProviderError } from '@orbit/integrations';
import { errorMessage, redactSecrets, truncate } from '@orbit/shared';
import { recordMissionEvent, type OrbitContext } from './context';
import type { IntegrationService } from './integrations';
import type { Outbox } from './outbox';
import { RetryableJobError, type JobQueue } from './queue';

export type Milestone = 'received' | 'plan' | 'started' | 'review' | 'pr' | 'blocked' | 'failed' | 'cancelled' | 'completed' | 'status';

const MINIMAL: ReadonlySet<Milestone> = new Set(['plan', 'pr', 'blocked', 'failed', 'status']);

/**
 * Posts mission progress back to the source task. Every comment goes through
 * the outbox with a marker in its footer, so a retry after a crash finds the
 * earlier comment instead of posting a duplicate.
 */
export class Notifier {
  constructor(
    private readonly ctx: OrbitContext,
    private readonly queue: JobQueue,
    private readonly integrations: IntegrationService,
    private readonly outbox: Outbox,
  ) {}

  notify(missionId: string, milestone: Milestone, lines: string[], discriminator?: string | number): void {
    const m = this.ctx.db.select().from(missions).where(eq(missions.id, missionId)).get();
    if (!m || m.sourceProvider === 'local' || !m.sourceTaskId || !m.integrationId) return;
    const verbosity = this.ctx.settings.get().asana.commentVerbosity;
    if (verbosity === 'minimal' && !MINIMAL.has(milestone)) return;
    const disc = discriminator ?? m.iteration;
    const key = `asana.comment:${missionId}:${milestone}:${disc}`;
    const marker = `orbit:${missionId}:${milestone}:${disc}`;
    const link = `${this.ctx.dashboardUrl()}/missions/${missionId}`;
    const text = redactSecrets([...lines.filter(Boolean), '', `Open in Orbit: ${link}`, `— Orbit · ${marker}`].join('\n'));
    this.queue.enqueue({
      type: 'mission.notify',
      missionId,
      payload: { key, marker, text, taskId: m.sourceTaskId, integrationId: m.integrationId, milestone },
      dedupeKey: key,
      maxAttempts: 5,
    });
  }

  async handle(job: JobRow): Promise<void> {
    const p = job.payload as { key: string; marker: string; text: string; taskId: string; integrationId: string; milestone: string };
    let provider;
    try {
      provider = this.integrations.providerFor(p.integrationId);
    } catch (err) {
      if (job.missionId) recordMissionEvent(this.ctx, job.missionId, { kind: 'error', actor: 'asana', title: 'Could not post progress to Asana', detail: errorMessage(err) });
      return;
    }
    try {
      const { reused } = await this.outbox.perform(
        p.key,
        { kind: 'asana.comment', missionId: job.missionId, request: { taskId: p.taskId, milestone: p.milestone } },
        {
          check: async () => {
            const found = await provider.findCommentContaining(p.taskId, p.marker);
            return found ? { commentId: found.id } : null;
          },
          execute: async () => {
            const c = await provider.postComment(p.taskId, p.text);
            return { commentId: c.id };
          },
        },
      );
      if (job.missionId) {
        recordMissionEvent(this.ctx, job.missionId, {
          kind: 'external',
          actor: 'asana',
          title: reused ? `Asana already had the ${p.milestone} update` : `Posted ${p.milestone} update to Asana`,
          detail: truncate(p.text, 600),
        });
      }
    } catch (err) {
      this.integrations.noteProviderError(p.integrationId, err);
      const retryable = err instanceof ProviderError && ['rate_limited', 'unavailable', 'network'].includes(err.kind);
      if (job.missionId) {
        recordMissionEvent(this.ctx, job.missionId, {
          kind: 'error',
          actor: 'asana',
          title: retryable ? 'Asana comment delayed, will retry' : 'Could not post progress to Asana',
          detail: errorMessage(err),
        });
      }
      if (retryable) {
        const delay = err instanceof ProviderError && err.retryAfterSec ? err.retryAfterSec * 1000 : 30_000;
        throw new RetryableJobError(errorMessage(err), delay);
      }
    }
  }
}
