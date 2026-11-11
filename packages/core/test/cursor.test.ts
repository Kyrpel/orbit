import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyResult, type AgentRunRequest, type AgentRuntime } from '@orbit/agents';
import { createOrbit, MemorySecretStore, silentLogger, type Orbit } from '../src';
import { cleanup, makeRepo, tempDir } from './helpers';

/* Cursor as a session's AI, with a stand-in for the Cursor CLI runtime. */

function fakeCursor(calls: AgentRunRequest[], ready = true): AgentRuntime & { listModels: () => Promise<{ id: string; label: string }[]> } {
  return {
    id: 'cursor-cli',
    displayName: 'Cursor',
    kind: 'ai',
    resumable: true,
    checkAvailability: async () =>
      ready ? { available: true, reason: null, sandbox: 'unknown', details: { version: '2026.11.11' } } : { available: false, reason: 'The Cursor CLI is installed but not signed in.', sandbox: 'unknown', details: { version: '2026.11.11' } },
    listModels: async () => [
      { id: 'auto', label: 'Auto' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 1M High' },
    ],
    run: async (req) => {
      calls.push(req);
      return emptyResult({ status: 'succeeded', durationMs: 5, numTurns: 1, sessionId: `cursor-chat-${calls.length}`, text: `answer ${calls.length}` });
    },
  };
}

describe('Cursor in sessions', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    cleanup(root);
  });

  async function setup(ready = true) {
    root = tempDir();
    const calls: AgentRunRequest[] = [];
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [fakeCursor(calls, ready)], secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux' });
    orbit.ctx.settings.update({ execution: { suggestNext: true, pastSessions: false } });
    const { repoPath } = await makeRepo(root, 'shop');
    const repo = await orbit.repos.register(repoPath);
    return { calls, repo };
  }

  async function until(check: () => boolean, ms = 8000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('lists your account\'s models, keeps your picks and instructions, and runs sessions on them', async () => {
    const { calls, repo } = await setup();
    const status = await orbit.cursor.status();
    // Only picks your account offers show; the catalog has them all to add from.
    expect(status).toMatchObject({ installed: true, ready: true, version: '2026.11.11' });
    expect(status.models.map((m) => m.id)).toEqual(['cursor:auto', 'cursor:composer-2.5', 'cursor:claude-opus-5-5-high']);
    expect(status.catalog).toHaveLength(3);
    await expect(orbit.cursor.addModel('gpt-9-imaginary')).rejects.toThrow('Your Cursor account has no model "gpt-9-imaginary"');
    await orbit.cursor.setInstructions('cursor:composer-2.5', 'Answer in Greek.');
    expect((await orbit.team()).cursor.models.find((m) => m.slug === 'composer-2.5')?.instructions).toBe('Answer in Greek.');

    const s = orbit.chat.start({ message: 'Add a test', repoIds: [repo.id], mode: 'edit', provider: 'cursor', model: 'cursor:composer-2.5' });
    await until(() => !orbit.chat.isRunning(s.id));
    // Give suggestions a moment: Cursor sessions never ask another AI for one.
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.model).toBe('composer-2.5');
    expect(req.gateway).toBeUndefined();
    expect(req.stateDir).toBe(path.join(orbit.ctx.paths.home, 'cursor-sessions', s.id));
    expect(req.systemAppend).toContain('Answer in Greek.');
    expect(req.commands).toMatchObject({ mode: 'allowlist' });
    expect(orbit.chat.detail(s.id)).toMatchObject({ provider: 'cursor', agentRuntime: 'cursor-cli' });

    // The next message continues Cursor's own chat.
    orbit.chat.send(s.id, { message: 'and another' });
    await until(() => calls.length === 2 && !orbit.chat.isRunning(s.id));
    expect(calls[1]?.session?.resumeId).toBe('cursor-chat-1');

    // No model picked: the first one in your list.
    const t = orbit.chat.start({ message: 'hi', repoIds: [repo.id], mode: 'ask', provider: 'cursor' });
    await until(() => calls.length === 3 && !orbit.chat.isRunning(t.id));
    expect(calls[2]?.model).toBe('auto');
    expect(calls[2]?.access).toBe('read-only');

    // Deleting a session deletes its Cursor settings and chats too (the real runtime writes them there).
    mkdirSync(req.stateDir!, { recursive: true });
    writeFileSync(path.join(req.stateDir!, 'cli-config.json'), '{}');
    orbit.chat.remove(s.id);
    expect(existsSync(req.stateDir!)).toBe(false);
  });

  it('says what to do when Cursor is not signed in', async () => {
    const { calls, repo } = await setup(false);
    expect(await orbit.cursor.status()).toMatchObject({ installed: true, ready: false, reason: 'The Cursor CLI is installed but not signed in.' });
    const s = orbit.chat.start({ message: 'hi', repoIds: [repo.id], mode: 'ask', provider: 'cursor' });
    await until(() => !orbit.chat.isRunning(s.id));
    expect(orbit.chat.detail(s.id).messages[1]?.error).toContain('not signed in');
    expect(calls).toHaveLength(0);
  });
});
