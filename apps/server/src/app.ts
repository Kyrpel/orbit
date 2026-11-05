import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { Orbit } from '@orbit/core';
import {
  ENTRY_POINTS,
  errorMessage,
  MISSION_STATES,
  ORBIT_VERSION,
  OrbitError,
  redactSecrets,
  SettingsPatchSchema,
  type Actor,
  type EntryPoint,
  type MissionState,
  type ServerEvent,
  type SettingsPatch,
} from '@orbit/shared';
import { isAllowedHost, isAllowedOrigin, parseCookies, SESSION_COOKIE, tokensMatch } from './auth';

export interface AppOptions {
  token: string;
  /** Extra hostnames allowed in Host/Origin headers (ORBIT_ALLOWED_HOSTS). */
  allowedHosts?: string[];
  webDist?: string | null;
  logger?: boolean;
}

const CommandSpecSchema = z.object({
  id: z.string().default(''),
  label: z.string().default(''),
  command: z.string().min(1),
  timeoutSec: z.number().int().min(10).max(7200).default(600),
  enabled: z.boolean().default(true),
  source: z.enum(['detected', 'user']).default('user'),
});

const schemas = {
  addRepo: z.object({ path: z.string().min(1), name: z.string().optional(), allowModify: z.boolean().optional() }),
  scan: z.object({ root: z.string().min(1) }),
  clone: z.object({ nameWithOwner: z.string().min(3) }),
  patchRepo: z.object({
    name: z.string().optional(),
    allowModify: z.boolean().optional(),
    defaultBranch: z.string().optional(),
    setupCommands: z.array(CommandSpecSchema).optional(),
    verifyCommands: z.array(CommandSpecSchema).optional(),
  }),
  asana: z.object({ token: z.string().min(16) }),
  authorizeUser: z.object({ externalUserId: z.string().min(1), displayName: z.string().nullish(), email: z.string().nullish() }),
  connectProject: z.object({ integrationId: z.string(), externalProjectId: z.string(), repoIds: z.array(z.string()).default([]) }),
  patchProject: z.object({ repoIds: z.array(z.string()).optional(), triggersEnabled: z.boolean().optional() }),
  runTasks: z.object({ taskIds: z.array(z.string()).min(1).max(20) }),
  createMission: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    repoIds: z.array(z.string()).optional(),
    source: z.object({ integrationId: z.string(), taskId: z.string(), projectId: z.string().nullish() }).optional(),
    extraInstructions: z.string().max(4000).nullish(),
    referenceRepoIds: z.array(z.string()).max(10).optional(),
  }),
  approveScope: z.object({ repoIds: z.array(z.string()).optional(), notes: z.string().max(4000).nullish(), referenceRepoIds: z.array(z.string()).max(10).optional() }),
  replan: z.object({ refreshSource: z.boolean().optional() }),
  requestChanges: z.object({ notes: z.string().min(1).max(8000) }),
  publish: z.object({ missionRepoId: z.string(), title: z.string().max(250).optional(), body: z.string().max(60_000).optional(), draft: z.boolean().optional() }),
  cancel: z.object({ reason: z.string().max(2000).nullish() }),
  consent: z.object({ grant: z.boolean() }),
  chat: z.object({
    message: z.string().min(1).max(20_000),
    repoIds: z.array(z.string()).max(50).optional(),
    mode: z.enum(['edit', 'ask']).optional(),
    provider: z.enum(['auto', 'claude', 'codex']).optional(),
    permissionMode: z.enum(['ask', 'auto']).optional(),
  }),
  patchChat: z.object({
    provider: z.enum(['auto', 'claude', 'codex']).optional(),
    mode: z.enum(['edit', 'ask']).optional(),
    title: z.string().max(200).optional(),
    permissionMode: z.enum(['ask', 'auto']).optional(),
  }),
  allowCommand: z.object({ command: z.string().min(1).max(4000) }),
  commit: z.object({ message: z.string().min(1).max(5000) }),
  applyTask: z.object({ title: z.string().min(1).max(500), description: z.string().max(60_000) }),
  improveText: z.object({ text: z.string().min(1).max(20_000), repoId: z.string().nullish() }),
};

