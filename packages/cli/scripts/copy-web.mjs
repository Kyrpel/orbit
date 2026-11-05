// Copies the built dashboard next to the bundled CLI (dist/web), where the server looks for it.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));
const dest = fileURLToPath(new URL('../dist/web', import.meta.url));

if (!existsSync(src)) {
  console.error('The dashboard is not built. Run `pnpm --filter @orbit/web build` first.');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log('Copied dashboard into dist/web');
