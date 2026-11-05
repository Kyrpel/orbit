import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedRuntime, demoEngineer } from '@orbit/agents';
import { eq, externalProjects, jobs, sideEffects } from '@orbit/database';
import type { ExternalComment, ExternalTask, PollResult, ProjectSyncState, TaskProvider, TriggerCandidate } from '@orbit/integrations';
import { shortId, slugify } from '@orbit/shared';
import { createOrbit, MemorySecretStore, silentLogger } from '../src';
import { cleanup, FakeGitHub, git, makeOrbit, makeRepo, markAsGitHub, tempDir, USER, waitFor, type TestOrbit } from './helpers';

class FakeAsana implements TaskProvider {
  readonly id = 'asana' as const;
  readonly displayName = 'Asana';
  tasks = new Map<string, ExternalTask>();
  posted: { taskId: string; text: string; id: string }[] = [];
  failPosts = 0;
  async verify() {
    return { id: 'u-owner', name: 'Owner', email: 'owner@example.com' };
  }
  async listWorkspaces() {
    return [{ id: 'w1', name: 'Acme' }];
  }
  async listProjects() {
    return [{ id: 'p-ext', name: 'SaaS Platform', workspaceId: 'w1', workspaceName: 'Acme', url: null, archived: false }];
  }
  async getProject(id: string) {
    return { id, name: 'SaaS Platform', workspaceId: 'w1', workspaceName: 'Acme', url: 'https://app.asana.com/0/p-ext', archived: false };
  }
  async listTasks() {
    return [...this.tasks.values()];
  }
  async getTask(id: string) {
    const t = this.tasks.get(id);
    if (!t) throw new Error('not found');
    return t;
  }
  async listComments(): Promise<ExternalComment[]> {
    return [];
  }
  async postComment(taskId: string, text: string): Promise<ExternalComment> {
    if (this.failPosts > 0) {
      this.failPosts--;
      throw new Error('network down');
    }
    const id = `c${this.posted.length + 1}`;
    this.posted.push({ taskId, text, id });
    return { id, text, author: null, createdAt: new Date().toISOString(), isSystem: false };
  }
  async findCommentContaining(taskId: string, marker: string) {
    const c = this.posted.find((p) => p.taskId === taskId && p.text.includes(marker));
    return c ? { id: c.id, text: c.text, author: null, createdAt: '', isSystem: false } : null;
  }
  async pollTriggers(_p: string, state: ProjectSyncState): Promise<PollResult> {
    return { triggers: [], taskChanges: [], state, resynced: false, reconciled: false, warnings: [] };
  }
}

function task(id: string, title: string): ExternalTask {
  return { provider: 'asana', id, projectIds: ['p-ext'], title, description: 'Add a note to the docs.', url: `https://app.asana.com/0/p-ext/${id}`, completed: false, assignee: null, createdAt: null, updatedAt: null };
}

function candidate(storyId: string, taskId: string, authorId: string | null): TriggerCandidate {
  return {
    provider: 'asana',
    dedupeKey: `asana:story:${storyId}`,
    taskId,
    projectExternalId: 'p-ext',
    commentId: storyId,
    author: authorId ? { id: authorId, name: authorId, email: null } : null,
    command: 'run',
    extraInstructions: null,
    createdAt: new Date().toISOString(),
    via: 'event',
  };
}

