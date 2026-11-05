import { and, asc, desc, eq, inArray, lte, sql, jobs, type JobRow, type OrbitDb } from '@orbit/database';
import { errorMessage, newId } from '@orbit/shared';
import type { Logger } from './bus';

export type JobType = 'mission.analyze' | 'mission.execute' | 'mission.publish' | 'mission.notify';

export interface EnqueueInput {
  type: JobType;
  missionId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  priority?: number;
  /** While a job with this key is queued or running, enqueueing another one returns the existing job. */
  dedupeKey?: string;
}

/**
 * Durable SQLite job queue. Jobs survive restarts; a lease marks which worker
 * owns a running job. Claiming happens inside a transaction, and better-sqlite3
 * is synchronous, so two claims can never take the same job.
 */
export class JobQueue {
  constructor(
    private readonly db: OrbitDb,
    private readonly now: () => Date,
  ) {}

  enqueue(input: EnqueueInput): JobRow {
    const ts = this.now().toISOString();
    if (input.dedupeKey) {
      const existing = this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.dedupeKey, input.dedupeKey), inArray(jobs.status, ['queued', 'running'])))
        .get();
      if (existing) return existing;
    }
    try {
      return this.db
        .insert(jobs)
        .values({
          id: newId('job'),
          type: input.type,
          missionId: input.missionId ?? null,
          payload: input.payload ?? {},
          status: 'queued',
          priority: input.priority ?? 0,
          runAt: (input.runAt ?? this.now()).toISOString(),
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 3,
          dedupeKey: input.dedupeKey ?? null,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
    } catch (err) {
      // Lost a race on the partial unique index: return the job that won.
      if (input.dedupeKey && /UNIQUE/i.test(errorMessage(err))) {
        const existing = this.db
          .select()
          .from(jobs)
          .where(and(eq(jobs.dedupeKey, input.dedupeKey), inArray(jobs.status, ['queued', 'running'])))
          .get();
        if (existing) return existing;
      }
      throw err;
    }
  }

  claimNext(owner: string, leaseMs: number, types: readonly JobType[]): JobRow | null {
    const nowIso = this.now().toISOString();
    return this.db.transaction((tx) => {
      const next = tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'queued'), lte(jobs.runAt, nowIso), inArray(jobs.type, [...types])))
        .orderBy(desc(jobs.priority), asc(jobs.runAt), asc(jobs.createdAt))
        .limit(1)
        .get();
      if (!next) return null;
      return (
        tx
          .update(jobs)
          .set({
            status: 'running',
            leaseOwner: owner,
            leaseExpiresAt: new Date(this.now().getTime() + leaseMs).toISOString(),
            attempts: sql`${jobs.attempts} + 1`,
            updatedAt: nowIso,
          })
          .where(and(eq(jobs.id, next.id), eq(jobs.status, 'queued')))
          .returning()
          .get() ?? null
      );
    });
  }

  heartbeat(id: string, owner: string, leaseMs: number): void {
    this.db
      .update(jobs)
      .set({ leaseExpiresAt: new Date(this.now().getTime() + leaseMs).toISOString(), updatedAt: this.now().toISOString() })
      .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner), eq(jobs.status, 'running')))
      .run();
  }

  complete(id: string): void {
    const ts = this.now().toISOString();
    this.db.update(jobs).set({ status: 'succeeded', finishedAt: ts, updatedAt: ts, leaseOwner: null, leaseExpiresAt: null }).where(eq(jobs.id, id)).run();
  }

  /** Marks a job failed, or requeues it with a delay when `retry` is set and attempts remain. */
  fail(id: string, error: string, opts: { retry: boolean; delayMs?: number }): 'requeued' | 'failed' {
    const job = this.get(id);
    const ts = this.now().toISOString();
    if (job && opts.retry && job.attempts < job.maxAttempts) {
      this.db
        .update(jobs)
        .set({
          status: 'queued',
          lastError: error.slice(0, 4000),
          runAt: new Date(this.now().getTime() + (opts.delayMs ?? 5000)).toISOString(),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: ts,
        })
        .where(eq(jobs.id, id))
        .run();
      return 'requeued';
    }
    this.db
      .update(jobs)
      .set({ status: 'failed', lastError: error.slice(0, 4000), finishedAt: ts, updatedAt: ts, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(jobs.id, id))
      .run();
    return 'failed';
  }

  cancelForMission(missionId: string): number {
    const ts = this.now().toISOString();
    return this.db
      .update(jobs)
      .set({ status: 'cancelled', finishedAt: ts, updatedAt: ts, leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(jobs.missionId, missionId), inArray(jobs.status, ['queued', 'running'])))
      .run().changes;
  }

  get(id: string): JobRow | null {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
  }

  activeForMission(missionId: string): JobRow[] {
    return this.db.select().from(jobs).where(and(eq(jobs.missionId, missionId), inArray(jobs.status, ['queued', 'running']))).all();
  }

  /**
   * Orbit runs one worker process. At startup, any job still marked running
   * belonged to a process that died; put it back in the queue.
   */
  requeueOrphaned(): JobRow[] {
    const ts = this.now().toISOString();
    const orphaned = this.db.select().from(jobs).where(eq(jobs.status, 'running')).all();
    for (const job of orphaned) {
      this.db
        .update(jobs)
        .set({ status: 'queued', leaseOwner: null, leaseExpiresAt: null, runAt: ts, updatedAt: ts, lastError: 'Interrupted by a restart' })
        .where(eq(jobs.id, job.id))
        .run();
    }
    return orphaned;
  }

  /** Requeues running jobs whose lease expired (a hung handler that stopped heartbeating). */
  requeueExpired(): number {
    const ts = this.now().toISOString();
    return this.db
      .update(jobs)
      .set({ status: 'queued', leaseOwner: null, leaseExpiresAt: null, updatedAt: ts, lastError: 'Lease expired' })
      .where(and(eq(jobs.status, 'running'), lte(jobs.leaseExpiresAt, ts)))
      .run().changes;
  }
}

