import { FolderPlus, LayoutGrid, Plus, Search, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ConversationSummaryDTO, RepoDTO } from '@orbit/shared';
import { LAMP_LABEL, LampDot, lampOf, type Lamp } from '../components/lamp';
import { TabView } from '../components/session';
import { TerminalTabView } from '../components/terminal';
import { Button, ErrorNote, Loading } from '../components/ui';
import { useChats, useRepos } from '../lib/api';
import { gridColumns, tabs, useTabs, WORKSPACE_COLUMNS, type WorkspaceColumns, type WorkspaceLayout, type WorkspaceTab } from '../lib/tabs';
import { useTheme } from '../lib/theme';
import { cn, shortPath, timeAgo } from '../lib/utils';
import { AddRepoDialog } from './projects';

/*
  The workspace: your projects on the left, the ones you opened as tabs, and an AI working
  in each. The lamps carry the status: teal = working, amber = it needs you, green =
  finished, red = stopped.
*/

/** Project summaries often come from a README: show them as plain text. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ownSessions = (repoId: string, sessions: ConversationSummaryDTO[]) => sessions.filter((s) => s.repoIds.length === 1 && s.repoIds[0] === repoId);

function projectLamp(repoId: string, sessions: ConversationSummaryDTO[]): Lamp {
  const mine = ownSessions(repoId, sessions);
  if (mine.some((s) => s.running)) return 'working';
  if (mine.some((s) => s.needsYou)) return 'needs';
  return mine.length ? 'done' : 'idle';
}

/** One line about where a project stands, or nothing when there is nothing to say. */
function projectNote(repo: RepoDTO, lamp: Lamp, latest: ConversationSummaryDTO | undefined): { text: string; tone: string } | null {
  if (lamp === 'working') return { text: 'Working now', tone: 'text-telemetry' };
  if (lamp === 'needs') return { text: 'Needs your OK', tone: 'text-signal-deep' };
  if (latest) return { text: latest.title, tone: 'text-dust' };
  if (!repo.allowModify) return { text: 'Read-only', tone: 'text-dust' };
  return null;
}

// ---------------------------------------------------------------------------

