import type { AgentGateway } from '@orbit/agents';
import { OrbitError } from '@orbit/shared';
import type { OrbitContext } from './context';
import { planSeat, type SeatCandidate } from './team';

/*
  Other AIs that run inside Claude Code's tools through their own Anthropic-compatible API:
  OpenRouter, and your own models on rented GPUs (Hugging Face Inference Endpoints). A session
  that picks one stays on it for everything (answers, /compact, next-message suggestions,
  /improve): it never falls back to Claude or Codex, and your Claude login is never used.
*/

export interface GatewaySeat {
  /** Who runs it: Claude Code (the program only) with `gateway` attached, or the AI's own CLI (Cursor). */
  candidate: SeatCandidate;
  /** The Anthropic-compatible API Claude Code talks to; null when the AI runs its own CLI. */
  gateway: AgentGateway | null;
}

export interface GatewayProvider {
  /** The session provider it serves. */
  readonly id: 'openrouter' | 'huggingface' | 'cursor';
  /** "OpenRouter", "Hugging Face". */
  readonly label: string;
  /** For the model's own note on who it is: "served through OpenRouter". */
  readonly servedBy: string;
  /**
   * Ready to run `model` (the session's model setting, or null for this AI's default).
   * `wake: false`: do not start a sleeping endpoint (for small extras like suggestions); it then throws.
   */
  seat(model: string | null, opts?: { onProgress?: (message: string) => void; signal?: AbortSignal; wake?: boolean }): Promise<GatewaySeat>;
  /** Its name for the model, and your instructions for it. */
  info(model: string): { name: string; instructions: string };
}

/**
 * The seat for a gateway model: the Claude Code CLI (only the program: your Claude login is
 * never used, the run authenticates with the gateway's key) on `model`, with `gateway` attached.
 */
export async function claudeCodeSeat(ctx: OrbitContext, label: string, model: string, gateway: AgentGateway): Promise<GatewaySeat> {
  const plan = await planSeat(ctx, 'assistant', 'claude');
  const claude = [plan.primary, plan.fallback].find((c) => c?.runtime.id === 'claude-code-cli') ?? null;
  if (!claude) throw new OrbitError('PRECONDITION', `${label} runs inside the Claude Code CLI, which is not installed.`, { hint: 'Install it with npm install -g @anthropic-ai/claude-code.' });
  // Not being signed in to Claude does not matter here: the CLI only has to be installed.
  const installed = claude.availability.available || !!claude.availability.details.version;
  return {
    candidate: { ...claude, label, model, gateway, availability: installed ? { ...claude.availability, available: true, reason: null } : claude.availability },
    gateway,
  };
}