export interface JobContext {
  signal: AbortSignal;
  heartbeat(): void;
}

export class RetryableJobError extends Error {
  readonly delayMs: number;
  constructor(message: string, delayMs = 10_000) {
    super(message);
    this.name = 'RetryableJobError';
    this.delayMs = delayMs;
  }
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<void>;

export interface WorkerLane {
  name: string;
  types: readonly JobType[];
  concurrency: () => number;
}

/**
 * Polls the queue and runs handlers with per-lane concurrency limits. The
 * "agent" lane (AI work) defaults to one mission at a time; the "io" lane
 * handles pushes, PRs and comments.
 */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly running = new Map<string, { controller: AbortController; missionId: string | null; lane: string; promise: Promise<void> }>();
  private readonly owner = `worker-${process.pid}-${newId('job', 4)}`;
  private ticking = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Partial<Record<JobType, JobHandler>>,
    private readonly lanes: WorkerLane[],
    private readonly log: Logger,
    private readonly opts: { pollMs?: number; leaseMs?: number } = {},
  ) {}

  private get leaseMs() {
    return this.opts.leaseMs ?? 120_000;
  }

  start(): void {
    this.stopping = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 1000);
    void this.tick();
  }

  /** Check the queue now instead of waiting for the next poll. */
  wake(): void {
    if (!this.stopping) setImmediate(() => void this.tick());
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const all = [...this.running.values()];
    const timeout = new Promise<void>((r) => setTimeout(r, timeoutMs).unref());
    await Promise.race([Promise.allSettled(all.map((r) => r.promise)), timeout]);
    for (const r of this.running.values()) r.controller.abort();
  }

  /** Aborts running jobs of a mission (used by cancel). */
  abortMission(missionId: string): number {
    let n = 0;
    for (const r of this.running.values()) {
      if (r.missionId === missionId) {
        r.controller.abort();
        n++;
      }
    }
    return n;
  }

  isMissionRunning(missionId: string): boolean {
    for (const r of this.running.values()) if (r.missionId === missionId) return true;
    return false;
  }

  /** Waits until no job is running or queued for the given types (tests and graceful flows). */
  async idle(timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.running.size === 0 && !this.ticking) {
        await this.tick();
        if (this.running.size === 0) return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('Worker did not become idle in time');
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      this.queue.requeueExpired();
      for (const lane of this.lanes) {
        let active = [...this.running.values()].filter((r) => r.lane === lane.name).length;
        while (active < lane.concurrency()) {
          const job = this.queue.claimNext(this.owner, this.leaseMs, lane.types);
          if (!job) break;
          this.launch(job, lane.name);
          active++;
        }
      }
    } catch (err) {
      this.log.error('worker tick failed', errorMessage(err));
    } finally {
      this.ticking = false;
    }
  }

  private launch(job: JobRow, lane: string): void {
    const handler = this.handlers[job.type as JobType];
    const controller = new AbortController();
    const heartbeat = () => this.queue.heartbeat(job.id, this.owner, this.leaseMs);
    const beat = setInterval(heartbeat, Math.max(1000, Math.floor(this.leaseMs / 3)));
    const promise = (async () => {
      try {
        if (!handler) throw new Error(`No handler for job type ${job.type}`);
        await handler(job, { signal: controller.signal, heartbeat });
        this.queue.complete(job.id);
      } catch (err) {
        const msg = errorMessage(err);
        if (controller.signal.aborted) {
          this.queue.fail(job.id, `Cancelled: ${msg}`, { retry: false });
        } else if (err instanceof RetryableJobError) {
          const outcome = this.queue.fail(job.id, msg, { retry: true, delayMs: err.delayMs });
          this.log.warn(`job ${job.type} ${job.id} ${outcome === 'requeued' ? 'will retry' : 'failed'}`, msg);
        } else {
          this.queue.fail(job.id, msg, { retry: false });
          this.log.error(`job ${job.type} ${job.id} failed`, msg);
        }
      } finally {
        clearInterval(beat);
        this.running.delete(job.id);
        this.wake();
      }
    })();
    this.running.set(job.id, { controller, missionId: job.missionId, lane, promise });
  }
}
