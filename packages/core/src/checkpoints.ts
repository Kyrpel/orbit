import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from '@orbit/agents';
import { DEFAULT_STAGE_EXCLUDES, type Git } from '@orbit/git';

/*
  Checkpoints for /rewind. Before an agent turn that may change files, Orbit saves the project's
  files (tracked and new, not ignored, no dependency folders) as a git commit that no branch
  points to, kept alive by a ref under refs/orbit/checkpoints/. It uses a copy of the index, so
  the project's own staging area, branches and HEAD are never touched. Rewinding restores those
  files; commits the agent made in between stay (Claude Code's /rewind has the same limit).
*/

const IDENTITY = { GIT_AUTHOR_NAME: 'Orbit', GIT_AUTHOR_EMAIL: 'orbit@localhost', GIT_COMMITTER_NAME: 'Orbit', GIT_COMMITTER_EMAIL: 'orbit@localhost' };
const REF_ROOT = 'refs/orbit/checkpoints';
const SKIPPED = /(^|\/)(node_modules|\.venv|__pycache__|\.pytest_cache|\.mypy_cache|\.turbo)(\/|$)/;

const safeRef = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Saves the project's files now. Returns the checkpoint, or null when it could not be taken. */
export async function takeCheckpoint(git: Git, dir: string, ref: string): Promise<string | null> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'orbit-checkpoint-'));
  try {
    const index = path.join(tmp, 'index');
    // Start from the real index (it knows which files are unchanged), then let `add -A` catch up with the folder.
    const realIndex = path.resolve(dir, (await git.run(dir, ['rev-parse', '--git-path', 'index'])).trim());
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index, ...IDENTITY };
    await git.run(dir, ['add', '-A', '--', '.', ...DEFAULT_STAGE_EXCLUDES], { env });
    const tree = (await git.run(dir, ['write-tree'], { env })).trim();
    const head = await git.tryRevParse(dir, 'HEAD');
    const commit = (await git.run(dir, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'Orbit checkpoint'], { env })).trim();
    await git.run(dir, ['update-ref', `${REF_ROOT}/${ref.split('/').map(safeRef).join('/')}`, commit]);
    return commit;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Puts the project's files back as they were at a checkpoint: files changed since are restored,
 * files created since are removed. Ignored files and dependency folders are never touched, and
 * neither are the index, HEAD or branches. Returns what it restored and removed.
 */
export async function restoreCheckpoint(git: Git, dir: string, commit: string): Promise<{ restored: number; removed: string[] }> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('That checkpoint is not valid.');
  const saved = new Set((await git.run(dir, ['ls-tree', '-r', '-z', '--name-only', commit])).split('\0').filter(Boolean));
  const current = (await git.run(dir, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const removed: string[] = [];
  for (const file of new Set(current)) {
    if (saved.has(file) || SKIPPED.test(file)) continue;
    const abs = path.resolve(dir, file);
    if (!isInside(dir, abs) || abs === path.resolve(dir)) continue;
    rmSync(abs, { force: true });
    removed.push(file);
    // A folder only this file was in goes with it.
    for (let up = path.dirname(abs); isInside(dir, up) && up !== path.resolve(dir); up = path.dirname(up)) {
      try {
        if (readdirSync(up).length) break;
        rmdirSync(up);
      } catch {
        break;
      }
    }
  }
  if (saved.size) await git.run(dir, ['restore', `--source=${commit}`, '--worktree', '--', '.']);
  return { restored: saved.size, removed };
}

/** Forgets a conversation's checkpoints (its refs), so git can clean up their files. */
export async function dropCheckpoints(git: Git, dir: string, conversationId: string): Promise<void> {
  try {
    const refs = (await git.run(dir, ['for-each-ref', '--format=%(refname)', `${REF_ROOT}/${safeRef(conversationId)}/`])).split('\n').filter(Boolean);
    for (const r of refs) await git.run(dir, ['update-ref', '-d', r]);
  } catch {
    /* the project may be gone */
  }
}

/** The ref name for a message's checkpoint. */
export const checkpointRef = (conversationId: string, messageId: string) => `${safeRef(conversationId)}/${safeRef(messageId)}`;
