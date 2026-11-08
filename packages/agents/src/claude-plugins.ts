import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { buildAgentEnv } from './env';

/*
  Claude Code's own plugin system (`claude plugin …`), driven from Orbit. Plugins carry
  skills, agents, commands, hooks and MCP servers; they come from marketplaces (Anthropic's
  official one and its plugin directory, plus any you add). Installing here is the same as
  `/plugin install` in Claude Code: it works in your terminal too, and the other way round.
*/

export interface CatalogPlugin {
  /** `name@marketplace`, the id Claude Code uses. */
  id: string;
  name: string;
  marketplace: string;
  description: string | null;
  version: string | null;
  installs: number | null;
  /** Where its files come from, when that is a web page you can open. */
  sourceUrl: string | null;
  /** Installed by running a command the marketplace declares: review that in Claude Code itself. */
  needsCommand: boolean;
}

export interface InstalledPlugin {
  id: string;
  version: string | null;
  enabled: boolean;
  scope: string;
  /** From the plugin's own manifest. */
  description: string | null;
  sourceUrl: string | null;
}

/** Description and home page from an installed plugin's `.claude-plugin/plugin.json`. */
function manifestOf(installPath: unknown): { description: string | null; sourceUrl: string | null } {
  if (typeof installPath !== 'string') return { description: null, sourceUrl: null };
  try {
    const m = JSON.parse(readFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), 'utf8')) as { description?: unknown; homepage?: unknown; repository?: unknown };
    const link = [m.homepage, typeof m.repository === 'object' && m.repository ? (m.repository as { url?: unknown }).url : m.repository].find((x): x is string => typeof x === 'string' && /^https:\/\//i.test(x));
    return { description: typeof m.description === 'string' ? m.description.slice(0, 1000) : null, sourceUrl: link ? link.replace(/\.git$/, '') : null };
  } catch {
    return { description: null, sourceUrl: null };
  }
}

export interface PluginCatalog {
  installed: InstalledPlugin[];
  available: CatalogPlugin[];
  marketplaces: { name: string; repo: string | null }[];
}

/** A skill folder of your own (`~/.claude/skills/<name>/SKILL.md`). */
export interface UserSkill {
  name: string;
  description: string | null;
  path: string;
}

export interface PluginResult {
  ok: boolean;
  message: string;
}

const githubRepo = (url: string) => /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?\/?$/i.exec(url)?.[1] ?? null;

