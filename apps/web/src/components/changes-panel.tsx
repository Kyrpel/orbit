import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, GitCommitHorizontal, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ConversationDetailDTO, RepoChangesDTO, RepoDTO } from '@orbit/shared';
import { keys, post, useAction, useChanges } from '../lib/api';
import { tabs } from '../lib/tabs';
import { cn } from '../lib/utils';
import { DiffView } from './diff-view';
import { Button, ErrorNote, Spinner } from './ui';

type FileStatus = RepoChangesDTO['files'][number]['status'];

const STATUS: Record<FileStatus, { label: string; className: string }> = {
  modified: { label: 'edited', className: 'bg-hull-3 text-dust' },
  added: { label: 'new', className: 'bg-go/12 text-go' },
  untracked: { label: 'new', className: 'bg-go/12 text-go' },
  deleted: { label: 'deleted', className: 'bg-fault/10 text-fault' },
  renamed: { label: 'renamed', className: 'bg-telemetry/10 text-telemetry' },
  conflict: { label: 'conflict', className: 'bg-fault/10 text-fault' },
};

function FileName({ path }: { path: string }) {
  const i = path.lastIndexOf('/');
  return (
    <span className="mono min-w-0 truncate text-xs" title={path}>
      {i >= 0 ? <span className="text-dust-2">{path.slice(0, i + 1)}</span> : null}
      <span className="text-chalk">{path.slice(i + 1)}</span>
    </span>
  );
}

/**
 * The project's uncommitted changes, next to the session that makes them: what
 * changed, the diff, a commit box, and a security check by the security reviewer.
 */
export function ChangesPanel({ repo, running, editEvents, open, onClose, docked = true }: { repo: RepoDTO; running: boolean; editEvents: number; open: boolean; onClose: () => void; docked?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const changes = useChanges(repo.id);
  const [message, setMessage] = useState('');
  const commit = useAction((msg: string) => post<{ sha: string; files: number }>(`/api/repos/${repo.id}/commit`, { message: msg }), {
    success: (r) => `Committed ${r.files} ${r.files === 1 ? 'file' : 'files'} to ${repo.name}`,
    invalidate: [keys.changes(repo.id)],
  });
  const security = useAction(() => post<ConversationDetailDTO>(`/api/repos/${repo.id}/security-check`), { invalidate: [keys.chats] });

  // While the agent edits files, refresh shortly after each edit.
  useEffect(() => {
    if (!editEvents) return;
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: keys.changes(repo.id) }), 700);
    return () => clearTimeout(t);
  }, [editEvents, qc, repo.id]);

  const data = changes.data;
  const count = data?.files.length ?? 0;
  const body = (
    <aside className="flex h-full w-full flex-col bg-hull" aria-label={`Changes in ${repo.name}`}>
      <div className="flex items-center gap-2 border-b border-seam px-4 py-3">
        <h2 className="text-base">Changes</h2>
        {count ? <span className="rounded-full bg-hull-3 px-2 py-0.5 text-2xs font-[600] tabular text-chalk">{count}</span> : null}
        {data?.branch ? (
          <span className="mono ml-1 inline-flex min-w-0 items-center gap-1 truncate text-2xs text-dust" title="Current branch">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            {data.branch}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => void changes.refetch()} className="grid size-8 place-items-center rounded-[8px] text-dust hover:bg-hull-2 hover:text-chalk" aria-label="Refresh changes" title="Refresh">
            <RefreshCw className={cn('size-3.5', changes.isFetching && 'animate-spin')} />
          </button>
          <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-[8px] text-dust hover:bg-hull-2 hover:text-chalk xl:hidden" aria-label="Close changes">
            <X className="size-4" />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {changes.isPending ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-dust">
            <Spinner /> Looking for changes…
          </div>
        ) : changes.error ? (
          <div className="p-4">
            <ErrorNote error={changes.error} />
          </div>
        ) : !data?.isGit ? (
          <p className="px-4 py-6 text-sm text-dust">This folder is not a git repository, so Orbit cannot list or commit its changes.</p>
        ) : !count ? (
          <div className="px-5 py-10 text-center">
            <p className="casual text-base font-[650]">Nothing changed yet</p>
            <p className="mx-auto mt-1 max-w-[30ch] text-sm text-dust">When the agent edits files, they show up here so you can review them before you commit.</p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-seam border-b border-seam">
              {data.files.map((f) => (
                <li key={f.path} className="flex items-center gap-2.5 px-4 py-1.5">
                  <span className={cn('w-[62px] shrink-0 rounded-full px-2 py-0.5 text-center text-2xs font-[600]', STATUS[f.status].className)}>{STATUS[f.status].label}</span>
                  <FileName path={f.path} />
                </li>
              ))}
            </ul>
            <DiffView diff={data.diff} truncated={data.truncated} index={false} />
          </>
        )}
      </div>

      {data?.isGit ? (
        <div className="space-y-2 border-t border-seam p-3">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="Describe what changed, e.g. Add dark mode toggle"
            aria-label="Commit message"
            className="block w-full resize-none rounded-[10px] border border-seam-2 bg-hull px-3 py-2 text-sm text-chalk outline-none placeholder:text-dust-2 focus:border-telemetry/70"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!count || !message.trim() || running}
              loading={commit.isPending}
              onClick={() => commit.mutate(message, { onSuccess: () => setMessage('') })}
              title={running ? 'Wait for the agent to finish before committing' : undefined}
            >
              <GitCommitHorizontal className="size-4" /> Commit {count ? `${count} ${count === 1 ? 'file' : 'files'}` : ''}
            </Button>
            <Button
              size="sm"
              disabled={!count}
              loading={security.isPending}
              onClick={() =>
                security.mutate(undefined, {
                  onSuccess: (c) => {
                    tabs.openSession(c.id, repo.id);
                    navigate(`/s/${c.id}`);
                  },
                })
              }
            >
              <ShieldCheck className="size-4" /> Check security
            </Button>
          </div>
          {running ? <p className="text-2xs text-dust">The agent is still working. Commit when it has finished.</p> : null}
        </div>
      ) : null}
    </aside>
  );

  return (
    <>
      {docked ? <div className="hidden w-[400px] shrink-0 border-l border-seam xl:flex">{body}</div> : null}
      {open ? (
        <div className={cn('fixed inset-0 z-30', docked && 'xl:hidden')}>
          <button type="button" className="absolute inset-0 bg-[#1c2333]/20" onClick={onClose} aria-label="Close changes" />
          <div className="absolute inset-y-0 right-0 flex w-[min(420px,92vw)] border-l border-seam shadow-[-16px_0_40px_-24px_rgb(16_24_40/0.35)]">{body}</div>
        </div>
      ) : null}
    </>
  );
}
