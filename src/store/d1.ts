// Cloudflare D1 (SQLite at the edge) behind the same SQL store as node:sqlite.

import type { SqliteDriver, SqlValue } from "./sql.ts";

export interface D1Options {
  kind: "d1";
  /** The D1 binding name in wrangler config, e.g. "DB". */
  binding: string;
}

/** D1 storage for Cloudflare Workers: `db: d1("DB")`. */
export function d1(binding = "DB"): D1Options {
  return { kind: "d1", binding };
}

/** The parts of a D1Database binding the store uses. */
export interface D1DatabaseLike {
  prepare(sql: string): { bind(...values: unknown[]): D1Statement };
  batch(statements: D1Statement[]): Promise<unknown[]>;
}
interface D1Statement {
  all(): Promise<{ results: Record<string, any>[] }>;
  first(): Promise<Record<string, any> | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

/** Split SQL into single statements (D1 runs one statement per prepare). Our schema has no semicolons inside literals. */
export function statements(sql: string): string[] {
  return sql.split(";").map((s) => s.trim()).filter(Boolean);
}

export function d1Driver(db: D1DatabaseLike): SqliteDriver {
  const bind = (sql: string, params?: SqlValue[]) => db.prepare(sql).bind(...(params ?? []));
  return {
    all: async (sql, params) => (await bind(sql, params).all()).results,
    get: async (sql, params) => (await bind(sql, params).first()) ?? undefined,
    run: async (sql, params) => ({ changes: (await bind(sql, params).run()).meta.changes ?? 0 }),
    async exec(sql) {
      for (const s of statements(sql)) await bind(s).run();
    },
    async batch(list) {
      // D1 batches are atomic: if one statement fails, none apply.
      if (list.length) await db.batch(list.map((s) => bind(s.sql, s.params)));
    },
    close: async () => {},
  };
}
