// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

/** Applies every `NNN_name.sql` file not yet recorded in `schema_migration`, each in its own transaction. */
export function migrate(db: DatabaseSync): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migration').all() as Array<{ version: number }>).map((row) => row.version),
  );
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_.+\.sql$/.test(file))
    .sort()
    .map((file) => ({ version: Number.parseInt(file.slice(0, 3), 10), file }))
    .filter(({ version }) => !applied.has(version));

  for (const { version, file } of pending) {
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(
        version,
        file,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return pending.map(({ version }) => version);
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
