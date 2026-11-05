import { and, desc, eq, inArray, authorizedUsers, externalProjects, integrations, missions, projectRepos, repos, type ExternalProjectRow, type IntegrationRow } from '@orbit/database';
import { ProviderError, type TaskProvider } from '@orbit/integrations';
import {
  newId,
  OrbitError,
  TERMINAL_STATES,
  type ExternalProjectDTO,
  type ExternalTaskDTO,
  type IntegrationDTO,
  type MissionState,
  type WorkspaceDTO,
} from '@orbit/shared';
import { audit, nowIso, type OrbitContext } from './context';

export function providerErrorToOrbit(err: unknown): never {
  if (err instanceof ProviderError) {
    const code =
      err.kind === 'auth'
        ? 'UNAUTHORIZED'
        : err.kind === 'forbidden'
          ? 'FORBIDDEN'
          : err.kind === 'not_found'
            ? 'NOT_FOUND'
            : err.kind === 'rate_limited'
              ? 'RATE_LIMITED'
              : err.kind === 'invalid' || err.kind === 'payment_required'
                ? 'VALIDATION'
                : 'EXTERNAL';
    throw new OrbitError(code, err.message, {
      ...(err.kind === 'auth' ? { hint: 'Reconnect the integration with a new token.' } : {}),
      ...(err.retryAfterSec != null ? { details: { retryAfterSec: err.retryAfterSec } } : {}),
    });
  }
  throw err;
}

export class IntegrationService {
  private readonly providers = new Map<string, { token: string; provider: TaskProvider }>();

  constructor(private readonly ctx: OrbitContext) {}

  private row(id: string): IntegrationRow {
    const row = this.ctx.db.select().from(integrations).where(eq(integrations.id, id)).get();
    if (!row) throw new OrbitError('NOT_FOUND', 'Integration not found.');
    return row;
  }

  toDTO(row: IntegrationRow): IntegrationDTO {
    const users = this.ctx.db.select().from(authorizedUsers).where(eq(authorizedUsers.integrationId, row.id)).all();
    return {
      id: row.id,
      provider: row.provider,
      displayName: row.displayName,
      account: { id: row.accountUserId, name: row.accountName, email: row.accountEmail },
      authType: row.authType,
      status: row.status,
      statusMessage: row.statusMessage,
      authorizedUsers: users.map((u) => ({ externalUserId: u.externalUserId, displayName: u.displayName, email: u.email })),
      createdAt: row.createdAt,
    };
  }

  list(): IntegrationDTO[] {
    return this.ctx.db.select().from(integrations).orderBy(integrations.createdAt).all().map((r) => this.toDTO(r));
  }

  get(id: string): IntegrationDTO {
    return this.toDTO(this.row(id));
  }

