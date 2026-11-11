import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyResult, type AgentRunRequest, type AgentRuntime } from '@orbit/agents';
import { redactSecrets } from '@orbit/shared';
import { cheapestFit, createOrbit, endpointName, MemorySecretStore, needsGb, quantOf, silentLogger, suggestFile, type Orbit } from '../src';
import { cleanup, makeRepo, tempDir } from './helpers';

/*
  Your own models on rented GPUs (Hugging Face Inference Endpoints). A stand-in answers like
  the Hugging Face Hub and the Inference Endpoints API; the session agent records what it ran.
*/

const TOKEN = 'hf_abcdefghijklmnopqrstuvwxyz0123';
const REPO = 'example-org/Coder-27B-GGUF';
const GB = 1e9;

interface Ep {
  name: string;
  state: string;
  model: { repository: string; framework: string; image: { llamacpp: { modelPath: string } } };
  compute: { instanceType: string; instanceSize: string; scaling: { minReplica: number; scaleToZeroTimeout: number } };
  provider: { vendor: string; region: string };
  tags: string[];
}

function fakeHuggingFace() {
  const seen: { method: string; url: string; auth: boolean; body: unknown }[] = [];
  const endpoints = new Map<string, Ep>();
  let payment = true;
  let resumeFailure: { status: number; message: string } | null = null;
  let base = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = req.url ?? '';
      seen.push({ method: req.method ?? '', url, auth: req.headers.authorization === `Bearer ${TOKEN}`, body });
      const send = (code: number, value: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const view = (e: Ep) => ({ ...e, status: { state: e.state, message: e.state === 'failed' ? 'CUDA out of memory' : `Endpoint is ${e.state}`, url: `${base}/ep/${e.name}`, readyReplica: e.state === 'running' ? 1 : 0, lastUsedAt: null } });
      // The Hub
      if (url === '/hub/api/whoami-v2') return req.headers.authorization === `Bearer ${TOKEN}` ? send(200, { name: 'demo-user', auth: { accessToken: { role: 'write' } } }) : send(401, { error: 'Invalid credentials' });
      if (url === `/hub/api/models/${REPO}`) return send(200, { gated: false, tags: ['gguf', 'license:apache-2.0'], gguf: { chat_template: '{% if tools %}…{% endif %}' } });
      if (url === `/hub/api/models/${REPO}/tree/main?recursive=true`) {
        return send(200, [
          { type: 'file', path: 'README.md', size: 1000 },
          { type: 'file', path: 'Model-IQ3_M.gguf', lfs: { size: 14.1 * GB } },
          { type: 'file', path: 'Model-Q4_K_M.gguf', lfs: { size: 18 * GB } },
          { type: 'file', path: 'Model-MTP-Q4_K_M.gguf', lfs: { size: 18.5 * GB } },
          { type: 'file', path: 'Model-Q8_0.gguf', lfs: { size: 29.8 * GB } },
          { type: 'file', path: 'mmproj-F16.gguf', lfs: { size: 0.9 * GB } },
        ]);
      }
      if (url.startsWith('/hub/api/models/')) return send(404, { error: 'Repository not found' });
      // Inference Endpoints
      if (url === '/api/v2/provider') {
        const gpu = (id: string, type: string, mem: number, price: number, status = 'available') => ({ id, accelerator: 'gpu', numAccelerators: 1, gpuMemoryGb: mem, instanceType: type, instanceSize: 'x1', architecture: `Nvidia ${type.split('-')[1]!.toUpperCase()} x 1`, pricePerHour: price, status });
        return send(200, {
          vendors: [
            { name: 'aws', regions: [{ name: 'us-east-1', label: 'N. Virginia', status: 'available', computes: [gpu('aws-us-east-1-nvidia-l4-x1', 'nvidia-l4', 24, 0.8), gpu('aws-us-east-1-nvidia-l40s-x1', 'nvidia-l40s', 48, 1.8), gpu('aws-us-east-1-nvidia-a100-x1', 'nvidia-a100', 80, 2.5, 'not_available'), { id: 'cpu', accelerator: 'cpu', instanceType: 'intel', instanceSize: 'x1', pricePerHour: 0.03, status: 'available' }] }] },
          ],
        });
      }
      const m = /^\/api\/v2\/endpoint\/demo-user(?:\/([a-z0-9-]+)(\/(?:pause|resume))?)?$/.exec(url);
      if (m) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'no' });
        const [, name, action] = m;
        if (!name && req.method === 'GET') return send(200, { items: [...endpoints.values()].map(view), totalItems: endpoints.size });
        if (!name && req.method === 'POST') {
          if (!payment) return send(402, { error: 'Payment method required' });
          const b = body as Ep;
          endpoints.set(b.name, { ...b, state: 'initializing' });
          return send(200, view(endpoints.get(b.name)!));
        }
        const e = name ? endpoints.get(name) : undefined;
        if (!e) return send(404, { error: 'not found' });
        if (action === '/pause') e.state = 'paused';
        else if (action === '/resume') {
          if (resumeFailure) return send(resumeFailure.status, { error: resumeFailure.message });
          e.state = 'initializing';
        }
        else if (req.method === 'DELETE') {
          endpoints.delete(e.name);
          return send(200, {});
        } else if (req.method === 'GET' && e.state === 'initializing') {
          // Starting takes one more look.
          const v = view(e);
          e.state = 'running';
          return send(200, v);
        }
        return send(200, view(e));
      }
      // The endpoint itself: a request wakes it from sleep.
      const ep = /^\/ep\/([a-z0-9-]+)\/health$/.exec(url);
      if (ep) {
        const e = endpoints.get(ep[1]!);
        if (e?.state === 'scaledToZero') e.state = 'initializing';
        return send(503, { error: 'starting' });
      }
      send(404, {});
    });
  });
  return new Promise<{ url: string; close: () => void; seen: typeof seen; endpoints: typeof endpoints; noPayment: () => void; failResume: (status: number, message: string) => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ url: base, close: () => server.close(), seen, endpoints, noPayment: () => (payment = false), failResume: (status, message) => { resumeFailure = { status, message }; } });
    }),
  );
}

