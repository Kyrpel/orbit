import { rmSync, writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createOrbit, orbitPaths, resolveOrbitHome, type CreateOrbitOptions, type Orbit } from '@orbit/core';
import { DEFAULT_PORT, OrbitError } from '@orbit/shared';
import { buildApp } from './app';
import { loadOrCreateToken } from './auth';

export { buildApp, resolveWebDist } from './app';
export { loadOrCreateToken, isAllowedHost, isAllowedOrigin } from './auth';

export interface StartServerOptions {
  port?: number;
  host?: string;
  /** Allow binding to a non-loopback address. Off by default: Orbit is a local tool. */
  allowRemote?: boolean;
  orbit?: Orbit;
  orbitOptions?: CreateOrbitOptions;
  triggers?: boolean;
  webDist?: string | null;
  logger?: boolean;
}

export interface RunningServer {
  app: FastifyInstance;
  orbit: Orbit;
  url: string;
  loginUrl: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? process.env.ORBIT_HOST ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && !opts.allowRemote) {
    throw new OrbitError('FORBIDDEN', `Refusing to listen on ${host}. Orbit binds to localhost only; pass --allow-remote if you really mean it.`);
  }
  const port = opts.port ?? (Number(process.env.ORBIT_PORT) || DEFAULT_PORT);
  const displayHost = host === '::1' ? '[::1]' : host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${port}`;
  const orbit = opts.orbit ?? createOrbit({ ...opts.orbitOptions, dashboardUrl: () => url });
  const token = loadOrCreateToken(orbit.ctx.paths.auth);
  const allowedHosts = (process.env.ORBIT_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const app = await buildApp(orbit, { token, allowedHosts, webDist: opts.webDist ?? null, logger: opts.logger ?? false });
  try {
    await app.listen({ port, host });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new OrbitError('CONFLICT', `Port ${port} is already in use. Is Orbit already running? Use --port to pick another.`);
    }
    throw err;
  }
  const serverFile = orbit.ctx.paths.server;
  writeFileSync(serverFile, JSON.stringify({ pid: process.pid, port, host: displayHost, url, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  orbit.start({ triggers: opts.triggers !== false });
  return {
    app,
    orbit,
    url,
    loginUrl: `${url}/auth?token=${encodeURIComponent(token)}`,
    close: async () => {
      await app.close();
      await orbit.stop();
      orbit.close();
      try {
        rmSync(serverFile, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function serverInfoPath(home = resolveOrbitHome()): string {
  return orbitPaths(home).server;
}
