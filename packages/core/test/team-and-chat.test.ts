import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyResult, ScriptedRuntime, type AgentRunRequest, type AgentRunResult, type AgentRuntime } from '@orbit/agents';
import { createOrbit, MemorySecretStore, planSeat, silentLogger, type Orbit } from '../src';
import { cleanup, makeOrbit, makeRepo, tempDir, USER, waitFor, type TestOrbit } from './helpers';

type Behaviour = (req: AgentRunRequest) => Partial<AgentRunResult> & Pick<AgentRunResult, 'status'>;

function fake(id: AgentRuntime['id'], opts: { available?: boolean; behave?: Behaviour; calls?: AgentRunRequest[]; resumable?: boolean } = {}): AgentRuntime {
  return {
    id,
    displayName: id,
    kind: 'ai',
    resumable: opts.resumable ?? true,
    checkAvailability: async () => ({ available: opts.available ?? true, reason: opts.available === false ? `${id} is not signed in` : null, sandbox: 'unknown', details: {} }),
    run: async (req, ctx) => {
      opts.calls?.push(req);
      ctx.onEvent({ type: 'tool', tool: 'Read', id: 't1', summary: 'Read cart.ts', step: 'read', target: 'src/cart.ts' });
      const r = opts.behave?.(req) ?? { status: 'succeeded' as const, text: `answer from ${id}` };
      return emptyResult({ durationMs: 5, numTurns: 1, sessionId: `session-of-${id}`, ...r });
    },
  };
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('orchestrator routing', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(() => {
    orbit.close();
    cleanup(root);
  });
  const make = (runtimes: AgentRuntime[], platform: NodeJS.Platform = 'linux') => {
    root = tempDir();
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes, secrets: new MemorySecretStore(), logger: silentLogger, platform });
  };

  it('auto gives Claude the building seats and Codex the review, with the other AI as backup', async () => {
    make([fake('claude-code-cli'), fake('codex-cli')]);
    const engineer = await planSeat(orbit.ctx, 'engineer');
    const reviewer = await planSeat(orbit.ctx, 'reviewer');
    const assistant = await planSeat(orbit.ctx, 'assistant');
    expect(engineer.primary?.provider).toBe('claude');
    expect(engineer.fallback?.provider).toBe('codex');
    expect(reviewer.primary?.provider).toBe('codex');
    expect(reviewer.why).toMatch(/second opinion/);
    expect(assistant.primary?.model).toBe('claude-opus-5-5');
  });

  it('honours explicit choices and the reviewer follows the engineer to the other AI', async () => {
    make([fake('claude-code-cli'), fake('codex-cli')]);
    orbit.ctx.settings.update({ team: { engineer: 'codex' }, codexModels: { engineer: 'gpt-6-sol' } });
    const engineer = await planSeat(orbit.ctx, 'engineer');
    expect(engineer.primary).toMatchObject({ provider: 'codex', model: 'gpt-6-sol' });
    expect((await planSeat(orbit.ctx, 'reviewer')).primary?.provider).toBe('claude');
  });

  it('stands in with the other AI when the chosen one is not ready, unless fallback is off', async () => {
    make([fake('claude-code-cli', { available: false }), fake('codex-cli')]);
    const planner = await planSeat(orbit.ctx, 'planner');
    expect(planner.primary?.provider).toBe('codex');
    expect(planner.why).toMatch(/stands in/);
    orbit.ctx.settings.update({ team: { fallback: false } });
    const strict = await planSeat(orbit.ctx, 'planner');
    expect(strict.primary?.provider).toBe('claude');
    expect(strict.primary?.availability.available).toBe(false);
    expect(strict.fallback).toBeNull();
  });

  it('on Windows with the sandbox on, auto gives Codex the build (its sandbox works there) and Claude the review', async () => {
    make([fake('claude-code-cli'), fake('codex-cli')], 'win32');
    const engineer = await planSeat(orbit.ctx, 'engineer');
    expect(engineer.primary?.provider).toBe('codex');
    expect(engineer.why).toMatch(/sandbox works on Windows/);
    expect((await planSeat(orbit.ctx, 'reviewer')).primary?.provider).toBe('claude');
    // Trusted-local needs no sandbox, so Claude builds again.
    orbit.ctx.settings.update({ execution: { mode: 'trusted-local' } });
    expect((await planSeat(orbit.ctx, 'engineer')).primary?.provider).toBe('claude');
  });

  it('works with Claude alone and says the review has no second opinion', async () => {
    make([fake('claude-code-cli')]);
    const reviewer = await planSeat(orbit.ctx, 'reviewer');
    expect(reviewer.primary?.provider).toBe('claude');
    expect(reviewer.fallback).toBeNull();
    expect(reviewer.why).toMatch(/only one AI/);
  });
});