describe('Hugging Face endpoints', () => {
  let root: string;
  let orbit: Orbit;
  let hf: Awaited<ReturnType<typeof fakeHuggingFace>>;
  let calls: AgentRunRequest[];

  beforeEach(async () => {
    root = tempDir();
    hf = await fakeHuggingFace();
    calls = [];
    const runtime: AgentRuntime = {
      id: 'claude-code-cli',
      displayName: 'Claude',
      kind: 'ai',
      resumable: true,
      checkAvailability: async () => ({ available: true, reason: null, sandbox: 'unknown', details: { version: '2.1.322' } }),
      run: async (req) => {
        calls.push(req);
        return emptyResult({ status: 'succeeded', durationMs: 5, numTurns: 1, sessionId: `session-${calls.length}`, text: `answer ${calls.length}` });
      },
    };
    const env = { ...process.env, ORBIT_HF_HUB_URL: `${hf.url}/hub`, ORBIT_HF_ENDPOINTS_URL: `${hf.url}/api`, ORBIT_HF_POLL_MS: '20' };
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [runtime], secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux', env });
    orbit.ctx.settings.update({ execution: { suggestNext: false, pastSessions: false } });
  });

  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    hf.close();
    cleanup(root);
  });

  async function until(check: () => boolean, ms = 8000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('reads a pasted model link: its files, the GPUs that fit each one, and their prices, without a token', async () => {
    const p = await orbit.huggingface.plan(`https://endpoints.huggingface.co/new/${REPO}`);
    expect(p).toMatchObject({ repository: REPO, tools: true, license: 'apache-2.0', gated: false });
    // GGUF files only (no README, no vision projector), smallest first.
    expect(p.files.map((f) => f.quant)).toEqual(['IQ3_M', 'Q4_K_M', 'Q4_K_M', 'Q8_0']);
    // Q4_K_M without the MTP extras is the usual balance; 18 GB needs a 48 GB GPU with a 64k context.
    expect(p.suggested).toEqual({ file: 'Model-Q4_K_M.gguf', hardwareId: 'aws-us-east-1-nvidia-l40s-x1' });
    // GPUs only, ones you can rent, cheapest first.
    expect(p.hardware.map((h) => [h.label, h.gpuMemoryGb, h.pricePerHour, h.available])).toEqual([
      ['Nvidia L4 x 1', 24, 0.8, true],
      ['Nvidia L40S x 1', 48, 1.8, true],
      ['Nvidia A100 x 1', 80, 2.5, false],
    ]);
    expect(p.name).toMatch(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/);
    expect(hf.seen.every((s) => !s.auth)).toBe(true); // nothing needed a token

    await expect(orbit.huggingface.plan('https://huggingface.co/acme/missing')).rejects.toThrow('Hugging Face has no model "acme/missing"');
    await expect(orbit.huggingface.plan('not a link')).rejects.toThrow('Paste a Hugging Face model link');
  });

  it('picks files and GPUs on the safe side', () => {
    expect(quantOf('x/Model-MAX-MTP-IQ4_XS.gguf')).toBe('IQ4_XS');
    expect(quantOf('m-Q5_K_M.gguf')).toBe('Q5_K_M');
    expect(needsGb(18)).toBe(24.8);
    const hw = [
      { id: 'a', vendor: 'aws', region: 'r', regionLabel: 'R', instanceType: 'l4', instanceSize: 'x1', label: 'L4', gpuMemoryGb: 24, pricePerHour: 0.8, available: true },
      { id: 'b', vendor: 'aws', region: 'r', regionLabel: 'R', instanceType: 'l40s', instanceSize: 'x1', label: 'L40S', gpuMemoryGb: 48, pricePerHour: 1.8, available: true },
    ];
    expect(cheapestFit(hw, needsGb(14.1))?.id).toBe('a');
    expect(cheapestFit(hw, needsGb(18))?.id).toBe('b');
    expect(cheapestFit(hw, needsGb(60))).toBeNull();
    expect(suggestFile([{ path: 'A-MTP-Q4_K_M.gguf', sizeGb: 18.5, quant: 'Q4_K_M', needsGb: 25 }, { path: 'A-Q4_K_M.gguf', sizeGb: 18, quant: 'Q4_K_M', needsGb: 24.8 }]).path).toBe('A-Q4_K_M.gguf');
    expect(endpointName('example-org/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735')).toMatch(/^qwen3-8-27b-turbo-fable-col-[a-z0-9]{4}$/);
  });

  it('connects a token, creates a private llama.cpp endpoint that sleeps, and pauses, resumes and deletes it', async () => {
    await expect(orbit.huggingface.connect('hf_wrongwrongwrongwrongwrong1')).rejects.toThrow('Hugging Face did not accept this token.');
    await expect(orbit.huggingface.connect('nope')).rejects.toThrow('does not look like a Hugging Face token');
    const s = await orbit.huggingface.connect(TOKEN);
    expect(s).toMatchObject({ connected: true, account: 'demo-user', canManage: true, endpoints: [] });
    expect(redactSecrets(`token ${TOKEN}`)).not.toContain(TOKEN);
    expect(JSON.stringify(orbit.ctx.settings.get())).not.toContain(TOKEN);

    const created = await orbit.huggingface.create({ repository: `https://huggingface.co/${REPO}`, file: 'Model-Q4_K_M.gguf', hardwareId: 'aws-us-east-1-nvidia-l40s-x1', name: 'qwen-coder' });
    const sent = hf.seen.find((x) => x.method === 'POST' && x.url === '/api/v2/endpoint/demo-user')!;
    expect(sent.auth).toBe(true);
    expect(sent.body).toEqual({
      name: 'qwen-coder',
      type: 'authenticated',
      provider: { vendor: 'aws', region: 'us-east-1' },
      compute: { accelerator: 'gpu', instanceType: 'nvidia-l40s', instanceSize: 'x1', scaling: { minReplica: 0, maxReplica: 1, scaleToZeroTimeout: 15 } },
      model: {
        repository: REPO,
        framework: 'llamacpp',
        task: 'text-generation',
        image: { llamacpp: { url: 'ghcr.io/ggml-org/llama.cpp:server-cuda', modelPath: 'Model-Q4_K_M.gguf' } },
        args: ['--ctx-size', '65536', '--parallel', '1', '--jinja'],
        env: {},
      },
      tags: ['orbit'],
    });
    expect(created.endpoints[0]).toMatchObject({ id: 'hf:qwen-coder', name: 'qwen-coder', repository: REPO, file: 'Model-Q4_K_M.gguf', usable: true, createdByOrbit: true, sleepAfterMinutes: 15, hardware: { label: 'Nvidia L40S x 1', gpuMemoryGb: 48, pricePerHour: 1.8 } });

    // Its own name rules, and only GPUs Hugging Face offers.
    await expect(orbit.huggingface.create({ repository: REPO, file: 'Model-Q4_K_M.gguf', hardwareId: 'aws-us-east-1-nvidia-l40s-x1', name: 'Bad Name!' })).rejects.toThrow('lowercase letters');
    await expect(orbit.huggingface.create({ repository: REPO, file: 'Model-Q4_K_M.gguf', hardwareId: 'made-up' })).rejects.toThrow('not offered by Hugging Face');

    expect((await orbit.huggingface.pause('qwen-coder')).endpoints[0]?.state).toBe('paused');
    await orbit.huggingface.resume('qwen-coder');
    expect(hf.seen.some((x) => x.url === '/api/v2/endpoint/demo-user/qwen-coder/resume')).toBe(true);
    expect((await orbit.huggingface.remove('qwen-coder')).endpoints).toEqual([]);

    // No payment method on the account: says what to do.
    hf.noPayment();
    await expect(orbit.huggingface.create({ repository: REPO, file: 'Model-Q4_K_M.gguf', hardwareId: 'aws-us-east-1-nvidia-l40s-x1', name: 'another' })).rejects.toThrow('Hugging Face needs a payment method');
  });

  it.each([402, 403])('reports a billing failure on resume as payment required, including HTTP %s', async (status) => {
    await orbit.huggingface.connect(TOKEN);
    await orbit.huggingface.create({ repository: REPO, file: 'Model-Q4_K_M.gguf', hardwareId: 'aws-us-east-1-nvidia-l40s-x1', name: 'qwen-coder' });
    await orbit.huggingface.pause('qwen-coder');
    hf.failResume(status, 'Forbidden: Payment method required for namespace: demo-user');
    await expect(orbit.huggingface.resume('qwen-coder')).rejects.toMatchObject({ code: 'PRECONDITION', message: 'Hugging Face needs a payment method before it can resume qwen-coder.', hint: expect.stringContaining('huggingface.co/settings/billing') });
    expect(hf.endpoints.get('qwen-coder')?.state).toBe('paused');
  });

  it('keeps actual permission failures distinct and includes the provider explanation', async () => {
    await orbit.huggingface.connect(TOKEN);
    await orbit.huggingface.create({ repository: REPO, file: 'Model-Q4_K_M.gguf', hardwareId: 'aws-us-east-1-nvidia-l40s-x1', name: 'qwen-coder' });
    hf.failResume(403, 'Missing inference.endpoints.write permission');
    await expect(orbit.huggingface.resume('qwen-coder')).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('Missing inference.endpoints.write permission') });
  });

  it('runs a session on your endpoint: wakes it when asleep, with your token and instructions, never Claude', async () => {
    await orbit.huggingface.connect(TOKEN);
    await orbit.huggingface.create({ repository: REPO, file: 'Model-Q4_K_M.gguf', hardwareId: 'aws-us-east-1-nvidia-l40s-x1', name: 'qwen-coder' });
    await orbit.huggingface.setInstructions('qwen-coder', 'Answer in Greek.');
    hf.endpoints.get('qwen-coder')!.state = 'scaledToZero';
    expect((await orbit.team()).huggingface.endpoints[0]?.state).toBe('scaledToZero');

    const { repoPath } = await makeRepo(root, 'shop');
    const repo = await orbit.repos.register(repoPath);
    // No model picked: your first endpoint.
    const s = orbit.chat.start({ message: 'Add a test', repoIds: [repo.id], mode: 'edit', provider: 'huggingface' });
    await until(() => !orbit.chat.isRunning(s.id));
    const d = orbit.chat.detail(s.id);
    expect(d.messages[1]?.status).toBe('done');
    // It slept, so Orbit woke it with a request and said so.
    expect(hf.seen.some((x) => x.url === '/ep/qwen-coder/health' && x.auth)).toBe(true);
    expect(d.events.some((e) => e.title.startsWith('Waking your Hugging Face endpoint qwen-coder (Nvidia L40S x 1, $1.8/hour while awake)'))).toBe(true);
    expect(d.events.some((e) => e.title === 'Your Hugging Face endpoint qwen-coder is ready.')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.gateway).toEqual({ name: 'Hugging Face', baseUrl: `${hf.url}/ep/qwen-coder`, token: TOKEN, model: REPO, tools: true, compatibility: 'llamacpp' });
    expect(calls[0]?.model).toBe(REPO);
    expect(calls[0]?.systemAppend).toContain('running on the developer’s own Hugging Face Inference Endpoint');
    expect(calls[0]?.systemAppend).toContain('not Claude, not Claude Code and not made by Anthropic');
    expect(calls[0]?.systemAppend).toContain('Answer in Greek.');
    expect(d).toMatchObject({ provider: 'huggingface', agentRuntime: 'claude-code-cli:hf:qwen-coder' });
  });

  it('says why when the endpoint cannot run', async () => {
    const { repoPath } = await makeRepo(root, 'shop');
    const repo = await orbit.repos.register(repoPath);
    // Not connected.
    const a = orbit.chat.start({ message: 'hi', repoIds: [repo.id], mode: 'ask', provider: 'huggingface' });
    await until(() => !orbit.chat.isRunning(a.id));
    expect(orbit.chat.detail(a.id).messages[1]?.error).toContain('Hugging Face is not connected');

    await orbit.huggingface.connect(TOKEN);
    // Connected, but no endpoint yet.
    const b = orbit.chat.start({ message: 'hi', repoIds: [repo.id], mode: 'ask', provider: 'huggingface' });
    await until(() => !orbit.chat.isRunning(b.id));
    expect(orbit.chat.detail(b.id).messages[1]?.error).toContain('no Hugging Face endpoint to use yet');

    // Failed (out of memory): its own message and what to do.
    await orbit.huggingface.create({ repository: REPO, file: 'Model-Q8_0.gguf', hardwareId: 'aws-us-east-1-nvidia-l4-x1', name: 'too-big' });
    hf.endpoints.get('too-big')!.state = 'failed';
    const c = orbit.chat.start({ message: 'hi', repoIds: [repo.id], mode: 'ask', provider: 'huggingface', model: 'hf:too-big' });
    await until(() => !orbit.chat.isRunning(c.id));
    expect(orbit.chat.detail(c.id).messages[1]?.error).toContain('The Hugging Face endpoint too-big failed: CUDA out of memory');
    expect(calls).toHaveLength(0);
  });
});
