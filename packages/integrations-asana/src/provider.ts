import { parseOrbitCommand } from '@orbit/shared';
import type {
  ExternalComment,
  ExternalProject,
  ExternalTask,
  ExternalUser,
  ExternalWorkspace,
  PollOptions,
  PollResult,
  ProjectSyncState,
  TaskChange,
  TaskProvider,
  TriggerCandidate,
} from '@orbit/integrations';
import { AsanaClient, SyncTokenExpiredError, type AsanaClientOptions, type AsanaEvent, type AsanaStory, type AsanaTask, type AsanaUser } from './client';

function toUser(u: AsanaUser | null | undefined): ExternalUser | null {
  if (!u?.gid) return null;
  return { id: u.gid, name: u.name ?? null, email: u.email ?? null };
}

function toTask(t: AsanaTask): ExternalTask {
  const projectIds = new Set<string>();
  for (const m of t.memberships ?? []) if (m.project?.gid) projectIds.add(m.project.gid);
  for (const p of t.projects ?? []) if (p.gid) projectIds.add(p.gid);
  return {
    provider: 'asana',
    id: t.gid,
    projectIds: [...projectIds],
    title: t.name ?? '(untitled task)',
    description: t.notes ?? '',
    url: t.permalink_url ?? null,
    completed: t.completed === true,
    assignee: toUser(t.assignee),
    createdAt: t.created_at ?? null,
    updatedAt: t.modified_at ?? null,
  };
}

function toComment(s: AsanaStory): ExternalComment {
  return {
    id: s.gid,
    text: s.text ?? '',
    author: toUser(s.created_by),
    createdAt: s.created_at,
    isSystem: s.type === 'system' || (s.resource_subtype !== undefined && s.resource_subtype !== 'comment_added'),
  };
}

function isCommentEvent(e: AsanaEvent): boolean {
  return (
    e.action === 'added' &&
    e.resource?.resource_type === 'story' &&
    (e.resource.resource_subtype === undefined || e.resource.resource_subtype === 'comment_added') &&
    e.parent?.resource_type === 'task'
  );
}

/** Asana implementation of Orbit's provider-neutral `TaskProvider`. */
export class AsanaProvider implements TaskProvider {
  readonly id = 'asana' as const;
  readonly displayName = 'Asana';
  readonly client: AsanaClient;
  private readonly now: () => number;

  constructor(opts: AsanaClientOptions | AsanaClient, now: () => number = Date.now) {
    this.client = opts instanceof AsanaClient ? opts : new AsanaClient(opts);
    this.now = now;
  }

  async verify(): Promise<ExternalUser> {
    const me = await this.client.getMe();
    return { id: me.gid, name: me.name ?? null, email: me.email ?? null };
  }

  async listWorkspaces(): Promise<ExternalWorkspace[]> {
    return (await this.client.listWorkspaces()).map((w) => ({ id: w.gid, name: w.name }));
  }

  async listProjects(workspaceId: string): Promise<ExternalProject[]> {
    return (await this.client.listProjects(workspaceId)).map((p) => ({
      id: p.gid,
      name: p.name,
      workspaceId: p.workspace?.gid ?? workspaceId,
      workspaceName: p.workspace?.name ?? null,
      url: p.permalink_url ?? null,
      archived: p.archived === true,
    }));
  }

  async getProject(projectId: string): Promise<ExternalProject> {
    const p = await this.client.getProject(projectId);
    return {
      id: p.gid,
      name: p.name,
      workspaceId: p.workspace?.gid ?? null,
      workspaceName: p.workspace?.name ?? null,
      url: p.permalink_url ?? null,
      archived: p.archived === true,
    };
  }

  async listTasks(projectId: string, opts: { includeCompleted?: boolean; limit?: number } = {}): Promise<ExternalTask[]> {
    const tasks = await this.client.listProjectTasks(projectId, {
      ...(opts.includeCompleted !== undefined ? { includeCompleted: opts.includeCompleted } : {}),
      maxItems: opts.limit ?? 500,
    });
    return tasks.map(toTask);
  }

  async getTask(taskId: string): Promise<ExternalTask> {
    return toTask(await this.client.getTask(taskId));
  }

  async listComments(taskId: string, opts: { limit?: number } = {}): Promise<ExternalComment[]> {
    const stories = await this.client.listStories(taskId);
    const comments = stories.map(toComment).filter((c) => !c.isSystem);
    return opts.limit ? comments.slice(-opts.limit) : comments;
  }

  async updateTask(taskId: string, patch: { title?: string; description?: string }): Promise<ExternalTask> {
    const data: { name?: string; notes?: string } = {};
    if (patch.title !== undefined) data.name = patch.title;
    if (patch.description !== undefined) data.notes = patch.description;
    return toTask(await this.client.updateTask(taskId, data));
  }

  async postComment(taskId: string, text: string): Promise<ExternalComment> {
    return toComment(await this.client.createComment(taskId, text));
  }

  async findCommentContaining(taskId: string, marker: string): Promise<ExternalComment | null> {
    const stories = await this.client.listStories(taskId);
    const hit = [...stories].reverse().find((s) => (s.text ?? '').includes(marker));
    return hit ? toComment(hit) : null;
  }

