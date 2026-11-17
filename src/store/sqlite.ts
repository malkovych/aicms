import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import {
  ConflictError,
  type ChangesetRow,
  type EntryRow,
  type EventRow,
  type IndexSpec,
  type ListQuery,
  type Store,
  type VersionRow,
} from "./types.ts";

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  locale TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_model ON entries(model, locale, updated_at);

CREATE TABLE IF NOT EXISTS versions (
  entry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT,
  changeset_id TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, version)
);

CREATE TABLE IF NOT EXISTS changesets (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  comment TEXT,
  review_reason TEXT,
  items TEXT NOT NULL,
  issues TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  merged_at TEXT,
  merged_by TEXT
);
CREATE INDEX IF NOT EXISTS changesets_actor ON changesets(actor, status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  gate TEXT NOT NULL,
  action TEXT NOT NULL,
  input TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_actor ON events(actor, at);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  alt TEXT,
  meta TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
`;

type Row = Record<string, SQLInputValue>;
const SAFE_IDENT = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const jsonPath = (field: string) => {
  if (!SAFE_IDENT.test(field)) throw new Error(`Invalid field name: ${field}`);
  return `'$.${field}'`;
};
const toSql = (v: unknown): SQLInputValue =>
  v === undefined || v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "object" ? JSON.stringify(v) : (v as SQLInputValue);

function entryFrom(r: Row): EntryRow {
  return {
    id: r.id as string,
    model: r.model as string,
    locale: r.locale as string,
    data: JSON.parse(r.data as string),
    version: Number(r.version),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    createdBy: r.created_by as string,
    updatedBy: r.updated_by as string,
  };
}

function changesetFrom(r: Row): ChangesetRow {
  return {
    id: r.id as string,
    actor: r.actor as string,
    status: r.status as ChangesetRow["status"],
    note: (r.note as string) ?? undefined,
    comment: (r.comment as string) ?? undefined,
    reviewReason: (r.review_reason as string) ?? undefined,
    items: JSON.parse(r.items as string),
    issues: JSON.parse(r.issues as string),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    mergedAt: (r.merged_at as string) ?? undefined,
    mergedBy: (r.merged_by as string) ?? undefined,
  };
}

export class SqliteStore implements Store {
  private db: DatabaseSyncType;

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async init(indexes: IndexSpec[]) {
    for (const { model, fields } of indexes) {
      for (const f of fields) {
        if (!SAFE_IDENT.test(model) || !SAFE_IDENT.test(f)) continue;
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS idx_${model}_${f} ON entries(json_extract(data, ${jsonPath(f)})) WHERE model = '${model}'`,
        );
      }
    }
  }

  async close() {
    this.db.close();
  }

  async getEntry(id: string) {
    const r = this.get("SELECT * FROM entries WHERE id = ?", id);
    return r ? entryFrom(r) : null;
  }

  async findOne(model: string, field: string, value: unknown, locale?: string) {
    const r = locale
      ? this.get(`SELECT * FROM entries WHERE model = ? AND locale = ? AND json_extract(data, ${jsonPath(field)}) = ? LIMIT 1`, model, locale, toSql(value))
      : this.get(`SELECT * FROM entries WHERE model = ? AND json_extract(data, ${jsonPath(field)}) = ? LIMIT 1`, model, toSql(value));
    return r ? entryFrom(r) : null;
  }

  async list(q: ListQuery) {
    const where = ["model = ?"];
    const params: SQLInputValue[] = [q.model];
    if (q.locale) { where.push("locale = ?"); params.push(q.locale); }
    for (const [field, value] of Object.entries(q.where ?? {})) {
      if (q.arrayFields?.includes(field)) {
        where.push(`EXISTS (SELECT 1 FROM json_each(entries.data, ${jsonPath(field)}) WHERE value = ?)`);
      } else if (value === null) {
        where.push(`json_extract(data, ${jsonPath(field)}) IS NULL`);
        continue;
      } else {
        where.push(`json_extract(data, ${jsonPath(field)}) = ?`);
      }
      params.push(toSql(value));
    }
    const clause = where.join(" AND ");
    const order = q.order
      ? `json_extract(data, ${jsonPath(q.order.field)}) ${q.order.desc ? "DESC" : "ASC"}, updated_at DESC`
      : "updated_at DESC";
    const total = Number(this.get(`SELECT COUNT(*) AS n FROM entries WHERE ${clause}`, ...params)?.n ?? 0);
    const items = this.all(`SELECT * FROM entries WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, q.limit, q.offset).map(entryFrom);
    return { items, total };
  }

  async scan(models: string[], limit: number) {
    if (!models.length) return [];
    const marks = models.map(() => "?").join(", ");
    return this.all(`SELECT * FROM entries WHERE model IN (${marks}) ORDER BY updated_at DESC LIMIT ?`, ...models, limit).map(entryFrom);
  }

  async versions(entryId: string): Promise<VersionRow[]> {
    return this.all("SELECT * FROM versions WHERE entry_id = ? ORDER BY version DESC", entryId).map((r) => ({
      entryId: r.entry_id as string,
      version: Number(r.version),
      data: r.data ? JSON.parse(r.data as string) : null,
      changesetId: (r.changeset_id as string) ?? null,
      actor: r.actor as string,
      createdAt: r.created_at as string,
    }));
  }

  async getChangeset(id: string) {
    const r = this.get("SELECT * FROM changesets WHERE id = ?", id);
    return r ? changesetFrom(r) : null;
  }

  async findOpenChangeset(actor: string) {
    const r = this.get("SELECT * FROM changesets WHERE actor = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1", actor);
    return r ? changesetFrom(r) : null;
  }

  async createChangeset(c: ChangesetRow) {
    this.run(
      `INSERT INTO changesets (id, actor, status, note, comment, review_reason, items, issues, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id, c.actor, c.status, toSql(c.note), toSql(c.comment), toSql(c.reviewReason),
      JSON.stringify(c.items), JSON.stringify(c.issues), c.createdAt, c.updatedAt,
    );
  }

  async saveChangeset(c: ChangesetRow) {
    this.run(
      `UPDATE changesets SET status = ?, note = ?, comment = ?, review_reason = ?, items = ?, issues = ?,
       updated_at = ?, merged_at = ?, merged_by = ? WHERE id = ?`,
      c.status, toSql(c.note), toSql(c.comment), toSql(c.reviewReason), JSON.stringify(c.items),
      JSON.stringify(c.issues), c.updatedAt, toSql(c.mergedAt), toSql(c.mergedBy), c.id,
    );
  }

  async listChangesets(q: { actor?: string; status?: ChangesetRow["status"][]; limit: number }) {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.actor) { where.push("actor = ?"); params.push(q.actor); }
    if (q.status?.length) { where.push(`status IN (${q.status.map(() => "?").join(", ")})`); params.push(...q.status); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.all(`SELECT * FROM changesets ${clause} ORDER BY updated_at DESC LIMIT ?`, ...params, q.limit).map(changesetFrom);
  }

  async mergeChangeset(id: string, by: string, at: string) {
    return this.tx(() => {
      const row = this.get("SELECT * FROM changesets WHERE id = ?", id);
      if (!row) throw new Error(`Changeset ${id} not found`);
      const cs = changesetFrom(row);
      const touched: EntryRow[] = [];
      for (const item of cs.items) {
        const current = this.get("SELECT * FROM entries WHERE id = ?", item.id);
        const cur = current ? entryFrom(current) : null;
        if (item.op === "create") {
          if (cur) throw new ConflictError(item.id, `Entry ${item.id} already exists`);
          const data = item.data ?? {};
          this.run(
            `INSERT INTO entries (id, model, locale, data, version, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
            item.id, item.model, item.locale, JSON.stringify(data), at, at, cs.actor, cs.actor,
          );
          this.run("INSERT INTO versions VALUES (?, 1, ?, ?, ?, ?)", item.id, JSON.stringify(data), cs.id, cs.actor, at);
          touched.push({ id: item.id, model: item.model, locale: item.locale, data, version: 1, createdAt: at, updatedAt: at, createdBy: cs.actor, updatedBy: cs.actor });
          continue;
        }
        if (!cur) throw new ConflictError(item.id, `Entry ${item.id} was deleted after it was drafted`);
        if (item.baseVersion !== undefined && cur.version !== item.baseVersion) {
          throw new ConflictError(item.id, `Entry ${item.id} changed after it was drafted (v${item.baseVersion} → v${cur.version})`);
        }
        const version = cur.version + 1;
        if (item.op === "delete") {
          this.run("DELETE FROM entries WHERE id = ?", item.id);
          this.run("INSERT INTO versions VALUES (?, ?, NULL, ?, ?, ?)", item.id, version, cs.id, cs.actor, at);
          touched.push({ ...cur, version, updatedAt: at, updatedBy: cs.actor });
          continue;
        }
        const data = applyPatch(cur.data, item.data ?? {});
        this.run("UPDATE entries SET data = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?", JSON.stringify(data), version, at, cs.actor, item.id);
        this.run("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)", item.id, version, JSON.stringify(data), cs.id, cs.actor, at);
        touched.push({ ...cur, data, version, updatedAt: at, updatedBy: cs.actor });
      }
      this.run("UPDATE changesets SET status = 'merged', merged_at = ?, merged_by = ?, updated_at = ?, issues = '[]' WHERE id = ?", at, by, at, id);
      return touched;
    });
  }

  async logEvent(e: EventRow) {
    this.run(
      "INSERT INTO events (at, actor, gate, action, input, ok, error, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      e.at, e.actor, e.gate, e.action, toSql(e.input), e.ok ? 1 : 0, toSql(e.error), e.ms,
    );
  }

  async countEvents(actor: string, sinceIso: string) {
    return Number(this.get("SELECT COUNT(*) AS n FROM events WHERE actor = ? AND at >= ?", actor, sinceIso)?.n ?? 0);
  }

  async listEvents(q: { actor?: string; limit: number }) {
    const rows = q.actor
      ? this.all("SELECT * FROM events WHERE actor = ? ORDER BY id DESC LIMIT ?", q.actor, q.limit)
      : this.all("SELECT * FROM events ORDER BY id DESC LIMIT ?", q.limit);
    return rows.map((r) => ({
      id: Number(r.id),
      at: r.at as string,
      actor: r.actor as string,
      gate: r.gate as string,
      action: r.action as string,
      input: (r.input as string) ?? undefined,
      ok: r.ok === 1,
      error: (r.error as string) ?? undefined,
      ms: Number(r.ms),
    }));
  }

  async createToken(t: { id: string; agent: string; hash: string; createdAt: string }) {
    this.run("INSERT INTO tokens (id, agent, hash, created_at) VALUES (?, ?, ?, ?)", t.id, t.agent, t.hash, t.createdAt);
  }

  async findToken(hash: string) {
    const r = this.get("SELECT id, agent FROM tokens WHERE hash = ? AND revoked_at IS NULL", hash);
    return r ? { id: r.id as string, agent: r.agent as string } : null;
  }

  async revokeTokens(agent: string, at: string) {
    return Number(this.run("UPDATE tokens SET revoked_at = ? WHERE agent = ? AND revoked_at IS NULL", at, agent).changes);
  }

  async listTokens() {
    return this.all("SELECT id, agent, created_at, revoked_at FROM tokens ORDER BY created_at DESC").map((r) => ({
      id: r.id as string,
      agent: r.agent as string,
      createdAt: r.created_at as string,
      revokedAt: (r.revoked_at as string) ?? null,
    }));
  }
}

/** Shallow patch: `null` removes a key, anything else replaces it. */
export function applyPatch(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out;
}
