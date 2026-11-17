import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyResult, type AgentRunRequest, type AgentRuntime } from '@orbit/agents';
import { runMigrations } from '@orbit/database';
import { createOrbit, MemorySecretStore, silentLogger, type Orbit } from '../src';
import { cleanup, git, tempDir, USER } from './helpers';

describe('local sessions in plain folders', () => {
  let root: string;
  let folder: string;
  let orbit: Orbit;
  let calls: AgentRunRequest[];

  beforeEach(() => {
    root = tempDir();
    folder = path.join(root, 'publisher');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'publish.py'), 'print("hi")\n');
    calls = [];
    const runtime: AgentRuntime = {
      id: 'claude-code-cli', displayName: 'Claude', kind: 'ai', resumable: true,
      checkAvailability: async () => ({ available: true, reason: null, sandbox: 'unknown', details: {} }),
      run: async (req) => {
        calls.push(req);
        if (req.access === 'workspace-write') writeFileSync(path.join(req.cwd, 'publish.py'), 'print("updated")\n');
        return emptyResult({ status: 'succeeded', text: 'Finished.', sessionId: 'folder-session', numTurns: 1, durationMs: 5 });
      },
    };
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [runtime], secrets: new MemorySecretStore(), logger: silentLogger });
    orbit.ctx.settings.update({ execution: { suggestNext: false, pastSessions: false } });
  });

  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    cleanup(root);
  });

  async function finished(id: string) {
    await expect.poll(() => orbit.chat.isRunning(id)).toBe(false);
    return orbit.chat.detail(id);
  }

  it('edits files directly without creating a git repository or requiring checkpoints', async () => {
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const repo = await orbit.repos.register(folder);
    expect(repo).toMatchObject({ isGit: false, allowModify: true });
    expect(repo.verifyCommands.some((c) => c.command === 'npm test')).toBe(true);
    const session = orbit.chat.start({ repoIds: [repo.id], message: 'Update publish.py', mode: 'edit', provider: 'claude' });
    const result = await finished(session.id);
    expect(result.messages.at(-1)).toMatchObject({ status: 'done', content: 'Finished.' });
    expect(calls[0]).toMatchObject({ access: 'workspace-write', cwd: folder, commands: { mode: 'allowlist' } });
    expect(calls[0]?.systemAppend).toContain('Do not initialize Git unless the developer asks');
    expect(result.messages[0]?.checkpoint).toBe(false);
    expect(readFileSync(path.join(folder, 'publish.py'), 'utf8')).toBe('print("updated")\n');
    expect(existsSync(path.join(folder, '.git'))).toBe(false);
    await expect(orbit.changes(repo.id)).resolves.toMatchObject({ isGit: false, files: [], diff: '' });
  });

  it('respects read-only permissions, and lets the user enable editing without Git', async () => {
    const repo = await orbit.repos.register(folder, { allowModify: false });
    expect(repo.allowModify).toBe(false);
    expect(() => orbit.chat.start({ repoIds: [repo.id], message: 'Change it', mode: 'edit' })).toThrow('read-only');
    expect(() => orbit.chat.shell({ repoId: repo.id, command: 'echo blocked' })).toThrow('read-only');
    expect(orbit.repos.update(repo.id, { allowModify: true })).toMatchObject({ isGit: false, allowModify: true });
    const session = orbit.chat.start({ repoIds: [repo.id], message: 'Update it', mode: 'edit' });
    expect((await finished(session.id)).messages.at(-1)?.status).toBe('done');
    orbit.repos.update(repo.id, { allowModify: false });
    orbit.chat.send(session.id, { message: 'Update it again' });
    expect((await finished(session.id)).messages.at(-1)?.error).toContain('read-only');
    expect(calls).toHaveLength(1);
    expect(existsSync(path.join(folder, '.git'))).toBe(false);
  });

  it('keeps plan mode read-only in a folder that is otherwise editable', async () => {
    const repo = await orbit.repos.register(folder);
    const session = orbit.chat.start({ repoIds: [repo.id], message: 'Plan the update', mode: 'edit', permissionMode: 'plan' });
    await finished(session.id);
    expect(calls[0]?.access).toBe('read-only');
    expect(readFileSync(path.join(folder, 'publish.py'), 'utf8')).toBe('print("hi")\n');
  });

  it('runs a shell command in an editable session without Git', async () => {
    const repo = await orbit.repos.register(folder);
    const session = orbit.chat.shell({ repoId: repo.id, command: 'echo plain-folder-shell' });
    expect(session.mode).toBe('edit');
    const result = await finished(session.id);
    expect(result.messages.at(-1)).toMatchObject({ status: 'done', runtime: 'shell' });
    expect(result.messages.at(-1)?.content).toContain('plain-folder-shell');
    expect(existsSync(path.join(folder, '.git'))).toBe(false);
  });

  it('completes files and folders without scanning dependencies', async () => {
    mkdirSync(path.join(folder, 'src'));
    mkdirSync(path.join(folder, 'node_modules'));
    writeFileSync(path.join(folder, 'src', 'publisher.py'), 'pass\n');
    writeFileSync(path.join(folder, 'node_modules', 'ignored.py'), 'pass\n');
    const repo = await orbit.repos.register(folder);
    expect(await orbit.files(repo.id, 'src')).toEqual(['src/', 'src/publisher.py']);
    expect(await orbit.files(repo.id, 'ignored')).toEqual([]);
    expect(await orbit.files(repo.id, 'publish')).toContain('publish.py');
  });

  it('keeps Git worktrees out of plain-folder sessions and explains the Autopilot requirement', async () => {
    const repo = await orbit.repos.register(folder);
    await expect(orbit.missions.create({ title: 'Change it', repoIds: [repo.id], entryPoint: 'cli', triggeredBy: USER, triggerVerified: true })).rejects.toThrow('local session');
  });

  it('still detects Git later without reconnecting the folder', async () => {
    const repo = await orbit.repos.register(folder);
    await git(folder, 'init', '--initial-branch=main');
    await git(folder, 'add', '-A');
    await git(folder, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first');
    const now = orbit.repos.update(repo.id, { allowModify: true });
    expect(now).toMatchObject({ isGit: true, allowModify: true, defaultBranch: 'main' });
  });

  it('never turns on editing for a read-only folder by itself: only you can', async () => {
    // A plain folder that an older version connected as read-only.
    const legacy = await orbit.repos.register(folder, { allowModify: false });
    orbit.ctx.sqlite.prepare('INSERT INTO audit_log (ts, actor, action, target, summary) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), 'user', 'repo.connected', legacy.id, `Connected folder ${legacy.name} (${legacy.localPath}) as read-only: it is not a git repository`);
    // Upgrading (or a database where the retired 0014 never ran) changes nothing.
    orbit.ctx.sqlite.prepare('DELETE FROM __orbit_migrations WHERE id = ?').run('0014_plain_folder_sessions');
    expect(runMigrations(orbit.ctx.sqlite)).toEqual([]);
    expect(orbit.repos.get(legacy.id).allowModify).toBe(false);
    expect(orbit.repos.update(legacy.id, { allowModify: true }).allowModify).toBe(true);
  });
});