describe('Asana triggers', () => {
  let root: string;
  let t: TestOrbit;
  let asana: FakeAsana;
  let repoId: string;

  beforeEach(async () => {
    root = tempDir();
    const { repoPath } = await makeRepo(root);
    asana = new FakeAsana();
    t = makeOrbit(root, { providerFactory: () => asana });
    repoId = (await t.orbit.repos.register(repoPath)).id;
    const integration = await t.orbit.integrations.connectAsana('fake-asana-token-1234567890');
    await t.orbit.integrations.connectProject(integration.id, 'p-ext', [repoId]);
    asana.tasks.set('t1', task('t1', 'Document checkout'));
    asana.tasks.set('t2', task('t2', 'Second task'));
  });

  afterEach(async () => {
    await t.close();
    cleanup(root);
  });

  const project = () => t.orbit.ctx.db.select().from(externalProjects).get()!;

  it('creates exactly one mission for duplicate deliveries and posts progress back', async () => {
    const { orbit } = t;
    orbit.start({ triggers: false });
    expect(await orbit.triggers.handleTrigger(project(), candidate('s1', 't1', 'u-owner'))).toBe('accepted');
    expect(await orbit.triggers.handleTrigger(project(), candidate('s1', 't1', 'u-owner'))).toBe('duplicate');
    expect(await orbit.triggers.handleTrigger(project(), candidate('s2', 't1', 'u-owner'))).toBe('duplicate');
    const list = orbit.missions.list();
    expect(list).toHaveLength(1);
    const id = list[0]!.id;
    const d = await waitFor(() => orbit.missions.detail(id), (x) => ['AWAITING_REVIEW', 'BLOCKED', 'FAILED'].includes(x.status), 45_000, 'review');
    expect(d.status, String(d.blockedReason)).toBe('AWAITING_REVIEW');
    expect(d.triggerVerified).toBe(true);
    await waitFor(() => asana.posted.length, (n) => n >= 3, 20_000, 'comments');
    expect(asana.posted.every((p) => p.taskId === 't1')).toBe(true);
    expect(asana.posted.map((p) => /orbit:msn_\w+:(\w+):/.exec(p.text)?.[1])).toEqual(['received', 'plan', 'review']);
  });

  it('ignores unauthorized authors and requires approval when identity is unknown', async () => {
    const { orbit } = t;
    orbit.start({ triggers: false });
    expect(await orbit.triggers.handleTrigger(project(), candidate('s3', 't1', 'u-stranger'))).toBe('rejected');
    expect(orbit.missions.list()).toHaveLength(0);
    expect(await orbit.triggers.handleTrigger(project(), candidate('s4', 't2', null))).toBe('needs_approval');
    const id = orbit.missions.list()[0]!.id;
    const m = await waitFor(() => orbit.missions.row(id), (x) => x.status === 'AWAITING_SCOPE_APPROVAL' || x.status === 'BLOCKED', 30_000, 'approval');
    expect(m.status).toBe('AWAITING_SCOPE_APPROVAL');
    expect(orbit.overview.activity().some((a) => a.action === 'trigger.rejected')).toBe(true);
  });

  it('retries a failed Asana comment without posting it twice', async () => {
    const { orbit } = t;
    asana.failPosts = 1;
    orbit.notifier.notify((await orbit.missions.create({ source: { provider: 'asana', integrationId: orbit.integrations.list()[0]!.id, taskId: 't2' }, entryPoint: 'dashboard', triggeredBy: USER, triggerVerified: true })).mission.id, 'status', ['hello'], 'x');
    const job = orbit.ctx.db.select().from(jobs).where(eq(jobs.type, 'mission.notify')).all().find((j) => (j.payload as { milestone: string }).milestone === 'status')!;
    await expect(orbit.notifier.handle(job)).resolves.toBeUndefined();
    expect(asana.posted).toHaveLength(0);
    // Simulate "posted but the response was lost": the comment exists remotely, the outbox thinks it failed.
    asana.posted.push({ taskId: 't2', text: String((job.payload as { text: string }).text), id: 'c-lost' });
    await orbit.notifier.handle(job);
    expect(asana.posted.filter((p) => p.text.includes((job.payload as { marker: string }).marker))).toHaveLength(1);
    const fx = orbit.ctx.db.select().from(sideEffects).where(eq(sideEffects.idempotencyKey, (job.payload as { key: string }).key)).get();
    expect(fx?.status).toBe('succeeded');
  });

  it('flags missions when the source task changes', async () => {
    const { orbit } = t;
    const { mission } = await orbit.missions.create({ source: { provider: 'asana', integrationId: orbit.integrations.list()[0]!.id, taskId: 't1' }, entryPoint: 'dashboard', triggeredBy: USER, triggerVerified: true });
    asana.tasks.set('t1', { ...task('t1', 'Document checkout'), description: 'Totally different requirement' });
    await orbit.triggers.handleTaskChange(project(), { taskId: 't1', kind: 'changed' });
    expect(orbit.missions.summary(mission.id).requirementsChanged).toBe(true);
  });
});