  /** Verifies a personal access token with GET /users/me, stores it in the secret store and authorizes its owner. */
  async connectAsana(token: string, actor = 'user'): Promise<IntegrationDTO> {
    const trimmed = token.trim();
    if (trimmed.length < 16) throw new OrbitError('VALIDATION', 'That does not look like an Asana personal access token.');
    const ts = nowIso(this.ctx);
    const probeRow: IntegrationRow = {
      id: 'probe',
      provider: 'asana',
      displayName: 'Asana',
      accountUserId: null,
      accountName: null,
      accountEmail: null,
      authType: 'pat',
      secretRef: 'probe',
      status: 'connected',
      statusMessage: null,
      createdAt: ts,
      updatedAt: ts,
    };
    let me;
    try {
      me = await this.ctx.providerFactory(probeRow, trimmed, this.ctx.settings.get()).verify();
    } catch (err) {
      providerErrorToOrbit(err);
    }
    const existing = this.ctx.db
      .select()
      .from(integrations)
      .where(and(eq(integrations.provider, 'asana'), eq(integrations.accountUserId, me.id)))
      .get();
    const id = existing?.id ?? newId('int');
    const secretRef = existing?.secretRef ?? `asana:${id}`;
    this.ctx.secrets.set(secretRef, trimmed);
    if (existing) {
      this.ctx.db
        .update(integrations)
        .set({ accountName: me.name, accountEmail: me.email, status: 'connected', statusMessage: null, updatedAt: ts })
        .where(eq(integrations.id, id))
        .run();
    } else {
      this.ctx.db
        .insert(integrations)
        .values({
          id,
          provider: 'asana',
          displayName: 'Asana',
          accountUserId: me.id,
          accountName: me.name,
          accountEmail: me.email,
          authType: 'pat',
          secretRef,
          status: 'connected',
          statusMessage: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }
    this.ctx.db
      .insert(authorizedUsers)
      .values({ id: newId('usr'), integrationId: id, externalUserId: me.id, displayName: me.name, email: me.email, createdAt: ts })
      .onConflictDoNothing()
      .run();
    this.providers.delete(id);
    audit(this.ctx, { actor, action: 'integration.connected', target: id, summary: `Connected Asana as ${me.name ?? me.id}` });
    this.ctx.bus.publish({ type: 'integrations.updated' });
    return this.get(id);
  }

  /** Deletes the stored token and every Orbit link to this account. Mission history is kept. */
  disconnect(id: string, actor = 'user'): void {
    const row = this.row(id);
    this.ctx.secrets.delete(row.secretRef);
    this.ctx.db.delete(integrations).where(eq(integrations.id, id)).run();
    this.providers.delete(id);
    audit(this.ctx, {
      actor,
      action: 'integration.disconnected',
      target: id,
      summary: `Disconnected ${row.displayName}. The token was deleted from this machine; revoke it in Asana too if it is no longer needed.`,
    });
    this.ctx.bus.publish({ type: 'integrations.updated' });
  }

  providerFor(integrationId: string): TaskProvider {
    const row = this.row(integrationId);
    const token = this.ctx.secrets.get(row.secretRef);
    if (!token) throw new OrbitError('NOT_CONFIGURED', `${row.displayName} token is missing on this machine.`, { hint: 'Reconnect the integration.' });
    const cached = this.providers.get(integrationId);
    if (cached && cached.token === token) return cached.provider;
    const provider = this.ctx.providerFactory(row, token, this.ctx.settings.get());
    this.providers.set(integrationId, { token, provider });
    return provider;
  }

  setStatus(id: string, status: IntegrationRow['status'], message: string | null): void {
    const row = this.ctx.db.select().from(integrations).where(eq(integrations.id, id)).get();
    if (!row || (row.status === status && row.statusMessage === message)) return;
    this.ctx.db.update(integrations).set({ status, statusMessage: message, updatedAt: nowIso(this.ctx) }).where(eq(integrations.id, id)).run();
    this.ctx.bus.publish({ type: 'integrations.updated' });
  }

  /** Marks the integration broken when the provider reports revoked or insufficient access. */
  noteProviderError(integrationId: string, err: unknown): void {
    if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'forbidden')) {
      this.setStatus(integrationId, err.kind === 'auth' ? 'revoked' : 'error', err.message);
    }
  }

  isAuthorized(integrationId: string, externalUserId: string | null | undefined): boolean {
    if (!externalUserId) return false;
    return !!this.ctx.db
      .select()
      .from(authorizedUsers)
      .where(and(eq(authorizedUsers.integrationId, integrationId), eq(authorizedUsers.externalUserId, externalUserId)))
      .get();
  }

  addAuthorizedUser(integrationId: string, user: { externalUserId: string; displayName?: string | null; email?: string | null }, actor = 'user'): IntegrationDTO {
    this.row(integrationId);
    if (!/^\d{3,}$/.test(user.externalUserId.trim())) throw new OrbitError('VALIDATION', 'Use the numeric Asana user gid.');
    this.ctx.db
      .insert(authorizedUsers)
      .values({
        id: newId('usr'),
        integrationId,
        externalUserId: user.externalUserId.trim(),
        displayName: user.displayName ?? null,
        email: user.email ?? null,
        createdAt: nowIso(this.ctx),
      })
      .onConflictDoNothing()
      .run();
    audit(this.ctx, { actor, action: 'integration.user_authorized', target: integrationId, summary: `Authorized Asana user ${user.displayName ?? user.externalUserId} to trigger missions` });
    this.ctx.bus.publish({ type: 'integrations.updated' });
    return this.get(integrationId);
  }

