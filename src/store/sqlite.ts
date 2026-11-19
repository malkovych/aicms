import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { SqlStore, type SqliteDriver, type SqlValue } from "./sql.ts";

export { applyPatch } from "./sql.ts";

export interface SqliteOptions {
  kind: "sqlite";
  path: string;
}

/** SQLite storage, built into Node 22.13+. Pass ":memory:" for tests. */
export function sqlite(path = ".aicms/data.db"): SqliteOptions {
  return { kind: "sqlite", path };
}

// node:sqlite still prints an ExperimentalWarning on load. It is noise for
// users (and would pollute stdio MCP logs), so swallow that one warning only.
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

/** The node:sqlite driver: synchronous calls behind the async interface; batches run in BEGIN IMMEDIATE. */
export function nodeSqliteDriver(path: string): SqliteDriver {
  const { DatabaseSync } = loadSqlite();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db: DatabaseSyncType = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const p = (params?: SqlValue[]) => (params ?? []) as never[];
  return {
    all: async (sql, params) => db.prepare(sql).all(...p(params)) as Record<string, any>[],
    get: async (sql, params) => db.prepare(sql).get(...p(params)) as Record<string, any> | undefined,
    run: async (sql, params) => ({ changes: Number(db.prepare(sql).run(...p(params)).changes) }),
    exec: async (sql) => db.exec(sql),
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const s of statements) db.prepare(s.sql).run(...p(s.params));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: async () => db.close(),
  };
}

/** SQLite storage on node:sqlite. */
export class SqliteStore extends SqlStore {
  constructor(path: string) {
    super(nodeSqliteDriver(path));
  }
}