describe('Ask conversations', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    cleanup(root);
  });

  async function setup(runtimes: AgentRuntime[]) {
    root = tempDir();
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes, secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux' });
    const { repoPath } = await makeRepo(root, 'shop-api');
    return orbit.repos.register(repoPath);
  }

  it('answers read-only from the project, records steps, and proposes a mission', async () => {
    const calls: AgentRunRequest[] = [];
    const repo = await setup([
      fake('claude-code-cli', {
        calls,
        behave: () => ({ status: 'succeeded', text: 'Totals live in `src/cart.ts`.\n```orbit-mission\n{"title":"Add discounts","description":"Percent off","projects":["shop-api"]}\n```' }),
      }),
    ]);
    const started = orbit.chat.start({ message: 'Where are totals computed?' });
    expect(started.title).toBe('Where are totals computed?');
    await until(() => orbit.chat.detail(started.id).messages.at(-1)?.status === 'done');

    const d = orbit.chat.detail(started.id);
    expect(d.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'done'],
    ]);
    expect(d.messages[1]).toMatchObject({ content: 'Totals live in `src/cart.ts`.', runtime: 'claude-code-cli', suggestion: { title: 'Add discounts', repoIds: [repo.id] } });
    expect(d.events.map((e) => e.title)).toEqual(['Assistant started (Claude · claude-opus-5-5)', 'Read cart.ts', expect.stringMatching(/^Assistant finished/)]);
    expect(calls[0]).toMatchObject({ role: 'assistant', access: 'read-only', cwd: repo.localPath });
    expect(calls[0]?.prompt).toContain('Where are totals computed?');
  });

  it('continues the agent session on follow-ups, and re-sends history when it cannot', async () => {
    const calls: AgentRunRequest[] = [];
    await setup([fake('claude-code-cli', { calls })]);
    const c = orbit.chat.start({ message: 'First question' });
    await until(() => !orbit.chat.isRunning(c.id));
    orbit.chat.send(c.id, { message: 'And a follow-up?' });
    await until(() => orbit.chat.detail(c.id).messages.length === 4 && !orbit.chat.isRunning(c.id));
    expect(calls[0]?.session).toEqual({ resumeId: null, persist: true });
    expect(calls[1]?.session).toEqual({ resumeId: 'session-of-claude-code-cli', persist: true });
    expect(calls[1]?.prompt).toBe('And a follow-up?');
  });

  it('includes the conversation so far when the runtime cannot resume', async () => {
    const calls: AgentRunRequest[] = [];
    await setup([fake('claude-code-cli', { calls, resumable: false })]);
    const c = orbit.chat.start({ message: 'First question' });
    await until(() => !orbit.chat.isRunning(c.id));
    orbit.chat.send(c.id, { message: 'And a follow-up?' });
    await until(() => orbit.chat.detail(c.id).messages.length === 4 && !orbit.chat.isRunning(c.id));
    expect(calls[1]?.session?.resumeId).toBeNull();
    expect(calls[1]?.prompt).toContain('Developer: First question');
    expect(calls[1]?.prompt).toContain('Assistant: answer from claude-code-cli');
    expect(calls[1]?.prompt).toContain('And a follow-up?');
  });

  it('switches to the other AI when the first hits its usage limit', async () => {
    await setup([fake('claude-code-cli', { behave: () => ({ status: 'rate_limited', error: 'Claude AI usage limit reached' }) }), fake('codex-cli')]);
    const c = orbit.chat.start({ message: 'Explain the project' });
    await until(() => orbit.chat.detail(c.id).messages.at(-1)?.status !== 'running');
    const d = orbit.chat.detail(c.id);
    expect(d.messages.at(-1)).toMatchObject({ status: 'done', content: 'answer from codex-cli', runtime: 'codex-cli' });
    expect(d.events.some((e) => e.title === 'Claude hit its usage limit. Switching to Codex.')).toBe(true);
  });

  it('explains a usage limit when there is no other AI', async () => {
    await setup([fake('claude-code-cli', { behave: () => ({ status: 'rate_limited', error: 'usage limit' }) })]);
    const c = orbit.chat.start({ message: 'Explain the project' });
    await until(() => orbit.chat.detail(c.id).messages.at(-1)?.status !== 'running');
    expect(orbit.chat.detail(c.id).messages.at(-1)).toMatchObject({ status: 'failed', error: expect.stringMatching(/usage limit/) });
  });

  it('queues follow-ups sent while the agent works and sends them together when it finishes', async () => {
    const calls: AgentRunRequest[] = [];
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const slow: AgentRuntime = {
      ...fake('claude-code-cli'),
      run: async (req, ctx) => {
        calls.push(req);
        if (calls.length === 1) await gate;
        void ctx;
        return emptyResult({ status: 'succeeded', durationMs: 1, text: `answer ${calls.length}`, sessionId: 's1', numTurns: 1 });
      },
    };
    await setup([slow]);
    const c = orbit.chat.start({ message: 'One' });
    expect(() => orbit.chat.send(c.id, { message: '   ' })).toThrow();
    orbit.chat.send(c.id, { message: 'Two' });
    const three = orbit.chat.send(c.id, { message: 'Three' });
    expect(three.messages.filter((m) => m.status === 'queued').map((m) => m.content)).toEqual(['Two', 'Three']);
    // Take one back before it is sent.
    const dropped = three.messages.find((m) => m.content === 'Three')!;
    orbit.chat.unqueue(c.id, dropped.id);
    orbit.chat.send(c.id, { message: 'Four' });
    release();
    await until(() => calls.length === 2 && !orbit.chat.isRunning(c.id));
    expect(calls[1]?.prompt).toBe('Two\n\nFour');
    const d = orbit.chat.detail(c.id);
    expect(d.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'One', 'done'],
      ['assistant', 'answer 1', 'done'],
      ['user', 'Two', 'done'],
      ['user', 'Four', 'done'],
      ['assistant', 'answer 2', 'done'],
    ]);
    gate = Promise.resolve();
  });

  it('delivers a message mid-answer when the agent can take it, like typing into Claude Code', async () => {
    const received: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const live: AgentRuntime = {
      ...fake('claude-code-cli'),
      run: async (req, ctx) => {
        runs++;
        received.push(req.prompt);
        ctx.onSteerReady?.((text) => (received.push(text), true));
        await gate;
        ctx.onSteerReady?.(null);
        return emptyResult({ status: 'succeeded', durationMs: 1, text: 'done with both', numTurns: 1 });
      },
    };
    await setup([live]);
    const c = orbit.chat.start({ message: 'Long task' });
    await until(() => orbit.chat.detail(c.id).steerable);
    const d = orbit.chat.send(c.id, { message: 'Also check the tests' });
    expect(d.messages.at(-1)).toMatchObject({ role: 'user', content: 'Also check the tests', status: 'steered' });
    release();
    await until(() => !orbit.chat.isRunning(c.id));
    expect(received).toHaveLength(2);
    expect(received[0]).toContain('Long task');
    expect(received[1]).toBe('Also check the tests');
    expect(runs).toBe(1);
    const after = orbit.chat.detail(c.id);
    expect(after.steerable).toBe(false);
    expect(after.messages.map((m) => m.status)).toEqual(['done', 'done', 'steered']);
  });

  it('"send now" interrupts the current answer and sends the new message right away', async () => {
    const calls: AgentRunRequest[] = [];
    const slow: AgentRuntime = {
      ...fake('claude-code-cli'),
      run: (req, ctx) => {
        calls.push(req);
        if (calls.length > 1) return Promise.resolve(emptyResult({ status: 'succeeded', durationMs: 1, text: 'redirected', numTurns: 1 }));
        return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(emptyResult({ status: 'cancelled', durationMs: 1, text: 'partial' }))));
      },
    };
    await setup([slow]);
    const c = orbit.chat.start({ message: 'Long task' });
    await until(() => calls.length === 1);
    orbit.chat.send(c.id, { message: 'Actually, do this instead', now: true });
    await until(() => calls.length === 2 && !orbit.chat.isRunning(c.id));
    const d = orbit.chat.detail(c.id);
    expect(d.messages.map((m) => m.status)).toEqual(['done', 'cancelled', 'done', 'done']);
    expect(d.messages.at(-1)?.content).toBe('redirected');
  });
});