  private candidateFromStory(story: AsanaStory, taskId: string, projectId: string, via: 'event' | 'reconcile'): TriggerCandidate | null {
    if (story.type === 'system') return null;
    if (story.resource_subtype && story.resource_subtype !== 'comment_added') return null;
    const parsed = parseOrbitCommand(story.text ?? '');
    if (!parsed) return null;
    return {
      provider: 'asana',
      dedupeKey: `asana:story:${story.gid}`,
      taskId,
      projectExternalId: projectId,
      commentId: story.gid,
      author: toUser(story.created_by),
      command: parsed.command,
      extraInstructions: parsed.extraInstructions,
      createdAt: story.created_at,
      via,
    };
  }

  /**
   * Scans recently active, incomplete tasks for `/orbit` comments posted since `since`.
   * Used after downtime or an expired sync token. Bounded by `limit` tasks because each
   * task costs one request. Asana does not bump `modified_at` for new comments, so this
   * is best-effort; duplicates are filtered by the caller's dedupe keys.
   */
  async reconcile(projectId: string, since: string, limit: number, ignore?: ReadonlySet<string>): Promise<TriggerCandidate[]> {
    const tasks = await this.client.listProjectTasks(projectId, { maxItems: 500 });
    const recent = tasks
      .map((t) => ({ t, ts: Math.max(Date.parse(t.modified_at ?? '') || 0, Date.parse(t.created_at ?? '') || 0) }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
    const sinceMs = Date.parse(since) - 5 * 60_000;
    const found: TriggerCandidate[] = [];
    for (const { t } of recent) {
      const stories = await this.client.listStories(t.gid);
      for (const s of stories) {
        if (ignore?.has(s.gid)) continue;
        if ((Date.parse(s.created_at) || 0) < sinceMs) continue;
        const c = this.candidateFromStory(s, t.gid, projectId, 'reconcile');
        if (c) found.push(c);
      }
    }
    return found;
  }

  async pollTriggers(projectId: string, state: ProjectSyncState, opts: PollOptions = {}): Promise<PollResult> {
    const nowIso = new Date(this.now()).toISOString();
    const warnings: string[] = [];

    if (!state.syncToken) {
      // First poll: only establish a token. Historical comments are never executed.
      const token = await this.client.initialSyncToken(projectId);
      return {
        triggers: [],
        taskChanges: [],
        state: { ...state, syncToken: token, lastPolledAt: nowIso },
        resynced: true,
        reconciled: false,
        warnings,
      };
    }

    const events: AsanaEvent[] = [];
    let token = state.syncToken;
    let expired = false;
    try {
      for (let page = 0; page < 20; page++) {
        const res = await this.client.getEvents(projectId, token);
        events.push(...res.data);
        token = res.sync || token;
        if (!res.has_more) break;
      }
    } catch (err) {
      if (!(err instanceof SyncTokenExpiredError)) throw err;
      token = err.newSyncToken;
      expired = true;
      warnings.push('Asana sync token expired (Orbit was offline or the token aged out). Scanning recent tasks for missed /orbit commands.');
    }

    const triggers: TriggerCandidate[] = [];
    const changes = new Map<string, TaskChange['kind']>();
    const storyRefs = new Map<string, string>();
    let lastEventAt = state.lastEventAt;
    for (const e of events) {
      if (e.created_at && (!lastEventAt || e.created_at > lastEventAt)) lastEventAt = e.created_at;
      if (isCommentEvent(e) && e.parent) storyRefs.set(e.resource.gid, e.parent.gid);
      else if (e.resource?.resource_type === 'task') {
        if (e.action === 'deleted') changes.set(e.resource.gid, 'deleted');
        else if (e.action === 'changed' && changes.get(e.resource.gid) !== 'deleted') changes.set(e.resource.gid, 'changed');
      }
    }

    for (const [storyGid, taskGid] of storyRefs) {
      if (opts.ignoreCommentIds?.has(storyGid)) continue;
      try {
        const story = await this.client.getStory(storyGid);
        const c = this.candidateFromStory(story, taskGid, projectId, 'event');
        if (c) triggers.push(c);
      } catch (err) {
        warnings.push(`Could not read comment ${storyGid}: ${(err as Error).message}`);
      }
    }

    let reconciled = false;
    if (expired || opts.reconcile) {
      const since = state.lastPolledAt ?? new Date(this.now() - 24 * 3600_000).toISOString();
      const extra = await this.reconcile(projectId, since, opts.reconcileTaskLimit ?? 25, opts.ignoreCommentIds);
      const seen = new Set(triggers.map((t) => t.dedupeKey));
      for (const c of extra) if (!seen.has(c.dedupeKey)) triggers.push(c);
      reconciled = true;
    }

    return {
      triggers,
      taskChanges: [...changes.entries()].map(([taskId, kind]) => ({ taskId, kind })),
      state: {
        syncToken: token,
        lastPolledAt: nowIso,
        lastEventAt,
        lastReconciledAt: reconciled ? nowIso : state.lastReconciledAt,
      },
      resynced: expired,
      reconciled,
      warnings,
    };
  }
}
