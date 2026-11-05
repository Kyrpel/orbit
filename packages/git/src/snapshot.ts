import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Read-only reference projects are given to agents as a disposable COPY, so an
 * agent can never modify your real folder, whatever runtime it uses. The copy
 * includes uncommitted and gitignored files (generated templates often are),
 * but never dependency folders, git internals, symlinks or likely secrets.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.cache',
  '.parcel-cache',
  '.gradle',
  '.idea',
  'coverage',
]);

const SECRET_FILE = /^(\.env(\..+)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|credentials(\.json)?|\.npmrc|\.netrc|\.pypirc|secrets?\.json|.*\.keystore|.*\.jks)$/i;
const ALLOWED_ENV_EXAMPLES = /^\.env\.(example|sample|template)$/i;

export interface SnapshotOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export interface SnapshotResult {
  files: number;
  bytes: number;
  skipped: { path: string; reason: string }[];
}

export function snapshotFolder(src: string, dest: string, opts: SnapshotOptions = {}): SnapshotResult {
  const maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024;
  const maxTotalBytes = opts.maxTotalBytes ?? 300 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 20_000;
  const result: SnapshotResult = { files: 0, bytes: 0, skipped: [] };
  const skip = (p: string, reason: string) => {
    if (result.skipped.length < 200) result.skipped.push({ path: p, reason });
  };

  rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(dest, { recursive: true });

  const walk = (dir: string, rel: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skip(rel || '.', 'unreadable folder');
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skip(relPath, 'symbolic link');
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        mkdirSync(path.join(dest, relPath), { recursive: true });
        walk(full, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SECRET_FILE.test(entry.name) && !ALLOWED_ENV_EXAMPLES.test(entry.name)) {
        skip(relPath, 'looks like a secret');
        continue;
      }
      let size = 0;
      try {
        size = lstatSync(full).size;
      } catch {
        skip(relPath, 'unreadable file');
        continue;
      }
      if (size > maxFileBytes) {
        skip(relPath, `larger than ${Math.round(maxFileBytes / 1024 / 1024)} MB`);
        continue;
      }
      if (result.files >= maxFiles || result.bytes + size > maxTotalBytes) {
        skip(relPath, 'reference copy size limit reached');
        continue;
      }
      try {
        copyFileSync(full, path.join(dest, relPath));
        result.files++;
        result.bytes += size;
      } catch {
        skip(relPath, 'could not copy');
      }
    }
  };

  walk(src, '');
  return result;
}
