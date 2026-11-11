import { cursorModelId, type AgentRuntime, type RuntimeAvailability } from '@orbit/agents';
import { CURSOR_PREFIX, isCursorModel, MAX_MODEL_INSTRUCTIONS, OrbitError, type CursorModelDTO, type CursorStatusDTO } from '@orbit/shared';
import { audit, type OrbitContext } from './context';
import type { GatewayProvider, GatewaySeat } from './gateways';

/*
  Cursor as a session's AI: Cursor's own agent (the Cursor CLI) on your Cursor subscription and
  login. Orbit never sees your Cursor credentials. You pick which of your account's models are in
  the Model menu, and each can have your own instructions. A Cursor session never falls back to
  Claude or Codex.
*/

type CursorRuntime = AgentRuntime & { listModels?: () => Promise<{ id: string; label: string }[]> };

const STATUS_TTL_MS = 60_000;

export class CursorService implements GatewayProvider {
  readonly id = 'cursor' as const;
  readonly label = 'Cursor';
  readonly servedBy = 'running through the developer’s Cursor subscription';
  private availability: { at: number; value: RuntimeAvailability } | null = null;
  private catalog: { id: string; label: string }[] = [];

  constructor(
    private readonly ctx: OrbitContext,
    private readonly runtime: CursorRuntime | null,
  ) {}

  private async check(fresh = false): Promise<RuntimeAvailability> {
    if (!this.runtime) return { available: false, reason: 'The Cursor CLI is not set up in this Orbit.', sandbox: 'unknown', details: {} };
    if (!fresh && this.availability && Date.now() - this.availability.at < STATUS_TTL_MS) return this.availability.value;
    const value = await this.runtime.checkAvailability().catch((err: Error) => ({ available: false, reason: err.message, sandbox: 'unknown' as const, details: {} }));
    this.availability = { at: Date.now(), value };
    return value;
  }

  async status(fresh = false): Promise<CursorStatusDTO> {
    const a = await this.check(fresh);
    if (a.available && this.runtime?.listModels) this.catalog = await this.runtime.listModels().catch(() => this.catalog);
    return {
      installed: a.available || !!a.details.version,
      ready: a.available,
      reason: a.available ? null : a.reason,
      version: a.details.version ?? null,
      models: this.ctx.settings.get().cursor.models.map((m) => this.describe(m)).filter((m) => !m.missing || !this.catalog.length),
      catalog: this.catalog,
    };
  }

  describe(slug: string): CursorModelDTO {
    const hit = this.catalog.find((c) => c.id === slug);
    return { id: `${CURSOR_PREFIX}${slug}`, slug, label: hit?.label ?? slug, missing: !!this.catalog.length && !hit, instructions: this.ctx.settings.get().cursor.instructions[slug] ?? '' };
  }

  async addModel(input: string): Promise<CursorStatusDTO> {
    const slug = cursorModelId(input.trim());
    await this.status();
    if (this.catalog.length && !this.catalog.some((c) => c.id === slug)) throw new OrbitError('NOT_FOUND', `Your Cursor account has no model "${slug}".`);
    const models = this.ctx.settings.get().cursor.models;
    if (!models.includes(slug)) this.ctx.settings.update({ cursor: { models: [...models, slug] } });
    return this.status();
  }

  async removeModel(input: string): Promise<CursorStatusDTO> {
    const slug = cursorModelId(input.trim());
    const { models, instructions } = this.ctx.settings.get().cursor;
    const { [slug]: _gone, ...rest } = instructions;
    this.ctx.settings.update({ cursor: { models: models.filter((m) => m !== slug), instructions: rest } });
    return this.status();
  }

  async setInstructions(input: string, text: string): Promise<CursorStatusDTO> {
    const slug = cursorModelId(input.trim());
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (clean.length > MAX_MODEL_INSTRUCTIONS) throw new OrbitError('VALIDATION', `Instructions are limited to ${MAX_MODEL_INSTRUCTIONS.toLocaleString('en')} characters.`);
    const { [slug]: _old, ...rest } = this.ctx.settings.get().cursor.instructions;
    this.ctx.settings.update({ cursor: { instructions: clean ? { ...rest, [slug]: clean } : rest } });
    audit(this.ctx, { actor: 'user', action: 'cursor.instructions', target: slug, summary: clean ? `Set instructions for Cursor's ${slug} (${clean.length} characters)` : `Removed the instructions for Cursor's ${slug}` });
    return this.status();
  }

  async seat(model: string | null): Promise<GatewaySeat> {
    if (!this.runtime) throw new OrbitError('PRECONDITION', 'Cursor is not available here.');
    const a = await this.check();
    if (!a.available) throw new OrbitError('PRECONDITION', a.reason ?? 'The Cursor CLI is not ready.', { hint: 'Install it from cursor.com/cli, then run `cursor-agent login` (or type `! cursor-agent login` in a session).' });
    const chosen = isCursorModel(model) ? model : `${CURSOR_PREFIX}${this.ctx.settings.get().cursor.models[0] ?? 'auto'}`;
    return { candidate: { runtime: this.runtime, availability: a, provider: 'cursor', label: this.label, model: chosen, effort: null }, gateway: null };
  }

  info(model: string): { name: string; instructions: string } {
    const d = this.describe(cursorModelId(model));
    return { name: d.label, instructions: d.instructions };
  }
}
