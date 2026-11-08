import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaudePlugins, PluginCatalog } from '@orbit/agents';
import { createOrbit, matchScore, MemorySecretStore, silentLogger, SkillsService, type Orbit } from '../src';
import { cleanup, tempDir } from './helpers';

/** Claude Code's plugin commands, faked: no real plugin is installed by these tests. */
function fakePlugins(over: Partial<Record<'install' | 'uninstall' | 'setEnabled' | 'addMarketplace', (...a: unknown[]) => Promise<{ ok: boolean; message: string }>>> = {}) {
  const calls: string[] = [];
  const catalog: PluginCatalog = {
    installed: [
      { id: 'frontend-design@claude-plugins-official', version: '1.1.1', enabled: true, scope: 'user', description: 'Distinctive frontend design', sourceUrl: null },
      { id: 'vercel@claude-plugins-official', version: '2.0.0', enabled: false, scope: 'user', description: 'Deploy to Vercel', sourceUrl: 'https://github.com/vercel/vercel-plugin' },
    ],
    marketplaces: [{ name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official' }],
    available: [
      { id: 'frontend-design@claude-plugins-official', name: 'frontend-design', marketplace: 'claude-plugins-official', description: 'Distinctive frontend design', version: '1.1.1', installs: 90_000, sourceUrl: null, needsCommand: false },
      { id: 'superpowers@claude-plugins-official', name: 'superpowers', marketplace: 'claude-plugins-official', description: 'Brainstorming and planning workflows', version: null, installs: 1_100_000, sourceUrl: 'https://github.com/obra/superpowers', needsCommand: false },
      { id: 'design-system@anthropic-plugin-directory', name: 'design-system', marketplace: 'anthropic-plugin-directory', description: 'Tokens and components', version: null, installs: null, sourceUrl: null, needsCommand: false },
      { id: 'xcode@claude-plugins-official', name: 'xcode', marketplace: 'claude-plugins-official', description: 'Work with Xcode projects', version: null, installs: 5_000, sourceUrl: null, needsCommand: true },
    ],
  };
  const ok = (message: string) => Promise.resolve({ ok: true, message });
  const fake = {
    catalog: async () => (calls.push('catalog'), catalog),
    details: async (id: string) => `${id}\nComponent inventory\n  Skills (1)  frontend-design\n  Agents (0)\n  Hooks (2)\n  MCP servers (1)\nProjected token cost\n  Always-on:   ~80 tok   added to every session`,
    install: over.install ?? ((id: unknown) => (calls.push(`install ${String(id)}`), ok('installed'))),
    uninstall: over.uninstall ?? ((id: unknown) => (calls.push(`uninstall ${String(id)}`), ok('removed'))),
    setEnabled: over.setEnabled ?? ((id: unknown, on: unknown) => (calls.push(`${on ? 'enable' : 'disable'} ${String(id)}`), ok('done'))),
    updateMarketplaces: () => (calls.push('update'), ok('updated')),
    addMarketplace: over.addMarketplace ?? ((s: unknown) => (calls.push(`add ${String(s)}`), ok('added'))),
  };
  return { plugins: fake as unknown as ClaudePlugins, calls };
}

describe('skills (Claude Code plugins)', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(() => {
    orbit.close();
    cleanup(root);
  });
  const make = (plugins: ClaudePlugins) => {
    root = tempDir();
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [], secrets: new MemorySecretStore(), logger: silentLogger, env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude') } });
    return new SkillsService(orbit.ctx, plugins);
  };

  it('lists the most installed first, marks what is installed, and searches name and description', async () => {
    const { plugins, calls } = fakePlugins();
    const skills = make(plugins);
    const all = await skills.list();
    expect(all.available).toBe(true);
    expect(all.results.map((p) => p.name)).toEqual(['superpowers', 'frontend-design', 'xcode', 'design-system', 'vercel']);
    expect(all.installed).toEqual([
      expect.objectContaining({ id: 'frontend-design@claude-plugins-official', installed: true, enabled: true, marketplaceLabel: 'Official' }),
      // Installed but not in the "available" list: described from its own manifest.
      expect.objectContaining({ id: 'vercel@claude-plugins-official', installed: true, enabled: false, description: 'Deploy to Vercel' }),
    ]);
    expect(all.marketplaces).toEqual([
      { name: 'claude-plugins-official', label: 'Official', count: 4 },
      { name: 'anthropic-plugin-directory', label: 'Plugin directory', count: 1 },
    ]);
    const design = await skills.list({ query: 'design' });
    expect(design.results.map((p) => p.name)).toEqual(['frontend-design', 'design-system']);
    expect((await skills.list({ query: 'planning' })).results.map((p) => p.name)).toEqual(['superpowers']);
    expect((await skills.list({ filter: 'anthropic-plugin-directory' })).results.map((p) => p.name)).toEqual(['design-system']);
    expect((await skills.list({ filter: 'installed' })).results.map((p) => p.name)).toEqual(['frontend-design', 'vercel']);
    expect((await skills.list({ query: 'deploy' })).results.map((p) => p.name)).toEqual(['vercel']);
    // One catalog read, cached between searches.
    expect(calls.filter((c) => c === 'catalog')).toHaveLength(1);
  });

  it('installs through Claude Code, refuses unknown and command-based plugins, and reloads afterwards', async () => {
    const { plugins, calls } = fakePlugins();
    const skills = make(plugins);
    await expect(skills.install('nope@claude-plugins-official')).rejects.toThrow(/not in your marketplaces/);
    await expect(skills.install('xcode@claude-plugins-official')).rejects.toThrow(/\/plugin/);
    const r = await skills.install('superpowers@claude-plugins-official');
    expect(r.message).toMatch(/Installed superpowers/);
    expect(calls).toContain('install superpowers@claude-plugins-official');
    await skills.list();
    expect(calls.filter((c) => c === 'catalog')).toHaveLength(2);
  });

  it('reports a failed install with Claude Code\'s own message', async () => {
    const { plugins } = fakePlugins({ install: () => Promise.resolve({ ok: false, message: 'Network error while cloning' }) });
    const skills = make(plugins);
    await expect(skills.install('superpowers@claude-plugins-official')).rejects.toThrow('Network error while cloning');
  });

  it('turns installed plugins on and off, removes them, and shows what they contain', async () => {
    const { plugins, calls } = fakePlugins();
    const skills = make(plugins);
    await skills.setEnabled('frontend-design@claude-plugins-official', false);
    await skills.uninstall('frontend-design@claude-plugins-official');
    expect(calls).toEqual(expect.arrayContaining(['disable frontend-design@claude-plugins-official', 'uninstall frontend-design@claude-plugins-official']));
    await expect(skills.uninstall('superpowers@claude-plugins-official')).rejects.toThrow(/not installed/);
    const d = await skills.details('frontend-design@claude-plugins-official');
    expect(d).toMatchObject({ skills: ['frontend-design'], hooks: 2, mcpServers: 1, alwaysOn: '~80 tok' });
  });

  it('adds only marketplaces that look like a repo or an https URL', async () => {
    const { plugins, calls } = fakePlugins();
    const skills = make(plugins);
    await expect(skills.addMarketplace('rm -rf /')).rejects.toThrow(/owner\/repo/);
    await skills.addMarketplace('anthropics/skills');
    expect(calls).toContain('add anthropics/skills');
  });

  it('ranks name matches above description matches and needs every word', () => {
    expect(matchScore({ name: 'design-system', description: null }, ['design'])).toBeGreaterThan(matchScore({ name: 'superpowers', description: 'a design flow' }, ['design']));
    expect(matchScore({ name: 'stripe', description: 'payments' }, ['stripe', 'missing'])).toBe(0);
  });
});
