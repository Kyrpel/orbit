import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** Tests never read your real Claude Code and Codex sessions: these folders do not exist. */
const noSessions = path.join(os.tmpdir(), 'orbit-vitest-no-past-sessions');

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      ORBIT_CLAUDE_PROJECTS_DIR: path.join(noSessions, 'claude'),
      ORBIT_CODEX_SESSIONS_DIR: path.join(noSessions, 'codex'),
      ORBIT_CODEX_SESSION_INDEX: path.join(noSessions, 'session_index.jsonl'),
    },
  },
});
