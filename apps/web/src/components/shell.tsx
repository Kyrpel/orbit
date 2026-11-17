import { Settings2, SquareTerminal, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useOverview } from '../lib/api';
import { useNewVersion } from '../lib/new-version';
import { setTheme, useTheme, type Theme } from '../lib/theme';
import { cn } from '../lib/utils';
import { Toaster } from './ui';

function Logo() {
  return (
    <NavLink to="/" className="flex shrink-0 items-center gap-2 rounded-[8px] pr-1" aria-label="Orbit workspace">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <ellipse cx="16" cy="16" rx="12.5" ry="7" fill="none" stroke="var(--color-telemetry)" strokeWidth="1.6" transform="rotate(-24 16 16)" />
        <circle cx="16" cy="16" r="4.4" fill="var(--color-chalk)" />
        <circle cx="26.6" cy="11.2" r="2.6" fill="var(--color-signal)" />
      </svg>
      <span className="casual text-lg font-[700]">Orbit</span>
    </NavLink>
  );
}

/** The three places you work. Everything you set up once is under Settings. */
const MAIN = [
  { to: '/', label: 'Workspace', end: true, match: (p: string) => p === '/' || p.startsWith('/s/') },
  { to: '/autopilot', label: 'Autopilot', end: false, match: (p: string) => p.startsWith('/autopilot') || p.startsWith('/missions') },
  { to: '/projects', label: 'Projects', end: false, match: (p: string) => p.startsWith('/projects') },
];

const SETTINGS = [
  { to: '/settings', label: 'General' },
  { to: '/agents', label: 'Agents' },
  { to: '/skills', label: 'Skills' },
  { to: '/integrations', label: 'Connections' },
  { to: '/activity', label: 'Activity' },
];

const inSettings = (p: string) => SETTINGS.some((i) => p === i.to || p.startsWith(`${i.to}/`));

/** Terminal (dark, like Claude Code) or Light. */
function ThemeSwitch() {
  const theme = useTheme();
  const opt = (v: Theme, label: string, Icon: typeof Sun, hint: string) => (
    <button
      type="button"
      onClick={() => setTheme(v)}
      aria-pressed={theme === v}
      title={hint}
      className={cn('flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-xs transition-colors', theme === v ? 'bg-hull font-[600] text-chalk shadow-[0_1px_2px_rgb(16_24_40/0.12)]' : 'text-dust hover:text-chalk')}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-[8px] bg-hull-3 p-0.5" role="group" aria-label="Look">
      {opt('terminal', 'Terminal', SquareTerminal, 'Dark, like Claude Code in a terminal')}
      {opt('light', 'Light', Sun, 'White and friendly')}
    </div>
  );
}

/** Settings pages share one side list, so every setting has an obvious home. */
function SettingsFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-[1180px] gap-x-10 gap-y-6 lg:grid-cols-[168px_minmax(0,1fr)]">
      <nav aria-label="Settings" className="min-w-0 lg:sticky lg:top-[88px] lg:self-start">
        <p className="mb-2 hidden px-3 text-xs text-dust lg:block">Settings</p>
        <ul className="-mx-1 flex gap-0.5 overflow-x-auto px-1 py-0.5 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:py-0">
          {SETTINGS.map((i) => (
            <li key={i.to} className="shrink-0">
              <NavLink
                to={i.to}
                className={({ isActive }) =>
                  cn('flex h-9 items-center rounded-[8px] px-3 text-sm transition-colors', isActive ? 'bg-hull font-[600] text-chalk shadow-[0_1px_2px_rgb(16_24_40/0.08)]' : 'text-dust hover:bg-hull-2 hover:text-chalk')
                }
              >
                {i.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The app frame: one quiet top bar, then the page. The workspace takes the whole window
 * under the bar; other pages sit in a readable column.
 */
export function Shell({ children, live }: { children: ReactNode; live: 'connecting' | 'live' | 'offline' }) {
  const overview = useOverview();
  const attention = overview.data?.counts.attention ?? 0;
  const { pathname } = useLocation();
  const fullBleed = pathname === '/' || pathname.startsWith('/s/');
  const settings = inSettings(pathname);
  const updated = useNewVersion(live);
  const tab = (active: boolean) => cn('relative flex h-9 shrink-0 items-center gap-2 rounded-[8px] px-3 text-sm transition-colors', active ? 'bg-hull-2 font-[600] text-chalk' : 'text-dust hover:bg-hull-2 hover:text-chalk');
  return (
    <div className={cn('flex flex-col', fullBleed ? 'h-dvh overflow-hidden' : 'min-h-dvh')}>
      {updated ? (
        <div className="flex shrink-0 items-center justify-center gap-3 bg-telemetry px-4 py-2 text-sm text-hull" role="status">
          Orbit was updated. Reload to get the latest version.
          <button type="button" onClick={() => window.location.reload()} className="rounded-[8px] bg-hull px-3 py-1 text-xs font-[650] text-telemetry hover:bg-hull-2">
            Reload
          </button>
        </div>
      ) : null}
      <header className="sticky top-0 z-20 flex shrink-0 flex-wrap items-center gap-x-3 border-b border-seam bg-hull px-4 pt-2 sm:h-13 sm:flex-nowrap sm:pt-0 md:px-5">
        <Logo />
        <nav className="order-last flex min-w-0 basis-full items-center gap-0.5 overflow-x-auto py-1.5 [scrollbar-width:none] sm:order-none sm:flex-1 sm:basis-auto sm:py-0" aria-label="Main">
          {MAIN.map((i) => {
            const active = i.match(pathname);
            return (
              <NavLink key={i.to} to={i.to} end={i.end} aria-current={active ? 'page' : undefined} className={tab(active)}>
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
        <span className="flex-1 sm:hidden" aria-hidden />
        {live === 'connecting' ? (
          <span className="hidden items-center gap-2 text-2xs text-dust sm:flex" role="status">
            <span className="size-2 rounded-full bg-signal" aria-hidden />
            Connecting…
          </span>
        ) : null}
        <ThemeSwitch />
        <NavLink to="/settings" aria-current={settings ? 'page' : undefined} className={tab(settings)} title="Agents, skills, connections and how Orbit behaves">
          <Settings2 className="size-4" aria-hidden />
          <span className="hidden sm:inline">Settings</span>
        </NavLink>
      </header>
      {live === 'offline' ? (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-fault/30 bg-fault/10 px-4 py-2 text-sm text-chalk" role="alert">
          <span className="size-2 rounded-full bg-fault" aria-hidden />
          Orbit is not answering. Check that it is still running on this computer, then reload.
          <button type="button" onClick={() => window.location.reload()} className="rounded-[8px] border border-fault/40 px-3 py-0.5 text-xs font-[600] hover:bg-fault/10">
            Reload
          </button>
        </div>
      ) : null}
      {fullBleed ? (
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      ) : (
        <main className="min-w-0 flex-1 px-5 pb-16 pt-8 md:px-10">{settings ? <SettingsFrame>{children}</SettingsFrame> : <div className="mx-auto max-w-[1180px]">{children}</div>}</main>
      )}
      <Toaster />
    </div>
  );
}
