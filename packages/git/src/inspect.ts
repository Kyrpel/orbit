import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { newId, type CommandSpec, type RepoSummary } from '@orbit/shared';
import type { Git } from './git';

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.hpp': 'C++',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.dart': 'Dart',
  '.scala': 'Scala',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.sql': 'SQL',
  '.css': 'CSS',
  '.scss': 'CSS',
  '.html': 'HTML',
};

const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit',
  '@angular/core': 'Angular',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  hono: 'Hono',
  '@remix-run/react': 'Remix',
  astro: 'Astro',
  vite: 'Vite',
  electron: 'Electron',
  'react-native': 'React Native',
  expo: 'Expo',
  tailwindcss: 'Tailwind CSS',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  'drizzle-orm': 'Drizzle',
  payload: 'Payload CMS',
  vitest: 'Vitest',
  jest: 'Jest',
  '@playwright/test': 'Playwright',
  '@capacitor/core': 'Capacitor',
  'react-router': 'React Router',
};

const PY_FRAMEWORKS: Record<string, string> = { django: 'Django', flask: 'Flask', fastapi: 'FastAPI', pytest: 'pytest' };

const NPM_DEFAULT_TEST = /no test specified/i;

function readText(file: string, max = 200_000): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function excerpt(text: string | null, max = 1200): string | undefined {
  if (!text) return undefined;
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned || undefined;
}

function firstParagraph(markdown: string | null): string | undefined {
  if (!markdown) return undefined;
  const para = markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('[!') && !p.startsWith('<') && !p.startsWith('!['));
  return para ? para.replace(/\s+/g, ' ').slice(0, 300) : undefined;
}

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';

export function detectPackageManager(dir: string, pkg: Record<string, unknown> | null): PackageManager | null {
  if (!pkg) return null;
  const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (pm === 'pnpm' || pm === 'yarn' || pm === 'npm' || pm === 'bun') return pm;
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

function cmd(label: string, command: string, timeoutSec: number, enabled = true): CommandSpec {
  return { id: newId('cmd', 8), label, command, timeoutSec, enabled, source: 'detected' };
}

export interface DetectedCommands {
  packageManager: PackageManager | null;
  setup: CommandSpec[];
  verify: CommandSpec[];
}

/** Suggests setup and verification commands from repository files. Suggestions are confirmed by the user. */
export function detectCommands(dir: string): DetectedCommands {
  const setup: CommandSpec[] = [];
  const verify: CommandSpec[] = [];
  const pkg = readJson(path.join(dir, 'package.json'));
  const pm = detectPackageManager(dir, pkg);

  if (pkg && pm) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const hasLock =
      existsSync(path.join(dir, 'pnpm-lock.yaml')) ||
      existsSync(path.join(dir, 'yarn.lock')) ||
      existsSync(path.join(dir, 'package-lock.json')) ||
      existsSync(path.join(dir, 'bun.lock')) ||
      existsSync(path.join(dir, 'bun.lockb'));
    const berry = existsSync(path.join(dir, '.yarnrc.yml'));
    const install =
      pm === 'pnpm'
        ? hasLock
          ? 'pnpm install --frozen-lockfile'
          : 'pnpm install'
        : pm === 'yarn'
          ? berry
            ? 'yarn install --immutable'
            : 'yarn install --frozen-lockfile'
          : pm === 'bun'
            ? 'bun install'
            : hasLock
              ? 'npm ci'
              : 'npm install --no-package-lock';
    setup.push(cmd('Install dependencies', install, 900));
    const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : pm === 'bun' ? `bun run ${script}` : `${pm} run ${script}`);
    if (scripts.typecheck) verify.push(cmd('Typecheck', run('typecheck'), 600));
    else if (scripts['type-check']) verify.push(cmd('Typecheck', run('type-check'), 600));
    if (scripts.lint) verify.push(cmd('Lint', run('lint'), 600));
    if (scripts.test && !NPM_DEFAULT_TEST.test(scripts.test)) verify.push(cmd('Tests', pm === 'bun' ? 'bun run test' : `${pm} test`, 900));
    if (scripts.build) verify.push(cmd('Build', run('build'), 900, false));
  }

  if (existsSync(path.join(dir, 'Cargo.toml'))) verify.push(cmd('Tests', 'cargo test', 1200));
  if (existsSync(path.join(dir, 'go.mod'))) {
    verify.push(cmd('Vet', 'go vet ./...', 600));
    verify.push(cmd('Tests', 'go test ./...', 1200));
  }
  const pyproject = readText(path.join(dir, 'pyproject.toml'));
  if (existsSync(path.join(dir, 'uv.lock'))) {
    setup.push(cmd('Install dependencies', 'uv sync', 900));
    verify.push(cmd('Tests', 'uv run pytest', 1200));
  } else if (pyproject && /\[tool\.poetry\]/.test(pyproject)) {
    setup.push(cmd('Install dependencies', 'poetry install', 900));
    verify.push(cmd('Tests', 'poetry run pytest', 1200));
  } else if (pyproject || existsSync(path.join(dir, 'requirements.txt'))) {
    if (existsSync(path.join(dir, 'tests')) || existsSync(path.join(dir, 'test'))) verify.push(cmd('Tests', 'python -m pytest', 1200));
  }
  if (existsSync(path.join(dir, 'pom.xml'))) verify.push(cmd('Tests', 'mvn -q -B test', 1800));
  if (existsSync(path.join(dir, 'build.gradle')) || existsSync(path.join(dir, 'build.gradle.kts'))) {
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    verify.push(cmd('Tests', existsSync(path.join(dir, 'gradlew')) ? `${wrapper} test` : 'gradle test', 1800));
  }
  if (verify.length === 0) {
    const makefile = readText(path.join(dir, 'Makefile'));
    if (makefile && /^test:/m.test(makefile)) verify.push(cmd('Tests', 'make test', 1200));
  }
  return { packageManager: pm, setup, verify };
}