/** A browsable link for a plugin's source, or null when it has none (e.g. a command). */
export function pluginSourceUrl(source: unknown, marketplaceRepo: string | null): string | null {
  if (typeof source === 'string') {
    if (!marketplaceRepo) return null;
    const rel = source.replace(/^\.\//, '').replace(/\/$/, '');
    return `https://github.com/${marketplaceRepo}/tree/main/${rel}`;
  }
  if (!source || typeof source !== 'object') return null;
  const s = source as { source?: string; url?: string; path?: string; ref?: string; sha?: string; repo?: string };
  if (s.source === 'github' && s.repo) return `https://github.com/${s.repo}`;
  if (!s.url || !/^https:\/\//i.test(s.url)) return null;
  const base = s.url.replace(/\.git$/, '');
  if (s.source === 'git-subdir' && s.path && githubRepo(s.url)) return `${base}/tree/${s.ref ?? s.sha ?? 'HEAD'}/${s.path}`;
  return base;
}

/** Name and description from a SKILL.md's frontmatter. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Claude Code's config folder (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

/** Your own skills: folders with a SKILL.md in Claude Code's skills folder. */
export function userSkills(env: NodeJS.ProcessEnv = process.env): UserSkill[] {
  const dir = path.join(claudeConfigDir(env), 'skills');
  if (!existsSync(dir)) return [];
  const out: UserSkill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    try {
      const meta = parseSkillFrontmatter(readFileSync(file, 'utf8').slice(0, 8000));
      out.push({ name: meta.name || entry.name, description: meta.description?.slice(0, 600) || null, path: path.join(dir, entry.name) });
    } catch {
      /* unreadable skill: skip it */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The counts that matter before you trust a plugin: hooks and MCP servers run code. */
export function parsePluginDetails(text: string): { skills: string[]; agents: number; hooks: number; mcpServers: number; alwaysOn: string | null } {
  const count = (label: string) => Number(new RegExp(`^\\s*${label} \\((\\d+)\\)`, 'm').exec(text)?.[1] ?? 0);
  const skillsLine = /^\s*Skills \(\d+\)\s+(.*)$/m.exec(text)?.[1] ?? '';
  return {
    skills: skillsLine
      .split(/,\s*/)
      .map((x) => x.trim())
      .filter(Boolean),
    agents: count('Agents'),
    hooks: count('Hooks'),
    mcpServers: count('MCP servers'),
    alwaysOn: /Always-on:\s*(~?[\d.,]+k? tok)/.exec(text)?.[1] ?? null,
  };
}

/** The JSON result line a `claude plugin … --json` command prints. */
function resultLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export class ClaudePlugins {
  constructor(
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async run(args: string[], timeoutMs = 120_000) {
    const r = await execa(this.bin, args, { env: buildAgentEnv(this.env), extendEnv: false, reject: false, timeout: timeoutMs, windowsHide: true, stdin: 'ignore' });
    return { code: r.exitCode ?? -1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), timedOut: !!r.timedOut, missing: (r as { code?: string }).code === 'ENOENT' };
  }

  /** Installed plugins, everything the marketplaces offer, and the marketplaces themselves. */
  async catalog(): Promise<PluginCatalog> {
    const [list, markets] = await Promise.all([this.run(['plugin', 'list', '--json', '--available'], 180_000), this.run(['plugin', 'marketplace', 'list', '--json'])]);
    if (list.missing) throw new Error('Claude Code is not installed (the `claude` command was not found).');
    if (list.code !== 0) throw new Error(`Claude Code could not list plugins: ${(list.stderr || list.stdout).trim().slice(0, 300) || `exit ${list.code}`}`);
    const data = JSON.parse(list.stdout) as { installed?: Record<string, unknown>[]; available?: Record<string, unknown>[] };
    let marketplaces: { name: string; repo: string | null }[] = [];
    try {
      marketplaces = (JSON.parse(markets.stdout) as { name?: string; repo?: string; url?: string }[]).filter((m) => m.name).map((m) => ({ name: m.name!, repo: m.repo ?? (m.url ? githubRepo(m.url) : null) }));
    } catch {
      /* older CLI: no marketplace list */
    }
    const repoOf = new Map(marketplaces.map((m) => [m.name, m.repo]));
    return {
      installed: (data.installed ?? []).map((p) => ({
        id: String(p.id),
        version: typeof p.version === 'string' ? p.version : null,
        enabled: p.enabled !== false,
        scope: String(p.scope ?? 'user'),
        ...manifestOf(p.installPath),
      })),
      available: (data.available ?? []).map((p) => {
        const marketplace = String(p.marketplaceName ?? '');
        const src = p.source as { source?: string } | string | undefined;
        return {
          id: String(p.pluginId ?? `${String(p.name)}@${marketplace}`),
          name: String(p.name ?? ''),
          marketplace,
          description: typeof p.description === 'string' ? p.description.slice(0, 1000) : null,
          version: typeof p.version === 'string' ? p.version : null,
          installs: typeof p.installCount === 'number' ? p.installCount : null,
          sourceUrl: pluginSourceUrl(p.source, repoOf.get(marketplace) ?? null),
          needsCommand: typeof src === 'object' && src?.source === 'command',
        };
      }),
      marketplaces,
    };
  }

  /** What an installed plugin contains and what it costs per session, as Claude Code reports it. */
  async details(id: string): Promise<string> {
    const r = await this.run(['plugin', 'details', id]);
    const text = (r.stdout || r.stderr).trim();
    if (r.code !== 0 || /not found/i.test(text.split('\n')[0] ?? '')) throw new Error(text.slice(0, 300) || 'Claude Code could not show this plugin.');
    return text;
  }

  private async action(args: string[], verb: string, timeoutMs = 180_000): Promise<PluginResult> {
    const r = await this.run([...args, '--json'], timeoutMs);
    if (r.missing) return { ok: false, message: 'Claude Code is not installed (the `claude` command was not found).' };
    if (r.timedOut) return { ok: false, message: `${verb} took too long and was stopped.` };
    const res = resultLine(r.stdout);
    const ok = res ? res.outcome !== 'failed' && !res.failureCode && !res.error : r.code === 0;
    const message = typeof res?.message === 'string' ? res.message : (r.stderr || r.stdout).trim().split('\n').at(-1) || (ok ? `${verb} done.` : `${verb} failed.`);
    return { ok, message: message.slice(0, 400) };
  }

  install(id: string): Promise<PluginResult> {
    return this.action(['plugin', 'install', id, '--scope', 'user'], 'Installing', 300_000);
  }

  uninstall(id: string): Promise<PluginResult> {
    return this.action(['plugin', 'uninstall', id, '--scope', 'user'], 'Removing');
  }

  setEnabled(id: string, enabled: boolean): Promise<PluginResult> {
    return this.action(['plugin', enabled ? 'enable' : 'disable', id, '--scope', 'user'], enabled ? 'Turning on' : 'Turning off');
  }

  /** Pulls the latest catalogs from every marketplace. */
  async updateMarketplaces(): Promise<PluginResult> {
    const r = await this.run(['plugin', 'marketplace', 'update'], 300_000);
    return { ok: r.code === 0, message: r.code === 0 ? 'Catalogs updated.' : (r.stderr || r.stdout).trim().slice(0, 300) || 'Could not update the catalogs.' };
  }

  addMarketplace(source: string): Promise<PluginResult> {
    return this.action(['plugin', 'marketplace', 'add', source], 'Adding the marketplace', 300_000);
  }
}
