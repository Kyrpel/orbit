import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, RuntimeAvailability } from '@orbit/agents';
import type { AiProvider, EffortLevel, ProviderStatusDTO, SeatResolutionDTO, TeamDTO, TeamSeat } from '@orbit/shared';
import type { OrbitContext } from './context';
import { resolveRuntime } from './runtimes';

/**
 * The orchestrator's routing table: which AI sits in each seat of the team.
 *
 * - Claude comes from the existing "Claude connection" setting (Claude Code plan,
 *   API key or cloud provider). If that setting is `scripted`, every seat is scripted.
 * - Codex is the developer's local Codex CLI.
 * - `auto` gives Claude the planner, engineer and assistant seats, and gives the
 *   reviewer seat to the *other* AI, so every change gets a second opinion from a
 *   different model.
 * - With fallback on, a seat whose AI is not ready, or hits its usage limit, moves to the other AI.
 */

export interface SeatCandidate {
  runtime: AgentRuntime;
  availability: RuntimeAvailability;
  provider: AiProvider;
  label: string;
  model: string | null;
  effort: EffortLevel | null;
}

export interface SeatPlan {
  seat: TeamSeat;
  primary: SeatCandidate | null;
  fallback: SeatCandidate | null;
  why: string;
}

export const PROVIDER_LABEL: Record<AiProvider, string> = { claude: 'Claude', codex: 'Codex', scripted: 'Scripted demo' };

export function providerOf(runtime: Pick<AgentRuntime, 'id' | 'kind'>): AiProvider {
  if (runtime.kind === 'scripted') return 'scripted';
  return runtime.id === 'codex-cli' ? 'codex' : 'claude';
}

const codexCache = new WeakMap<OrbitContext, { at: number; value: RuntimeAvailability }>();
const TTL_MS = 30_000;

async function codexAvailability(ctx: OrbitContext, runtime: AgentRuntime): Promise<RuntimeAvailability> {
  const hit = codexCache.get(ctx);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await runtime.checkAvailability().catch((err: Error) => ({ available: false, reason: err.message, sandbox: 'unknown' as const, details: {} }));
  codexCache.set(ctx, { at: Date.now(), value });
  return value;
}

/** Drop the cached Codex check (after a failed run or a settings change). */
export function forgetCodexAvailability(ctx: OrbitContext): void {
  codexCache.delete(ctx);
}

interface Providers {
  claude: { runtime: AgentRuntime; availability: RuntimeAvailability } | null;
  codex: { runtime: AgentRuntime; availability: RuntimeAvailability } | null;
  scripted: boolean;
}

async function providers(ctx: OrbitContext): Promise<Providers> {
  const resolved = await resolveRuntime(ctx).catch(() => null);
  const scripted = resolved?.runtime.kind === 'scripted';
  // A resolved Codex runtime only happens in tests that register nothing else.
  const claude = resolved && !scripted && resolved.runtime.id !== 'codex-cli' ? { runtime: resolved.runtime, availability: resolved.availability } : null;
  const codexRt = ctx.runtimes.get('codex-cli');
  const codex = codexRt && !scripted ? { runtime: codexRt, availability: await codexAvailability(ctx, codexRt) } : null;
  if (scripted && resolved) return { claude: { runtime: resolved.runtime, availability: resolved.availability }, codex: null, scripted: true };
  return { claude, codex, scripted: false };
}

function candidate(ctx: OrbitContext, seat: TeamSeat, p: { runtime: AgentRuntime; availability: RuntimeAvailability }): SeatCandidate {
  const settings = ctx.settings.get();
  const provider = providerOf(p.runtime);
  const model = provider === 'codex' ? settings.codexModels[seat] : provider === 'scripted' ? null : settings.models[seat];
  return { runtime: p.runtime, availability: p.availability, provider, label: PROVIDER_LABEL[provider], model, effort: settings.efforts[seat] ?? null };
}

/** The provider the engineer will most likely use, for the reviewer's "different AI" rule. */
function engineerProvider(ctx: OrbitContext, p: Providers): 'claude' | 'codex' | null {
  const choice = ctx.settings.get().team.engineer;
  const claudeOk = !!p.claude?.availability.available;
  const codexOk = !!p.codex?.availability.available;
  const codexFirst = choice === 'codex' || (choice === 'auto' && codexBuildsSafer(ctx.platform, ctx.settings.get().execution.mode) && codexOk);
  if (codexFirst) return codexOk ? 'codex' : claudeOk ? 'claude' : null;
  return claudeOk ? 'claude' : codexOk ? 'codex' : null;
}

/**
 * Claude Code's OS sandbox does not run on Windows, so a sandboxed Claude engineer
 * stops before writing anything there. Codex brings its own sandbox that does work
 * on Windows, so Auto gives Codex the engineer seat in that case.
 */
export function codexBuildsSafer(platform: NodeJS.Platform, mode: 'sandbox' | 'trusted-local'): boolean {
  return platform === 'win32' && mode === 'sandbox';
}

/**
 * Decides which AI runs a seat now, what it falls back to, and why, in plain words.
 * `choice` overrides the seat's setting (a working session's own Claude/Codex pick).
 */
