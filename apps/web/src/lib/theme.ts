import { useSyncExternalStore } from 'react';

/**
 * `terminal`: dark and monospace, laid out like the Claude Code terminal, so people who
 * use Claude Code feel at home (the default). `light`: the white, friendly workbench.
 */
export type Theme = 'terminal' | 'light';

const KEY = 'orbit.theme';
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'terminal';
  } catch {
    return 'terminal';
  }
}

let current: Theme = typeof localStorage === 'undefined' ? 'terminal' : read();

/** Puts the theme on <html>; index.html does the same before the first paint. */
function apply(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme === 'terminal' ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'terminal' ? '#0c0c0c' : '#ffffff');
}
apply(current);

export function setTheme(theme: Theme) {
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: not remembered */
  }
  apply(theme);
  for (const l of listeners) l();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}
