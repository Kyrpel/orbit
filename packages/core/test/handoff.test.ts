import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyResult, type AgentRunRequest, type AgentRuntime } from '@orbit/agents';
import { createOrbit, MemorySecretStore, silentLogger, type Orbit } from '../src';
import { cleanup, makeRepo, tempDir } from './helpers';

/*
  A session moving to another AI (a usage limit, or you switched) gets a handoff: who had it and
  why, the commands it ran for the message, and what it changed. Never the other AI's answers
  presented as its own.
*/

describe('handing a session to another AI', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    cleanup(root);
  });

  async function until(check: () => boolean, ms = 8000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Claude answers its first message, then edits a file, runs a command and hits its usage limit. */
  function claude(calls: AgentRunRequest[], limited: () => boolean): AgentRuntime {
    return {
      id: 'claude-code-cli',
      displayName: 'Claude',
      kind: 'ai',
      resumable: true,
      checkAvailability: async () => ({ available: true, reason: null, sandbox: 'unknown', details: {} }),
      run: async (req, ctx) => {
        calls.push(req);
        if (!limited()) return emptyResult({ status: 'succeeded', durationMs: 5, numTurns: 1, sessionId: 'claude-1', text: 'Planned the discount: a new discount.js.' });
        writeFileSync(path.join(req.cwd, 'discount.js'), 'export const discount = (p) => p * 0.9;\n');
        ctx.onEvent({ type: 'tool', tool: 'Bash', summary: 'Run npm test', step: 'run', target: 'npm test' });
        ctx.onEvent({ type: 'denied', tool: 'Bash', reason: 'needs approval', command: 'npm publish' });
        return emptyResult({ status: 'rate_limited', durationMs: 5, sessionId: 'claude-1', error: 'Claude AI usage limit reached' });
      },
    };
  }

  function codex(calls: AgentRunRequest[]): AgentRuntime {
    return {
      id: 'codex-cli',
      displayName: 'Codex',
      kind: 'ai',
      resumable: true,
      checkAvailability: async () => ({ available: true, reason: null, sandbox: 'unknown', details: {} }),
      run: async (req) => {
        calls.push(req);
        return emptyResult({ status: 'succeeded', durationMs: 5, numTurns: 1, sessionId: 'codex-1', text: 'Finished the discount.' });
      },
    };
  }

  async function setup(claudeCalls: AgentRunRequest[], codexCalls: AgentRunRequest[], limited: () => boolean) {
    root = tempDir();
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [claude(claudeCalls, limited), codex(codexCalls)], secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux' });
    orbit.ctx.settings.update({ execution: { suggestNext: false, pastSessions: false } });
    const { repoPath } = await makeRepo(root, 'shop');
    return orbit.repos.register(repoPath);
  }

  it('at a usage limit: Codex gets what Claude ran and changed for this message, and Claude\'s answers as Claude\'s', async () => {
    let limit = false;
    const claudeCalls: AgentRunRequest[] = [];
    const codexCalls: AgentRunRequest[] = [];
    const repo = await setup(claudeCalls, codexCalls, () => limit);

    const s = orbit.chat.start({ message: 'Plan a 10% discount', repoIds: [repo.id], mode: 'edit' });
    await until(() => !orbit.chat.isRunning(s.id));
    limit = true;
    orbit.chat.send(s.id, { message: 'Now build it' });
    await until(() => codexCalls.length === 1 && !orbit.chat.isRunning(s.id));

    const prompt = codexCalls[0]!.prompt;
    expect(prompt).toContain('## You are taking over from Claude');
    expect(prompt).toContain('stopped because it hit its usage limit');
    expect(prompt).toContain('- Run npm test');
    expect(prompt).toContain("npm publish (refused: it needed the developer's OK)");
    // Exactly what Claude changed in this turn, new files included.
    expect(prompt).toContain('### What Claude changed while working on this message');
    expect(prompt).toContain('discount.js');
    expect(prompt).toContain('+export const discount = (p) => p * 0.9;');
    // Claude's earlier answer is Claude's, not "You".
    expect(prompt).toContain('Claude: Planned the discount: a new discount.js.');
    expect(prompt).not.toContain('You: Planned the discount');
    expect(prompt).toContain('Now build it');
    const d = orbit.chat.detail(s.id);
    expect(d.events.some((e) => e.title === 'Handed over from Claude: 2 commands and 1 changed file passed on')).toBe(true);
    expect(d.messages.at(-1)).toMatchObject({ status: 'done', content: 'Finished the discount.' });
  });

  it('when you switch AI: the new one gets the uncommitted changes and a handoff; switching back labels Codex\'s answers too', async () => {
    const claudeCalls: AgentRunRequest[] = [];
    const codexCalls: AgentRunRequest[] = [];
    const repo = await setup(claudeCalls, codexCalls, () => false);

    const s = orbit.chat.start({ message: 'Plan a 10% discount', repoIds: [repo.id], mode: 'edit', provider: 'claude' });
    await until(() => !orbit.chat.isRunning(s.id));
    writeFileSync(path.join(repo.localPath, 'notes.md'), 'half done\n');
    orbit.chat.send(s.id, { message: 'Carry on', provider: 'codex' });
    await until(() => codexCalls.length === 1 && !orbit.chat.isRunning(s.id));
    const toCodex = codexCalls[0]!.prompt;
    expect(toCodex).toContain('The developer switched this session from Claude to you.');
    expect(toCodex).toContain('### Uncommitted changes in the project right now');
    expect(toCodex).toContain('notes.md');
    expect(toCodex).toContain('Claude: Planned the discount');

    // Back to Claude: a fresh Claude session (its old one misses Codex's work), with Codex's answer as Codex's.
    orbit.chat.send(s.id, { message: 'Check it', provider: 'claude' });
    await until(() => claudeCalls.length === 2 && !orbit.chat.isRunning(s.id));
    const back = claudeCalls[1]!;
    expect(back.session?.resumeId).toBeNull();
    expect(back.prompt).toContain('## You are taking over from Codex');
    expect(back.prompt).toContain('Codex: Finished the discount.');
    // Its own earlier answer stays its own.
    expect(back.prompt).toContain('You: Planned the discount');
  });

  it('the same AI continuing its own session gets no handoff', async () => {
    const claudeCalls: AgentRunRequest[] = [];
    const repo = await setup(claudeCalls, [], () => false);
    const s = orbit.chat.start({ message: 'one', repoIds: [repo.id], mode: 'edit', provider: 'claude' });
    await until(() => !orbit.chat.isRunning(s.id));
    orbit.chat.send(s.id, { message: 'two' });
    await until(() => claudeCalls.length === 2 && !orbit.chat.isRunning(s.id));
    expect(claudeCalls[1]?.session?.resumeId).toBe('claude-1');
    expect(claudeCalls[1]?.prompt).toBe('two');
  });
});
