import { eq, inArray, like, sql, sideEffects, type SideEffectRow } from '@orbit/database';
import { errorMessage, newId, redactDeep, redactSecrets } from '@orbit/shared';
import { nowIso, type OrbitContext } from './context';

export interface SideEffectMeta {
  kind: string;
  missionId?: string | null;
  missionRepoId?: string | null;
  request?: unknown;
}

export interface SideEffectOps<T> {
  /** Looks for evidence that the operation already happened (e.g. an existing PR for the branch). */
  check: () => Promise<T | null>;
  execute: () => Promise<T>;
}

/**
 * Records every outward-facing operation (comments, pushes, pull requests) with
 * an idempotency key. If a previous attempt is uncertain (crash, timeout, error
 * after the request left), Orbit checks whether it already succeeded before
 * trying again, so duplicates are not created.
 */
export class Outbox {
  constructor(private readonly ctx: OrbitContext) {}

  get(key: string): SideEffectRow | null {
    return this.ctx.db.select().from(sideEffects).where(eq(sideEffects.idempotencyKey, key)).get() ?? null;
  }

  listForMission(missionId: string): SideEffectRow[] {
    return this.ctx.db.select().from(sideEffects).where(eq(sideEffects.missionId, missionId)).all();
  }

  /** In-flight operations at startup belong to a dead process: their outcome is unknown. */
  markInFlightUnknown(): number {
    return this.ctx.db
      .update(sideEffects)
      .set({ status: 'unknown', updatedAt: nowIso(this.ctx) })
      .where(eq(sideEffects.status, 'in_flight'))
      .run().changes;
  }

  /** Comment ids Orbit posted itself (never treated as triggers). */
  postedCommentIds(): Set<string> {
    const rows = this.ctx.db
      .select({ result: sideEffects.result })
      .from(sideEffects)
      .where(inArray(sideEffects.status, ['succeeded']))
      .all();
    const ids = new Set<string>();
    for (const r of rows) {
      const id = (r.result as { commentId?: string } | null)?.commentId;
      if (id) ids.add(id);
    }
    return ids;
  }

  countWithPrefix(prefix: string): number {
    return this.ctx.db.select({ n: sql<number>`count(*)` }).from(sideEffects).where(like(sideEffects.idempotencyKey, `${prefix}%`)).get()?.n ?? 0;
  }

  async perform<T>(key: string, meta: SideEffectMeta, ops: SideEffectOps<T>): Promise<{ result: T; reused: boolean }> {
    const ts = nowIso(this.ctx);
    let row = this.get(key);
    if (!row) {
      row = this.ctx.db
        .insert(sideEffects)
        .values({
          id: newId('fx'),
          missionId: meta.missionId ?? null,
          missionRepoId: meta.missionRepoId ?? null,
          kind: meta.kind,
          idempotencyKey: key,
          status: 'pending',
          request: meta.request === undefined ? null : redactDeep(meta.request),
          attempts: 0,
          createdAt: ts,
          updatedAt: ts,
        })
        .onConflictDoNothing()
        .returning()
        .get() ?? this.get(key);
      if (!row) throw new Error(`Could not record side effect ${key}`);
    }
    if (row.status === 'succeeded') return { result: row.result as T, reused: true };

    if (row.attempts > 0) {
      const existing = await ops.check();
      if (existing !== null) {
        this.finish(row.id, 'succeeded', existing, null);
        return { result: existing, reused: true };
      }
    }

    this.ctx.db
      .update(sideEffects)
      .set({ status: 'in_flight', attempts: row.attempts + 1, updatedAt: nowIso(this.ctx) })
      .where(eq(sideEffects.id, row.id))
      .run();
    try {
      const result = await ops.execute();
      this.finish(row.id, 'succeeded', result, null);
      return { result, reused: false };
    } catch (err) {
      this.finish(row.id, 'failed', null, redactSecrets(errorMessage(err)));
      throw err;
    }
  }

  private finish(id: string, status: 'succeeded' | 'failed', result: unknown, error: string | null) {
    this.ctx.db
      .update(sideEffects)
      .set({
        status,
        ...(status === 'succeeded' ? { result: result === undefined ? null : redactDeep(result) } : {}),
        lastError: error,
        updatedAt: nowIso(this.ctx),
      })
      .where(eq(sideEffects.id, id))
      .run();
  }
}
