import { ClaudePlugins, parsePluginDetails, userSkills, type CatalogPlugin, type PluginCatalog } from '@orbit/agents';
import { OrbitError, truncate, type PluginActionDTO, type PluginDetailsDTO, type PluginDTO, type SkillsDTO, type UserSkillDTO } from '@orbit/shared';
import { audit, nowIso, type OrbitContext } from './context';

/** Catalogs change slowly; installing or refreshing reloads them. */
const CACHE_MS = 10 * 60_000;

const MARKETPLACE_LABEL: Record<string, string> = {
  'claude-plugins-official': 'Official',
  'anthropic-plugin-directory': 'Plugin directory',
};

/**
 * Skills for your agents, through Claude Code's own plugin system: search everything the
 * marketplaces offer (Anthropic's official marketplace, its plugin directory, and any you
 * add), install, turn on or off, remove. What you install here also works in your terminal.
 * Working sessions load them from the next message (Claude only; Codex has its own).
 */
export class SkillsService {
  private cache: { at: number; data: PluginCatalog } | null = null;
  private loading: Promise<PluginCatalog> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: OrbitContext,
    private readonly plugins = new ClaudePlugins(ctx.env.ORBIT_CLAUDE_BIN || 'claude', ctx.env),
  ) {}

  private load(force = false): Promise<PluginCatalog> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return Promise.resolve(this.cache.data);
    this.loading ??= this.plugins
      .catalog()
      .then((data) => {
        this.cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** One change at a time: every one of them edits Claude Code's settings. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private ownSkills(): UserSkillDTO[] {
    return userSkills(this.ctx.env).map((s) => ({ name: s.name, description: s.description, path: s.path }));
  }

  async list(q: { query?: string; filter?: string; limit?: number } = {}): Promise<SkillsDTO> {
    let catalog: PluginCatalog;
    try {
      catalog = await this.load();
    } catch (err) {
      return { available: false, reason: (err as Error).message, installed: [], skills: this.ownSkills(), results: [], total: 0, marketplaces: [], updatedAt: null };
    }
    const installedById = new Map(catalog.installed.map((p) => [p.id, p]));
    const byId = new Map(catalog.available.map((p) => [p.id, p]));
    // Claude Code's "available" list leaves out what is installed: add those back from their manifests.
    const all: CatalogPlugin[] = [
      ...catalog.available,
      ...catalog.installed
        .filter((i) => !byId.has(i.id))
        .map((i) => {
          const [name, marketplace = ''] = i.id.split('@');
          return { id: i.id, name: name ?? i.id, marketplace, description: i.description, version: i.version, installs: null, sourceUrl: i.sourceUrl, needsCommand: false };
        }),
    ];
    const allById = new Map(all.map((p) => [p.id, p]));
    const dto = (p: CatalogPlugin): PluginDTO => ({ ...p, marketplaceLabel: MARKETPLACE_LABEL[p.marketplace] ?? p.marketplace, installed: installedById.has(p.id), enabled: installedById.get(p.id)?.enabled ?? null });
    const installed = catalog.installed.map((i) => allById.get(i.id)).filter((p): p is CatalogPlugin => !!p).map(dto);

    const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const pool = q.filter === 'installed' ? all.filter((p) => installedById.has(p.id)) : q.filter && q.filter !== 'all' ? all.filter((p) => p.marketplace === q.filter) : all;
    const ranked = pool
      .map((p) => ({ p, score: matchScore(p, words) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.p.installs ?? 0) - (a.p.installs ?? 0) || a.p.name.localeCompare(b.p.name));
    const limit = Math.min(Math.max(q.limit ?? 40, 1), 200);
    const counts = new Map<string, number>();
    for (const p of all) counts.set(p.marketplace, (counts.get(p.marketplace) ?? 0) + 1);
    return {
      available: true,
      reason: null,
      installed,
      skills: this.ownSkills(),
      results: ranked.slice(0, limit).map((x) => dto(x.p)),
      total: ranked.length,
      marketplaces: [...counts].map(([name, count]) => ({ name, label: MARKETPLACE_LABEL[name] ?? name, count })).sort((a, b) => b.count - a.count),
      updatedAt: this.cache ? new Date(this.cache.at).toISOString() : null,
    };
  }

  async details(id: string): Promise<PluginDetailsDTO> {
    const catalog = await this.load();
    if (!catalog.installed.some((p) => p.id === id)) throw new OrbitError('PRECONDITION', 'Claude Code shows what a plugin contains once it is installed.');
    const text = await this.plugins.details(id);
    return { id, text, ...parsePluginDetails(text) };
  }

  async install(id: string): Promise<PluginActionDTO> {
    const plugin = (await this.load()).available.find((p) => p.id === id);
    if (!plugin) throw new OrbitError('NOT_FOUND', 'That plugin is not in your marketplaces. Refresh the catalogs and try again.');
    if (plugin.needsCommand) {
      throw new OrbitError('PRECONDITION', 'This plugin installs by running a command its marketplace declares. Install it in Claude Code with /plugin, where you can review that command first.');
    }
    const r = await this.serial(() => this.plugins.install(id));
    audit(this.ctx, { actor: 'user', action: 'skills.install', target: id, summary: `${r.ok ? 'Installed' : 'Could not install'} the Claude Code plugin ${id}` });
    this.cache = null;
    if (!r.ok) throw new OrbitError('PRECONDITION', r.message);
    return { ok: true, message: `Installed ${plugin.name}. Your Claude sessions can use it from their next message.` };
  }

  async uninstall(id: string): Promise<PluginActionDTO> {
    await this.requireInstalled(id);
    const r = await this.serial(() => this.plugins.uninstall(id));
    audit(this.ctx, { actor: 'user', action: 'skills.uninstall', target: id, summary: `${r.ok ? 'Removed' : 'Could not remove'} the Claude Code plugin ${id}` });
    this.cache = null;
    if (!r.ok) throw new OrbitError('PRECONDITION', r.message);
    return { ok: true, message: `Removed ${id.split('@')[0]}.` };
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginActionDTO> {
    await this.requireInstalled(id);
    const r = await this.serial(() => this.plugins.setEnabled(id, enabled));
    audit(this.ctx, { actor: 'user', action: enabled ? 'skills.enable' : 'skills.disable', target: id, summary: `${enabled ? 'Turned on' : 'Turned off'} the Claude Code plugin ${id}` });
    this.cache = null;
    if (!r.ok) throw new OrbitError('PRECONDITION', r.message);
    return { ok: true, message: `${id.split('@')[0]} is ${enabled ? 'on' : 'off'}.` };
  }

  /** Pulls the newest catalogs from every marketplace. */
  async refresh(): Promise<PluginActionDTO> {
    const r = await this.serial(() => this.plugins.updateMarketplaces());
    await this.load(true).catch(() => undefined);
    if (!r.ok) throw new OrbitError('PRECONDITION', r.message);
    return { ok: true, message: `Catalogs updated ${nowIso(this.ctx).slice(11, 16)}.` };
  }

  /** Adds a marketplace you trust: a GitHub `owner/repo` or an https git URL. */
  async addMarketplace(source: string): Promise<PluginActionDTO> {
    const s = source.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(s) && !/^https:\/\/\S+$/i.test(s)) throw new OrbitError('VALIDATION', 'Use a GitHub owner/repo (like anthropics/skills) or an https URL.');
    const r = await this.serial(() => this.plugins.addMarketplace(s));
    audit(this.ctx, { actor: 'user', action: 'skills.marketplace_add', target: truncate(s, 200), summary: `${r.ok ? 'Added' : 'Could not add'} the plugin marketplace ${truncate(s, 200)}` });
    this.cache = null;
    if (!r.ok) throw new OrbitError('PRECONDITION', r.message);
    return { ok: true, message: `Added ${s}. Its plugins are in the search now.` };
  }

  private async requireInstalled(id: string): Promise<void> {
    const catalog = await this.load();
    if (!catalog.installed.some((p) => p.id === id)) throw new OrbitError('NOT_FOUND', 'That plugin is not installed.');
  }
}

/** Every word must appear in the name or description; name matches count most. */
export function matchScore(p: Pick<CatalogPlugin, 'name' | 'description'>, words: string[]): number {
  if (!words.length) return 1;
  const name = p.name.toLowerCase();
  const desc = (p.description ?? '').toLowerCase();
  let score = 0;
  for (const w of words) {
    if (name === w) score += 10;
    else if (name.includes(w)) score += 5;
    else if (desc.includes(w)) score += 1;
    else return 0;
  }
  return score;
}
