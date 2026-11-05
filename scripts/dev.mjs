// Runs the API (tsx watch, :7420) and the dashboard (Vite, :5173) together.
// Uses the locally installed binaries directly, so it works without a global pnpm.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));

const tsxCli = require.resolve('tsx/cli');
const viteBin = path.join(path.dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js');

const procs = [
  spawn(process.execPath, [tsxCli, 'watch', '--clear-screen=false', 'apps/server/src/dev.ts'], { cwd: root, stdio: 'inherit', env: process.env }),
  spawn(process.execPath, [viteBin], { cwd: path.join(root, 'apps/web'), stdio: 'inherit', env: process.env }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  process.exit(code);
};
for (const p of procs) p.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
