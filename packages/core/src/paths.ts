import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OrbitPaths {
  home: string;
  db: string;
  secrets: string;
  auth: string;
  server: string;
  worktrees: string;
  repos: string;
  logs: string;
}

/** `ORBIT_HOME` or `~/.orbit`. Everything Orbit stores lives here, never inside your repositories. */
export function resolveOrbitHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.ORBIT_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.orbit');
}

export function orbitPaths(home: string): OrbitPaths {
  return {
    home,
    db: path.join(home, 'orbit.db'),
    secrets: path.join(home, 'secrets.json'),
    auth: path.join(home, 'auth.json'),
    server: path.join(home, 'server.json'),
    worktrees: path.join(home, 'worktrees'),
    repos: path.join(home, 'repos'),
    logs: path.join(home, 'logs'),
  };
}

export function ensureOrbitHome(paths: OrbitPaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  for (const dir of [paths.worktrees, paths.repos, paths.logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
