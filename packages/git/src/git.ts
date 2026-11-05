import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DiffFileStat, DiffStats } from '@orbit/shared';
import { defaultRunner, runChecked, type CommandRunner, type RunOptions } from './exec';

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

export interface StatusEntry {
  code: string;
  path: string;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

/** Environment applied to every git invocation: never prompt, never page, no colors. */
const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_EDITOR: 'true',
  NO_COLOR: '1',
};

const BASE_ARGS = ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'core.pager=cat'];

/** Never part of a mission's change, even in repositories without a .gitignore for them. */
export const DEFAULT_STAGE_EXCLUDES = [
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/.venv/**',
  ':(exclude,glob)**/__pycache__/**',
  ':(exclude,glob)**/.pytest_cache/**',
  ':(exclude,glob)**/.mypy_cache/**',
  ':(exclude,glob)**/.turbo/**',
];

/** Thin, injectable wrapper around the native `git` binary. */
export class Git {
  constructor(
    private readonly runner: CommandRunner = defaultRunner,
    private readonly bin = 'git',
  ) {}

  private opts(cwd: string, extra: RunOptions = {}): RunOptions {
    return { timeoutMs: 120_000, ...extra, cwd, env: { ...GIT_ENV, ...extra.env } };
  }

  async raw(cwd: string, args: string[], extra?: RunOptions) {
    return this.runner.run(this.bin, [...BASE_ARGS, ...args], this.opts(cwd, extra));
  }

  async run(cwd: string, args: string[], extra?: RunOptions): Promise<string> {
    const res = await runChecked(this.runner, this.bin, [...BASE_ARGS, ...args], this.opts(cwd, extra));
    return res.stdout;
  }

  async version(): Promise<string | null> {
    const res = await this.runner.run(this.bin, ['--version'], { timeoutMs: 15_000 });
    if (!res.ok) return null;
    return res.stdout.replace(/^git version\s*/, '').trim();
  }

  async isRepo(dir: string): Promise<boolean> {
    if (!existsSync(dir)) return false;
    const res = await this.raw(dir, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 15_000 });
    return res.ok && res.stdout.trim() === 'true';
  }

  async topLevel(dir: string): Promise<string> {
    return path.resolve((await this.run(dir, ['rev-parse', '--show-toplevel'])).trim());
  }

  async headSha(dir: string, ref = 'HEAD'): Promise<string> {
    return (await this.run(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  }

  async tryRevParse(dir: string, ref: string): Promise<string | null> {
    const res = await this.raw(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return res.ok ? res.stdout.trim() : null;
  }

  async currentBranch(dir: string): Promise<string | null> {
    const res = await this.raw(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return res.ok ? res.stdout.trim() : null;
  }

  async remoteUrl(dir: string, remote = 'origin'): Promise<string | null> {
    const res = await this.raw(dir, ['remote', 'get-url', remote]);
    return res.ok ? res.stdout.trim() || null : null;
  }

  async hasRemote(dir: string, remote = 'origin'): Promise<boolean> {
    return (await this.remoteUrl(dir, remote)) !== null;
  }

  /** Best guess at the default branch: origin/HEAD, then main/master, then the current branch. */
  async defaultBranch(dir: string): Promise<string> {
    const originHead = await this.raw(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (originHead.ok && originHead.stdout.trim()) return originHead.stdout.trim().replace(/^origin\//, '');
    for (const candidate of ['main', 'master', 'trunk', 'develop']) {
      if (await this.branchExists(dir, candidate)) return candidate;
    }
    return (await this.currentBranch(dir)) ?? 'main';
  }

  async branchExists(dir: string, branch: string): Promise<boolean> {
    const res = await this.raw(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return res.ok;
  }

  async isValidBranchName(dir: string, branch: string): Promise<boolean> {
    const res = await this.raw(dir, ['check-ref-format', '--branch', branch]);
    return res.ok;
  }

  async identity(dir: string): Promise<GitIdentity> {
    const name = await this.raw(dir, ['config', '--get', 'user.name']);
    const email = await this.raw(dir, ['config', '--get', 'user.email']);
    return { name: name.ok ? name.stdout.trim() || null : null, email: email.ok ? email.stdout.trim() || null : null };
  }

  /** Fetches the remote; returns false (instead of throwing) when offline or no remote exists. */
  async fetch(dir: string, remote = 'origin', signal?: AbortSignal): Promise<boolean> {
    if (!(await this.hasRemote(dir, remote))) return false;
    const res = await this.raw(dir, ['fetch', '--quiet', '--prune', remote], { timeoutMs: 120_000, ...(signal ? { signal } : {}) });
    return res.ok;
  }

  async worktreeList(dir: string): Promise<WorktreeInfo[]> {
    const out = await this.run(dir, ['worktree', 'list', '--porcelain']);
    const list: WorktreeInfo[] = [];
    let cur: WorktreeInfo | null = null;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        cur = { path: path.resolve(line.slice(9)), head: null, branch: null, bare: false, detached: false };
        list.push(cur);
      } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (cur && line === 'bare') cur.bare = true;
      else if (cur && line === 'detached') cur.detached = true;
    }
    return list;
  }

  /** Creates a new branch at `base` checked out in a separate worktree directory. */
  async worktreeAdd(repoDir: string, worktreePath: string, branch: string, base: string): Promise<void> {
    await this.run(repoDir, ['worktree', 'add', '-b', branch, worktreePath, base]);
  }

  async worktreeRemove(repoDir: string, worktreePath: string, force = false): Promise<void> {
    await this.run(repoDir, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]);
  }

  async worktreePrune(repoDir: string): Promise<void> {
    await this.raw(repoDir, ['worktree', 'prune']);
  }

  async deleteBranch(repoDir: string, branch: string): Promise<void> {
    await this.raw(repoDir, ['branch', '-D', branch]);
  }

  /** `normal` collapses untracked folders into one entry (e.g. `node_modules/`). */
  async status(dir: string, untracked: 'all' | 'normal' = 'all'): Promise<StatusEntry[]> {
    const out = await this.run(dir, ['status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`]);
    const entries: StatusEntry[] = [];
    const parts = out.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      const code = part.slice(0, 2);
      entries.push({ code, path: part.slice(3) });
      if (code.startsWith('R') || code.startsWith('C')) i++; // rename source follows
    }
    return entries;
  }

  async isClean(dir: string): Promise<boolean> {
    return (await this.status(dir)).length === 0;
  }

  /**
   * Stages every change in a mission worktree, except dependency folders and the
   * given paths (files created by setup commands such as an install step).
   */
  async stageAll(dir: string, excludes: string[] = []): Promise<void> {
    const pathspecs = ['.', ...DEFAULT_STAGE_EXCLUDES, ...excludes.map((e) => `:(exclude,literal)${e}`)];
    await this.run(dir, ['add', '-A', '--', ...pathspecs]);
    // Paths that were staged earlier but are excluded now must not stay in the index.
    if (excludes.length) await this.raw(dir, ['reset', '-q', '--', ...excludes.map((e) => `:(literal)${e}`)]);
  }

  /** Unified diff of the index against `base` (stage first to include new files). */
  async diffStaged(dir: string, base: string): Promise<string> {
    return this.run(dir, ['diff', '--cached', '--no-ext-diff', '--find-renames', base, '--'], { timeoutMs: 120_000 });
  }

  async diffCommits(dir: string, from: string, to: string): Promise<string> {
    return this.run(dir, ['diff', '--no-ext-diff', '--find-renames', from, to, '--'], { timeoutMs: 120_000 });
  }

  async diffStatsStaged(dir: string, base: string): Promise<DiffStats> {
    const numstat = await this.run(dir, ['diff', '--cached', '--numstat', '--find-renames', '-z', base, '--']);
    const nameStatus = await this.run(dir, ['diff', '--cached', '--name-status', '--find-renames', '-z', base, '--']);
    return parseDiffStats(numstat, nameStatus);
  }

  async diffStatsCommits(dir: string, from: string, to: string): Promise<DiffStats> {
    const numstat = await this.run(dir, ['diff', '--numstat', '--find-renames', '-z', from, to, '--']);
    const nameStatus = await this.run(dir, ['diff', '--name-status', '--find-renames', '-z', from, to, '--']);
    return parseDiffStats(numstat, nameStatus);
  }

  /** Commits staged changes. The message is passed on stdin, never on the command line. */
  async commit(dir: string, message: string): Promise<string> {
    await this.run(dir, ['commit', '--quiet', '-F', '-'], { input: message, timeoutMs: 300_000 });
    return this.headSha(dir);
  }

  async commitsBetween(dir: string, from: string, to = 'HEAD'): Promise<number> {
    const out = await this.run(dir, ['rev-list', '--count', `${from}..${to}`]);
    return Number(out.trim()) || 0;
  }

  /** Remote branch SHA via ls-remote, or null if the branch does not exist remotely. */
  async remoteBranchSha(dir: string, branch: string, remote = 'origin'): Promise<string | null> {
    const res = await this.raw(dir, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`Could not reach remote "${remote}": ${res.stderr.trim() || res.errorMessage}`);
    const line = res.stdout.trim().split('\n').find((l) => l.endsWith(`refs/heads/${branch}`));
    return line ? (line.split(/\s+/)[0] ?? null) : null;
  }

  /** Pushes a branch. Never forces. */
  async push(dir: string, branch: string, remote = 'origin'): Promise<void> {
    await this.run(dir, ['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 300_000 });
  }

  async clone(url: string, dest: string): Promise<void> {
    await this.run(path.dirname(dest), ['clone', '--', url, dest], { timeoutMs: 900_000 });
  }

  async lsFiles(dir: string, limit = 5000): Promise<string[]> {
    const out = await this.run(dir, ['ls-files', '-z']);
    return out.split('\0').filter(Boolean).slice(0, limit);
  }
}

export function parseDiffStats(numstatZ: string, nameStatusZ: string): DiffStats {
  const statusByPath = new Map<string, DiffFileStat['status']>();
  const ns = nameStatusZ.split('\0').filter((s) => s.length > 0);
  for (let i = 0; i < ns.length; i++) {
    const code = ns[i] as string;
    if (code.startsWith('R') || code.startsWith('C')) {
      const to = ns[i + 2];
      if (to) statusByPath.set(to, 'renamed');
      i += 2;
    } else {
      const p = ns[i + 1];
      if (p) statusByPath.set(p, code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
      i += 1;
    }
  }

  const fileList: DiffFileStat[] = [];
  const parts = numstatZ.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(rec);
    if (!m) continue;
    let filePath = m[3] ?? '';
    if (filePath === '') {
      // rename: the next two NUL-separated fields are old and new path
      filePath = parts[i + 2] ?? parts[i + 1] ?? '';
      i += 2;
    }
    const binary = m[1] === '-';
    fileList.push({
      path: filePath,
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      status: binary ? 'binary' : (statusByPath.get(filePath) ?? 'modified'),
    });
  }
  return {
    files: fileList.length,
    additions: fileList.reduce((a, f) => a + f.additions, 0),
    deletions: fileList.reduce((a, f) => a + f.deletions, 0),
    fileList,
  };
}
