import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyResult, type AgentRunRequest, type AgentRuntime } from '@orbit/agents';
import { redactSecrets } from '@orbit/shared';
import { createOrbit, MemorySecretStore, silentLogger, type Orbit } from '../src';
import { cleanup, makeRepo, tempDir } from './helpers';

/*
  OpenRouter models in Claude Code sessions. A stand-in for OpenRouter's API answers the key
  check and the public model list; the session agent records what it was asked to run.
*/

const GOOD_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

function fakeOpenRouter(): Promise<{ url: string; close: () => void; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ? 'auth' : 'no-auth'}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/key') {
      if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'No auth credentials found' } }));
        return;
      }
      res.end(JSON.stringify({ data: { label: 'orbit test', usage: 1.25, limit: 20 } }));
      return;
    }
    if (req.url === '/v1/models') {
      res.end(
        JSON.stringify({
          data: [
            { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017', context_length: 1048576, supported_parameters: ['tools', 'tool_choice', 'reasoning'], pricing: { prompt: '0.000000006', completion: '0.0000005' } },
            { id: 'nousresearch/hermes-4-405b', name: 'Nous: Hermes 4 405B', context_length: 131072, supported_parameters: ['reasoning', 'temperature'], pricing: { prompt: '0.000001', completion: '0.000003' } },
            { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', context_length: 1000000, supported_parameters: ['tools'], pricing: { prompt: '0.00000125', completion: '0.00001' } },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), seen })),
  );
}

describe('OpenRouter in sessions', () => {
  let root: string;
  let orbit: Orbit;
  let api: Awaited<ReturnType<typeof fakeOpenRouter>>;
  let calls: AgentRunRequest[];

  beforeEach(async () => {
    root = tempDir();
    api = await fakeOpenRouter();
    calls = [];
    const runtime: AgentRuntime = {
      id: 'claude-code-cli',
      displayName: 'Claude',
      kind: 'ai',
      resumable: true,
      checkAvailability: async () => ({ available: true, reason: null, sandbox: 'unknown', details: {} }),
      run: async (req) => {
        calls.push(req);
        return emptyResult({ status: 'succeeded', durationMs: 5, numTurns: 1, sessionId: `session-${calls.length}`, text: `answer ${calls.length}` });
      },
    };
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [runtime], secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux', env: { ...process.env, ORBIT_OPENROUTER_URL: api.url } });
    orbit.ctx.settings.update({ execution: { suggestNext: false, pastSessions: false } });
  });

  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    api.close();
    cleanup(root);
  });

  async function until(check: () => boolean, ms = 8000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('connects with a key OpenRouter accepts, keeps it secret, and describes the models', async () => {
    const before = await orbit.openrouter.status();
    expect(before).toMatchObject({ connected: false, keyHint: null });
    expect(before.models.map((m) => m.slug)).toEqual(['deepseek/deepseek-v4.1-flash-1017', 'nousresearch/hermes-4-405b']);
    expect(api.seen).toEqual([]); // nothing goes out before you connect

    await expect(orbit.openrouter.connect('sk-or-v1-this-key-is-wrong-0000000000')).rejects.toThrow('OpenRouter did not accept this key.');
    await expect(orbit.openrouter.connect('short')).rejects.toThrow('does not look like an OpenRouter API key');

    const s = await orbit.openrouter.connect(GOOD_KEY);
    expect(s).toMatchObject({ connected: true, keyHint: 'cdef', account: { label: 'orbit test', usageUsd: 1.25, limitUsd: 20 } });
    const [flash, hermes] = s.models;
    expect(flash).toMatchObject({ id: 'openrouter:deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017', tools: true, contextLength: 1048576, pricePerMillion: { input: 0.006, output: 0.5 }, missing: false });
    expect(hermes).toMatchObject({ slug: 'nousresearch/hermes-4-405b', tools: false, pricePerMillion: { input: 1, output: 3 } });
    // The key never shows in anything Orbit prints, and never in settings.
    expect(redactSecrets(`token ${GOOD_KEY}`)).not.toContain(GOOD_KEY);
    expect(JSON.stringify(orbit.ctx.settings.get())).not.toContain(GOOD_KEY);
    // The team status carries it for the model menus.
    expect((await orbit.team()).openrouter.connected).toBe(true);

    // Models are added by link or id, only when OpenRouter has them.
    await orbit.openrouter.addModel('https://openrouter.ai/google/gemini-2.5-pro');
    await expect(orbit.openrouter.addModel('acme/no-such-model')).rejects.toThrow('OpenRouter has no model "acme/no-such-model"');
    await expect(orbit.openrouter.addModel('hello')).rejects.toThrow('Paste a model link');
    expect(orbit.ctx.settings.get().openrouter.models).toContain('google/gemini-2.5-pro');
    await orbit.openrouter.removeModel('google/gemini-2.5-pro');
    expect(orbit.ctx.settings.get().openrouter.models).not.toContain('google/gemini-2.5-pro');

    expect(orbit.openrouter.disconnect().connected).toBe(false);
    expect((await orbit.openrouter.status()).connected).toBe(false);
  });

  it('is its own AI: its models, chat only when they cannot use tools, your instructions, and its own agent session', async () => {
    await orbit.openrouter.connect(GOOD_KEY);
    await orbit.openrouter.setInstructions('deepseek/deepseek-v4.1-flash-1017', 'Answer in Greek.\nKeep functions small.');
    const { repoPath } = await makeRepo(root, 'shop');
    const repo = await orbit.repos.register(repoPath);

    // OpenRouter without a model picked: its first model, DeepSeek, which can use tools.
    const s = orbit.chat.start({ message: 'Add a test', repoIds: [repo.id], mode: 'edit', provider: 'openrouter' });
    await until(() => !orbit.chat.isRunning(s.id));
    expect(calls[0]?.gateway).toEqual({ name: 'OpenRouter', baseUrl: api.url, token: GOOD_KEY, model: 'deepseek/deepseek-v4.1-flash-1017', tools: true });
    expect(calls[0]?.model).toBe('deepseek/deepseek-v4.1-flash-1017');
    expect(calls[0]?.access).toBe('workspace-write');
    expect(calls[0]?.systemAppend).not.toContain('you have no tools');
    // Your master prompt for DeepSeek is in its system prompt.
    expect(calls[0]?.systemAppend).toContain("## The developer's instructions for you (deepseek/deepseek-v4.1-flash-1017)");
    expect(calls[0]?.systemAppend).toContain('Answer in Greek.\nKeep functions small.');
    expect(orbit.chat.detail(s.id)).toMatchObject({ provider: 'openrouter' });
    expect(orbit.chat.detail(s.id).events.some((e) => e.title === 'Agent started (deepseek/deepseek-v4.1-flash-1017 via OpenRouter)')).toBe(true);

    // The next message continues DeepSeek's own session.
    orbit.chat.send(s.id, { message: 'and another' });
    await until(() => calls.length === 2 && !orbit.chat.isRunning(s.id));
    expect(calls[1]?.session?.resumeId).toBe('session-1');

    // Switching to Hermes (no tools): a fresh agent session with the conversation so far, no tools,
    // and not DeepSeek's instructions.
    orbit.chat.send(s.id, { message: 'what do you think?', model: 'openrouter:nousresearch/hermes-4-405b' });
    await until(() => calls.length === 3 && !orbit.chat.isRunning(s.id));
    expect(calls[2]?.gateway).toMatchObject({ model: 'nousresearch/hermes-4-405b', tools: false });
    expect(calls[2]?.session?.resumeId).toBeNull();
    expect(calls[2]?.prompt).toContain('Add a test');
    expect(calls[2]?.systemAppend).toContain('In this session you have no tools');
    expect(calls[2]?.systemAppend).not.toContain('Answer in Greek');

    // Claude as the AI: your Claude login, never an OpenRouter model, even one left in the session.
    orbit.chat.send(s.id, { message: 'thanks', provider: 'claude' });
    await until(() => calls.length === 4 && !orbit.chat.isRunning(s.id));
    expect(calls[3]?.gateway).toBeUndefined();
    expect(calls[3]?.model).not.toContain('openrouter');
    expect(calls[3]?.session?.resumeId).toBeNull();

    // Instructions: only for models you added, within the limit; empty text removes them.
    await expect(orbit.openrouter.setInstructions('acme/other', 'x')).rejects.toThrow('Add this model first');
    // Long master prompts are fine (they reach Claude Code in a file); the limit is 40,000 characters.
    await expect(orbit.openrouter.setInstructions('deepseek/deepseek-v4.1-flash-1017', 'x'.repeat(40_001))).rejects.toThrow('limited to 40,000 characters');
    const long = 'Rule. '.repeat(2500).trim();
    await orbit.openrouter.setInstructions('nousresearch/hermes-4-405b', long);
    expect((await orbit.openrouter.status()).models[1]?.instructions).toBe(long);
    await orbit.openrouter.setInstructions('nousresearch/hermes-4-405b', '');
    expect((await orbit.openrouter.status()).models[0]?.instructions).toBe('Answer in Greek.\nKeep functions small.');
    await orbit.openrouter.setInstructions('deepseek/deepseek-v4.1-flash-1017', '   ');
    expect((await orbit.openrouter.status()).models[0]?.instructions).toBe('');
    // Removing a model removes its instructions too.
    await orbit.openrouter.setInstructions('nousresearch/hermes-4-405b', 'Be brief.');
    await orbit.openrouter.removeModel('nousresearch/hermes-4-405b');
    expect(orbit.ctx.settings.get().openrouter.instructions).toEqual({});
  });

  it('says what to do when OpenRouter is not connected', async () => {
    const { repoPath } = await makeRepo(root, 'shop');
    const repo = await orbit.repos.register(repoPath);
    const s = orbit.chat.start({ message: 'hi', repoIds: [repo.id], mode: 'ask', provider: 'openrouter', model: 'openrouter:deepseek/deepseek-v4.1-flash-1017' });
    await until(() => !orbit.chat.isRunning(s.id));
    const answer = orbit.chat.detail(s.id).messages.find((m) => m.role === 'assistant');
    expect(answer?.status).toBe('failed');
    expect(answer?.error).toContain('OpenRouter is not connected');
    expect(calls).toHaveLength(0);
  });

  it('keeps an OpenRouter session independent of Claude: its answers, suggestions and Improve all run on OpenRouter', async () => {
    await orbit.openrouter.connect(GOOD_KEY);
    orbit.ctx.settings.update({ execution: { suggestNext: true } });
    const { repoPath } = await makeRepo(root, 'shop');
    const repo = await orbit.repos.register(repoPath);

    const s = orbit.chat.start({ message: 'Hello', repoIds: [repo.id], mode: 'edit', provider: 'openrouter' });
    // The answer, then the next-message suggestion.
    await until(() => calls.length >= 2 && !orbit.chat.isRunning(s.id));
    await until(() => !!orbit.chat.detail(s.id).nextPrompt);
    const [answer, suggestion] = calls;
    // The model knows who it is: Claude Code's own prompt would tell it that it is Claude.
    expect(answer?.systemAppend).toContain('you are DeepSeek V4.1 Flash 1017 (deepseek/deepseek-v4.1-flash-1017), a model served through OpenRouter');
    expect(answer?.systemAppend).toContain('not Claude, not Claude Code and not made by Anthropic');
    // The suggestion comes from the same OpenRouter model (no tools), never from Claude Haiku.
    expect(suggestion?.role).toBe('prompter');
    expect(suggestion?.gateway).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash-1017', tools: false, token: GOOD_KEY });
    expect(suggestion?.model).toBe('deepseek/deepseek-v4.1-flash-1017');
    // Every run of this session went through OpenRouter.
    expect(calls.every((c) => c.gateway?.name === 'OpenRouter')).toBe(true);

    // Improve, from an OpenRouter session, runs on its OpenRouter model as well.
    calls.length = 0;
    await orbit.prompter.improveText({ text: 'add tests', repoId: repo.id, gateway: { provider: 'openrouter', model: null } }).catch(() => undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.gateway).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash-1017', tools: true });
    // A model that cannot use tools cannot run Improve (it answers in a structured form): it says so.
    await expect(orbit.prompter.improveText({ text: 'add tests', repoId: repo.id, gateway: { provider: 'openrouter', model: 'openrouter:nousresearch/hermes-4-405b' } })).rejects.toThrow('Hermes 4 405B cannot use tools, so it cannot run Improve.');
    expect(calls).toHaveLength(1);
  });
});