describe('orchestrator in a real mission', () => {
  let root: string;
  let t: TestOrbit;
  afterEach(async () => {
    await t.close();
    cleanup(root);
  });

  /** Scripted agent work under a real provider's id, so routing treats it as that AI. */
  function as(id: 'claude-code-cli' | 'codex-cli', limitFor: string[] = []): AgentRuntime {
    const scripted = new ScriptedRuntime();
    return {
      id,
      displayName: id,
      kind: 'ai',
      checkAvailability: async () => ({ available: true, reason: null, sandbox: 'unknown', details: {} }),
      run: (req, ctx) => (limitFor.includes(req.role) ? Promise.resolve(emptyResult({ status: 'rate_limited', durationMs: 1, error: 'Claude AI usage limit reached' })) : scripted.run(req, ctx)),
    };
  }

  it('hands the engineer to Codex when Claude hits its limit, and the mission still reaches review', async () => {
    root = tempDir();
    const { repoPath } = await makeRepo(root);
    const claude = as('claude-code-cli', ['engineer']);
    t = makeOrbit(root, { runtime: claude, runtimes: [claude, as('codex-cli')], platform: 'linux' });
    const { orbit } = t;
    const repo = await orbit.repos.register(repoPath);
    orbit.start({ triggers: false });
    const { mission } = await orbit.missions.create({ title: 'Document checkout', description: 'Add a note.', repoIds: [repo.id], entryPoint: 'cli', triggeredBy: USER, triggerVerified: true });

    const ready = await waitFor(() => orbit.missions.detail(mission.id), (d) => ['AWAITING_REVIEW', 'BLOCKED', 'FAILED'].includes(d.status), 45_000, 'review');
    expect(ready.status, `blocked: ${ready.blockedReason} ${ready.lastError}`).toBe('AWAITING_REVIEW');
    const runs = ready.agentRuns.map((r) => [r.role, r.runtime, r.status]);
    expect(runs).toContainEqual(['planner', 'claude-code-cli', 'succeeded']);
    expect(runs).toContainEqual(['engineer', 'claude-code-cli', 'failed']);
    expect(runs).toContainEqual(['engineer', 'codex-cli', 'succeeded']);
    // Auto review: a different AI from the one the engineer seat is assigned to.
    expect(runs).toContainEqual(['reviewer', 'codex-cli', 'succeeded']);
    const events = orbit.missions.events(mission.id);
    expect(events.some((e) => e.title === 'Claude hit its usage limit. Switching the engineer to Codex.')).toBe(true);
  });
});

