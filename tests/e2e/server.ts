/**
 * Starts a throwaway Orbit for end-to-end tests: temporary ORBIT_HOME, a demo
 * repository with a local bare remote, the scripted runtime (no AI) and a
 * fixed sign-in token. Nothing touches your real ~/.orbit.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedRuntime } from '@orbit/agents';
import { createOrbit } from '@orbit/core';
import { startServer } from '@orbit/server';

export const E2E_TOKEN = 'e2e-token-0123456789abcdefghijklmnopqrstuvwxyz';

const port = Number(process.env.ORBIT_E2E_PORT || 7499);
const root = mkdtempSync(path.join(os.tmpdir(), 'orbit-e2e-'));
const home = path.join(root, 'home');
mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token: E2E_TOKEN, createdAt: new Date().toISOString() }));

const repo = path.join(root, 'shop-api');
const remote = path.join(root, 'shop-api.git');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
mkdirSync(path.join(repo, 'src'), { recursive: true });
git(root, 'init', '--bare', '--initial-branch=main', remote);
git(repo, 'init', '--initial-branch=main');
writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'shop-api', type: 'module', scripts: {} }, null, 2));
writeFileSync(path.join(repo, 'README.md'), '# shop-api\n');
writeFileSync(path.join(repo, 'src', 'cart.js'), 'export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n');
git(repo, 'add', '-A');
git(repo, '-c', 'user.name=Orbit E2E', '-c', 'user.email=e2e@example.com', 'commit', '-m', 'init');
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-u', 'origin', 'main');
git(repo, 'config', 'user.name', 'Orbit E2E');
git(repo, 'config', 'user.email', 'e2e@example.com');

const url = `http://127.0.0.1:${port}`;
const orbit = createOrbit({ home, runtimes: [new ScriptedRuntime()], dashboardUrl: () => url, workerPollMs: 100 });
orbit.ctx.settings.update({
  execution: { runtime: 'scripted', localExecutionConsentAt: new Date().toISOString() },
  onboarding: { completedAt: new Date().toISOString() },
});
await orbit.repos.register(repo);
await startServer({ port, orbit, triggers: false });
console.log(`Orbit e2e server on ${url}`);