function ProjectRail({ repos, sessions, activeRepo, onOpen, onAdd, narrow }: { repos: RepoDTO[]; sessions: ConversationSummaryDTO[]; activeRepo: string | null; onOpen: (repoId: string) => void; onAdd: () => void; narrow?: boolean }) {
  const [filter, setFilter] = useState('');
  const shown = repos.filter((r) => !filter.trim() || `${r.name} ${r.localPath}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <nav className={cn('hidden w-[232px] shrink-0 flex-col border-r border-seam bg-night', narrow ? '2xl:flex' : 'md:flex')} aria-label="Your projects">
      <div className="flex h-10 shrink-0 items-center justify-between pl-4 pr-2">
        <h2 className="text-sm">Projects</h2>
        <button type="button" onClick={onAdd} className="grid size-7 place-items-center rounded-[8px] text-dust hover:bg-hull-3 hover:text-chalk" aria-label="Add a project" title="Add a project">
          <FolderPlus className="size-4" />
        </button>
      </div>
      {repos.length > 7 ? (
        <label className="mx-2 mb-2 flex h-8 items-center gap-2 rounded-[8px] border border-seam bg-hull px-2.5 text-dust focus-within:border-telemetry/60">
          <Search className="size-3.5" aria-hidden />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a project" aria-label="Find a project" className="min-w-0 flex-1 bg-transparent text-xs text-chalk outline-none placeholder:text-dust" />
        </label>
      ) : null}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {shown.map((r) => {
          const lamp = projectLamp(r.id, sessions);
          const note = projectNote(r, lamp, ownSessions(r.id, sessions)[0]);
          const on = r.id === activeRepo;
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen(r.id)}
                title={r.localPath}
                aria-current={on ? 'true' : undefined}
                className={cn('flex w-full items-start gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left transition-colors', on ? 'bg-hull shadow-[0_1px_2px_rgb(16_24_40/0.08)]' : 'hover:bg-hull-2')}
              >
                <LampDot lamp={lamp} className="mt-[5px]" />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', on ? 'font-[650] text-chalk' : 'text-chalk/90')}>{r.name}</span>
                  {note ? <span className={cn('block truncate text-2xs', note.tone)}>{note.text}</span> : null}
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
    <div ref={box} className="absolute left-0 top-9 z-30 w-72 rounded-[12px] border border-seam bg-hull p-1.5 shadow-[0_12px_32px_-12px_rgb(16_24_40/0.25)]">
      <p className="px-2.5 pb-1 pt-1.5 text-2xs text-dust">Open a new session in</p>
      <ul className="max-h-80 overflow-y-auto">
        {repos.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onPick(r.id)} title={r.localPath} className="block w-full rounded-[8px] px-2.5 py-1.5 text-left hover:bg-hull-2">
              <span className="block truncate text-sm">{r.name}</span>
              <span className="mono block truncate text-2xs text-dust">{shortPath(r.localPath)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SEGMENT = 'flex h-7 items-center justify-center gap-1.5 rounded-[6px] px-2 text-xs transition-colors';
const SEGMENT_ON = 'bg-hull font-[600] text-chalk shadow-[0_1px_2px_rgb(16_24_40/0.1)]';
const SEGMENT_OFF = 'text-dust hover:text-chalk';

/** Shown once two projects are open: see them all at once, or one at full size. */
function LayoutSwitch({ value, columns, panes }: { value: WorkspaceLayout; columns: WorkspaceColumns; panes: number }) {
  const opt = (v: WorkspaceLayout, label: string, Icon: typeof Square, hint: string) => (
    <button type="button" onClick={() => tabs.setLayout(v)} aria-pressed={value === v} aria-label={label} title={hint} className={cn(SEGMENT, value === v ? SEGMENT_ON : SEGMENT_OFF)}>
      <Icon className="size-3.5" aria-hidden />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
  return (
    <div className="mb-1 ml-auto hidden shrink-0 items-center gap-1.5 pl-2 lg:flex">
      {/* Two panes always sit in two columns, so the choice only matters from three. */}
      {value === 'grid' && panes >= 3 ? <ColumnsSwitch value={columns} /> : null}
      <div className="flex items-center gap-0.5 rounded-[8px] bg-hull-3 p-0.5" role="group" aria-label="Layout">
        {opt('grid', 'Side by side', LayoutGrid, 'See every open project at once')}
        {opt('tabs', 'One at a time', Square, 'One project full size, switch with the tabs')}
      </div>
    </div>
  );
}

/** Side by side: how many projects per row (3 shows six terminals as 3 × 2). */
function ColumnsSwitch({ value }: { value: WorkspaceColumns }) {
  return (
    <div className="flex items-center gap-0.5 rounded-[8px] bg-hull-3 p-0.5" role="radiogroup" aria-label="Columns side by side">
      <span className="px-1.5 text-2xs text-dust">Columns</span>
      {WORKSPACE_COLUMNS.map((c) => (
        <button
          key={String(c)}
          type="button"
          role="radio"
          aria-checked={value === c}
          onClick={() => tabs.setColumns(c)}
          title={c === 'auto' ? 'Orbit picks from how many projects are open and how wide the window is' : `${c} projects per row`}
          className={cn(SEGMENT, 'min-w-7 tabular-nums', value === c ? SEGMENT_ON : SEGMENT_OFF)}
        >
          {c === 'auto' ? 'Auto' : c}
        </button>
      ))}
    </div>
  );
}

function TabStrip({ list, active, repos, sessions, onSelect, layout, columns }: { list: WorkspaceTab[]; active: string | null; repos: RepoDTO[]; sessions: ConversationSummaryDTO[]; onSelect: (t: WorkspaceTab) => void; layout: WorkspaceLayout; columns: WorkspaceColumns }) {
  const [picking, setPicking] = useState(false);
  const navigate = useNavigate();
  // Side by side, every pane already shows its session title: the tab only names the project.
  const titled = layout === 'tabs' || list.length === 1;
  return (
    <div className="flex h-10 shrink-0 items-end gap-0.5 border-b border-seam bg-night px-2" role="tablist" aria-label="Open projects">
      {/* Tabs shrink like browser tabs before the strip scrolls. */}
      <div className="flex min-w-0 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {list.map((t) => {
          const repo = repos.find((r) => r.id === t.repoId);
          const s = t.sessionId ? sessions.find((x) => x.id === t.sessionId) : null;
          const lamp = t.sessionId ? lampOf(s) : 'new';
          const on = t.key === active;
          const name = repo?.name ?? 'Project';
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={on}
              tabIndex={0}
              onClick={() => onSelect(t)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(t)}
              title={`${name}: ${s?.title ?? 'New session'} (${LAMP_LABEL[lamp]})`}
              className={cn(
                'group flex h-[34px] min-w-[104px] max-w-[280px] cursor-pointer items-center gap-2 rounded-t-[8px] border border-b-0 pl-3 pr-1 text-sm transition-colors',
                on ? 'border-seam bg-hull text-chalk' : 'border-transparent text-dust hover:bg-hull-2 hover:text-chalk',
              )}
            >
              <LampDot lamp={lamp} />
              <span className={cn('min-w-0 truncate', on && 'font-[650]')}>{name}</span>
              {lamp === 'needs' ? (
                <span className="min-w-0 flex-1 basis-0 truncate text-xs text-signal-deep">needs your OK</span>
              ) : titled && s?.title ? (
                <span className="min-w-0 flex-1 basis-0 truncate text-xs text-dust">{s.title}</span>
              ) : null}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  tabs.close(t.key);
                  if (on) navigate('/');
                }}
                className={cn('ml-auto grid size-6 shrink-0 place-items-center rounded-[6px] text-dust hover:bg-hull-3 hover:text-chalk focus-visible:opacity-100', !on && 'opacity-0 group-hover:opacity-100')}
                aria-label={`Close ${name}`}
                title="Close this tab (the session is kept)"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="relative mb-1 shrink-0">
        <button type="button" onClick={() => setPicking(!picking)} aria-expanded={picking} className="grid size-7 place-items-center rounded-[8px] text-dust hover:bg-hull-2 hover:text-chalk" aria-label="Open a project in a new tab" title="New tab">
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
      {list.length >= 2 ? <LayoutSwitch value={layout} columns={columns} panes={list.length} /> : null}
    </div>
  );
}

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/**
 * Every open project at once, like a wall of terminals: each pane is a full session
 * (live steps, Allow buttons, follow-ups). The pane you are in has a teal edge; a pane
 * waiting for you has an amber one, so you notice it without switching.
 */
function PaneGrid({ list, active, repos, sessions, onFocus, onExpand }: { list: WorkspaceTab[]; active: string | null; repos: RepoDTO[]; sessions: ConversationSummaryDTO[]; onFocus: (t: WorkspaceTab) => void; onExpand: (t: WorkspaceTab) => void }) {
  const [box, size] = useSize<HTMLDivElement>();
  const term = useTheme() === 'terminal';
  const cols = gridColumns(list.length, size.width, useTabs().columns);
  const rows = Math.ceil(list.length / cols);
  // Fill the screen when the panes fit (each at least 380px tall); otherwise scroll.
  const fits = size.height / rows >= 380;
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto bg-night p-2">
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: fits ? `calc((${size.height}px - ${(rows - 1) * 8 + 16}px) / ${rows})` : '560px',
        }}
      >
        {list.map((t, i) => {
          const repo = repos.find((r) => r.id === t.repoId);
          if (!repo) return null;
          // The last pane fills the rest of its row, so there is no empty hole.
          const span = i === list.length - 1 && list.length % cols ? cols - (list.length % cols) + 1 : 1;
          const s = t.sessionId ? sessions.find((x) => x.id === t.sessionId) : null;
          const needs = !!t.sessionId && lampOf(s) === 'needs';
          const on = t.key === active;
          const several = list.length > 1;
          return (
            <div
              key={t.key}
              id={`pane-${t.key}`}
              style={span > 1 ? { gridColumn: `span ${span} / span ${span}` } : undefined}
              onMouseDownCapture={() => !on && onFocus(t)}
              onFocusCapture={() => !on && onFocus(t)}
              className={cn('relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[12px] border bg-hull transition-colors', needs ? 'border-signal' : on && several ? 'border-telemetry/70' : 'border-seam')}
            >
              {term ? <TerminalTabView tab={t} repo={repo} active={on} onExpand={several ? () => onExpand(t) : undefined} /> : <TabView tab={t} repo={repo} compact={several} onExpand={several ? () => onExpand(t) : undefined} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Welcome({ repos, sessions, onOpen, onAdd }: { repos: RepoDTO[]; sessions: ConversationSummaryDTO[]; onOpen: (repoId: string) => void; onAdd: () => void }) {
  const recent = sessions.filter((s) => s.repoIds.length === 1 && repos.some((r) => r.id === s.repoIds[0])).slice(0, 5);
  return (
    <div className="flex min-w-0 flex-1 overflow-y-auto px-5 py-10 sm:px-8 sm:py-14">
      <div className="mx-auto w-full min-w-0 max-w-[920px]">
        <h1 className="text-[32px] leading-10">What are we working on?</h1>
        <p className="mt-2 max-w-[56ch] text-base text-dust">Pick a project and tell the AI what you need. It asks before it runs anything.</p>
        <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((r) => {
            const lamp = projectLamp(r.id, sessions);
            const latest = ownSessions(r.id, sessions)[0];
            const note = projectNote(r, lamp, latest);
            const about = r.summary?.description ? plain(r.summary.description) : '';
            return (
              <li key={r.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpen(r.id)}
                  title={r.localPath}
                  className="flex h-full min-h-[104px] w-full min-w-0 flex-col rounded-[12px] border border-seam bg-hull p-4 text-left transition-[border-color,box-shadow] hover:border-seam-2 hover:shadow-[0_8px_20px_-14px_rgb(16_24_40/0.35)]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <LampDot lamp={lamp} />
                    <span className="casual truncate text-base font-[700]">{r.name}</span>
                  </span>
                  {about ? <span className="mt-1.5 line-clamp-2 text-xs text-dust">{about}</span> : <span className="mono mt-1.5 truncate text-2xs text-dust">{shortPath(r.localPath)}</span>}
                  {note ? (
                    <span className={cn('mt-auto flex min-w-0 items-baseline gap-2 pt-3 text-xs', note.tone)}>
                      <span className="truncate">{note.text}</span>
                      {latest && lamp === 'done' ? <span className="shrink-0 text-2xs text-dust">{timeAgo(latest.updatedAt)}</span> : null}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
          <li>
            <button type="button" onClick={onAdd} className="flex h-full min-h-[104px] w-full flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-seam-2 p-4 text-center text-dust transition-colors hover:border-dust hover:text-chalk">
              <FolderPlus className="size-5" aria-hidden />
              <span className="text-sm font-[600]">Add a project</span>
              <span className="text-2xs">Any folder on this computer</span>
            </button>
          </li>
        </ul>
        {recent.length ? (
          <div className="mt-12">
            <h2 className="text-sm">Pick up where you left off</h2>
            <ul className="mt-3 divide-y divide-seam rounded-[12px] border border-seam bg-hull">
              {recent.map((s) => (
                <li key={s.id}>
                  <Link to={`/s/${s.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hull-2">
                    <LampDot lamp={lampOf(s)} />
                    <span className="w-36 shrink-0 truncate text-sm font-[600]">{repos.find((r) => r.id === s.repoIds[0])?.name}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-dust">{s.title}</span>
                    <span className="shrink-0 text-2xs text-dust">{timeAgo(s.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function WorkspacePage() {
  const { id = null } = useParams();
  const term = useTheme() === 'terminal';
  const navigate = useNavigate();
  const repos = useRepos();
  const chats = useChats();
  const state = useTabs();
  const [adding, setAdding] = useState(false);
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
  const grid = state.layout === 'grid' && state.tabs.length > 0;
  // In side by side, a click on a tab or project brings its pane into view.
  const open = (repoId: string) => {
    const t = tabs.openProject(repoId);
    select(t);
    if (grid) requestAnimationFrame(() => document.getElementById(`pane-${t.key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  const pick = (t: WorkspaceTab) => {
    select(t);
    if (grid) document.getElementById(`pane-${t.key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const addDialog = <AddRepoDialog open={adding} onOpenChange={setAdding} />;

  if (!list.length) {
    return (
      <div className="m-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-[28px] leading-9">Add your first project</h1>
        <p className="mt-2 text-sm text-dust">A project is any folder on this computer: code, documents, a website. Add one and you can start working on it with an AI right away.</p>
        <Button variant="primary" size="lg" className="mt-6" onClick={() => setAdding(true)}>
          <FolderPlus className="size-4" /> Add a project
        </Button>
        {addDialog}
      </div>
    );
  }

  // With nothing open, the project cards are the whole screen: no second list beside them.
  if (!state.tabs.length) {
    return (
      <div className="flex min-h-0 flex-1">
        <Welcome repos={list} sessions={sessions} onOpen={open} onAdd={() => setAdding(true)} />
        {addDialog}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <ProjectRail repos={list} sessions={sessions} activeRepo={activeRepo?.id ?? null} onOpen={open} onAdd={() => setAdding(true)} narrow={grid && state.tabs.length > 1} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabStrip list={state.tabs} active={state.active} repos={list} sessions={sessions} onSelect={pick} layout={state.layout} columns={state.columns} />
        {grid ? (
          <PaneGrid
            list={state.tabs}
            active={state.active}
            repos={list}
            sessions={sessions}
            onFocus={select}
            onExpand={(t) => {
              tabs.setLayout('tabs');
              select(t);
            }}
          />
        ) : active && activeRepo ? (
          term ? (
            <TerminalTabView tab={active} repo={activeRepo} />
          ) : (
            <TabView tab={active} repo={activeRepo} />
          )
        ) : (
          <Welcome repos={list} sessions={sessions} onOpen={open} onAdd={() => setAdding(true)} />
        )}
      </div>
      {addDialog}
    </div>
  );
}
