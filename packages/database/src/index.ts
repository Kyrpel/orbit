import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { MIGRATIONS, type Migration } from './migrations';

export * from './schema';
// Query operators are re-exported so every package shares this package's single drizzle-orm instance.
export { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lte, ne, notInArray, or, sql } from 'drizzle-orm';
export { schema, MIGRATIONS, type Migration };

export type OrbitDb = BetterSQLite3Database<typeof schema>;
export type SqliteDatabase = Database.Database;

export interface DatabaseHandle {
  db: OrbitDb;
  sqlite: Database.Database;
  file: string;
  close(): void;
}

/** Applies pending migrations inside one transaction each. Returns the ids applied. */
export function runMigrations(sqlite: Database.Database, migrations: readonly Migration[] = MIGRATIONS): string[] {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __orbit_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (sqlite.prepare('SELECT id FROM __orbit_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const apply = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      sqlite.prepare('INSERT INTO __orbit_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, new Date().toISOString());
    });
    apply();
    ran.push(migration.id);
  }
  return ran;
}

/**
 * Opens (and migrates) the Orbit SQLite database. Use `':memory:'` in tests.
 * WAL mode lets the dashboard read while the worker writes.
 */
export function openDatabase(file: string): DatabaseHandle {
  const sqlite = new Database(file);
  if (file !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    file,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
