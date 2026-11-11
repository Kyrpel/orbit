import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime } from '@orbit/agents';
import { ScriptedRuntime } from '@orbit/agents';
import { eq, repos } from '@orbit/database';
import { defaultRunner, runChecked, type CreatePullRequestInput, type GhAuthStatus, type GhRepo, type GitHubClient } from '@orbit/git';
import type { PullRequestInfo, RuntimeId } from '@orbit/shared';
import { createOrbit, MemorySecretStore, silentLogger, type CreateOrbitOptions, type Orbit } from '../src';

export async function git(cwd: string, ...args: string[]) {
  return runChecked(defaultRunner, 'git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0' } });
}

export function tempDir(prefix = 'orbit-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold file handles briefly */
  }
}

/** Creates a repo with one commit on main and a local bare "origin". */
export async function makeRepo(root: string, name = 'demo-app'): Promise<{ repoPath: string; remotePath: string }> {
  const remotePath = path.join(root, `${name}.git`);
  const repoPath = path.join(root, name);
  mkdirSync(repoPath, { recursive: true });
  await git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Orbit Test');
  await git(repoPath, 'config', 'user.email', 'orbit-test@example.com');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), `# ${name}\n\nA tiny checkout service used in Orbit tests.\n`);
  mkdirSync(path.join(repoPath, 'src', 'checkout'), { recursive: true });
  writeFileSync(path.join(repoPath, 'src', 'checkout', 'cart.js'), 'export const total = (items) => items.reduce((a, b) => a + b, 0);\n');
  await git(repoPath, 'add', '-A');
  await git(repoPath, 'commit', '-m', 'Initial commit');
  await git(repoPath, 'remote', 'add', 'origin', remotePath);
  await git(repoPath, 'push', '-u', 'origin', 'main');
  return { repoPath, remotePath };
}

export class FakeGitHub implements GitHubClient {
  prs: (PullRequestInfo & { head: string; repo: string; body: string })[] = [];
  createCalls = 0;
  failNextCreate: Error | null = null;
  loggedIn = true;

  async authStatus(): Promise<GhAuthStatus> {
    return { installed: true, version: 'fake', loggedIn: this.loggedIn, account: 'tester', host: 'github.com', scopes: ['repo'], detail: '' };
  }
  async listRepos(): Promise<GhRepo[]> {
    return [];
  }
  async repoView(nameWithOwner: string): Promise<GhRepo> {
    return { nameWithOwner, name: nameWithOwner.split('/')[1] ?? '', owner: 'acme', url: `https://github.com/${nameWithOwner}`, visibility: 'PRIVATE', isPrivate: true, description: null, defaultBranch: 'main', updatedAt: null };
  }
  async findPullRequest(nameWithOwner: string, head: string): Promise<PullRequestInfo | null> {
    return this.prs.find((p) => p.repo === nameWithOwner && p.head === head) ?? null;
  }
  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
    this.createCalls++;
    if (this.failNextCreate) {
      const e = this.failNextCreate;
      this.failNextCreate = null;
      throw e;
    }
    const pr = { number: this.prs.length + 1, url: `https://github.com/${input.repo}/pull/${this.prs.length + 1}`, state: 'OPEN', title: input.title, head: input.head, repo: input.repo, body: input.body };
    this.prs.push(pr);
    return pr;
  }
  async viewPullRequest(): Promise<PullRequestInfo> {
    throw new Error('not used');
  }
  async cloneRepo(): Promise<void> {
    throw new Error('not used');
  }
}

export interface TestOrbit {
  orbit: Orbit;
  github: FakeGitHub;
  root: string;
  close(): Promise<void>;
}

export function makeOrbit(root: string, opts: Partial<CreateOrbitOptions> & { runtime?: AgentRuntime } = {}): TestOrbit {
  const github = (opts.github as FakeGitHub | undefined) ?? new FakeGitHub();
  const orbit = createOrbit({
    home: path.join(root, '.orbit-home'),
    dbFile: ':memory:',
    runtimes: [opts.runtime ?? new ScriptedRuntime()],
    github,
    secrets: new MemorySecretStore(),
    logger: silentLogger,
    workerPollMs: 20,
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
    ...opts,
  });
  // Tests register one runtime; the Claude-connection setting only accepts Claude runtimes or `scripted`.
  const runtimeId = (opts.runtime ?? new ScriptedRuntime()).id as Exclude<RuntimeId, 'codex-cli' | 'cursor-cli'>;
  orbit.ctx.settings.update({ execution: { runtime: runtimeId, localExecutionConsentAt: new Date().toISOString(), maxFixIterations: 1 } });
  return {
    orbit,
    github,
    root,
    close: async () => {
      await orbit.stop();
      orbit.close();
    },
  };
}

/** Pretends the local bare remote is a GitHub repository (the push still goes to the bare repo). */
export function markAsGitHub(orbit: Orbit, repoId: string, owner = 'acme', name = 'demo-app'): void {
  orbit.ctx.db.update(repos).set({ githubOwner: owner, githubRepo: name }).where(eq(repos.id, repoId)).run();
}

export async function waitFor<T>(fn: () => T | Promise<T>, predicate: (v: T) => boolean, timeoutMs = 45_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)?.slice(0, 500)}`);
}

export const USER = { type: 'user' as const, name: 'tester' };
