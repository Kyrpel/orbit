import type { AgentRuntime } from '@orbit/agents';
import { eq, auditLog, missionEvents, settings as settingsTable, type IntegrationRow, type OrbitDb, type SqliteDatabase } from '@orbit/database';
import type { CommandRunner, Git, GitHubClient } from '@orbit/git';
import type { TaskProvider } from '@orbit/integrations';
import {
  mergeSettings,
  parseStoredSettings,
  redactDeep,
  redactSecrets,
  type MissionEventActor,
  type MissionEventDTO,
  type MissionEventKind,
  type RuntimeId,
  type Settings,
  type SettingsPatch,
} from '@orbit/shared';
import type { EventBus, Logger } from './bus';
import type { OrbitPaths } from './paths';
import type { SecretStore } from './secrets';

export type ProviderFactory = (integration: IntegrationRow, token: string, settings: Settings) => TaskProvider;

/** Shared dependencies for every Orbit service. Created once by `createOrbit`. */
export interface OrbitContext {
  db: OrbitDb;
  sqlite: SqliteDatabase;
  paths: OrbitPaths;
  bus: EventBus;
  log: Logger;
  git: Git;
  github: GitHubClient;
  runner: CommandRunner;
  secrets: SecretStore;
  settings: SettingsService;
  runtimes: Map<RuntimeId, AgentRuntime>;
  providerFactory: ProviderFactory;
  now: () => Date;
  /** Base URL of the dashboard, used in links Orbit posts to task comments. */
  dashboardUrl: () => string;
  env: NodeJS.ProcessEnv;
  /** The host platform; injectable so tests can check Windows-specific routing anywhere. */
  platform: NodeJS.Platform;
}

export const nowIso = (ctx: Pick<OrbitContext, 'now'>): string => ctx.now().toISOString();

const SETTINGS_KEY = 'orbit.settings';

export class SettingsService {
  private cached: Settings | null = null;
  constructor(
    private readonly db: OrbitDb,
    private readonly bus: EventBus,
    private readonly now: () => Date,
  ) {}

  get(): Settings {
    if (this.cached) return this.cached;
    const row = this.db.select().from(settingsTable).where(eq(settingsTable.key, SETTINGS_KEY)).get();
    this.cached = parseStoredSettings(row?.value);
    return this.cached;
  }

  update(patch: SettingsPatch): Settings {
    const next = mergeSettings(this.get(), patch);
    const ts = this.now().toISOString();
    this.db
      .insert(settingsTable)
      .values({ key: SETTINGS_KEY, value: next, updatedAt: ts })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: next, updatedAt: ts } })
      .run();
    this.cached = next;
    this.bus.publish({ type: 'settings.updated' });
    return next;
  }
}

export function audit(
  ctx: Pick<OrbitContext, 'db' | 'now'>,
  entry: { actor: string; action: string; target?: string | null; summary: string; details?: unknown },
): void {
  ctx.db
    .insert(auditLog)
    .values({
      ts: nowIso(ctx),
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      summary: redactSecrets(entry.summary),
      details: entry.details === undefined ? null : redactDeep(entry.details),
    })
    .run();
}

export interface MissionEventInput {
  kind: MissionEventKind;
  actor: MissionEventActor;
  title: string;
  detail?: string | null;
  data?: unknown;
  missionRepoId?: string | null;
}

/** Appends to the durable mission history and pushes it to live dashboards. */
export function recordMissionEvent(ctx: Pick<OrbitContext, 'db' | 'now' | 'bus'>, missionId: string, input: MissionEventInput): MissionEventDTO {
  const row = ctx.db
    .insert(missionEvents)
    .values({
      missionId,
      missionRepoId: input.missionRepoId ?? null,
      ts: nowIso(ctx),
      kind: input.kind,
      actor: input.actor,
      title: redactSecrets(input.title).slice(0, 500),
      detail: input.detail ? redactSecrets(input.detail).slice(0, 20_000) : null,
      data: input.data === undefined ? null : redactDeep(input.data),
    })
    .returning()
    .get();
  const dto: MissionEventDTO = {
    id: row.id,
    missionId: row.missionId,
    missionRepoId: row.missionRepoId,
    ts: row.ts,
    kind: row.kind as MissionEventKind,
    actor: row.actor as MissionEventActor,
    title: row.title,
    detail: row.detail,
    data: row.data,
  };
  ctx.bus.publish({ type: 'mission.event', missionId, event: dto });
  return dto;
}
