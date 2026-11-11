import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { OrbitError, redactSecrets, type RepoChangesDTO } from '@orbit/shared';
import type { RepoRow } from '@orbit/database';
import { audit, type OrbitContext } from './context';

const MAX_FILES = 300;
const MAX_DIFF_CHARS = 400_000;
const MAX_NEW_FILE_BYTES = 256 * 1024;
const MAX_NEW_FILES_SHOWN = 40;

type FileStatus = RepoChangesDTO['files'][number]['status'];

function statusOf(code: string): FileStatus {
  if (code === '??') return 'untracked';
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflict';
  if (code.includes('R')) return 'renamed';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  return 'modified';
}

/** A unified diff for a file git does not track yet (git diff skips those). */
function newFileDiff(rel: string, abs: string): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_NEW_FILE_BYTES) return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`;
    const text = buf.toString('utf8');
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length) return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;
    return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
  } catch {
    return null;
  }
}

/** Every uncommitted change in a project, the way `git status` and `git diff` would show it. */
export async function repoChanges(ctx: OrbitContext, repo: RepoRow): Promise<RepoChangesDTO> {
  if (!repo.isGit) return { repoId: repo.id, isGit: false, branch: null, files: [], diff: '', truncated: false };
  const dir = repo.localPath;
  const [entries, branch, head] = await Promise.all([ctx.git.status(dir, 'all'), ctx.git.currentBranch(dir), ctx.git.tryRevParse(dir, 'HEAD')]);
  const files = entries.slice(0, MAX_FILES).map((e) => ({ path: e.path, code: e.code, status: statusOf(e.code) }));
  let diff = head ? await ctx.git.run(dir, ['diff', '--no-ext-diff', '--find-renames', 'HEAD', '--'], { timeoutMs: 60_000 }) : '';
  let shown = 0;
  for (const f of files) {
    if (f.status !== 'untracked' && (head || f.status !== 'added')) continue;
    if (shown++ >= MAX_NEW_FILES_SHOWN || diff.length > MAX_DIFF_CHARS) break;
    const part = newFileDiff(f.path, path.join(dir, f.path));
    if (part) diff += (diff && !diff.endsWith('\n') ? '\n' : '') + part;
  }
  const truncated = diff.length > MAX_DIFF_CHARS || entries.length > MAX_FILES;
  return { repoId: repo.id, isGit: true, branch, files, diff: redactSecrets(truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff), truncated };
}

const SKIPPED_DIRS = /(^|\/)(node_modules|\.git|\.venv|__pycache__|\.pytest_cache|\.mypy_cache|\.turbo)(\/|$)/;

/**
 * Files and folders to complete an `@mention` in the prompt: the project's own files (tracked or new,
 * not ignored), best matches first. With no query, the top of the tree. Plain folders without git have none.
 */
export async function repoFiles(ctx: OrbitContext, repo: RepoRow, query: string, limit = 30): Promise<string[]> {
  if (!repo.isGit) return [];
  const out = await ctx.git.run(repo.localPath, ['ls-files', '-co', '--exclude-standard', '-z']);
  const files = [...new Set(out.split('\0').filter((f) => f && !SKIPPED_DIRS.test(f)))];
  const dirs = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
  }
  const q = query.trim().replace(/\\/g, '/').toLowerCase().slice(0, 200);
  const rank = (p: string): number => {
    const isDir = p.endsWith('/');
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/', isDir ? lower.length - 2 : lower.length) + 1);
    if (!q) return p.split('/').length - (isDir ? 1 : 0);
    if (lower.startsWith(q)) return 0;
    if (base.startsWith(q)) return 1;
    if (base.includes(q)) return 2;
    if (lower.includes(q)) return 3;
    // Letters in order, like a fuzzy file picker: "chkt" finds "checkout".
    let at = 0;
    for (const ch of q) {
      at = lower.indexOf(ch, at);
      if (at === -1) return -1;
      at++;
    }
    return 4;
  };
  return [...files, ...dirs]
    .map((p) => ({ p, r: rank(p) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.p.length - b.p.length || a.p.localeCompare(b.p))
    .slice(0, Math.min(Math.max(limit, 1), 100))
    .map((x) => x.p);
}

/** Commits every change in the project (dependency folders excluded) with the developer's message. */
export async function commitRepoChanges(ctx: OrbitContext, repo: RepoRow, message: string): Promise<{ sha: string; files: number }> {
  if (!repo.isGit) throw new OrbitError('PRECONDITION', `${repo.name} is not a git repository.`);
  if (!repo.allowModify) throw new OrbitError('FORBIDDEN', `${repo.name} is read-only in Orbit.`);
  const msg = message.trim();
  if (!msg) throw new OrbitError('VALIDATION', 'Write a commit message first.');
  if (msg.length > 5000) throw new OrbitError('VALIDATION', 'The commit message is too long.');
  const dir = repo.localPath;
  await ctx.git.stageAll(dir);
  const staged = (await ctx.git.run(dir, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  if (!staged.length) throw new OrbitError('CONFLICT', 'There is nothing to commit.');
  const sha = await ctx.git.commit(dir, msg);
  audit(ctx, { actor: 'user', action: 'repo.commit', target: repo.id, summary: `Committed ${staged.length} file(s) in ${repo.name}: ${msg.split('\n')[0]}`, details: { sha } });
  ctx.bus.publish({ type: 'repo.changed', repoId: repo.id });
  return { sha, files: staged.length };
}
