import type { AgentGateway } from '@orbit/agents';
import {
  isOpenRouterModel,
  MAX_MODEL_INSTRUCTIONS,
  OrbitError,
  openRouterSlug,
  parseOpenRouterModel,
  registerSecret,
  unregisterSecret,
  type OpenRouterModelDTO,
  type OpenRouterStatusDTO,
} from '@orbit/shared';
import { audit, type OrbitContext } from './context';
import { claudeCodeSeat, type GatewayProvider, type GatewaySeat } from './gateways';

/*
  OpenRouter inside Claude Code sessions: pick DeepSeek, Hermes, GPT, Gemini and others in a
  session's model menu, and Orbit runs Claude Code against OpenRouter's Anthropic-compatible
  API with your OpenRouter key instead of your Claude login.

  The key is kept in Orbit's secrets file (never the database or logs) and only goes to
  OpenRouter. OpenRouter's public model list says which models can use tools: those that
  cannot get none, so they can talk but not read or change files.
*/

const SECRET = 'openrouter.apiKey';
const CATALOG_TTL_MS = 6 * 60 * 60_000;
const ACCOUNT_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

interface CatalogModel {
  id: string;
  name: string;
  tools: boolean;
  contextLength: number | null;
  pricePerMillion: { input: number; output: number } | null;
}

export class OpenRouterService implements GatewayProvider {
  private catalog: { at: number; models: Map<string, CatalogModel> } | null = null;
  private loading: Promise<void> | null = null;
  private account: { at: number; value: OpenRouterStatusDTO['account'] } | null = null;

  constructor(private readonly ctx: OrbitContext) {
    registerSecret(this.key());
  }

  /** OpenRouter's address (`ORBIT_OPENROUTER_URL` points tests at a stand-in). */
  private get base(): string {
    return (this.ctx.env.ORBIT_OPENROUTER_URL?.trim() || 'https://openrouter.ai/api').replace(/\/+$/, '');
  }

  private key(): string | null {
    return this.ctx.secrets.get(SECRET);
  }

  async status(): Promise<OpenRouterStatusDTO> {
    const key = this.key();
    const slugs = this.ctx.settings.get().openrouter.models;
    if (!key) return { connected: false, keyHint: null, account: null, models: slugs.map((s) => this.describe(s)) };
    await Promise.all([this.loadCatalog(), this.loadAccount(key)]);
    return { connected: true, keyHint: key.slice(-4), account: this.account?.value ?? null, models: slugs.map((s) => this.describe(s)) };
  }

  /** Checks the key with OpenRouter, then keeps it. */
  async connect(input: string): Promise<OpenRouterStatusDTO> {
    const key = input.trim();
    if (!/^[\w.-]{20,300}$/.test(key)) throw new OrbitError('VALIDATION', 'That does not look like an OpenRouter API key.', { hint: 'Create one at openrouter.ai/keys. It starts with sk-or-.' });
    const res = await this.call('/v1/key', key).catch((err: Error) => {
      throw new OrbitError('EXTERNAL', `Could not reach OpenRouter: ${err.message}`);
    });
    if (res.status === 401 || res.status === 403) throw new OrbitError('VALIDATION', 'OpenRouter did not accept this key.', { hint: 'Check that you copied all of it, and that it is not disabled at openrouter.ai/keys.' });
    if (!res.ok) throw new OrbitError('EXTERNAL', `OpenRouter answered ${res.status} when checking the key.`);
    unregisterSecret(this.key());
    this.ctx.secrets.set(SECRET, key);
    registerSecret(key);
    this.account = { at: Date.now(), value: accountFrom(await res.json().catch(() => null)) };
    audit(this.ctx, { actor: 'user', action: 'openrouter.connect', target: null, summary: `Connected OpenRouter (key ending ${key.slice(-4)})` });
    return this.status();
  }

  disconnect(): OpenRouterStatusDTO {
    const key = this.key();
    if (key) {
      this.ctx.secrets.delete(SECRET);
      unregisterSecret(key);
      audit(this.ctx, { actor: 'user', action: 'openrouter.disconnect', target: null, summary: 'Disconnected OpenRouter' });
    }
    this.account = null;
    return { connected: false, keyHint: null, account: null, models: this.ctx.settings.get().openrouter.models.map((s) => this.describe(s)) };
  }

  /** Adds a model by its id or its openrouter.ai link. */
  async addModel(input: string): Promise<OpenRouterStatusDTO> {
    const slug = parseOpenRouterModel(input);
    if (!slug) throw new OrbitError('VALIDATION', 'Paste a model link from openrouter.ai, or its id like deepseek/deepseek-v4.1-flash-1017.');
    await this.loadCatalog();
    if (this.catalog && !this.catalog.models.has(slug)) throw new OrbitError('NOT_FOUND', `OpenRouter has no model "${slug}".`, { hint: 'Copy the id from the model page on openrouter.ai.' });
    const models = this.ctx.settings.get().openrouter.models;
    if (!models.includes(slug)) this.ctx.settings.update({ openrouter: { models: [...models, slug] } });
    return this.status();
  }

  removeModel(input: string): Promise<OpenRouterStatusDTO> {
    const slug = parseOpenRouterModel(input) ?? input;
    const { models, instructions } = this.ctx.settings.get().openrouter;
    const { [slug]: _dropped, ...rest } = instructions;
    this.ctx.settings.update({ openrouter: { models: models.filter((m) => m !== slug), instructions: rest } });
    return this.status();
  }