export async function planSeat(ctx: OrbitContext, seat: TeamSeat, choice: 'auto' | 'claude' | 'codex' = ctx.settings.get().team[seat]): Promise<SeatPlan> {
  const settings = ctx.settings.get();
  const p = await providers(ctx);
  if (p.scripted && p.claude) return { seat, primary: candidate(ctx, seat, p.claude), fallback: null, why: 'Scripted demo runtime: no AI, deterministic changes only.' };

  let order: ('claude' | 'codex')[] = ['claude', 'codex'];
  let why: string;
  if (choice === 'claude') why = 'You chose Claude for this seat.';
  else if (choice === 'codex') {
    order = ['codex', 'claude'];
    why = 'You chose Codex for this seat.';
  } else if (seat === 'reviewer' || seat === 'security') {
    const eng = engineerProvider(ctx, p);
    const other = eng === 'claude' ? 'codex' : eng === 'codex' ? 'claude' : null;
    const what = seat === 'security' ? 'checks the security of' : 'reviews';
    if (other && p[other]?.availability.available) {
      order = [other, other === 'claude' ? 'codex' : 'claude'];
      why = `Auto: ${PROVIDER_LABEL[other]} ${what} ${PROVIDER_LABEL[eng as AiProvider]}'s work, so every change gets a second opinion from a different AI.`;
    } else {
      why = `Auto: only one AI is ready, so it also ${what === 'reviews' ? 'reviews' : 'checks security'}. Connect the other one for a second opinion.`;
    }
  } else if (seat === 'engineer' && codexBuildsSafer(ctx.platform, settings.execution.mode) && p.codex?.availability.available) {
    order = ['codex', 'claude'];
    why = "Auto: Codex writes the code, because its sandbox works on Windows and Claude Code's does not.";
  } else {
    why =
      seat === 'assistant'
        ? 'Auto: Claude works with you directly in your projects, like Claude Code in a terminal.'
        : seat === 'prompter'
          ? 'Auto: Claude rewrites rough tasks into clear ones, with a fast model.'
        : seat === 'engineer'
          ? 'Auto: Claude writes the code.'
          : 'Auto: Claude reads the task and your code and proposes the plan.';
  }

  const options = order.map((k) => p[k]).filter((x): x is NonNullable<typeof x> => !!x);
  const first = options[0] ?? null;
  const second = options[1] ?? null;
  if (!first) return { seat, primary: null, fallback: null, why: 'No AI is connected. Sign in to Claude Code or Codex.' };

  if (!first.availability.available && settings.team.fallback && second?.availability.available) {
    const name = PROVIDER_LABEL[providerOf(first.runtime)];
    return { seat, primary: candidate(ctx, seat, second), fallback: null, why: `${why} ${name} is not ready (${first.availability.reason ?? 'unavailable'}), so ${PROVIDER_LABEL[providerOf(second.runtime)]} stands in.` };
  }
  const fallback = settings.team.fallback && second?.availability.available ? candidate(ctx, seat, second) : null;
  return { seat, primary: candidate(ctx, seat, first), fallback, why };
}

export function seatResolution(plan: SeatPlan): SeatResolutionDTO {
  const c = plan.primary;
  return {
    runtimeId: c?.runtime.id ?? null,
    provider: c?.provider ?? null,
    label: c?.label ?? 'Not connected',
    model: c?.model ?? null,
    available: !!c?.availability.available,
    why: c && !c.availability.available ? `${plan.why} ${c.label} is not ready: ${c.availability.reason ?? 'unavailable'}` : plan.why,
    fallback: plan.fallback ? { runtimeId: plan.fallback.runtime.id, provider: plan.fallback.provider, label: plan.fallback.label, model: plan.fallback.model } : null,
  };
}

/** Where mission worktrees go: the configured folder, or ORBIT_HOME/worktrees. */
export function worktreeRoot(ctx: OrbitContext): string {
  return ctx.settings.get().execution.worktreeRoot || ctx.paths.worktrees;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function teamStatus(ctx: OrbitContext): Promise<TeamDTO> {
  const settings = ctx.settings.get();
  const p = await providers(ctx);
  const list: ProviderStatusDTO[] = [];
  const claudeRt = p.claude?.runtime ?? ctx.runtimes.get('claude-code-cli') ?? ctx.runtimes.get('claude-agent-sdk');
  if (claudeRt && claudeRt.kind !== 'scripted') {
    const a = p.claude?.availability ?? (await claudeRt.checkAvailability().catch(() => null));
    list.push({
      provider: 'claude',
      runtimeId: claudeRt.id,
      label: claudeRt.id === 'claude-code-cli' ? 'Claude Code' : 'Claude (API)',
      available: !!a?.available,
      reason: a?.reason ?? null,
      details: a?.details ?? {},
      models: [
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
        { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
      ],
    });
  }
  const codexRt = ctx.runtimes.get('codex-cli');
  if (codexRt) {
    const a = p.codex?.availability ?? (await codexAvailability(ctx, codexRt));
    const models = 'listModels' in codexRt && typeof codexRt.listModels === 'function' ? (codexRt.listModels as () => { id: string; label: string }[])() : [];
    list.push({ provider: 'codex', runtimeId: 'codex-cli', label: 'Codex', available: a.available, reason: a.reason, details: a.details, models });
  }
  const root = worktreeRoot(ctx);
  const codexBlocked = ctx.platform === 'win32' && isInside(root, os.homedir());
  return {
    providers: list,
    fallback: settings.team.fallback,
    worktrees: {
      root,
      custom: !!settings.execution.worktreeRoot,
      codexBlocked,
      suggestedRoot: codexBlocked ? path.join(path.parse(os.homedir()).root, 'orbit-work') : null,
    },
  };
}
