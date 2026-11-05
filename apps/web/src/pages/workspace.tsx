import { FolderPlus, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ConversationSummaryDTO, RepoDTO } from '@orbit/shared';
import { TabView } from '../components/session';
import { Button, ErrorNote, Loading } from '../components/ui';
import { useChats, useRepos } from '../lib/api';
import { tabs, useTabs, type WorkspaceTab } from '../lib/tabs';
import { cn, timeAgo } from '../lib/utils';

/*
  The workspace: every project you connected, each one a tab you can work in,
  like a row of terminal tabs. The tab lights are the one bold element here:
  teal = an AI is working, amber = it needs you, green = finished, red = stopped.
*/

type Lamp = 'idle' | 'new' | 'working' | 'needs' | 'done' | 'failed';

const LAMP_LABEL: Record<Lamp, string> = {
  idle: 'No session yet',
  new: 'New session',
  working: 'Working',
  needs: 'Needs your OK',
  done: 'Finished',
  failed: 'Stopped with a problem',
};

function lampOf(s: ConversationSummaryDTO | undefined | null): Lamp {
  if (!s) return 'new';
  if (s.running) return 'working';
  if (s.needsYou) return 'needs';
  if (s.lastStatus === 'failed') return 'failed';
  return 'done';
}

function LampDot({ lamp, className }: { lamp: Lamp; className?: string }) {
  if (lamp === 'working') {
    return (
      <span className={cn('relative grid size-2.5 shrink-0 place-items-center', className)} aria-label={LAMP_LABEL[lamp]}>
        <span className="absolute inset-0 animate-ping rounded-full bg-telemetry/50" />
        <span className="size-2.5 rounded-full bg-telemetry" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'size-2.5 shrink-0 rounded-full',
        lamp === 'needs' && 'bg-signal shadow-[0_0_0_3px_rgb(243_174_61/0.25)]',
        lamp === 'done' && 'bg-go',
        lamp === 'failed' && 'bg-fault',
        (lamp === 'new' || lamp === 'idle') && 'border-[1.5px] border-dust-2',
        className,
      )}
      aria-label={LAMP_LABEL[lamp]}
    />
  );
}

