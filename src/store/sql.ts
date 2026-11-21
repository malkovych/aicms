// SQLite-dialect storage over an async driver: node:sqlite on servers,
// Cloudflare D1 on the edge. Merges are planned first and applied in one atomic
// batch; the versions primary key catches anything that changed in between.

import {
  ConflictError,
  type ChangesetRow,
  type EntryRow,
  type EventRow,
  type IndexSpec,
  type ListQuery,
  type MediaRow,
  type Store,
  type TextDoc,
  type TextHit,
  type TokenKind,
  type TokenRow,
  type VersionRow,
  changesetMeta,
} from "./types.ts";

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, any>;

/** What a SQLite-dialect database must offer. */
export interface SqliteDriver {
  all(sql: string, params?: SqlValue[]): Promise<Row[]>;
  get(sql: string, params?: SqlValue[]): Promise<Row | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Several statements without parameters (schema). */
  exec(sql: string): Promise<void>;
  /** Run statements atomically: all or none. */
  batch(statements: { sql: string; params?: SqlValue[] }[]): Promise<void>;
  close(): Promise<void>;
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
  merged_by TEXT,
  meta TEXT
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
  created_by TEXT NOT NULL,
  filename TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS text_docs (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  locale TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS text_terms (
  term TEXT NOT NULL,
  doc TEXT NOT NULL,
  tf REAL NOT NULL,
  PRIMARY KEY (term, doc)
);
CREATE INDEX IF NOT EXISTS text_terms_doc ON text_terms(doc);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  kind TEXT NOT NULL DEFAULT 'agent',
  expires_at TEXT
);
`;

/** Columns added after a table first shipped: [table, column, definition]. */
const MIGRATIONS: [string, string, string][] = [
  ["tokens", "kind", "TEXT NOT NULL DEFAULT 'agent'"],
  ["tokens", "expires_at", "TEXT"],
  ["media", "filename", "TEXT"],
  ["changesets", "meta", "TEXT"],
];

const SAFE_IDENT = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const jsonPath = (field: string) => {
  if (!SAFE_IDENT.test(field)) throw new Error(`Invalid field name: ${field}`);
  return `'$.${field}'`;
};
const toSql = (v: unknown): SqlValue =>
  v === undefined || v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "object" ? JSON.stringify(v) : (v as SqlValue);

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

function metaSql(c: ChangesetRow): string | null {
  const meta = changesetMeta(c);
  return meta ? JSON.stringify(meta) : null;
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
    ...(r.meta ? JSON.parse(r.meta as string) : {}),
  };
}

export class SqlStore implements Store {
  protected d: SqliteDriver;
  private ready: Promise<void> | undefined;

  constructor(driver: SqliteDriver) {
    this.d = driver;
  }

  private all(sql: string, ...params: SqlValue[]) {
    return this.d.all(sql, params);
  }
  private get(sql: string, ...params: SqlValue[]) {
    return this.d.get(sql, params);
  }
  private run(sql: string, ...params: SqlValue[]) {
    return this.d.run(sql, params);
  }

  /** Tables and later columns, once. */
  private schema() {
    this.ready ??= (async () => {
      await this.d.exec(SCHEMA);
      for (const [table, column, def] of MIGRATIONS) {
        const has = (await this.d.all(`PRAGMA table_info(${table})`)).some((c) => c.name === column);
        if (!has) await this.d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    })();
    return this.ready;
  }

  async init(indexes: IndexSpec[]) {
    await this.schema();
    for (const { model, fields } of indexes) {
      for (const f of fields) {
        if (!SAFE_IDENT.test(model) || !SAFE_IDENT.test(f)) continue;
        await this.d.exec(`CREATE INDEX IF NOT EXISTS idx_${model}_${f} ON entries(json_extract(data, ${jsonPath(f)})) WHERE model = '${model}'`);
      }
    }
  }

  async close() {
    await this.d.close();
  }

  async getEntry(id: string) {
    const r = await this.get("SELECT * FROM entries WHERE id = ?", id);
    return r ? entryFrom(r) : null;
  }

  async findOne(model: string, field: string, value: unknown, locale?: string) {
    const r = locale
      ? await this.get(`SELECT * FROM entries WHERE model = ? AND locale = ? AND json_extract(data, ${jsonPath(field)}) = ? LIMIT 1`, model, locale, toSql(value))
      : await this.get(`SELECT * FROM entries WHERE model = ? AND json_extract(data, ${jsonPath(field)}) = ? LIMIT 1`, model, toSql(value));
    return r ? entryFrom(r) : null;
  }

  async list(q: ListQuery) {
    const where = ["model = ?"];
    const params: SqlValue[] = [q.model];
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
    const total = Number((await this.get(`SELECT COUNT(*) AS n FROM entries WHERE ${clause}`, ...params))?.n ?? 0);
    const items = (await this.all(`SELECT * FROM entries WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, q.limit, q.offset)).map(entryFrom);
    return { items, total };
  }

  async scan(models: string[], limit: number) {
    if (!models.length) return [];
    const marks = models.map(() => "?").join(", ");
    return (await this.all(`SELECT * FROM entries WHERE model IN (${marks}) ORDER BY updated_at DESC LIMIT ?`, ...models, limit)).map(entryFrom);
  }

  async versions(entryId: string): Promise<VersionRow[]> {
    return (await this.all("SELECT * FROM versions WHERE entry_id = ? ORDER BY version DESC", entryId)).map((r) => ({
      entryId: r.entry_id as string,
      version: Number(r.version),
      data: r.data ? JSON.parse(r.data as string) : null,
      changesetId: (r.changeset_id as string) ?? null,
      actor: r.actor as string,
      createdAt: r.created_at as string,
    }));
  }

  async getChangeset(id: string) {
    const r = await this.get("SELECT * FROM changesets WHERE id = ?", id);
    return r ? changesetFrom(r) : null;
  }

  async findOpenChangeset(actor: string) {
    const r = await this.get("SELECT * FROM changesets WHERE actor = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1", actor);
    return r ? changesetFrom(r) : null;
  }

  async createChangeset(c: ChangesetRow) {
    await this.run(
      `INSERT INTO changesets (id, actor, status, note, comment, review_reason, items, issues, created_at, updated_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id, c.actor, c.status, toSql(c.note), toSql(c.comment), toSql(c.reviewReason),
      JSON.stringify(c.items), JSON.stringify(c.issues), c.createdAt, c.updatedAt, metaSql(c),
    );
  }

  async saveChangeset(c: ChangesetRow) {
    await this.run(
      `UPDATE changesets SET status = ?, note = ?, comment = ?, review_reason = ?, items = ?, issues = ?,
       updated_at = ?, merged_at = ?, merged_by = ?, meta = ? WHERE id = ?`,
      c.status, toSql(c.note), toSql(c.comment), toSql(c.reviewReason), JSON.stringify(c.items),
      JSON.stringify(c.issues), c.updatedAt, toSql(c.mergedAt), toSql(c.mergedBy), metaSql(c), c.id,
    );
  }

  async listChangesets(q: { actor?: string; status?: ChangesetRow["status"][]; limit: number }) {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.actor) { where.push("actor = ?"); params.push(q.actor); }
    if (q.status?.length) { where.push(`status IN (${q.status.map(() => "?").join(", ")})`); params.push(...q.status); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (await this.all(`SELECT * FROM changesets ${clause} ORDER BY updated_at DESC LIMIT ?`, ...params, q.limit)).map(changesetFrom);
  }

  async mergeChangeset(id: string, by: string, at: string) {
    const row = await this.get("SELECT * FROM changesets WHERE id = ?", id);
    if (!row) throw new Error(`Changeset ${id} not found`);
    const cs = changesetFrom(row);
    const touched: EntryRow[] = [];
    const statements: { sql: string; params: SqlValue[] }[] = [];
    const add = (sql: string, ...params: SqlValue[]) => statements.push({ sql, params });
    for (const item of cs.items) {
      if (item.op === "install") continue;
      const current = await this.getEntry(item.id);
      if (item.op === "create") {
        if (current) throw new ConflictError(item.id, `Entry ${item.id} already exists`);
        const data = item.data ?? {};
        // A restored entry keeps its id, so its history continues where it stopped.
        const version = Number((await this.get("SELECT MAX(version) AS v FROM versions WHERE entry_id = ?", item.id))?.v ?? 0) + 1;
        add(
          `INSERT INTO entries (id, model, locale, data, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          item.id, item.model, item.locale, JSON.stringify(data), version, at, at, cs.actor, cs.actor,
        );
        add("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)", item.id, version, JSON.stringify(data), cs.id, cs.actor, at);
        touched.push({ id: item.id, model: item.model, locale: item.locale, data, version, createdAt: at, updatedAt: at, createdBy: cs.actor, updatedBy: cs.actor });
        continue;
      }
      if (!current) throw new ConflictError(item.id, `Entry ${item.id} was deleted after it was drafted`);
      if (item.baseVersion !== undefined && current.version !== item.baseVersion) {
        throw new ConflictError(item.id, `Entry ${item.id} changed after it was drafted (v${item.baseVersion} → v${current.version})`);
      }
      const version = current.version + 1;
      // The (entry_id, version) primary key turns any concurrent change into a conflict.
      if (item.op === "delete") {
        add("DELETE FROM entries WHERE id = ? AND version = ?", item.id, current.version);
        add("INSERT INTO versions VALUES (?, ?, NULL, ?, ?, ?)", item.id, version, cs.id, cs.actor, at);
        touched.push({ ...current, version, updatedAt: at, updatedBy: cs.actor });
        continue;
      }
      const data = applyPatch(current.data, item.data ?? {});
      add("UPDATE entries SET data = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?", JSON.stringify(data), version, at, cs.actor, item.id, current.version);
      add("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)", item.id, version, JSON.stringify(data), cs.id, cs.actor, at);
      touched.push({ ...current, data, version, updatedAt: at, updatedBy: cs.actor });
    }
    add("UPDATE changesets SET status = 'merged', merged_at = ?, merged_by = ?, updated_at = ?, issues = '[]' WHERE id = ?", at, by, at, id);
    try {
      await this.d.batch(statements);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(msg)) throw new ConflictError(touched[0]?.id ?? id, "An entry changed while this changeset was being merged");
      throw e;
    }
    return touched;
  }

  async logEvent(e: EventRow) {
    await this.run(
      "INSERT INTO events (at, actor, gate, action, input, ok, error, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      e.at, e.actor, e.gate, e.action, toSql(e.input), e.ok ? 1 : 0, toSql(e.error), e.ms,
    );
  }

  async countEvents(actor: string, sinceIso: string) {
    return Number((await this.get("SELECT COUNT(*) AS n FROM events WHERE actor = ? AND at >= ?", actor, sinceIso))?.n ?? 0);
  }

  async listEvents(q: { actor?: string; limit: number; before?: number }) {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.actor) { where.push("actor = ?"); params.push(q.actor); }
    if (q.before) { where.push("id < ?"); params.push(q.before); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.all(`SELECT * FROM events ${clause} ORDER BY id DESC LIMIT ?`, ...params, q.limit);
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

  async actorStats(sinceIso: string) {
    return (await this.all(
      "SELECT actor, MAX(at) AS last_at, SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS recent FROM events GROUP BY actor",
      sinceIso,
    )).map((r) => ({ actor: r.actor as string, lastAt: r.last_at as string, recent: Number(r.recent ?? 0) }));
  }

  // ---------- module storage ----------

  async kvGet(scope: string, key: string) {
    const r = await this.get("SELECT value FROM kv WHERE scope = ? AND key = ?", scope, key);
    return r ? JSON.parse(r.value as string) : undefined;
  }

  async kvSet(scope: string, key: string, value: unknown) {
    await this.run("INSERT INTO kv (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", scope, key, JSON.stringify(value));
  }

  async kvDelete(scope: string, key: string) {
    await this.run("DELETE FROM kv WHERE scope = ? AND key = ?", scope, key);
  }

  async kvList(scope: string, prefix = "") {
    return (await this.all("SELECT key, value FROM kv WHERE scope = ? AND key >= ? AND key < ? ORDER BY key", scope, prefix, prefix + "\uffff")).map((r) => ({
      key: r.key as string,
      value: JSON.parse(r.value as string),
    }));
  }

  // ---------- full-text index ----------
  // A small inverted index in plain tables, so search works on every Node build
  // (node:sqlite ships without FTS). Scoring is TF-IDF; title terms are weighted up front.

  async textUpsert(doc: TextDoc) {
    await this.d.batch([
      { sql: "DELETE FROM text_terms WHERE doc = ?", params: [doc.id] },
      {
        sql: "INSERT INTO text_docs (id, model, locale, title, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model, locale = excluded.locale, title = excluded.title, body = excluded.body",
        params: [doc.id, doc.model, doc.locale, doc.title, doc.body],
      },
      ...Object.entries(doc.terms).map(([term, tf]) => ({ sql: "INSERT INTO text_terms (term, doc, tf) VALUES (?, ?, ?)", params: [term, doc.id, tf] as SqlValue[] })),
    ]);
  }

  async textRemove(id: string) {
    await this.d.batch([
      { sql: "DELETE FROM text_terms WHERE doc = ?", params: [id] },
      { sql: "DELETE FROM text_docs WHERE id = ?", params: [id] },
    ]);
  }

  async textSearch(q: { terms: string[]; prefixLast: boolean; models: string[]; locale?: string; limit: number }): Promise<TextHit[]> {
    if (!q.terms.length || !q.models.length) return [];
    const total = Number((await this.get("SELECT COUNT(*) AS n FROM text_docs"))?.n ?? 0) || 1;
    const scores = new Map<string, { score: number; matched: number }>();
    for (const [i, term] of q.terms.entries()) {
      const prefix = q.prefixLast && i === q.terms.length - 1;
      const rows = prefix
        ? await this.all("SELECT term, doc, tf FROM text_terms WHERE term >= ? AND term < ?", term, term + "\uffff")
        : await this.all("SELECT term, doc, tf FROM text_terms WHERE term = ?", term);
      const df = new Set(rows.map((r) => r.doc)).size || 1;
      const idf = Math.log(1 + total / df);
      const best = new Map<string, number>();
      for (const r of rows) best.set(r.doc as string, Math.max(best.get(r.doc as string) ?? 0, Number(r.tf)));
      for (const [doc, tf] of best) {
        const s = scores.get(doc) ?? { score: 0, matched: 0 };
        s.score += (1 + Math.log(tf)) * idf;
        s.matched += 1;
        scores.set(doc, s);
      }
    }
    if (!scores.size) return [];
    const ids = [...scores.keys()];
    const out: TextHit[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const params: SqlValue[] = [...chunk, ...q.models];
      let sql = `SELECT * FROM text_docs WHERE id IN (${chunk.map(() => "?").join(",")}) AND model IN (${q.models.map(() => "?").join(",")})`;
      if (q.locale) { sql += " AND locale = ?"; params.push(q.locale); }
      for (const r of await this.all(sql, ...params)) {
        const s = scores.get(r.id as string)!;
        out.push({ id: r.id as string, model: r.model as string, locale: r.locale as string, title: r.title as string, body: r.body as string, score: s.score, matched: s.matched });
      }
    }
    // Documents that match every term come first, then by score.
    return out.sort((a, b) => b.matched - a.matched || b.score - a.score).slice(0, q.limit);
  }

  async textCount() {
    return Number((await this.get("SELECT COUNT(*) AS n FROM text_docs"))?.n ?? 0);
  }

  async textClear() {
    await this.d.exec("DELETE FROM text_terms; DELETE FROM text_docs;");
  }

  // ---------- media ----------

  private mediaFrom(r: Row): MediaRow {
    return {
      id: r.id as string,
      url: r.url as string,
      filename: (r.filename as string) ?? "",
      mime: (r.mime as string) ?? "application/octet-stream",
      size: Number(r.size ?? 0),
      ...(r.width != null ? { width: Number(r.width) } : {}),
      ...(r.height != null ? { height: Number(r.height) } : {}),
      ...(r.alt ? { alt: r.alt as string } : {}),
      ...(r.meta ? { meta: JSON.parse(r.meta as string) } : {}),
      createdAt: r.created_at as string,
      createdBy: r.created_by as string,
    };
  }

  async createMedia(m: MediaRow) {
    await this.run(
      "INSERT INTO media (id, url, filename, mime, size, width, height, alt, meta, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.id, m.url, m.filename, m.mime, m.size, toSql(m.width), toSql(m.height), toSql(m.alt), toSql(m.meta), m.createdAt, m.createdBy,
    );
  }

  async getMedia(id: string) {
    const r = await this.get("SELECT * FROM media WHERE id = ?", id);
    return r ? this.mediaFrom(r) : null;
  }

  async listMedia(q: { query?: string; missingAlt?: boolean; limit: number; offset: number }) {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.query) { where.push("(filename LIKE ? OR alt LIKE ?)"); params.push(`%${q.query}%`, `%${q.query}%`); }
    if (q.missingAlt) where.push("(alt IS NULL OR alt = '')");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.get(`SELECT COUNT(*) AS n FROM media ${clause}`, ...params))?.n ?? 0);
    const items = (await this.all(`SELECT * FROM media ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, q.limit, q.offset)).map((r) => this.mediaFrom(r));
    return { items, total };
  }

  async updateMedia(id: string, patch: Partial<Pick<MediaRow, "alt" | "meta">>) {
    const current = await this.getMedia(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.run("UPDATE media SET alt = ?, meta = ? WHERE id = ?", toSql(next.alt || null), toSql(next.meta), id);
    return next;
  }

  async deleteMedia(id: string) {
    return (await this.run("DELETE FROM media WHERE id = ?", id)).changes > 0;
  }

  async createToken(t: TokenRow) {
    await this.run(
      "INSERT INTO tokens (id, agent, hash, created_at, kind, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      t.id, t.agent, t.hash, t.createdAt, t.kind ?? "agent", toSql(t.expiresAt),
    );
  }

  async findToken(hash: string, nowIso: string) {
    const r = await this.get(
      "SELECT id, agent, kind FROM tokens WHERE hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      hash, nowIso,
    );
    return r ? { id: r.id as string, agent: r.agent as string, kind: r.kind as TokenKind } : null;
  }

  async revokeToken(id: string, at: string) {
    return (await this.run("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", at, id)).changes > 0;
  }

  async revokeTokens(agent: string, at: string) {
    return (await this.run("UPDATE tokens SET revoked_at = ? WHERE agent = ? AND revoked_at IS NULL", at, agent)).changes;
  }

  async listTokens() {
    return (await this.all("SELECT id, agent, kind, created_at, expires_at, revoked_at FROM tokens WHERE kind != 'login' ORDER BY created_at DESC")).map((r) => ({
      id: r.id as string,
      agent: r.agent as string,
      kind: r.kind as TokenKind,
      createdAt: r.created_at as string,
      ...(r.expires_at ? { expiresAt: r.expires_at as string } : {}),
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
