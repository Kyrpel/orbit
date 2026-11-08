import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePluginDetails, parseSkillFrontmatter, pluginSourceUrl, userSkills } from '../src';

describe('Claude Code plugins', () => {
  it('links each kind of plugin source to a page you can open', () => {
    expect(pluginSourceUrl('./plugins/agent-sdk-dev', 'anthropics/claude-plugins-official')).toBe('https://github.com/anthropics/claude-plugins-official/tree/main/plugins/agent-sdk-dev');
    expect(pluginSourceUrl({ source: 'url', url: 'https://github.com/obra/superpowers.git' }, null)).toBe('https://github.com/obra/superpowers');
    expect(pluginSourceUrl({ source: 'git-subdir', url: 'https://github.com/anthropics/knowledge-work-plugins', path: 'design', sha: 'abc' }, null)).toBe('https://github.com/anthropics/knowledge-work-plugins/tree/abc/design');
    expect(pluginSourceUrl({ source: 'command', command: 'xcrun agent plugin path' }, null)).toBeNull();
    expect(pluginSourceUrl({ source: 'url', url: 'file:///etc/passwd' }, null)).toBeNull();
  });

  it('reads a skill’s name and description from its SKILL.md', () => {
    expect(parseSkillFrontmatter('---\nname: taste\ndescription: "Anti-slop frontend"\n---\nBody')).toEqual({ name: 'taste', description: 'Anti-slop frontend' });
    expect(parseSkillFrontmatter('No frontmatter')).toEqual({});
  });

  it('pulls the counts that matter out of `claude plugin details`', () => {
    const text = 'frontend-design 1.1.1\nComponent inventory\n  Skills (2)  a, b\n  Agents (1)\n  Hooks (0)\n  MCP servers (3)\n  LSP servers (0)\nProjected token cost\n  Always-on:   ~1.2k tok   added to every session';
    expect(parsePluginDetails(text)).toEqual({ skills: ['a', 'b'], agents: 1, hooks: 0, mcpServers: 3, alwaysOn: '~1.2k tok' });
  });

  it('lists your own skills from the skills folder', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orbit-skills-'));
    try {
      mkdirSync(path.join(dir, 'skills', 'impeccable'), { recursive: true });
      writeFileSync(path.join(dir, 'skills', 'impeccable', 'SKILL.md'), '---\nname: impeccable\ndescription: Design work\n---\n');
      mkdirSync(path.join(dir, 'skills', 'notes'), { recursive: true }); // no SKILL.md: not a skill
      expect(userSkills({ CLAUDE_CONFIG_DIR: dir })).toEqual([{ name: 'impeccable', description: 'Design work', path: path.join(dir, 'skills', 'impeccable') }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