/** Project summaries often come from a README: show them as plain text. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function projectLamp(repoId: string, sessions: ConversationSummaryDTO[]): Lamp {
  const mine = sessions.filter((s) => s.repoIds.length === 1 && s.repoIds[0] === repoId);
  if (mine.some((s) => s.running)) return 'working';
  if (mine.some((s) => s.needsYou)) return 'needs';
  return mine.length ? 'done' : 'idle';
}

// ---------------------------------------------------------------------------

function ProjectRail({ repos, sessions, activeRepo, onOpen }: { repos: RepoDTO[]; sessions: ConversationSummaryDTO[]; activeRepo: string | null; onOpen: (repoId: string) => void }) {
  const [filter, setFilter] = useState('');
  const shown = repos.filter((r) => !filter.trim() || `${r.name} ${r.localPath}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <nav className="hidden w-[248px] shrink-0 flex-col border-r border-seam bg-night md:flex" aria-label="Your projects">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-sm">Your projects</h2>
        <Link to="/projects" className="grid size-7 place-items-center rounded-[8px] text-dust hover:bg-hull-3 hover:text-chalk" aria-label="Add a project" title="Add a project">
          <FolderPlus className="size-4" />
        </Link>
      </div>
      {repos.length > 7 ? (
        <label className="mx-3 mb-2 flex h-8 items-center gap-2 rounded-[8px] border border-seam bg-hull px-2.5 text-dust focus-within:border-telemetry/60">
          <Search className="size-3.5" aria-hidden />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a project" aria-label="Find a project" className="min-w-0 flex-1 bg-transparent text-xs text-chalk outline-none placeholder:text-dust-2" />
        </label>
      ) : null}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {shown.map((r) => {
          const lamp = projectLamp(r.id, sessions);
          const latest = sessions.find((s) => s.repoIds.length === 1 && s.repoIds[0] === r.id);
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen(r.id)}
                className={cn('flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors', r.id === activeRepo ? 'bg-hull shadow-[0_1px_2px_rgb(16_24_40/0.08)]' : 'hover:bg-hull-2')}
              >
                <LampDot lamp={lamp} className="mt-[5px]" />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', r.id === activeRepo ? 'font-[650] text-chalk' : 'text-chalk/90')}>{r.name}</span>
                  <span className={cn('block truncate text-2xs', lamp === 'needs' ? 'text-signal-deep' : lamp === 'working' ? 'text-telemetry' : 'text-dust-2')}>
                    {lamp === 'working' ? 'Working now' : lamp === 'needs' ? 'Needs your OK' : latest ? `${latest.title}` : !r.allowModify || !r.isGit ? 'Read-only' : 'Not started yet'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {!shown.length ? <li className="px-3 py-2 text-xs text-dust">No project matches.</li> : null}
      </ul>
    </nav>
  );
}

function ProjectPicker({ repos, onPick, onClose }: { repos: RepoDTO[]; onPick: (repoId: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div ref={box} className="absolute left-0 top-11 z-30 w-72 rounded-[12px] border border-seam bg-hull p-1.5 shadow-[0_12px_32px_-12px_rgb(16_24_40/0.25)]">
      <p className="px-2.5 pb-1 pt-1.5 text-2xs text-dust">Open a new session in</p>
      <ul className="max-h-80 overflow-y-auto">
        {repos.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onPick(r.id)} className="block w-full rounded-[8px] px-2.5 py-2 text-left hover:bg-hull-2">
              <span className="block truncate text-sm">{r.name}</span>
              <span className="mono block truncate text-2xs text-dust-2">{r.localPath}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TabStrip({ list, active, repos, sessions, onSelect }: { list: WorkspaceTab[]; active: string | null; repos: RepoDTO[]; sessions: ConversationSummaryDTO[]; onSelect: (t: WorkspaceTab) => void }) {
  const [picking, setPicking] = useState(false);
  const navigate = useNavigate();
  return (
    <div className="flex h-12 shrink-0 items-end gap-1 overflow-x-auto border-b border-seam bg-night px-2 pt-1.5" role="tablist" aria-label="Open sessions">
      {list.map((t) => {
        const repo = repos.find((r) => r.id === t.repoId);
        const s = t.sessionId ? sessions.find((x) => x.id === t.sessionId) : null;
        const lamp = t.sessionId ? lampOf(s) : 'new';
        const on = t.key === active;
        return (
          <div
            key={t.key}
            role="tab"
            aria-selected={on}
            tabIndex={0}
            onClick={() => onSelect(t)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(t)}
            title={`${repo?.name ?? 'Project'}: ${s?.title ?? 'New session'} (${LAMP_LABEL[lamp]})`}
            className={cn(
              'group flex h-[42px] max-w-[240px] shrink-0 cursor-pointer items-center gap-2 rounded-t-[10px] border border-b-0 pl-3 pr-1.5 text-sm transition-colors',
              on ? 'border-seam bg-hull text-chalk' : 'border-transparent text-dust hover:bg-hull-2 hover:text-chalk',
            )}
          >
            <LampDot lamp={lamp} />
            <span className="min-w-0">
              <span className={cn('block truncate leading-4', on && 'font-[650]')}>{repo?.name ?? 'Project'}</span>
              <span className={cn('block truncate text-2xs leading-4', lamp === 'needs' ? 'text-signal-deep' : 'text-dust-2')}>{lamp === 'needs' ? 'Needs your OK' : (s?.title ?? 'New session')}</span>
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                tabs.close(t.key);
                if (on) navigate('/');
              }}
              className={cn('ml-1 grid size-6 shrink-0 place-items-center rounded-[6px] text-dust-2 hover:bg-hull-3 hover:text-chalk', !on && 'opacity-0 group-hover:opacity-100')}
              aria-label={`Close ${repo?.name ?? 'this'} tab`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
      <div className="relative mb-1 shrink-0">
        <button type="button" onClick={() => setPicking(!picking)} className="grid size-9 place-items-center rounded-[8px] text-dust hover:bg-hull-2 hover:text-chalk" aria-label="Open a project in a new tab" title="New tab">
          <Plus className="size-4" />
        </button>
        {picking ? (
          <ProjectPicker
            repos={repos}
            onClose={() => setPicking(false)}
            onPick={(id) => {
              setPicking(false);
              const t = tabs.newSession(id);
              onSelect(t);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function Welcome({ repos, sessions, onOpen }: { repos: RepoDTO[]; sessions: ConversationSummaryDTO[]; onOpen: (repoId: string) => void }) {
  return (
    <div className="flex min-w-0 flex-1 overflow-y-auto px-5 py-10 sm:px-6 sm:py-12">
      <div className="m-auto w-full min-w-0 max-w-[880px]">
        <h1 className="text-[32px] leading-10">What are we working on?</h1>
        <p className="mt-2 max-w-[60ch] text-[15px] text-dust">
          Pick a project. An AI works in it with you, like Claude Code in a terminal: it reads, edits and asks before running commands. Open as many projects as you like, each in its own tab.
        </p>
        <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((r) => {
            const lamp = projectLamp(r.id, sessions);
            const langs = r.summary?.languages.slice(0, 3) ?? [];
            return (
              <li key={r.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpen(r.id)}
                  className="group flex h-full w-full min-w-0 flex-col rounded-[16px] border border-seam bg-hull p-4 text-left transition-[border-color,box-shadow] hover:border-seam-2 hover:shadow-[0_8px_24px_-16px_rgb(16_24_40/0.3)]"
                >
                  <span className="flex items-center gap-2">
                    <LampDot lamp={lamp} />
                    <span className="casual truncate text-base font-[700]">{r.name}</span>
                  </span>
                  <span className="mono mt-1 block truncate text-2xs text-dust-2">{r.localPath}</span>
                  {r.summary?.description ? <span className="mt-2 line-clamp-2 text-xs text-dust">{plain(r.summary.description)}</span> : null}
                  <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
                    {langs.map((l) => (
                      <span key={l} className="rounded-full bg-hull-2 px-2 py-0.5 text-2xs text-dust">
                        {l}
                      </span>
                    ))}
                    <span className="ml-auto text-xs font-[600] text-telemetry opacity-0 transition-opacity group-hover:opacity-100">Open</span>
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <Link to="/projects" className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1 rounded-[16px] border border-dashed border-seam-2 p-4 text-center text-dust transition-colors hover:border-dust-2 hover:text-chalk">
              <FolderPlus className="size-5" aria-hidden />
              <span className="text-sm font-[600]">Add a project</span>
              <span className="text-2xs">Any folder on this computer</span>
            </Link>
          </li>
        </ul>
        {sessions.length ? (
          <div className="mt-10">
            <h2 className="text-sm">Pick up where you left off</h2>
            <ul className="mt-3 divide-y divide-seam rounded-[14px] border border-seam bg-hull">
              {sessions.slice(0, 5).map((s) => {
                const repo = repos.find((r) => s.repoIds.length === 1 && r.id === s.repoIds[0]);
                if (!repo) return null;
                return (
                  <li key={s.id}>
                    <Link to={`/s/${s.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hull-2">
                      <LampDot lamp={lampOf(s)} />
                      <span className="w-32 shrink-0 truncate text-sm font-[600]">{repo.name}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-dust">{s.title}</span>
                      <span className="shrink-0 text-2xs text-dust-2">{timeAgo(s.updatedAt)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function WorkspacePage() {
  const { id = null } = useParams();
  const navigate = useNavigate();
  const repos = useRepos();
  const chats = useChats();
  const state = useTabs();
  const sessions = useMemo(() => chats.data ?? [], [chats.data]);

  // A link to /s/:id opens that session in a tab.
  useEffect(() => {
    if (!id || !chats.data) return;
    const s = chats.data.find((c) => c.id === id);
    if (s?.repoIds.length === 1) tabs.openSession(id, s.repoIds[0]!);
  }, [id, chats.data]);

  // Forget tabs whose project or session is gone.
  useEffect(() => {
    if (repos.data && chats.data) tabs.prune(new Set(repos.data.map((r) => r.id)), new Set(chats.data.map((c) => c.id)));
  }, [repos.data, chats.data]);

  if (repos.isPending) return <Loading label="Loading your projects" />;
  if (repos.error) return <div className="p-6"><ErrorNote error={repos.error} /></div>;
  const list = repos.data;
  const active = state.tabs.find((t) => t.key === state.active) ?? null;
  const activeRepo = active ? (list.find((r) => r.id === active.repoId) ?? null) : null;

  const select = (t: WorkspaceTab) => {
    tabs.activate(t.key);
    navigate(t.sessionId ? `/s/${t.sessionId}` : '/');
  };
  const open = (repoId: string) => select(tabs.openProject(repoId));

  if (!list.length) {
    return (
      <div className="m-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-[28px] leading-9">Add your first project</h1>
        <p className="mt-2 text-sm text-dust">Orbit works on folders you connect. Pick one of your projects and you can start talking to an AI about it right away.</p>
        <Link to="/projects">
          <Button variant="primary" className="mt-6">
            <FolderPlus className="size-4" /> Add a project
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-56px)] min-h-0">
      <ProjectRail repos={list} sessions={sessions} activeRepo={activeRepo?.id ?? null} onOpen={open} />
      <div className="flex min-w-0 flex-1 flex-col">
        {state.tabs.length ? <TabStrip list={state.tabs} active={state.active} repos={list} sessions={sessions} onSelect={select} /> : null}
        {active && activeRepo ? <TabView tab={active} repo={activeRepo} /> : <Welcome repos={list} sessions={sessions} onOpen={open} />}
      </div>
    </div>
  );
}
