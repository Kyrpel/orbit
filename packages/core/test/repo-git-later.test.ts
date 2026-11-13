import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrbit, MemorySecretStore, silentLogger, type Orbit } from '../src';
import { cleanup, git, tempDir } from './helpers';

describe('a plain folder that gets git later', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(() => {
    orbit.close();
    cleanup(root);
  });

  it('can be allowed to change once it has git and a first commit, without reconnecting it', async () => {
    root = tempDir();
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [], secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux' });
    const folder = path.join(root, 'publisher');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'publish.py'), 'print("hi")\n');
    const repo = await orbit.repos.register(folder);
    expect(repo).toMatchObject({ isGit: false, allowModify: false });

    // Still a plain folder: it says what to do.
    expect(() => orbit.repos.update(repo.id, { allowModify: true })).toThrow('folder without git');

    await git(folder, 'init', '--initial-branch=main');
    await git(folder, 'add', '-A');
    await git(folder, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first');
    const now = orbit.repos.update(repo.id, { allowModify: true });
    expect(now).toMatchObject({ isGit: true, allowModify: true, defaultBranch: 'main' });
  });
});
