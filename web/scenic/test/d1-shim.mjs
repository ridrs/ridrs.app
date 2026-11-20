// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal D1 stand-in over node:sqlite with the migrations applied, for tests of the import SQL and the admin API.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (typeof a === 'boolean' ? Number(a) : a === undefined ? null : a))); }
  exec() {
    const st = this.db.prepare(this.sql);
    if (st.columns().length) return { results: st.all(...this.args).map((r) => ({ ...r })), success: true, meta: {} };
    const r = st.run(...this.args);
    return { results: [], success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
  }
  async first(col) { const r = this.exec().results[0] ?? null; return col ? r?.[col] ?? null : r; }
  async all() { return this.exec(); }
  async run() { return this.exec(); }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s.exec()); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    exec: (sql) => db.exec(sql),
  };
}
