import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeLlamaSystem, startLlamaGateway } from '../src/llamacpp-gateway';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function endpoint(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function adapter(url: string, signal = new AbortController().signal) {
  const proxy = await startLlamaGateway({ name: 'Hugging Face', baseUrl: url, token: 'upstream-secret', model: 'qwen', tools: true, compatibility: 'llamacpp' }, signal);
  cleanup.push(() => proxy.close());
  return {
    ...proxy,
    send: (body: unknown, route = '/v1/messages?beta=true') => fetch(proxy.gateway.baseUrl + route, {
      method: 'POST', headers: { authorization: `Bearer ${proxy.gateway.token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body),
    }),
  };
}

describe('llama.cpp gateway compatibility', () => {
  it('keeps all system instructions and leaves images, tool calls and tool results intact', () => {
    const conversation = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'image' } }, { type: 'text', text: 'inspect' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'README.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'File contents: role system is just data.' }] },
    ];
    const body = { system: [{ type: 'text', text: 'original', cache_control: { type: 'ephemeral' } }], messages: [conversation[0], { role: 'system', content: 'available skills' }, conversation[1], { role: 'system', content: [{ type: 'text', text: 'available agents' }] }, conversation[2]], tools: [{ name: 'Read' }], stream: true };
    expect(normalizeLlamaSystem(body)).toEqual({ ...body, system: [...body.system, { type: 'text', text: 'available skills' }, { type: 'text', text: 'available agents' }], messages: conversation });
    expect(body.messages).toHaveLength(5); // never mutate the CLI's request
    expect(normalizeLlamaSystem({ system: 'first', messages: [{ role: 'system', content: 'second' }, conversation[0]] }).system).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]);
    expect(normalizeLlamaSystem({ messages: [{ role: 'system', content: 'only' }, conversation[0]] }).system).toEqual([{ type: 'text', text: 'only' }]);
    const alreadyValid = { system: 'first', messages: conversation };
    expect(normalizeLlamaSystem(alreadyValid)).toBe(alreadyValid);
  });

  it('fixes the failing request and relays streaming tool events without buffering the whole response', async () => {
    let release: () => void = () => undefined;
    const first = 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"read-1","name":"Read","input":{}}}\n\n';
    const last = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const upstream = await endpoint(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (body.messages.some((m: { role: string }) => m.role === 'system')) { res.writeHead(500); res.end('System message must be at the beginning.'); return; }
      expect(body.system.map((b: { text: string }) => b.text)).toEqual(['instructions', 'skills']);
      expect(req.url).toBe('/model/v1/messages?beta=true');
      expect(req.headers.authorization).toBe('Bearer upstream-secret');
      expect(req.headers['anthropic-version']).toBe('2023-06-01');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(first);
      await new Promise<void>((resolve) => { release = resolve; });
      res.end(last);
    });
    const proxy = await adapter(upstream + '/model/');
    const result = await proxy.send({ system: 'instructions', messages: [{ role: 'user', content: 'read' }, { role: 'system', content: 'skills' }], stream: true });
    expect(result.status).toBe(200);
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(first);
    release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(last);
    expect((await reader.read()).done).toBe(true);
  });

  it('only accepts authenticated model requests and does not follow redirects with credentials', async () => {
    let calls = 0;
    const upstream = await endpoint((_req, res) => { calls++; res.writeHead(307, { location: '/elsewhere' }); res.end(); });
    const proxy = await adapter(upstream);
    expect((await fetch(proxy.gateway.baseUrl + '/v1/messages', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await proxy.send({}, '/admin')).status).toBe(404);
    expect((await proxy.send(null)).status).toBe(400);
    expect(calls).toBe(0);
    expect((await proxy.send({ messages: [] })).status).toBe(502);
    expect(calls).toBe(1);
  });

  it('preserves upstream errors and token-count requests', async () => {
    const upstream = await endpoint((req, res) => { expect(req.url).toBe('/v1/messages/count_tokens'); res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' }); res.end('{"error":{"message":"busy"}}'); });
    const proxy = await adapter(upstream);
    const res = await proxy.send({ messages: [] }, '/v1/messages/count_tokens');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toEqual({ error: { message: 'busy' } });
  });

  it('cancels an in-flight inference when the agent stops', async () => {
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const upstream = await endpoint((_req, _res) => started());
    const controller = new AbortController();
    const proxy = await adapter(upstream, controller.signal);
    const pending = proxy.send({ messages: [] });
    await ready;
    controller.abort();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Model request stopped.');
  });
});