  removeAuthorizedUser(integrationId: string, externalUserId: string, actor = 'user'): IntegrationDTO {
    this.ctx.db
      .delete(authorizedUsers)
      .where(and(eq(authorizedUsers.integrationId, integrationId), eq(authorizedUsers.externalUserId, externalUserId)))
      .run();
    audit(this.ctx, { actor, action: 'integration.user_unauthorized', target: integrationId, summary: `Removed trigger permission for ${externalUserId}` });
    this.ctx.bus.publish({ type: 'integrations.updated' });
    return this.get(integrationId);
  }

  async listWorkspaces(integrationId: string): Promise<WorkspaceDTO[]> {
    try {
      return await this.providerFor(integrationId).listWorkspaces();
    } catch (err) {
      this.noteProviderError(integrationId, err);
      return providerErrorToOrbit(err);
    }
  }

  async listRemoteProjects(integrationId: string, workspaceId: string) {
    const connected = new Map(
      this.ctx.db
        .select()
        .from(externalProjects)
        .where(eq(externalProjects.integrationId, integrationId))
        .all()
        .map((p) => [p.externalId, p.id]),
    );
    try {
      const list = await this.providerFor(integrationId).listProjects(workspaceId);
      return list.filter((p) => !p.archived).map((p) => ({ ...p, connectedProjectId: connected.get(p.id) ?? null }));
    } catch (err) {
      this.noteProviderError(integrationId, err);
      return providerErrorToOrbit(err);
    }
  }

  projectRow(id: string): ExternalProjectRow {
    const row = this.ctx.db.select().from(externalProjects).where(eq(externalProjects.id, id)).get();
    if (!row) throw new OrbitError('NOT_FOUND', 'Project is not connected.');
    return row;
  }

  projectToDTO(row: ExternalProjectRow): ExternalProjectDTO {
    const repoIds = this.ctx.db.select().from(projectRepos).where(eq(projectRepos.projectId, row.id)).all().map((r) => r.repoId);
    return {
      id: row.id,
      integrationId: row.integrationId,
      provider: row.provider,
      externalId: row.externalId,
      name: row.name,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      url: row.url,
      triggersEnabled: row.triggersEnabled,
      repoIds,
      lastPolledAt: row.lastPolledAt,
      lastEventAt: row.lastEventAt,
      lastReconciledAt: row.lastReconciledAt,
      pollError: row.pollError,
      createdAt: row.createdAt,
    };
  }

  listProjects(): ExternalProjectDTO[] {
    return this.ctx.db.select().from(externalProjects).orderBy(externalProjects.name).all().map((r) => this.projectToDTO(r));
  }

  private setMapping(projectId: string, repoIds: string[]): void {
    const unique = [...new Set(repoIds)];
    if (unique.length) {
      const found = this.ctx.db.select({ id: repos.id }).from(repos).where(inArray(repos.id, unique)).all();
      if (found.length !== unique.length) throw new OrbitError('VALIDATION', 'One or more repositories are not connected to Orbit.');
    }
    const ts = nowIso(this.ctx);
    this.ctx.db.transaction((tx) => {
      tx.delete(projectRepos).where(eq(projectRepos.projectId, projectId)).run();
      for (const repoId of unique) tx.insert(projectRepos).values({ projectId, repoId, createdAt: ts }).run();
    });
  }