describe('working sessions (the workspace)', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    cleanup(root);
  });

  async function setup(runtimes: AgentRuntime[]) {
    root = tempDir();
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes, secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux' });
    const { repoPath } = await makeRepo(root, 'shop-api');
    const repo = await orbit.repos.register(repoPath);
    orbit.repos.update(repo.id, { verifyCommands: [{ id: '', label: 'Tests', command: 'npm test', timeoutSec: 60, enabled: true, source: 'user' }] });
    return orbit.repos.get(repo.id);
  }

  it('edits directly in the project, with only approved commands, and resumes the session', async () => {
    const calls: AgentRunRequest[] = [];
    const repo = await setup([fake('claude-code-cli', { calls })]);
    const s = orbit.chat.start({ message: 'Add a discount', repoIds: [repo.id], mode: 'edit' });
    expect(s).toMatchObject({ mode: 'edit', provider: 'auto' });
    await until(() => !orbit.chat.isRunning(s.id));
    expect(calls[0]).toMatchObject({ access: 'workspace-write', cwd: repo.localPath, readRoots: [], session: { resumeId: null, persist: true }, commands: { mode: 'allowlist', allowed: ['npm test'] } });
    expect(calls[0]?.prompt).toContain('Project: shop-api');
    expect(calls[0]?.prompt).toContain('Add a discount');

    orbit.chat.send(s.id, { message: 'Now add tests' });
    await until(() => orbit.chat.detail(s.id).messages.length === 4 && !orbit.chat.isRunning(s.id));
    expect(calls[1]).toMatchObject({ prompt: 'Now add tests', session: { resumeId: 'session-of-claude-code-cli', persist: true } });
    expect(orbit.chat.detail(s.id).agentRuntime).toBe('claude-code-cli');
  });

  it('asks before running a new command, and continues once you allow it', async () => {
    const calls: AgentRunRequest[] = [];
    const repo = await setup([
      fake('claude-code-cli', {
        calls,
        behave: (req) =>
          req.commands?.mode === 'allowlist' && req.commands.allowed.includes('npm install lodash')
            ? { status: 'succeeded', text: 'Installed and done.' }
            : { status: 'succeeded', text: 'I need to install lodash.', deniedTools: [{ tool: 'Bash', reason: 'Needs your approval', command: 'npm install lodash' }, { tool: 'Bash', reason: 'x', command: 'a, b' }] },
      }),
    ]);
    const s = orbit.chat.start({ message: 'Use lodash', repoIds: [repo.id], mode: 'edit' });
    await until(() => !orbit.chat.isRunning(s.id));
    const first = orbit.chat.detail(s.id).messages[1]!;
    expect(first.blocked).toEqual([
      { tool: 'Bash', command: 'npm install lodash', allowable: true },
      { tool: 'Bash', command: 'a, b', allowable: true },
    ]);

    orbit.chat.allow(s.id, 'npm install lodash');
    await until(() => orbit.chat.detail(s.id).messages.length === 4 && !orbit.chat.isRunning(s.id));
    const d = orbit.chat.detail(s.id);
    expect(d.allowedCommands).toEqual(['npm install lodash']);
    expect(calls[1]?.prompt).toContain('I allowed `npm install lodash`');
    expect(d.messages[3]).toMatchObject({ status: 'done', content: 'Installed and done.', blocked: [] });
    expect(() => orbit.chat.allow(s.id, '   ')).toThrow(/cannot be allowed/);
  });

  it('runs Auto sessions in auto mode, by choice or by default, and "allow everything" switches to it', async () => {
    const calls: AgentRunRequest[] = [];
    const repo = await setup([fake('claude-code-cli', { calls })]);
    const s = orbit.chat.start({ message: 'Fix the bug', repoIds: [repo.id], mode: 'edit' });
    expect(s.permissionMode).toBe('ask');
    await until(() => !orbit.chat.isRunning(s.id));
    expect(calls[0]?.commands?.mode).toBe('allowlist');

    orbit.chat.allowAll(s.id);
    await until(() => orbit.chat.detail(s.id).messages.length === 4 && !orbit.chat.isRunning(s.id));
    expect(orbit.chat.detail(s.id).permissionMode).toBe('auto');
    expect(calls[1]?.commands).toEqual({ mode: 'auto', allowed: ['npm test'] });
    expect(calls[1]?.prompt).toContain('without asking');

    orbit.chat.update(s.id, { permissionMode: 'ask' });
    expect(orbit.chat.detail(s.id).permissionMode).toBe('ask');

    orbit.ctx.settings.update({ execution: { sessionCommands: 'auto' } });
    const t = orbit.chat.start({ message: 'Another', repoIds: [repo.id], mode: 'edit' });
    expect(t.permissionMode).toBe('auto');
    await until(() => !orbit.chat.isRunning(t.id));
  });

  it('switching AI mid-session starts the new one with the conversation so far', async () => {
    const claudeCalls: AgentRunRequest[] = [];
    const codexCalls: AgentRunRequest[] = [];
    const repo = await setup([fake('claude-code-cli', { calls: claudeCalls }), fake('codex-cli', { calls: codexCalls })]);
    const s = orbit.chat.start({ message: 'Explain cart.js', repoIds: [repo.id], mode: 'edit' });
    await until(() => !orbit.chat.isRunning(s.id));
    orbit.chat.send(s.id, { message: 'Now refactor it', provider: 'codex' });
    await until(() => orbit.chat.detail(s.id).messages.length === 4 && !orbit.chat.isRunning(s.id));
    expect(codexCalls[0]?.session?.resumeId).toBeNull();
    expect(codexCalls[0]?.prompt).toContain('You: answer from claude-code-cli');
    expect(orbit.chat.detail(s.id)).toMatchObject({ provider: 'codex', agentRuntime: 'codex-cli' });
  });

  it('refuses to edit read-only projects and multi-project sessions', async () => {
    const repo = await setup([fake('claude-code-cli')]);
    orbit.repos.update(repo.id, { allowModify: false });
    expect(() => orbit.chat.start({ message: 'x', repoIds: [repo.id], mode: 'edit' })).toThrow(/read-only/);
    expect(() => orbit.chat.start({ message: 'x', repoIds: [], mode: 'edit' })).toThrow(/exactly one project/);
  });

  it('shows uncommitted changes including new files, and commits them', async () => {
    const repo = await setup([fake('claude-code-cli')]);
    const { writeFileSync, readFileSync } = await import('node:fs');
    const cart = path.join(repo.localPath, 'src', 'checkout', 'cart.js');
    writeFileSync(cart, `${readFileSync(cart, 'utf8')}export const VERSION = 2;\n`);
    writeFileSync(path.join(repo.localPath, 'src', 'discount.js'), 'export const off = (t, p) => t * (100 - p) / 100;\n');

    const changes = await orbit.changes(repo.id);
    expect(changes.files.map((f) => [f.path, f.status]).sort()).toEqual([
      ['src/checkout/cart.js', 'modified'],
      ['src/discount.js', 'untracked'],
    ]);
    expect(changes.diff).toContain('+export const VERSION = 2;');
    expect(changes.diff).toContain('+++ b/src/discount.js');
    expect(changes.diff).toContain('+export const off');

    const done = await orbit.commit(repo.id, 'Add discount helper');
    expect(done.files).toBe(2);
    expect((await orbit.changes(repo.id)).files).toEqual([]);
    await expect(orbit.commit(repo.id, 'again')).rejects.toThrow(/nothing to commit/);
  });
});
