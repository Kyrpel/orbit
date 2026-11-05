// Creates a tiny Node project with tests (and a local bare "origin") to try Orbit safely.
// Usage: node scripts/create-demo-repo.mjs [target-folder]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'orbit-demo'));
const repo = path.join(base, 'shop-api');
const remote = path.join(base, 'shop-api.git');
if (existsSync(repo)) {
  console.error(`${repo} already exists. Pick another folder.`);
  process.exit(1);
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

mkdirSync(path.join(repo, 'src'), { recursive: true });
mkdirSync(path.join(repo, 'test'), { recursive: true });
git(base, 'init', '--bare', '--initial-branch=main', remote);
git(repo, 'init', '--initial-branch=main');
writeFileSync(
  path.join(repo, 'package.json'),
  `${JSON.stringify({ name: 'shop-api', version: '1.0.0', description: 'Tiny checkout API used to try Orbit.', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
);
writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
writeFileSync(path.join(repo, 'README.md'), '# shop-api\n\nA tiny checkout API. Cart totals live in src/cart.js.\n');
writeFileSync(path.join(repo, 'src', 'cart.js'), 'export function cartTotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n}\n');
writeFileSync(
  path.join(repo, 'test', 'cart.test.js'),
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { cartTotal } from '../src/cart.js';\n\ntest('sums price times quantity', () => {\n  assert.equal(cartTotal([{ price: 5, quantity: 2 }, { price: 1, quantity: 3 }]), 13);\n});\n",
);
git(repo, 'add', '-A');
git(repo, '-c', 'user.name=Orbit Demo', '-c', 'user.email=demo@example.com', 'commit', '-m', 'Initial shop API');
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-u', 'origin', 'main');

console.log(`Demo repository ready: ${repo}`);
console.log('Next:');
console.log(`  orbit repo add "${repo}"`);
console.log('  orbit run "Add an optional percentage discount to cartTotal" --repo shop-api --watch');
