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

interface TabState {
  tabs: WorkspaceTab[];
  active: string | null;
  layout: WorkspaceLayout;
}

const STORAGE_KEY = 'orbit.workspace.tabs.v1';
const listeners = new Set<() => void>();

function load(): TabState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as TabState | null;
    if (raw && Array.isArray(raw.tabs)) return { tabs: raw.tabs.filter((t) => t && typeof t.key === 'string' && typeof t.repoId === 'string'), active: raw.active ?? null, layout: raw.layout === 'tabs' ? 'tabs' : 'grid' };
  } catch {
    /* ignore a corrupt entry */
  }
  return { tabs: [], active: null, layout: 'grid' };
}

let state: TabState = typeof localStorage === 'undefined' ? { tabs: [], active: null, layout: 'grid' } : load();

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
