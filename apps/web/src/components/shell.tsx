import { Activity, Bot, FolderGit2, LayoutGrid, MoreHorizontal, Plug, Rocket, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useOverview } from '../lib/api';
import { useNewVersion } from '../lib/new-version';
import { cn } from '../lib/utils';
import { Toaster } from './ui';

function Logo() {
  return (
    <NavLink to="/" className="flex items-center gap-2 rounded-[8px] pr-2" aria-label="Orbit workspace">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <ellipse cx="16" cy="16" rx="12.5" ry="7" fill="none" stroke="var(--color-telemetry)" strokeWidth="1.6" transform="rotate(-24 16 16)" />
        <circle cx="16" cy="16" r="4.4" fill="var(--color-chalk)" />
        <circle cx="26.6" cy="11.2" r="2.6" fill="var(--color-signal)" />
      </svg>
      <span className="casual text-lg font-[700]">Orbit</span>
    </NavLink>
  );
}

const MAIN = [
  { to: '/', label: 'Workspace', icon: LayoutGrid, end: true, match: (p: string) => p === '/' || p.startsWith('/s/') },
  { to: '/autopilot', label: 'Autopilot', icon: Rocket, end: false, match: (p: string) => p.startsWith('/autopilot') || p.startsWith('/missions') },
  { to: '/agents', label: 'Agents', icon: Bot, end: false, match: (p: string) => p.startsWith('/agents') },
  { to: '/projects', label: 'Projects', icon: FolderGit2, end: false, match: (p: string) => p.startsWith('/projects') },
  { to: '/settings', label: 'Settings', icon: Settings2, end: false, match: (p: string) => p.startsWith('/settings') },
];
const MORE = [
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/integrations', label: 'Integrations', icon: Plug },
];

function MoreMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="More pages"
        className={cn('grid size-9 place-items-center rounded-[8px] text-dust hover:bg-hull-2 hover:text-chalk', open && 'bg-hull-2 text-chalk')}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open ? (
        <div className="absolute right-0 top-11 z-30 w-48 rounded-[12px] border border-seam bg-hull p-1.5 shadow-[0_12px_32px_-12px_rgb(16_24_40/0.25)]">
          {MORE.map((i) => (
            <NavLink key={i.to} to={i.to} className="flex h-9 items-center gap-2.5 rounded-[8px] px-2.5 text-sm text-chalk/85 hover:bg-hull-2">
              <i.icon className="size-4 text-dust" aria-hidden />
              {i.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The app frame: one quiet top bar with plain page names, then the page. The
 * workspace takes the full width under the bar; other pages sit in a readable column.
 */
export function Shell({ children, live }: { children: ReactNode; live: 'connecting' | 'live' | 'offline' }) {
  const overview = useOverview();
  const attention = overview.data?.counts.attention ?? 0;
  const { pathname } = useLocation();
  const fullBleed = pathname === '/' || pathname.startsWith('/s/');
  const updated = useNewVersion(live);
  return (
    <div className="flex min-h-screen flex-col">
      {updated ? (
        <div className="flex items-center justify-center gap-3 bg-telemetry px-4 py-2 text-sm text-hull" role="status">
          Orbit was updated. Reload to get the latest version.
          <button type="button" onClick={() => window.location.reload()} className="rounded-[8px] bg-hull px-3 py-1 text-xs font-[650] text-telemetry hover:bg-hull-2">
            Reload
          </button>
        </div>
      ) : null}
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-4 border-b border-seam bg-hull/95 px-4 backdrop-blur-sm md:px-5">
        <Logo />
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Main">
          {MAIN.map((i) => {
            const active = i.match(pathname);
            return (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.end}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex h-9 shrink-0 items-center gap-2 rounded-[8px] px-3 text-sm transition-colors',
                  active ? 'bg-hull-2 font-[600] text-chalk' : 'text-dust hover:bg-hull-2 hover:text-chalk',
                )}
              >
                <i.icon className="size-4" aria-hidden />
                {i.label}
                {i.to === '/autopilot' && attention ? (
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-signal px-1.5 text-2xs font-[700] text-signal-ink tabular" aria-label={`${attention} waiting for you`}>
                    {attention}
                  </span>
                ) : null}
              </NavLink>
            );
          })}
        </nav>
        <span className="hidden items-center gap-2 text-2xs text-dust lg:flex" title="Orbit runs on this computer only">
          <span className={cn('size-2 rounded-full', live === 'live' ? 'bg-go' : live === 'connecting' ? 'bg-signal' : 'bg-fault')} aria-hidden />
          {live === 'live' ? 'Running on this computer' : live === 'connecting' ? 'Connecting…' : 'Offline: is Orbit still running?'}
        </span>
        <MoreMenu />
      </header>
      {fullBleed ? (
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      ) : (
        <main className="min-w-0 flex-1 px-5 pb-16 pt-8 md:px-10">
          <div className="mx-auto max-w-[1180px]">{children}</div>
        </main>
      )}
      <Toaster />
    </div>
  );
}
