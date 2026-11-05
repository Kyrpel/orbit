import { defineConfig } from 'tsup';

/**
 * Bundles the CLI with every @orbit/* workspace package inlined, so the
 * published package is one file plus the built dashboard in dist/web.
 * Third-party dependencies stay external and are installed from package.json.
 */
export default defineConfig({
  entry: { orbit: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  shims: false,
  noExternal: [/^@orbit\//],
  external: [
    'better-sqlite3',
    'drizzle-orm',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    'fastify',
    '@fastify/static',
    'execa',
    'commander',
    'zod',
  ],
});
