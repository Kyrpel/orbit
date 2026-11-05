import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, RuntimeAvailability } from '@orbit/agents';
import { createOrbit, forgetResolvedRuntime, MemorySecretStore, resolveRuntime, silentLogger, type Orbit } from '../src';
import { cleanup, tempDir } from './helpers';

function fakeRuntime(id: AgentRuntime['id'], available: boolean): AgentRuntime {
  const availability: RuntimeAvailability = { available, reason: available ? null : `${id} missing`, sandbox: 'unknown', details: {} };
  return {
    id,
    displayName: id,
    kind: id === 'scripted' ? 'scripted' : 'ai',
    checkAvailability: async () => availability,
    run: async () => {
      throw new Error('not used');
    },
  };
}

describe('automatic runtime', () => {
  let root: string;
  let orbit: Orbit;

  afterEach(() => {
    orbit.close();
    cleanup(root);
  });

  function make(runtimes: AgentRuntime[]) {
    root = tempDir();
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes, secrets: new MemorySecretStore(), logger: silentLogger });
    return orbit;
  }

  it('defaults to automatic and prefers the Claude Code plan when it is signed in', async () => {
    make([fakeRuntime('claude-code-cli', true), fakeRuntime('claude-agent-sdk', true)]);
    expect(orbit.ctx.settings.get().execution.runtime).toBe('auto');
    const r = await resolveRuntime(orbit.ctx);
    expect(r?.runtime.id).toBe('claude-code-cli');
    expect(r?.automatic).toBe(true);
  });

  it('falls back to the API key runtime when Claude Code is not available', async () => {
    make([fakeRuntime('claude-code-cli', false), fakeRuntime('claude-agent-sdk', true)]);
    expect((await resolveRuntime(orbit.ctx))?.runtime.id).toBe('claude-agent-sdk');
  });

  it('explains how to get going when neither is available', async () => {
    make([fakeRuntime('claude-code-cli', false), fakeRuntime('claude-agent-sdk', false)]);
    const r = await resolveRuntime(orbit.ctx);
    expect(r?.availability.available).toBe(false);
    expect(r?.availability.reason).toMatch(/claude.*ANTHROPIC_API_KEY/s);
  });

  it('honors an explicit choice', async () => {
    make([fakeRuntime('claude-code-cli', true), fakeRuntime('claude-agent-sdk', true)]);
    orbit.ctx.settings.update({ execution: { runtime: 'claude-agent-sdk' } });
    forgetResolvedRuntime(orbit.ctx);
    expect((await resolveRuntime(orbit.ctx))?.runtime.id).toBe('claude-agent-sdk');
  });
});
