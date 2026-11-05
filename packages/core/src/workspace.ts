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