describe('recovery, idempotency and safety', () => {
  let root: string;
  let repoPath: string;

  beforeEach(async () => {
    root = tempDir();
    ({ repoPath } = await makeRepo(root));
  });

  afterEach(() => cleanup(root));

  it('resumes an interrupted mission after a restart', async () => {
    const home = path.join(root, 'home');
    const dbFile = path.join(root, 'orbit.db');
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const a = createOrbit({
      home,
      dbFile,
      runtimes: [new ScriptedRuntime({ engineer: async () => (await hang, {}) })],
      github: new FakeGitHub(),
      secrets: new MemorySecretStore(),
      logger: silentLogger,
      workerPollMs: 20,
    });
    a.ctx.settings.update({ execution: { runtime: 'scripted', localExecutionConsentAt: new Date().toISOString() } });
    const repo = await a.repos.register(repoPath);
    a.start({ triggers: false });
    const { mission } = await a.missions.create({ title: 'Survive a crash', repoIds: [repo.id], entryPoint: 'cli', triggeredBy: USER, triggerVerified: true });
    await waitFor(() => a.missions.detail(mission.id), (d) => d.status === 'RUNNING' && d.agentRuns.some((r) => r.role === 'engineer' && r.status === 'running'), 30_000, 'engineer running');
    // "Crash": stop polling and abandon the in-flight job without letting it finish.
    (a.worker as unknown as { stopping: boolean }).stopping = true;
    a.triggers.stop();

    const b = createOrbit({ home, dbFile, runtimes: [new ScriptedRuntime()], github: new FakeGitHub(), secrets: new MemorySecretStore(), logger: silentLogger, workerPollMs: 20 });
    const recovered = b.recover();
    expect(recovered.requeuedJobs).toBe(1);
    b.start({ triggers: false });
    const done = await waitFor(() => b.missions.detail(mission.id), (d) => ['AWAITING_REVIEW', 'BLOCKED', 'FAILED'].includes(d.status), 45_000, 'resume');
    expect(done.status).toBe('AWAITING_REVIEW');
    expect(done.agentRuns.some((r) => r.status === 'failed' && /restart/i.test(r.error ?? ''))).toBe(true);
    expect(b.missions.events(mission.id).some((e) => /Resuming/.test(e.title))).toBe(true);
    // The "crashed" instance's job stays parked forever; never resume it after its database is closed.
    void release;
    await b.stop();
    b.close();
    a.close();
  });

  it('does not open a duplicate pull request and recovers from a failed creation', async () => {
    const github = new FakeGitHub();
    const t = makeOrbit(root, { github });
    const repo = await t.orbit.repos.register(repoPath);
    markAsGitHub(t.orbit, repo.id);
    t.orbit.start({ triggers: false });
    const { mission } = await t.orbit.missions.create({ title: 'Idempotent PR', repoIds: [repo.id], entryPoint: 'cli', triggeredBy: USER, triggerVerified: true });
    await waitFor(() => t.orbit.missions.row(mission.id), (m) => m.status === 'AWAITING_REVIEW', 45_000, 'review');
    await t.orbit.missions.approveChanges(mission.id, USER);
    const mr = t.orbit.missions.detail(mission.id).missionRepos[0]!;

    github.failNextCreate = new Error('HTTP 502 from GitHub');
    await t.orbit.missions.publish(mission.id, { missionRepoId: mr.id }, USER);
    const failed = await waitFor(() => t.orbit.missions.detail(mission.id), (d) => !!d.missionRepos[0]?.lastError, 30_000, 'failure');
    expect(failed.status).toBe('AWAITING_PR_APPROVAL');
    expect(failed.missionRepos[0]?.status).toBe('changes_approved');

    // The PR actually got created out of band (e.g. the response was lost). Publishing again must reuse it.
    github.prs.push({ number: 7, url: 'https://github.com/acme/demo-app/pull/7', state: 'OPEN', title: 'x', head: mr.branch!, repo: 'acme/demo-app', body: '' });
    await t.orbit.missions.publish(mission.id, { missionRepoId: mr.id }, USER);
    const ok = await waitFor(() => t.orbit.missions.detail(mission.id), (d) => d.status === 'PR_CREATED', 30_000, 'pr');
    expect(ok.missionRepos[0]?.pr?.number).toBe(7);
    expect(github.prs).toHaveLength(1);
    expect(github.createCalls).toBe(1);
    await t.close();
  });

  it('blocks changes that contain secrets', async () => {
    const t = makeOrbit(root, {
      runtime: new ScriptedRuntime({
        engineer: async (req) => {
          // Assembled at runtime so the source never contains a key-shaped literal (secret scanners).
          const fakeKey = ['sk', 'ant', 'api03', 'thisisnotarealkeybutlooksreal0123456789'].join('-');
          writeFileSync(path.join(req.cwd, 'config.js'), `export const key = '${fakeKey}';\n`);
          return {};
        },
      }),
    });
    const repo = await t.orbit.repos.register(repoPath);
    t.orbit.start({ triggers: false });
    const { mission } = await t.orbit.missions.create({ title: 'Leak', repoIds: [repo.id], entryPoint: 'cli', triggeredBy: USER, triggerVerified: true });
    const m = await waitFor(() => t.orbit.missions.row(mission.id), (x) => ['BLOCKED', 'AWAITING_REVIEW', 'FAILED'].includes(x.status), 30_000, 'blocked');
    expect(m.status).toBe('BLOCKED');
    expect(m.blockedReason).toMatch(/secrets/);
    await t.close();
  });

  it('picks a fresh branch when the default name is taken, and re-attaches a deleted worktree', async () => {
    const t = makeOrbit(root);
    const repo = await t.orbit.repos.register(repoPath);
    t.orbit.start({ triggers: false });
    const { mission } = await t.orbit.missions.create({ title: 'Branch clash', repoIds: [repo.id], entryPoint: 'api', triggeredBy: USER, triggerVerified: false });
    await waitFor(() => t.orbit.missions.row(mission.id), (m) => m.status === 'AWAITING_SCOPE_APPROVAL', 30_000, 'scope');
    const taken = `orbit/${shortId(mission.id)}-${slugify('Branch clash', 30)}`;
    await git(repoPath, 'branch', taken);
    t.orbit.missions.approveScope(mission.id, {}, USER);
    const d = await waitFor(() => t.orbit.missions.detail(mission.id), (x) => x.status === 'AWAITING_REVIEW' || x.status === 'BLOCKED', 45_000, 'review');
    expect(d.status).toBe('AWAITING_REVIEW');
    expect(d.missionRepos[0]?.branch).toBe(`${taken}-2`);

    const wt = d.missionRepos[0]!.worktreePath!;
    await git(repoPath, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
    t.orbit.missions.requestChanges(mission.id, { notes: 'Also mention the tax rules.' }, USER);
    const again = await waitFor(() => t.orbit.missions.detail(mission.id), (x) => x.status === 'AWAITING_REVIEW' && x.agentRuns.filter((r) => r.role === 'engineer').length >= 2, 45_000, 'rework');
    expect(again.missionRepos[0]?.branch).toBe(`${taken}-2`);
    expect(again.approvals.some((a) => a.decision === 'changes_requested')).toBe(true);
    void demoEngineer;
    void mkdirSync;
    await t.close();
  });
});
