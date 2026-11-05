import type { AgentRuntime, RuntimeAvailability } from '@orbit/agents';
import type { OrbitContext } from './context';

/**
 * Order for the "automatic" runtime: the developer's own Claude Code plan first
 * (no per-token billing, nothing to configure), then an API key or cloud provider.
 */
export const AUTO_RUNTIME_ORDER = ['claude-code-cli', 'claude-agent-sdk'] as const;

export interface ResolvedRuntime {
  runtime: AgentRuntime;
  availability: RuntimeAvailability;
  /** True when chosen by the automatic setting. */
  automatic: boolean;
}

const cache = new WeakMap<OrbitContext, { at: number; key: string; value: ResolvedRuntime }>();
const TTL_MS = 30_000;

/** Resolves the runtime to use now, honoring the "auto" setting. Availability checks are cached briefly. */
export async function resolveRuntime(ctx: OrbitContext): Promise<ResolvedRuntime | null> {
  const setting = ctx.settings.get().execution.runtime;
  const hit = cache.get(ctx);
  if (hit && hit.key === setting && Date.now() - hit.at < TTL_MS) return hit.value;

  let value: ResolvedRuntime | null = null;
  if (setting !== 'auto') {
    const runtime = ctx.runtimes.get(setting);
    if (runtime) value = { runtime, availability: await runtime.checkAvailability(), automatic: false };
  } else {
    let first: ResolvedRuntime | null = null;
    for (const id of AUTO_RUNTIME_ORDER) {
      const runtime = ctx.runtimes.get(id);
      if (!runtime) continue;
      const availability = await runtime.checkAvailability();
      const candidate = { runtime, availability, automatic: true };
      first ??= candidate;
      if (availability.available) {
        value = candidate;
        break;
      }
    }
    if (!value && first) {
      value = {
        ...first,
        availability: {
          ...first.availability,
          reason: 'Install Claude Code and sign in once (run `claude`), or set ANTHROPIC_API_KEY before starting Orbit.',
        },
      };
    }
    // Test setups may register only non-default runtimes (for example the scripted one).
    if (!value) {
      const only = [...ctx.runtimes.values()][0];
      if (only) value = { runtime: only, availability: await only.checkAvailability(), automatic: true };
    }
  }
  if (value) cache.set(ctx, { at: Date.now(), key: setting, value });
  return value;
}

/** Drop the cached choice (after settings change or a failed run). */
export function forgetResolvedRuntime(ctx: OrbitContext): void {
  cache.delete(ctx);
}
