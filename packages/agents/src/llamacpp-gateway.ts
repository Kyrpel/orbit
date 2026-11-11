import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AgentGateway } from './runtime';

/**
 * Claude Code puts agent/skill reminders in system turns inside messages[]. Qwen's
 * template only accepts a single leading system turn. Keep every instruction, in
 * order, in Anthropic's top-level system field; leave user/tool/image blocks alone.
 */
export function normalizeLlamaSystem(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  const isSystem = (m: unknown): m is Record<string, unknown> => !!m && typeof m === 'object' && (m as Record<string, unknown>).role === 'system';
  if (!body.messages.some(isSystem)) return body;
  const blocks = (value: unknown): unknown[] => typeof value === 'string' ? [{ type: 'text', text: value }] : Array.isArray(value) ? value : [];
  return {
    ...body,
    system: [...blocks(body.system), ...body.messages.filter(isSystem).flatMap((m) => blocks(m.content))],
    messages: body.messages.filter((m) => !isSystem(m)),
  };
}

/** A per-run, authenticated loopback adapter with one fixed upstream endpoint. */
export async function startLlamaGateway(upstream: AgentGateway, signal: AbortSignal): Promise<{ gateway: AgentGateway; close(): Promise<void> }> {
  signal.throwIfAborted();
  const token = randomBytes(32).toString('base64url');
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  signal.addEventListener('abort', abort, { once: true });
  const server = http.createServer(async (req, res) => {
    const fail = (status: number, message: string) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
    };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return fail(401, 'Invalid gateway token.');
    if (req.headers.origin) return fail(403, 'Browser requests are not supported.');
    const route = req.url ?? '';
    if (req.method !== 'POST' || !/^\/v1\/messages(?:\/count_tokens)?(?:\?[^#]*)?$/.test(route)) return fail(404, 'Unknown gateway route.');
    const disconnected = new AbortController();
    const disconnect = () => disconnected.abort();
    res.on('close', disconnect);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) return fail(413, 'Model request is too large.');
        chunks.push(chunk);
      }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(400, 'Expected a JSON object.');
        body = parsed as Record<string, unknown>;
      } catch {
        return fail(400, 'Invalid JSON.');
      }
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${upstream.token}` };
      for (const key of ['anthropic-version', 'anthropic-beta', 'accept']) {
        const value = req.headers[key];
        if (typeof value === 'string') headers[key] = value;
      }
      const response = await fetch(`${upstream.baseUrl.replace(/\/+$/, '')}${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(normalizeLlamaSystem(body)),
        signal: AbortSignal.any([lifetime.signal, disconnected.signal]),
        // Do not forward this endpoint's credential to a redirected destination.
        redirect: 'error',
      });
      res.statusCode = response.status;
      for (const key of ['content-type', 'cache-control', 'retry-after', 'request-id']) {
        const value = response.headers.get(key);
        if (value) res.setHeader(key, value);
      }
      if (response.body) await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
      else res.end();
    } catch {
      if (!res.destroyed) fail(502, lifetime.signal.aborted ? 'Model request stopped.' : 'Could not reach the model endpoint.');
    } finally {
      res.off('close', disconnect);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    signal.removeEventListener('abort', abort);
    throw err;
  }
  return {
    gateway: { ...upstream, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token },
    async close() {
      signal.removeEventListener('abort', abort);
      lifetime.abort();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