  /** Your master prompt for one model (empty text removes it). It applies from the next message on. */
  async setInstructions(input: string, text: string): Promise<OpenRouterStatusDTO> {
    const slug = parseOpenRouterModel(input);
    const { models, instructions } = this.ctx.settings.get().openrouter;
    if (!slug || !models.includes(slug)) throw new OrbitError('NOT_FOUND', 'Add this model first, then give it instructions.');
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (clean.length > MAX_MODEL_INSTRUCTIONS) throw new OrbitError('VALIDATION', `Instructions are limited to ${MAX_MODEL_INSTRUCTIONS.toLocaleString('en')} characters.`);
    const { [slug]: _old, ...rest } = instructions;
    this.ctx.settings.update({ openrouter: { instructions: clean ? { ...rest, [slug]: clean } : rest } });
    audit(this.ctx, { actor: 'user', action: 'openrouter.instructions', target: slug, summary: clean ? `Set instructions for ${slug} (${clean.length} characters)` : `Removed the instructions for ${slug}` });
    return this.status();
  }

  /**
   * Who runs an OpenRouter request: the Claude Code CLI (only the program: your Claude login is
   * never used) on `model`, or on the first OpenRouter model you added. Everything that works for
   * an OpenRouter session (its answers, /compact, next-message suggestions, /improve) goes through
   * here, so none of it falls back to Claude or Codex.
   */
  readonly id = 'openrouter' as const;
  readonly label = 'OpenRouter';
  readonly servedBy = 'served through OpenRouter';

  async seat(model: string | null): Promise<GatewaySeat> {
    const status = await this.status();
    if (!status.connected) throw new OrbitError('PRECONDITION', 'OpenRouter is not connected. Add your OpenRouter API key on the Agents page, or pick another AI.');
    const chosen = isOpenRouterModel(model) ? model : (status.models.find((m) => !m.missing)?.id ?? null);
    if (!chosen) throw new OrbitError('PRECONDITION', 'No OpenRouter model to use. Add one on the Agents page.');
    return claudeCodeSeat(this.ctx, this.label, chosen, await this.gateway(chosen));
  }

  info(model: string): { name: string; instructions: string } {
    const d = this.describe(isOpenRouterModel(model) ? openRouterSlug(model) : model);
    return { name: d.name.replace(/^[^:]+:\s*/, ''), instructions: d.instructions };
  }

  /** What a session on `openrouter:<slug>` runs with. Throws when OpenRouter is not connected. */
  async gateway(model: string): Promise<AgentGateway> {
    if (!isOpenRouterModel(model)) throw new OrbitError('VALIDATION', `${model} is not an OpenRouter model.`);
    const key = this.key();
    if (!key) throw new OrbitError('PRECONDITION', 'OpenRouter is not connected. Add your OpenRouter API key on the Agents page, or pick another model.');
    await this.loadCatalog();
    const slug = openRouterSlug(model);
    return { name: 'OpenRouter', baseUrl: this.base, token: key, model: slug, tools: this.describe(slug).tools !== false };
  }

  /** The model's name and abilities from OpenRouter's list, or just its id when the list is unknown. */
  describe(slug: string): OpenRouterModelDTO {
    const m = this.catalog?.models.get(slug);
    return {
      id: `openrouter:${slug}`,
      slug,
      name: m?.name ?? slug,
      tools: m ? m.tools : null,
      contextLength: m?.contextLength ?? null,
      pricePerMillion: m?.pricePerMillion ?? null,
      missing: !!this.catalog && !m,
      instructions: this.ctx.settings.get().openrouter.instructions[slug] ?? '',
    };
  }

  // ---------------------------------------------------------------------------

  private loadCatalog(): Promise<void> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return Promise.resolve();
    this.loading ??= this.call('/v1/models', null)
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { data?: unknown[] };
        const models = new Map<string, CatalogModel>();
        for (const raw of body.data ?? []) {
          const m = catalogModel(raw);
          if (m) models.set(m.id, m);
        }
        if (models.size) this.catalog = { at: Date.now(), models };
      })
      .catch(() => undefined)
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async loadAccount(key: string): Promise<void> {
    if (this.account && Date.now() - this.account.at < ACCOUNT_TTL_MS) return;
    try {
      const res = await this.call('/v1/key', key);
      this.account = { at: Date.now(), value: res.ok ? accountFrom(await res.json()) : null };
    } catch {
      this.account = { at: Date.now(), value: null };
    }
  }

  private call(route: string, key: string | null): Promise<Response> {
    return fetch(`${this.base}${route}`, {
      headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-title': 'Orbit' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}

function catalogModel(raw: unknown): CatalogModel | null {
  const m = raw as { id?: unknown; name?: unknown; context_length?: unknown; supported_parameters?: unknown; pricing?: { prompt?: unknown; completion?: unknown } };
  if (typeof m?.id !== 'string') return null;
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  const input = Number(m.pricing?.prompt);
  const output = Number(m.pricing?.completion);
  return {
    id: m.id.toLowerCase(),
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : m.id,
    tools: params.includes('tools'),
    contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    pricePerMillion: Number.isFinite(input) && Number.isFinite(output) ? { input: round(input * 1e6), output: round(output * 1e6) } : null,
  };
}

function accountFrom(body: unknown): OpenRouterStatusDTO['account'] {
  const d = (body as { data?: { label?: unknown; usage?: unknown; limit?: unknown } } | null)?.data;
  if (!d) return null;
  return { label: typeof d.label === 'string' ? d.label : null, usageUsd: typeof d.usage === 'number' ? d.usage : null, limitUsd: typeof d.limit === 'number' ? d.limit : null };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