/** Builds a concise, deterministic summary of a repository. No AI involved. */
export async function summarizeRepository(dir: string, git: Git): Promise<RepoSummary> {
  const pkg = readJson(path.join(dir, 'package.json'));
  const readme = readText(path.join(dir, 'README.md')) ?? readText(path.join(dir, 'readme.md'));
  const instructions = readText(path.join(dir, 'CLAUDE.md')) ?? readText(path.join(dir, 'AGENTS.md'));

  let topLevel: string[] = [];
  try {
    topLevel = readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') || ['.github', '.claude'].includes(d.name))
      .filter((d) => !['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__'].includes(d.name))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort()
      .slice(0, 60);
  } catch {
    topLevel = [];
  }

  const keyFileNames = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Dockerfile', 'docker-compose.yml', 'tsconfig.json', 'pnpm-workspace.yaml', 'turbo.json', 'Makefile'];
  const keyFiles = keyFileNames.filter((f) => existsSync(path.join(dir, f)));

  const langCount = new Map<string, number>();
  let files: string[] = [];
  try {
    files = await git.lsFiles(dir, 8000);
  } catch {
    files = [];
  }
  for (const f of files) {
    const lang = LANGUAGE_BY_EXT[path.extname(f).toLowerCase()];
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }
  const languages = [...langCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l]) => l);

  const deps = pkg ? { ...((pkg.dependencies ?? {}) as object), ...((pkg.devDependencies ?? {}) as object) } : {};
  const depNames = Object.keys(deps);
  const frameworks = new Set<string>();
  for (const d of depNames) if (FRAMEWORK_DEPS[d]) frameworks.add(FRAMEWORK_DEPS[d] as string);
  const pyText = `${readText(path.join(dir, 'pyproject.toml')) ?? ''}\n${readText(path.join(dir, 'requirements.txt')) ?? ''}`.toLowerCase();
  for (const [k, v] of Object.entries(PY_FRAMEWORKS)) if (new RegExp(`\\b${k}\\b`).test(pyText)) frameworks.add(v);

  const workspaces: string[] = [];
  if (pkg && Array.isArray(pkg.workspaces)) workspaces.push(...(pkg.workspaces as string[]));
  const pnpmWs = readText(path.join(dir, 'pnpm-workspace.yaml'));
  if (pnpmWs) for (const m of pnpmWs.matchAll(/-\s*["']?([^"'\n]+)["']?/g)) if (m[1]) workspaces.push(m[1].trim());

  const name = (typeof pkg?.name === 'string' && pkg.name) || path.basename(dir);
  const description = (typeof pkg?.description === 'string' && pkg.description) || firstParagraph(readme);

  const keywords = new Set<string>();
  const addWords = (s: string | undefined) => {
    if (!s) return;
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && w.length <= 30) keywords.add(w);
  };
  addWords(name);
  addWords(path.basename(dir));
  addWords(description);
  for (const t of topLevel) addWords(t);
  for (const d of depNames.slice(0, 80)) addWords(d);
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length > 1) dirs.add(parts.slice(0, Math.min(parts.length - 1, 3)).join('/'));
  }
  for (const d of [...dirs].slice(0, 400)) addWords(d);
  if (readme) for (const h of readme.matchAll(/^#{1,3}\s+(.+)$/gm)) addWords(h[1]);

  let headSha: string | undefined;
  try {
    headSha = await git.headSha(dir);
  } catch {
    headSha = undefined;
  }

  const summary: RepoSummary = {
    name,
    languages,
    frameworks: [...frameworks],
    topLevel,
    keyFiles,
    scripts: pkg ? ((pkg.scripts ?? {}) as Record<string, string>) : {},
    workspaces: [...new Set(workspaces)].slice(0, 20),
    dependencies: depNames.slice(0, 60),
    keywords: [...keywords].slice(0, 400),
    generatedAt: new Date().toISOString(),
  };
  if (description) summary.description = description;
  const pm = detectPackageManager(dir, pkg);
  if (pm) summary.packageManager = pm;
  const instr = excerpt(instructions, 1500);
  if (instr) summary.instructionsExcerpt = instr;
  const readmeEx = excerpt(readme, 1200);
  if (readmeEx) summary.readmeExcerpt = readmeEx;
  if (headSha) summary.headSha = headSha;
  return summary;
}

/** Lists git repositories directly inside `root` (one level deep, plus `root` itself). Never recursive. */
export async function findRepositories(root: string, git: Git, maxEntries = 300): Promise<string[]> {
  const found: string[] = [];
  if (!existsSync(root)) return found;
  if (existsSync(path.join(root, '.git'))) found.push(path.resolve(root));
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
      .slice(0, maxEntries);
  } catch {
    return found;
  }
  for (const name of entries) {
    const full = path.join(root, name);
    if (existsSync(path.join(full, '.git')) && (await git.isRepo(full))) found.push(path.resolve(full));
  }
  return found;
}
