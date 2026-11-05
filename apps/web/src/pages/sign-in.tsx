import { ApiError } from '../lib/api';
import { Code } from '../components/ui';

export function SignInPage({ error }: { error: unknown }) {
  const unauthorized = error instanceof ApiError && error.status === 401;
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="max-w-md">
        <svg viewBox="0 0 32 32" className="mb-6 size-10" aria-hidden>
          <ellipse cx="16" cy="16" rx="12.5" ry="7" fill="none" stroke="var(--color-telemetry)" strokeWidth="1.5" transform="rotate(-24 16 16)" />
          <circle cx="16" cy="16" r="4.4" fill="var(--color-chalk)" />
          <circle cx="26.6" cy="11.2" r="2.4" fill="var(--color-signal)" />
        </svg>
        <h1 className="text-2xl">{unauthorized ? 'Sign in to Orbit' : 'Orbit is not reachable'}</h1>
        {unauthorized ? (
          <p className="mt-3 text-sm text-dust">
            Orbit only accepts requests that carry the token stored on this machine. Run <Code>orbit open</Code> in a terminal for a signed-in link, or use the link
            printed by <Code>orbit start</Code>.
          </p>
        ) : (
          <p className="mt-3 text-sm text-dust">
            Start it with <Code>orbit start</Code> (or <Code>pnpm dev</Code> in a checkout), then reload this page.
          </p>
        )}
      </div>
    </div>
  );
}
