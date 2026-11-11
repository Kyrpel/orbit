import { useSyncExternalStore } from 'react';

/**
 * The workspace's open tabs, remembered in this browser. A tab is one project with
 * either a session (`sessionId`) or a new, not yet started session (`sessionId: null`),
 * the way a terminal tab is one shell in one folder.
 */
export interface WorkspaceTab {
  key: string;
  repoId: string;
  sessionId: string | null;
}

/** `grid`: every open project side by side. `tabs`: one at a time, full size. */
export type WorkspaceLayout = 'grid' | 'tabs';

/** Side by side: how many columns. `auto` picks from the number of panes and the window width. */
export type WorkspaceColumns = 'auto' | 2 | 3 | 4;
export const WORKSPACE_COLUMNS: WorkspaceColumns[] = ['auto', 2, 3, 4];

interface TabState {
  tabs: WorkspaceTab[];
  active: string | null;
  layout: WorkspaceLayout;
  columns: WorkspaceColumns;
}

/**
 * Columns for `n` panes in a container `width` pixels wide. A narrow window always gets one
 * column, and there are never more columns than panes; otherwise your choice wins, and `auto`
 * keeps two for 2 or 4 panes and uses three when 5 or more fit side by side.
 */
export function gridColumns(n: number, width: number, choice: WorkspaceColumns = 'auto'): number {
  if (width < 760 || n <= 1) return 1;
  if (choice !== 'auto') return Math.min(choice, n);
  if (n === 2 || n === 4) return 2;
  return width >= 1500 ? 3 : 2;
}

const STORAGE_KEY = 'orbit.workspace.tabs.v1';
const listeners = new Set<() => void>();

function load(): TabState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as TabState | null;
    if (raw && Array.isArray(raw.tabs)) {
      return {
        tabs: raw.tabs.filter((t) => t && typeof t.key === 'string' && typeof t.repoId === 'string'),
        active: raw.active ?? null,
        layout: raw.layout === 'tabs' ? 'tabs' : 'grid',
        columns: WORKSPACE_COLUMNS.includes(raw.columns) ? raw.columns : 'auto',
      };
    }
  } catch {
    /* ignore a corrupt entry */
  }
  return { tabs: [], active: null, layout: 'grid', columns: 'auto' };
}

let state: TabState = typeof localStorage === 'undefined' ? { tabs: [], active: null, layout: 'grid', columns: 'auto' } : load();

function set(next: TabState) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: tabs just are not remembered */
  }
  for (const l of listeners) l();
}

const newKey = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function useTabs(): TabState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

export const tabs = {
  get: () => state,
  setLayout(layout: WorkspaceLayout) {
    if (state.layout !== layout) set({ ...state, layout });
  },
  /** Columns side by side (and switches to side by side, where columns apply). */
  setColumns(columns: WorkspaceColumns) {
    if (state.columns !== columns || state.layout !== 'grid') set({ ...state, columns, layout: 'grid' });
  },
  activate(key: string) {
    if (state.tabs.some((t) => t.key === key)) set({ ...state, active: key });
  },
  /** Focus the project's open tab, or open a new session tab for it. */
  openProject(repoId: string): WorkspaceTab {
    const existing = state.tabs.find((t) => t.repoId === repoId && t.key === state.active) ?? state.tabs.find((t) => t.repoId === repoId);
    if (existing) {
      set({ ...state, active: existing.key });
      return existing;
    }
    return tabs.newSession(repoId);
  },
  /** Always a fresh tab, like opening another terminal in the same folder. */
  newSession(repoId: string): WorkspaceTab {
    const tab = { key: newKey(), repoId, sessionId: null };
    set({ ...state, tabs: [...state.tabs, tab], active: tab.key });
    return tab;
  },
  /** Focus (or open) the tab that shows a session. */
  openSession(sessionId: string, repoId: string): WorkspaceTab {
    const existing = state.tabs.find((t) => t.sessionId === sessionId);
    if (existing) {
      if (state.active !== existing.key) set({ ...state, active: existing.key });
      return existing;
    }
    const tab = { key: newKey(), repoId, sessionId };
    set({ ...state, tabs: [...state.tabs, tab], active: tab.key });
    return tab;
  },
  /** A new session tab became a real session after its first message. */
  attach(key: string, sessionId: string) {
    set({ ...state, tabs: state.tabs.map((t) => (t.key === key ? { ...t, sessionId } : t)) });
  },
  /** Show another session of the same project in this tab. */
  show(key: string, sessionId: string | null) {
    set({ ...state, tabs: state.tabs.map((t) => (t.key === key ? { ...t, sessionId } : t)), active: key });
  },
  close(key: string) {
    const i = state.tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    const rest = state.tabs.filter((t) => t.key !== key);
    const active = state.active === key ? (rest[Math.min(i, rest.length - 1)]?.key ?? null) : state.active;
    set({ ...state, tabs: rest, active });
  },
  /** Drop tabs whose project or session no longer exists. */
  prune(repoIds: Set<string>, sessionIds: Set<string> | null) {
    const kept = state.tabs.filter((t) => repoIds.has(t.repoId) && (!t.sessionId || !sessionIds || sessionIds.has(t.sessionId)));
    if (kept.length !== state.tabs.length) set({ ...state, tabs: kept, active: kept.some((t) => t.key === state.active) ? state.active : (kept[0]?.key ?? null) });
  },
};
