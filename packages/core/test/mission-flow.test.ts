import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedRuntime } from '@orbit/agents';
import { cleanup, git, makeOrbit, makeRepo, markAsGitHub, tempDir, USER, waitFor, type TestOrbit } from './helpers';

describe('mission flow (real git, scripted agents)', () => {
  let root: string;
  let t: TestOrbit;
  let repoPath: string;
  let remotePath: string;

  beforeEach(async () => {
    root = tempDir();
    ({ repoPath, remotePath } = await makeRepo(root));
    t = makeOrbit(root);
  });

  afterEach(async () => {
    await t.close();
    cleanup(root);
  });

  it('turns a task into a reviewed, committed change and a pull request', async () => {
    const { orbit, github } = t;
    const repo = await orbit.repos.register(repoPath);
    expect(repo.defaultBranch).toBe('main');
    orbit.repos.update(repo.id, { verifyCommands: [{ id: '', label: 'Check', command: 'node -e "process.exit(0)"', timeoutSec: 60, enabled: true, source: 'user' }] });
    markAsGitHub(orbit, repo.id);
    orbit.start({ triggers: false });

    const { mission, created } = await orbit.missions.create({
      title: 'Document the checkout flow',
      description: 'Add a short note describing how the cart total is computed.',
      repoIds: [repo.id],
      entryPoint: 'cli',
      triggeredBy: USER,
      triggerVerified: true,
    });
    expect(created).toBe(true);

    const ready = await waitFor(() => orbit.missions.detail(mission.id), (d) => d.status === 'AWAITING_REVIEW' || d.status === 'BLOCKED' || d.status === 'FAILED', 45_000, 'review');
    expect(ready.status, `blocked: ${ready.blockedReason} ${ready.lastError}`).toBe('AWAITING_REVIEW');
    const mr = ready.missionRepos[0]!;
    expect(mr.branch).toMatch(/^orbit\//);
    expect(mr.worktreePath && existsSync(mr.worktreePath)).toBe(true);
    expect(mr.diffStats?.files).toBe(1);
    expect(ready.verifications.filter((v) => v.kind === 'verify').every((v) => v.status === 'passed')).toBe(true);
    expect(ready.reviews.filter((r) => r.kind === 'quality').length).toBe(1);
    expect(ready.reviews.filter((r) => r.kind === 'security').map((r) => r.verdict)).toEqual(['approve']);
    expect(ready.plan?.repositories.map((r) => r.repoId)).toEqual([repo.id]);
    expect(ready.approvals.some((a) => a.kind === 'scope' && a.decision === 'approved')).toBe(true);

    // The user's checkout and default branch are untouched.
    expect(existsSync(path.join(repoPath, 'ORBIT_DEMO.md'))).toBe(false);
    const mainBefore = (await git(repoPath, 'rev-parse', 'main')).stdout.trim();

    const diff = await orbit.missions.diff(mission.id, mr.id);
    expect(diff.diff).toContain('ORBIT_DEMO.md');

    await orbit.missions.approveChanges(mission.id, USER);
    const approved = orbit.missions.detail(mission.id);
    expect(approved.status).toBe('AWAITING_PR_APPROVAL');
    const committed = approved.missionRepos[0]!;
    expect(committed.commitSha).toBeTruthy();
    expect(committed.prDraft?.body).toContain('## Verification');
    expect((await git(repoPath, 'rev-parse', 'main')).stdout.trim()).toBe(mainBefore);

    await orbit.missions.publish(mission.id, { missionRepoId: committed.id }, USER);
    const published = await waitFor(() => orbit.missions.detail(mission.id), (d) => d.status === 'PR_CREATED' || !!d.missionRepos[0]?.lastError, 30_000, 'PR');
    expect(published.missionRepos[0]?.lastError ?? null).toBeNull();
    expect(published.status).toBe('PR_CREATED');
    expect(github.createCalls).toBe(1);
    expect(published.missionRepos[0]?.pr?.url).toContain('/pull/1');

    // The branch really reached the remote, with the commit Orbit made.
    const remoteSha = (await git(remotePath, 'rev-parse', committed.branch!)).stdout.trim();
    expect(remoteSha).toBe(committed.commitSha);
    expect(readFileSync(path.join(committed.worktreePath!, 'ORBIT_DEMO.md'), 'utf8')).toContain('Document the checkout flow');

    orbit.missions.complete(mission.id, USER);
    expect(orbit.missions.row(mission.id).status).toBe('COMPLETED');
    const receipt = orbit.receipt(mission.id);
    expect(receipt.share.markdown).not.toContain('demo-app');
    expect(receipt.share.markdown).not.toContain('checkout flow');
    expect(receipt.share.svg).toContain('<svg');
  });

  it('sends failing checks back to the engineer, then surfaces the failure for review', async () => {
    const { orbit } = t;
    const repo = await orbit.repos.register(repoPath);
    orbit.repos.update(repo.id, { verifyCommands: [{ id: '', label: 'Tests', command: 'node -e "process.exit(3)"', timeoutSec: 60, enabled: true, source: 'user' }] });
    orbit.start({ triggers: false });
    const { mission } = await orbit.missions.create({ title: 'Break the build', repoIds: [repo.id], entryPoint: 'cli', triggeredBy: USER, triggerVerified: true });
    const d = await waitFor(() => orbit.missions.detail(mission.id), (x) => ['AWAITING_REVIEW', 'BLOCKED', 'FAILED'].includes(x.status), 45_000, 'review');
    expect(d.status).toBe('AWAITING_REVIEW');
    const runs = d.agentRuns.filter((r) => r.role === 'engineer');
    expect(runs.length).toBe(2); // first attempt + one fix iteration (maxFixIterations = 1)
    const failed = d.verifications.filter((v) => v.kind === 'verify' && v.status === 'failed');
    expect(failed.length).toBe(2);
    expect(failed[0]?.exitCode).toBe(3);
  });

  it('requires scope approval for unverified triggers and honors rejection', async () => {
    const { orbit } = t;
    const repo = await orbit.repos.register(repoPath);
    orbit.start({ triggers: false });
    const { mission } = await orbit.missions.create({ title: 'Unverified', repoIds: [repo.id], entryPoint: 'api', triggeredBy: { type: 'external', name: 'someone' }, triggerVerified: false });
    const d = await waitFor(() => orbit.missions.row(mission.id), (x) => x.status === 'AWAITING_SCOPE_APPROVAL' || x.status === 'BLOCKED', 30_000, 'scope approval');
    expect(d.status).toBe('AWAITING_SCOPE_APPROVAL');
    await orbit.missions.cancel(mission.id, { reason: 'Not now' }, USER);
    const after = orbit.missions.detail(mission.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.approvals.some((a) => a.kind === 'scope' && a.decision === 'rejected')).toBe(true);
    expect(after.agentRuns.filter((r) => r.role === 'engineer')).toHaveLength(0);
  });

  it('keeps files created or changed by setup commands out of the change', async () => {
    const { orbit } = t;
    const repo = await orbit.repos.register(repoPath);
    orbit.repos.update(repo.id, {
      setupCommands: [
        { id: '', label: 'Make lockfile', command: `node -e "require('fs').writeFileSync('deps.lock','x')"`, timeoutSec: 60, enabled: true, source: 'user' },
        { id: '', label: 'Touch readme', command: `node -e "require('fs').appendFileSync('README.md','setup noise')"`, timeoutSec: 60, enabled: true, source: 'user' },
      ],
      verifyCommands: [],
    });
    orbit.start({ triggers: false });
    const { mission } = await orbit.missions.create({ title: 'Setup noise', repoIds: [repo.id], entryPoint: 'cli', triggeredBy: USER, triggerVerified: true });
    const d = await waitFor(() => orbit.missions.detail(mission.id), (x) => ['AWAITING_REVIEW', 'BLOCKED', 'FAILED'].includes(x.status), 45_000, 'review');
    expect(d.status, String(d.blockedReason)).toBe('AWAITING_REVIEW');
    expect(d.missionRepos[0]?.diffStats?.fileList.map((f) => f.path)).toEqual(['ORBIT_DEMO.md']);
    await orbit.missions.approveChanges(mission.id, USER);
    const committed = orbit.missions.detail(mission.id).missionRepos[0]!;
    const files = (await git(committed.worktreePath!, 'show', '--name-only', '--format=', committed.commitSha!)).stdout.trim().split(/\r?\n/);
    expect(files).toEqual(['ORBIT_DEMO.md']);
  });

  it('warns before approval and blocks with a fixable code when local commands lack consent', async () => {
    const { orbit } = t;
    orbit.ctx.settings.update({ execution: { localExecutionConsentAt: null } });
    const repo = await orbit.repos.register(repoPath);
    orbit.repos.update(repo.id, { verifyCommands: [{ id: '', label: 'Check', command: 'node -e "process.exit(0)"', timeoutSec: 60, enabled: true, source: 'user' }] });
    orbit.start({ triggers: false });
    const { mission } = await orbit.missions.create({ title: 'Needs consent', repoIds: [repo.id], entryPoint: 'api', triggeredBy: USER, triggerVerified: false });
    const scope = await waitFor(() => orbit.missions.detail(mission.id), (x) => x.status === 'AWAITING_SCOPE_APPROVAL', 30_000, 'scope');
    expect(scope.preflight.needsConsent).toBe(true);
    expect(scope.preflight.commands).toContain('node -e "process.exit(0)"');

    orbit.missions.approveScope(mission.id, { notes: 'Keep it to one file.' }, USER);
    const blocked = await waitFor(() => orbit.missions.detail(mission.id), (x) => ['BLOCKED', 'AWAITING_REVIEW'].includes(x.status), 30_000, 'blocked');
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.blockedCode).toBe('needs_consent');

    orbit.ctx.settings.update({ execution: { localExecutionConsentAt: new Date().toISOString() } });
    orbit.missions.retry(mission.id, USER);
    const done = await waitFor(() => orbit.missions.detail(mission.id), (x) => ['BLOCKED', 'AWAITING_REVIEW', 'FAILED'].includes(x.status), 45_000, 'review');
    expect(done.status).toBe('AWAITING_REVIEW');
    expect(done.blockedCode).toBeNull();
    expect(done.preflight.needsConsent).toBe(false);
  });

  it('blocks clearly when the engineer makes no changes', async () => {
    const { orbit } = t;
    await t.close();
    t = makeOrbit(root, { runtime: new ScriptedRuntime({ engineer: async () => ({ structured: { summary: 'Nothing to do', changes: [], testsAddedOrUpdated: [], blocked: false, blockerReason: '', followUps: [] } }) }) });
    const repo = await t.orbit.repos.register(repoPath);
    t.orbit.start({ triggers: false });
    const { mission } = await t.orbit.missions.create({ title: 'Noop', repoIds: [repo.id], entryPoint: 'cli', triggeredBy: USER, triggerVerified: true });
    const d = await waitFor(() => t.orbit.missions.row(mission.id), (x) => ['BLOCKED', 'FAILED', 'AWAITING_REVIEW'].includes(x.status), 30_000, 'blocked');
    expect(d.status).toBe('BLOCKED');
    expect(d.blockedReason).toMatch(/without changing any files/);
    void orbit;
  });
});
