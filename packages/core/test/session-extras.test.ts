import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyResult, type AgentRunRequest, type AgentRunResult, type AgentRuntime } from '@orbit/agents';
import { defaultRunner, type CommandRunner, type RunResult } from '@orbit/git';
import { createOrbit, MemorySecretStore, silentLogger, type Orbit } from '../src';
import { cleanup, git, makeRepo, tempDir } from './helpers';
import { dropCheckpoints } from '../src/checkpoints';

type Behaviour = (req: AgentRunRequest) => Partial<AgentRunResult> | void;

/** A Claude session agent that records every request, and can change files or wait, like a real one. */
function agent(calls: AgentRunRequest[], behave?: Behaviour, hold?: () => Promise<void>): AgentRuntime {
  return {
    id: 'claude-code-cli',
    displayName: 'Claude',
    kind: 'ai',
    resumable: true,
    checkAvailability: async () => ({ available: true, reason: null, sandbox: 'unknown', details: {} }),
    run: async (req) => {
      calls.push(req);
      await hold?.();
      const extra = behave?.(req) ?? {};
      return emptyResult({ status: 'succeeded', durationMs: 5, numTurns: 1, sessionId: `session-${calls.length}`, text: `answer ${calls.length}`, ...extra });
    },
  };
}

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Real git, but the shell Orbit uses for `!` commands answers with a fixed result. */
function fakeShell(output: string, exitCode: number): CommandRunner {
  return {
    run: async (file, args, options) => {
      if (file !== '/bin/sh') return defaultRunner.run(file, args, options);
      const res: RunResult = { file, args, exitCode, stdout: output, stderr: '', output, durationMs: 7, timedOut: false, cancelled: false, spawnFailed: false, ok: exitCode === 0, errorMessage: null };
      return res;
    },
  };
}

