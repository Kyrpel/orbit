// Builds the dashboard (Vite) and the bundled CLI (tsup), then copies the dashboard into the CLI.
// Calls the local binaries directly, so it does not depend on a working global pnpm.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'apps/web');
const cliDir = path.join(root, 'packages/cli');
const webRequire = createRequire(path.join(webDir, 'package.json'));
const cliRequire = createRequire(path.join(cliDir, 'package.json'));

const viteBin = path.join(path.dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js');
const tsupBin = path.join(path.dirname(cliRequire.resolve('tsup/package.json')), 'dist', 'cli-default.js');

function run(label, args, cwd) {
  console.log(`\n▸ ${label}`);
  const res = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: process.env });
  if (res.status !== 0) {
    console.error(`✗ ${label} failed`);
    process.exit(res.status ?? 1);
  }
}

run('Dashboard (vite build)', [viteBin, 'build'], webDir);
run('CLI bundle (tsup)', [tsupBin], cliDir);
run('Copy dashboard into the CLI', [path.join(cliDir, 'scripts', 'copy-web.mjs')], cliDir);
console.log('\n✓ Built packages/cli/dist/orbit.js (run: node packages/cli/dist/orbit.js start)');