function body<T extends z.ZodType>(schema: T, req: FastifyRequest): z.infer<T> {
  return schema.parse(req.body ?? {});
}

function clientEntryPoint(req: FastifyRequest): EntryPoint {
  const h = String(req.headers['x-orbit-client'] ?? '').toLowerCase();
  return (ENTRY_POINTS as readonly string[]).includes(h) ? (h as EntryPoint) : 'dashboard';
}

function localActor(req: FastifyRequest): Actor {
  let name = 'you';
  try {
    name = os.userInfo().username || 'you';
  } catch {
    /* ignore */
  }
  return { type: 'user', name, provider: clientEntryPoint(req) };
}

export function resolveWebDist(explicit?: string | null): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, process.env.ORBIT_WEB_DIST, path.resolve(here, 'web'), path.resolve(here, '../web'), path.resolve(here, '../../web/dist')].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(path.join(c, 'index.html'))) ?? null;
}

const SIGN_IN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Orbit</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e9e5dc;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:32rem;padding:2rem}code{background:#1a1f2b;padding:.2rem .4rem;border-radius:.3rem}</style></head>
<body><main><h1>Orbit</h1><p>The dashboard is not built in this checkout.</p><p>Run <code>pnpm build</code>, or use <code>pnpm dev</code> for development.</p></main></body></html>`;

export async function buildApp(orbit: Orbit, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { level: 'warn' } : false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  const allowed = opts.allowedHosts ?? [];

  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host, allowed)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Host not allowed. Orbit only answers on localhost.' } });
    }
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !isAllowedOrigin(req.headers.origin as string | undefined, allowed)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Cross-origin requests are not allowed.' } });
    }
    const url = req.url.split('?')[0] ?? '';
    if (url.startsWith('/api/') && url !== '/api/health') {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!tokensMatch(opts.token, bearer) && !tokensMatch(opts.token, cookie)) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Sign in by opening the link printed by `orbit start` (or run `orbit open`).' } });
      }
    }
    return undefined;
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof OrbitError) {
      return reply.code(err.status).send({ error: { code: err.code, message: redactSecrets(err.message), ...(err.hint ? { hint: err.hint } : {}), ...(err.details !== undefined ? { details: err.details } : {}) } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: { code: 'VALIDATION', message: errorMessage(err) } });
    orbit.ctx.log.error('request failed', errorMessage(err));
    return reply.code(500).send({ error: { code: 'INTERNAL', message: redactSecrets(errorMessage(err)) } });
  });

  // --- session ---------------------------------------------------------------
  app.get('/auth', async (req, reply) => {
    const q = req.query as { token?: string; next?: string };
    if (!tokensMatch(opts.token, q.token)) return reply.code(401).type('text/html').send('<p>That sign-in link is not valid. Run <code>orbit open</code> for a fresh one.</p>');
    const next = typeof q.next === 'string' && q.next.startsWith('/') && !q.next.startsWith('//') ? q.next : '/';
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    return reply.redirect(next);
  });
  app.get('/api/health', async () => ({ ok: true, version: ORBIT_VERSION }));
  app.get('/api/session', async () => ({ ok: true, version: ORBIT_VERSION, dashboardUrl: orbit.ctx.dashboardUrl(), home: orbit.ctx.paths.home }));

  // --- system ----------------------------------------------------------------
  app.get('/api/doctor', async () => orbit.doctor());
  app.get('/api/overview', async () => orbit.overview.overview());
  app.get('/api/agents', async () => orbit.overview.agents());
  app.get('/api/team', async () => orbit.team());

  // Ask: conversations with the Assistant.
  app.get('/api/chats', async () => orbit.chat.list());
  app.post('/api/chats', async (req, reply) => reply.code(201).send(orbit.chat.start(body(schemas.chat, req))));
  app.get('/api/chats/:id', async (req) => orbit.chat.detail((req.params as { id: string }).id));
  app.post('/api/chats/:id/messages', async (req) => orbit.chat.send((req.params as { id: string }).id, body(schemas.chat, req)));
  app.patch('/api/chats/:id', async (req) => orbit.chat.update((req.params as { id: string }).id, body(schemas.patchChat, req)));
  app.post('/api/chats/:id/allow', async (req) => orbit.chat.allow((req.params as { id: string }).id, body(schemas.allowCommand, req).command));
  app.post('/api/chats/:id/allow-all', async (req) => orbit.chat.allowAll((req.params as { id: string }).id));

  // Workspace: a project's uncommitted changes, and committing them.
  app.get('/api/repos/:id/changes', async (req) => orbit.changes((req.params as { id: string }).id));
  app.post('/api/repos/:id/commit', async (req) => orbit.commit((req.params as { id: string }).id, body(schemas.commit, req).message));
  app.post('/api/repos/:id/security-check', async (req, reply) => reply.code(201).send(await orbit.chat.securityCheck((req.params as { id: string }).id)));

  // Prompt engineer: rewrite rough tasks (or a request in the workspace) into clear ones.
  app.post('/api/projects/:id/tasks/:taskId/improve', async (req) => {
    const p = req.params as { id: string; taskId: string };
    return orbit.prompter.improveTask(p.id, p.taskId);
  });
  app.post('/api/projects/:id/tasks/:taskId/apply', async (req) => {
    const p = req.params as { id: string; taskId: string };
    return orbit.prompter.applyTask(p.id, p.taskId, body(schemas.applyTask, req));
  });
  app.post('/api/prompts/improve', async (req) => {
    const b = body(schemas.improveText, req);
    return orbit.prompter.improveText({ text: b.text, repoId: b.repoId ?? null });
  });
  app.post('/api/chats/:id/cancel', async (req, reply) => {
    orbit.chat.cancel((req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.delete('/api/chats/:id', async (req, reply) => {
    orbit.chat.remove((req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.get('/api/activity', async (req) => orbit.overview.activity(Number((req.query as { limit?: string }).limit) || 100));
  app.get('/api/triggers', async () => orbit.triggers.recent(50));
  app.get('/api/settings', async () => orbit.ctx.settings.get());
  app.patch('/api/settings', async (req) => orbit.ctx.settings.update(SettingsPatchSchema.parse(req.body ?? {}) as SettingsPatch));
  app.post('/api/consent', async (req) => {
    const { grant } = body(schemas.consent, req);
    return orbit.ctx.settings.update({ execution: { localExecutionConsentAt: grant ? new Date().toISOString() : null } });
  });

  // --- repositories ----------------------------------------------------------
  app.get('/api/repos', async () => orbit.repos.list());
  app.post('/api/repos', async (req) => {
    const b = body(schemas.addRepo, req);
    return orbit.repos.register(b.path, { ...(b.name ? { name: b.name } : {}), ...(b.allowModify !== undefined ? { allowModify: b.allowModify } : {}) });
  });
  app.post('/api/repos/scan', async (req) => orbit.repos.scan(body(schemas.scan, req).root));
  app.get('/api/repos/github', async () => orbit.repos.listGitHub(100));
  app.post('/api/repos/clone', async (req) => orbit.repos.cloneFromGitHub(body(schemas.clone, req).nameWithOwner));
  app.get('/api/repos/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { ...orbit.repos.get(id), health: await orbit.repos.health(id) };
  });
  app.patch('/api/repos/:id', async (req) => orbit.repos.update((req.params as { id: string }).id, body(schemas.patchRepo, req)));
  app.delete('/api/repos/:id', async (req, reply) => {
    orbit.repos.remove((req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.post('/api/repos/:id/refresh', async (req) => orbit.repos.refreshSummary((req.params as { id: string }).id, true));
  app.post('/api/repos/:id/detect-commands', async (req) => orbit.repos.redetectCommands((req.params as { id: string }).id));

  // --- integrations & projects ----------------------------------------------
  app.get('/api/integrations', async () => orbit.integrations.list());
  app.post('/api/integrations/asana', async (req) => orbit.integrations.connectAsana(body(schemas.asana, req).token));
  app.delete('/api/integrations/:id', async (req, reply) => {
    orbit.integrations.disconnect((req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.get('/api/integrations/:id/workspaces', async (req) => orbit.integrations.listWorkspaces((req.params as { id: string }).id));
  app.get('/api/integrations/:id/projects', async (req) => {
    const ws = (req.query as { workspace?: string }).workspace;
    if (!ws) throw new OrbitError('VALIDATION', 'workspace is required');
    return orbit.integrations.listRemoteProjects((req.params as { id: string }).id, ws);
  });
  app.post('/api/integrations/:id/authorized-users', async (req) => {
    const b = body(schemas.authorizeUser, req);
    return orbit.integrations.addAuthorizedUser((req.params as { id: string }).id, { externalUserId: b.externalUserId, displayName: b.displayName ?? null, email: b.email ?? null });
  });
  app.delete('/api/integrations/:id/authorized-users/:userId', async (req) => {
    const p = req.params as { id: string; userId: string };
    return orbit.integrations.removeAuthorizedUser(p.id, p.userId);
  });
  app.get('/api/projects', async () => orbit.integrations.listProjects());
  app.post('/api/projects', async (req) => {
    const b = body(schemas.connectProject, req);
    return orbit.integrations.connectProject(b.integrationId, b.externalProjectId, b.repoIds);
  });
  app.patch('/api/projects/:id', async (req) => orbit.integrations.updateProject((req.params as { id: string }).id, body(schemas.patchProject, req)));
  app.delete('/api/projects/:id', async (req, reply) => {
    orbit.integrations.disconnectProject((req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.get('/api/projects/:id/tasks', async (req) =>
    orbit.integrations.listProjectTasks((req.params as { id: string }).id, { includeCompleted: (req.query as { includeCompleted?: string }).includeCompleted === 'true' }),
  );
  app.post('/api/projects/:id/poll', async (req) => orbit.triggers.pollNow((req.params as { id: string }).id));
  /** "Run ready tasks": the user picks tasks; nothing runs without an explicit selection. */
  app.post('/api/projects/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const project = orbit.integrations.projectToDTO(orbit.integrations.projectRow(id));
    const { taskIds } = body(schemas.runTasks, req);
    const results = [];
    for (const taskId of taskIds) {
      try {
        const r = await orbit.missions.create({
          source: { provider: 'asana', integrationId: project.integrationId, taskId, projectId: project.id },
          entryPoint: 'project-batch',
          triggeredBy: localActor(req),
          triggerVerified: true,
        });
        results.push({ taskId, missionId: r.mission.id, created: r.created, error: null });
      } catch (err) {
        results.push({ taskId, missionId: null, created: false, error: errorMessage(err) });
      }
    }
    return results;
  });

  // --- missions --------------------------------------------------------------
  app.get('/api/missions', async (req) => {
    const q = req.query as { status?: string; attention?: string; active?: string; limit?: string };
    const status = q.status
      ?.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is MissionState => (MISSION_STATES as readonly string[]).includes(s));
    return orbit.missions.list({ ...(status?.length ? { status } : {}), attention: q.attention === 'true', active: q.active === 'true', limit: Number(q.limit) || 100 });
  });
  app.post('/api/missions', async (req, reply) => {
    const b = body(schemas.createMission, req);
    const r = await orbit.missions.create({
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.repoIds ? { repoIds: b.repoIds } : {}),
      ...(b.source ? { source: { provider: 'asana' as const, integrationId: b.source.integrationId, taskId: b.source.taskId, projectId: b.source.projectId ?? null } } : {}),
      extraInstructions: b.extraInstructions ?? null,
      ...(b.referenceRepoIds ? { referenceRepoIds: b.referenceRepoIds } : {}),
      entryPoint: clientEntryPoint(req),
      triggeredBy: localActor(req),
      triggerVerified: true,
    });
    return reply.code(r.created ? 201 : 200).send(r);
  });
  app.get('/api/approvals', async () => orbit.missions.list({ attention: true, limit: 100 }));
  app.get('/api/missions/:id', async (req) => orbit.missions.detail((req.params as { id: string }).id));
  app.get('/api/missions/:id/events', async (req) => {
    const q = req.query as { after?: string; limit?: string };
    return orbit.missions.events((req.params as { id: string }).id, Number(q.after) || 0, Number(q.limit) || 500);
  });
  app.get('/api/missions/:id/diff', async (req) => {
    const q = req.query as { missionRepoId?: string };
    if (!q.missionRepoId) throw new OrbitError('VALIDATION', 'missionRepoId is required');
    return orbit.missions.diff((req.params as { id: string }).id, q.missionRepoId);
  });
  app.get('/api/missions/:id/receipt', async (req) => orbit.receipt((req.params as { id: string }).id));
  app.get('/api/missions/:id/receipt.svg', async (req, reply) => reply.type('image/svg+xml').send(orbit.receipt((req.params as { id: string }).id).share.svg));

  const action = (name: string, fn: (id: string, req: FastifyRequest) => unknown) =>
    app.post(`/api/missions/:id/${name}`, async (req) => fn((req.params as { id: string }).id, req));
  action('approve-scope', (id, req) => {
    const b = body(schemas.approveScope, req);
    return orbit.missions.approveScope(id, { ...(b.repoIds ? { repoIds: b.repoIds } : {}), notes: b.notes ?? null, ...(b.referenceRepoIds ? { referenceRepoIds: b.referenceRepoIds } : {}) }, localActor(req));
  });
  action('replan', (id, req) => orbit.missions.replan(id, body(schemas.replan, req), localActor(req)));
  action('request-changes', (id, req) => orbit.missions.requestChanges(id, body(schemas.requestChanges, req), localActor(req)));
  action('approve-changes', (id, req) => orbit.missions.approveChanges(id, localActor(req)));
  action('publish', (id, req) => {
    const b = body(schemas.publish, req);
    return orbit.missions.publish(
      id,
      { missionRepoId: b.missionRepoId, ...(b.title !== undefined ? { title: b.title } : {}), ...(b.body !== undefined ? { body: b.body } : {}), ...(b.draft !== undefined ? { draft: b.draft } : {}) },
      localActor(req),
    );
  });
  action('finish-local', (id, req) => orbit.missions.finishLocal(id, localActor(req)));
  action('cancel', (id, req) => orbit.missions.cancel(id, { reason: body(schemas.cancel, req).reason ?? null }, localActor(req)));
  action('retry', (id, req) => orbit.missions.retry(id, localActor(req)));
  action('complete', (id, req) => orbit.missions.complete(id, localActor(req)));

  // --- live updates (Server-Sent Events) ------------------------------------
  app.get('/api/stream', (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (e: ServerEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.write(': connected\n\n');
    const unsubscribe = orbit.ctx.bus.subscribe(send);
    const heartbeat = setInterval(() => send({ type: 'heartbeat', ts: new Date().toISOString() }), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- dashboard -------------------------------------------------------------
  const dist = resolveWebDist(opts.webDist);
  if (dist) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false, index: false, maxAge: '1h', immutable: false });
    // Read per request (it is tiny) so a rebuilt dashboard never points at deleted asset hashes.
    const indexHtml = () => readFileSync(path.join(dist, 'index.html'), 'utf8');
    app.get('/', async (_req, reply) => reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml()));
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml());
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url.split('?')[0]}` } });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(SIGN_IN_PAGE));
  }

  return app;
}