describe('session extras: plan mode, /compact, /rewind, ! commands, @ files, usage', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    cleanup(root);
  });

  async function setup(runtime: AgentRuntime, runner?: CommandRunner) {
    root = tempDir();
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [runtime], secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux', ...(runner ? { runner } : {}) });
    orbit.ctx.settings.update({ execution: { suggestNext: false } });
    const { repoPath } = await makeRepo(root, 'shop-api');
    const repo = await orbit.repos.register(repoPath);
    return orbit.repos.get(repo.id);
  }

  it('plans without changing anything, then works once you approve', async () => {
    const calls: AgentRunRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const repo = await setup(agent(calls, undefined, () => (calls.length === 1 ? gate : Promise.resolve())));
    const s = orbit.chat.start({ message: 'Add discounts', repoIds: [repo.id], mode: 'edit', permissionMode: 'plan' });
    await until(() => calls.length === 1);
    // While it plans, the project is not being changed, so you can commit your own work.
    expect(orbit.chat.isEditing(repo.id)).toBe(false);
    release();
    await until(() => !orbit.chat.isRunning(s.id));
    expect(calls[0]).toMatchObject({ access: 'read-only', userEnvironment: true });
    expect(calls[0]?.systemAppend).toContain('plan mode');
    expect(calls[0]?.commands).toBeUndefined();
    expect(calls[0]?.allowGit).toBeUndefined();
    const d = orbit.chat.detail(s.id);
    expect(d.permissionMode).toBe('plan');
    expect(d.messages.at(-1)).toMatchObject({ status: 'done', kind: 'plan', blocked: [] });
    // Plan mode changes nothing, so there is nothing to rewind to.
    expect(d.messages.some((m) => m.checkpoint)).toBe(false);

    orbit.chat.send(s.id, { message: 'The plan is approved. Go ahead.', permissionMode: 'auto' });
    await until(() => calls.length === 2 && !orbit.chat.isRunning(s.id));
    expect(calls[1]).toMatchObject({ access: 'workspace-write', commands: { mode: 'auto' }, allowGit: true });
    expect(calls[1]?.systemAppend).not.toContain('plan mode');
    expect(orbit.chat.detail(s.id).messages.filter((m) => m.checkpoint)).toHaveLength(1);
  });

  it('records what each answer used, for /cost and /context', async () => {
    const calls: AgentRunRequest[] = [];
    const repo = await setup(agent(calls, () => ({ costUsd: 0.0231, usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheWriteTokens: 80 }, context: { tokens: 6600, window: 200_000 } })));
    const s = orbit.chat.start({ message: 'Explain', repoIds: [repo.id], mode: 'edit' });
    await until(() => !orbit.chat.isRunning(s.id));
    const d = orbit.chat.detail(s.id);
    expect(d.messages.at(-1)?.usage).toEqual({ costUsd: 0.0231, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheWriteTokens: 80, contextTokens: 6600, contextWindow: 200_000 });
    expect(d.messages[0]?.usage).toBeNull();
  });

  it('rewinds the files and the conversation to before a message, without touching git', async () => {
    const calls: AgentRunRequest[] = [];
    const repo = await setup(
      agent(calls, (req) => {
        // The agent edits a tracked file and creates new ones.
        writeFileSync(path.join(req.cwd, 'src', 'checkout', 'cart.js'), 'export const total = () => 0;\n');
        writeFileSync(path.join(req.cwd, 'NOTES.md'), 'agent notes\n');
        mkdirSync(path.join(req.cwd, 'generated'), { recursive: true });
        writeFileSync(path.join(req.cwd, 'generated', 'out.txt'), 'x');
      }),
    );
    const cart = path.join(repo.localPath, 'src', 'checkout', 'cart.js');
    // git writes restored files the way this machine checks them out (CRLF with autocrlf on Windows).
    const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const original = text(cart);
    // Your own unsaved work in the folder before the agent starts: it must come back as it was.
    writeFileSync(path.join(repo.localPath, 'mine.txt'), 'my draft\n');
    const head = (await git(repo.localPath, 'rev-parse', 'HEAD')).stdout.trim();

    const s = orbit.chat.start({ message: 'Zero out the cart', repoIds: [repo.id], mode: 'edit' });
    await until(() => !orbit.chat.isRunning(s.id));
    expect(text(cart)).toContain('() => 0');
    const first = orbit.chat.detail(s.id).messages[0]!;
    expect(first.checkpoint).toBe(true);
    const refs = () => git(repo.localPath, 'for-each-ref', '--format=%(refname)', `refs/orbit/checkpoints/${s.id}/`);
    expect((await refs()).stdout).toContain(first.id);

    // Code only: the files go back and the conversation stays; the agent is told on its next message.
    const codeOnly = await orbit.chat.rewind(s.id, { messageId: first.id, code: true, conversation: false });
    expect(codeOnly.message).toBe('Zero out the cart');
    expect(text(cart)).toBe(original);
    expect(existsSync(path.join(repo.localPath, 'NOTES.md'))).toBe(false);
    expect(existsSync(path.join(repo.localPath, 'generated'))).toBe(false);
    expect(text(path.join(repo.localPath, 'mine.txt'))).toBe('my draft\n');
    expect(codeOnly.chat.messages).toHaveLength(2);
    // Branches, HEAD and the staging area are untouched.
    expect((await git(repo.localPath, 'rev-parse', 'HEAD')).stdout.trim()).toBe(head);
    expect((await git(repo.localPath, 'diff', '--cached', '--name-only')).stdout.trim()).toBe('');
    orbit.chat.send(s.id, { message: 'Try again' });
    await until(() => calls.length === 2 && !orbit.chat.isRunning(s.id));
    expect(calls[1]?.prompt).toContain('rewound your file changes');

    // Code and conversation: everything from that message on is gone and the agent starts a fresh session.
    const both = await orbit.chat.rewind(s.id, { messageId: first.id, code: true, conversation: true });
    expect(both.chat.messages).toHaveLength(0);
    expect(both.chat.events).toHaveLength(0);
    expect(text(cart)).toBe(original);
    orbit.chat.send(s.id, { message: 'Different idea' });
    await until(() => calls.length === 3 && !orbit.chat.isRunning(s.id));
    expect(calls[2]?.session?.resumeId).toBeNull();
    await dropCheckpoints(orbit.ctx.git, repo.localPath, s.id);
    expect((await refs()).stdout.trim()).toBe('');
  });

  it('keeps the active model for steered messages, then resumes with the newly selected model and effort', async () => {
    const calls: AgentRunRequest[] = [];
    const steered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = agent(calls, undefined, () => calls.length === 1 ? gate : Promise.resolve());
    const repo = await setup({
      ...base,
      run: async (req, ctx) => {
        ctx.onSteerReady?.((text) => (steered.push(text), true));
        try { return await base.run(req, ctx); }
        finally { ctx.onSteerReady?.(null); }
      },
    });
    const s = orbit.chat.start({ message: 'Long task', repoIds: [repo.id], mode: 'edit', model: 'claude-sonnet-5-5', effort: 'high' });
    await until(() => calls.length === 1);
    try {
      orbit.chat.update(s.id, { model: 'claude-opus-5-5', effort: 'max' });
      orbit.chat.send(s.id, { message: 'Also check the tests' });
      expect(steered).toEqual(['Also check the tests']);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
      expect(orbit.chat.isRunning(s.id)).toBe(true);
      orbit.chat.update(s.id, { permissionMode: 'plan' });
      expect(orbit.chat.isEditing(repo.id)).toBe(true);
      orbit.chat.update(s.id, { permissionMode: 'ask' });
      expect(orbit.chat.detail(s.id).messages.find((m) => m.role === 'assistant')?.model).toBe('claude-sonnet-5-5');
    } finally { release(); }
    await until(() => !orbit.chat.isRunning(s.id));
    orbit.chat.send(s.id, { message: 'Continue' });
    await until(() => calls.length === 2 && !orbit.chat.isRunning(s.id));
    expect(calls[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'max', session: { resumeId: 'session-1' } });
  });

  it('refuses a code rewind in a read-only session, a rewind with nothing chosen, and one while the agent works', async () => {
    const calls: AgentRunRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const repo = await setup(agent(calls, undefined, () => (calls.length === 2 ? gate : Promise.resolve())));
    const s = orbit.chat.start({ message: 'Hi', repoIds: [repo.id], mode: 'ask' });
    await until(() => !orbit.chat.isRunning(s.id));
    const first = orbit.chat.detail(s.id).messages[0]!;
    await expect(orbit.chat.rewind(s.id, { messageId: first.id, code: true, conversation: false })).rejects.toThrow(/only working sessions/i);
    await expect(orbit.chat.rewind(s.id, { messageId: first.id, code: false, conversation: false })).rejects.toThrow(/choose what to rewind/i);
    await expect(orbit.chat.rewind(s.id, { messageId: 'msg_nope', code: false, conversation: true })).rejects.toThrow(/not found/i);

    orbit.chat.send(s.id, { message: 'Again' });
    await until(() => calls.length === 2);
    await expect(orbit.chat.rewind(s.id, { messageId: first.id, code: false, conversation: true })).rejects.toThrow(/stop the agent/i);
    expect(() => orbit.chat.compact(s.id)).toThrow(/wait for the agent/i);
    release();
    await until(() => !orbit.chat.isRunning(s.id));
  });

  it('compacts: the agent summarizes, then continues from its summary in a fresh session', async () => {
    const calls: AgentRunRequest[] = [];
    const repo = await setup(agent(calls, (req) => (req.prompt.includes('Compact this session') ? { text: 'SUMMARY: we added discounts in src/discount.js.' } : undefined)));
    expect(() => orbit.chat.compact('chat_missing')).toThrow(/not found/i);
    const s = orbit.chat.start({ message: 'Add discounts please', repoIds: [repo.id], mode: 'edit' });
    await until(() => !orbit.chat.isRunning(s.id));
    orbit.chat.send(s.id, { message: 'Now add tests' });
    await until(() => calls.length === 2 && !orbit.chat.isRunning(s.id));

    orbit.chat.compact(s.id, 'the discount rules');
    await until(() => calls.length === 3 && !orbit.chat.isRunning(s.id));
    // The summary is written read-only, in the same agent session (which still knows everything).
    expect(calls[2]).toMatchObject({ access: 'read-only' });
    expect(calls[2]?.prompt).toContain('Focus especially on: the discount rules');
    expect(calls[2]?.session?.resumeId).toBe('session-2');
    const d = orbit.chat.detail(s.id);
    expect(d.messages.at(-1)).toMatchObject({ kind: 'summary', status: 'done', content: 'SUMMARY: we added discounts in src/discount.js.' });
    expect(d.messages.at(-2)).toMatchObject({ role: 'user', content: '/compact the discount rules', checkpoint: false });

    // The next message starts a fresh agent session whose context is the summary, not the old conversation.
    orbit.chat.send(s.id, { message: 'What did we do?' });
    await until(() => calls.length === 4 && !orbit.chat.isRunning(s.id));
    expect(calls[3]?.session?.resumeId).toBeNull();
    expect(calls[3]?.access).toBe('workspace-write');
    expect(calls[3]?.prompt).toContain('SUMMARY: we added discounts');
    expect(calls[3]?.prompt).not.toContain('Add discounts please');
  });

  it('has nothing to compact before the agent has answered', async () => {
    const repo = await setup(agent([]), fakeShell('ok', 0));
    const s = orbit.chat.shell({ repoId: repo.id, command: 'echo ok' });
    await until(() => !orbit.chat.isRunning(s.id));
    expect(() => orbit.chat.compact(s.id)).toThrow(/nothing to compact/i);
  });

  it('runs a ! command in the project and tells the agent on its next message', async () => {
    const calls: AgentRunRequest[] = [];
    const repo = await setup(agent(calls), fakeShell('3 passing\n1 failing', 1));
    const started = orbit.chat.shell({ repoId: repo.id, command: '!npm test' });
    expect(started.mode).toBe('edit');
    expect(started.running).toBe(true);
    await until(() => !orbit.chat.isRunning(started.id));
    const d = orbit.chat.detail(started.id);
    expect(d.messages[0]).toMatchObject({ role: 'user', content: '!npm test', kind: 'chat' });
    expect(d.messages[1]).toMatchObject({ role: 'assistant', kind: 'shell', status: 'failed', error: 'Exit code 1', content: '3 passing\n1 failing' });
    expect(calls).toHaveLength(0);
    // A failed command of yours is not a failed agent: the session does not look like it stopped with a problem.
    expect(d.lastStatus).toBeNull();

    orbit.chat.send(started.id, { message: 'Fix the failing test' });
    await until(() => calls.length === 1 && !orbit.chat.isRunning(started.id));
    expect(calls[0]?.prompt).toContain('$ npm test');
    expect(calls[0]?.prompt).toContain('3 passing');
    expect(calls[0]?.prompt).toContain('(exit code 1)');
    expect(calls[0]?.prompt).toContain('Fix the failing test');

    // Once the agent has answered, the command is old news.
    orbit.chat.send(started.id, { message: 'Thanks' });
    await until(() => calls.length === 2 && !orbit.chat.isRunning(started.id));
    expect(calls[1]?.prompt).not.toContain('npm test');
    expect(() => orbit.chat.shell({ repoId: repo.id, command: '!', chatId: started.id })).toThrow(/after the !/);
  });

  it('suggests files and folders for @ mentions, best match first, never dependency folders', async () => {
    const repo = await setup(agent([]));
    mkdirSync(path.join(repo.localPath, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(path.join(repo.localPath, 'node_modules', 'left-pad', 'cart.js'), 'x');
    writeFileSync(path.join(repo.localPath, 'src', 'cart-notes.md'), 'x');

    expect((await orbit.files(repo.id, 'cart')).slice(0, 2)).toEqual(['src/cart-notes.md', 'src/checkout/cart.js']);
    expect(await orbit.files(repo.id, 'cart')).not.toContain('node_modules/left-pad/cart.js');
    expect(await orbit.files(repo.id, 'chkt')).toContain('src/checkout/');
    expect((await orbit.files(repo.id, '')).slice(0, 2).sort()).toEqual(['README.md', 'src/']);
    expect(await orbit.files(repo.id, 'zzzz-no-such-file')).toEqual([]);
  });
});
