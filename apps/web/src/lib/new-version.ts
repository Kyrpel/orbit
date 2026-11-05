import { useEffect, useState } from 'react';

/** The bundle this tab is running, e.g. `/assets/index-B6FSXKBS.js` (null in dev). */
function currentBundle(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return s ? new URL(s.src).pathname : null;
}

/**
 * True when Orbit was updated after this tab loaded (the dashboard bundle on the server
 * changed). Without this, an open tab keeps running the old dashboard after a restart.
 */
export function useNewVersion(live: 'connecting' | 'live' | 'offline'): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const mine = currentBundle();
    if (!mine || stale) return;
    let cancelled = false;
    const check = async () => {
      try {
        const html = await (await fetch('/', { cache: 'no-store', credentials: 'same-origin' })).text();
        const served = /\/assets\/index-[^"']+\.js/.exec(html)?.[0];
        if (!cancelled && served && served !== mine) setStale(true);
      } catch {
        /* offline: try again later */
      }
    };
    void check();
    const t = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // Re-check whenever the live connection comes back (a restart drops it).
  }, [live, stale]);
  return stale;
}