  async connectProject(integrationId: string, externalProjectId: string, repoIds: string[], actor = 'user'): Promise<ExternalProjectDTO> {
    const integration = this.row(integrationId);
    let project;
    try {
      project = await this.providerFor(integrationId).getProject(externalProjectId);
    } catch (err) {
      this.noteProviderError(integrationId, err);
      providerErrorToOrbit(err);
    }
    const ts = nowIso(this.ctx);
    const existing = this.ctx.db
      .select()
      .from(externalProjects)
      .where(and(eq(externalProjects.integrationId, integrationId), eq(externalProjects.externalId, project.id)))
      .get();
    const id = existing?.id ?? newId('prj');
    if (!existing) {
      this.ctx.db
        .insert(externalProjects)
        .values({
          id,
          integrationId,
          provider: integration.provider,
          externalId: project.id,
          workspaceId: project.workspaceId,
          workspaceName: project.workspaceName,
          name: project.name,
          url: project.url,
          triggersEnabled: true,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }
    this.setMapping(id, repoIds);
    audit(this.ctx, { actor, action: 'project.connected', target: id, summary: `Connected ${integration.displayName} project ${project.name} → ${repoIds.length} repositories` });
    this.ctx.bus.publish({ type: 'integrations.updated' });
    return this.projectToDTO(this.projectRow(id));
  }

  updateProject(id: string, patch: { repoIds?: string[]; triggersEnabled?: boolean }, actor = 'user'): ExternalProjectDTO {
    const row = this.projectRow(id);
    if (patch.repoIds) this.setMapping(id, patch.repoIds);
    if (patch.triggersEnabled !== undefined) {
      this.ctx.db.update(externalProjects).set({ triggersEnabled: patch.triggersEnabled, updatedAt: nowIso(this.ctx) }).where(eq(externalProjects.id, id)).run();
    }
    audit(this.ctx, { actor, action: 'project.updated', target: id, summary: `Updated project ${row.name}`, details: patch });
    this.ctx.bus.publish({ type: 'integrations.updated' });
    return this.projectToDTO(this.projectRow(id));
  }

  disconnectProject(id: string, actor = 'user'): void {
    const row = this.projectRow(id);
    this.ctx.db.delete(externalProjects).where(eq(externalProjects.id, id)).run();
    audit(this.ctx, { actor, action: 'project.disconnected', target: id, summary: `Disconnected project ${row.name}` });
    this.ctx.bus.publish({ type: 'integrations.updated' });
  }

  async listProjectTasks(projectId: string, opts: { includeCompleted?: boolean } = {}): Promise<ExternalTaskDTO[]> {
    const project = this.projectRow(projectId);
    let tasks;
    try {
      tasks = await this.providerFor(project.integrationId).listTasks(project.externalId, { includeCompleted: opts.includeCompleted ?? false, limit: 300 });
    } catch (err) {
      this.noteProviderError(project.integrationId, err);
      providerErrorToOrbit(err);
    }
    const missionByTask = new Map<string, { id: string; status: MissionState }>();
    const ids = tasks.map((t) => t.id);
    if (ids.length) {
      const rows = this.ctx.db
        .select({ id: missions.id, status: missions.status, taskId: missions.sourceTaskId })
        .from(missions)
        .where(and(eq(missions.sourceProvider, project.provider), inArray(missions.sourceTaskId, ids)))
        .orderBy(desc(missions.createdAt))
        .all();
      for (const r of rows) {
        if (!r.taskId) continue;
        const current = missionByTask.get(r.taskId);
        // Prefer an active mission; otherwise the most recent one.
        if (!current || (TERMINAL_STATES.includes(current.status) && !TERMINAL_STATES.includes(r.status))) missionByTask.set(r.taskId, { id: r.id, status: r.status });
      }
    }
    return tasks.map((t) => ({
      provider: t.provider,
      id: t.id,
      projectId,
      title: t.title,
      description: t.description,
      url: t.url,
      completed: t.completed,
      assignee: t.assignee?.name ?? null,
      updatedAt: t.updatedAt,
      mission: missionByTask.get(t.id) ?? null,
    }));
  }
}
