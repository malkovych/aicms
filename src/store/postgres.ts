// Postgres storage: the same Store contract as SQLite, on JSONB.
// Works with node-postgres (`postgres({ url })`) or any client that speaks
// "query(sql, params)", such as PGlite (`postgres({ driver: pgliteDriver(db) })`).

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

/** The minimum a Postgres client must do. */
export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; count: number }>;
}

export interface SqlDriver extends SqlRunner {
  /** Run several statements without parameters (schema setup). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresOptions {
  kind: "postgres";
  /** Connection string, e.g. postgres://user:pass@host:5432/db. Needs `npm install pg`. */
  url?: string;
  /** A ready driver instead of a URL (PGlite, a shared pool, tests). */
  driver?: SqlDriver;
  /** Pool size for node-postgres. Default 10. */
  max?: number;
}

/** Postgres storage. `postgres({ url: process.env.DATABASE_URL })` */
export function postgres(opts: Omit<PostgresOptions, "kind"> = {}): PostgresOptions {
  return { kind: "postgres", ...opts, url: opts.url ?? (opts.driver ? undefined : process.env.DATABASE_URL) };
}

/** Wrap a node-postgres Pool. */
export function pgDriver(pool: {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>; release(): void }>;
  end(): Promise<void>;
}): SqlDriver {
  const wrap = (q: typeof pool.query) => async (sql: string, params?: unknown[]) => {
    const r = await q(sql, params);
    return { rows: r.rows, count: r.rowCount ?? 0 };
  };
  return {
    query: wrap(pool.query.bind(pool)),
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: wrap(client.query.bind(client)) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Wrap a PGlite instance (Postgres in WebAssembly): handy for tests and local tools. */
export function pgliteDriver(db: {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; affectedRows?: number }> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}): SqlDriver {
  const run = async (q: { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; affectedRows?: number }> }, sql: string, params?: unknown[]) => {
    const r = await q.query(sql, params);
    return { rows: r.rows, count: r.affectedRows ?? 0 };
  };
  return {
    query: (sql, params) => run(db, sql, params),
    async exec(sql) {
      await db.exec(sql);
    },
    transaction: (fn) => db.transaction((tx) => fn({ query: (sql, params) => run(tx, sql, params) })),
    close: () => db.close(),
  };
}

/** Open the store for `postgres({ url })`, loading node-postgres on demand. */
export async function openPostgres(opts: PostgresOptions): Promise<PostgresStore> {
  if (opts.driver) return new PostgresStore(opts.driver);
  if (!opts.url) throw new Error("postgres() needs a url (or DATABASE_URL) or a driver");
  let pg: any;
  try {
    pg = await import("pg");
  } catch {
    throw new Error('Postgres needs the "pg" package: npm install pg');
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  return new PostgresStore(pgDriver(new Pool({ connectionString: opts.url, max: opts.max ?? 10 })));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  locale TEXT NOT NULL,
  data JSONB NOT NULL,
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
  data JSONB,
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
  items JSONB NOT NULL,
  issues JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  merged_at TEXT,
  merged_by TEXT,
  meta JSONB
);
ALTER TABLE changesets ADD COLUMN IF NOT EXISTS meta JSONB;
CREATE INDEX IF NOT EXISTS changesets_actor ON changesets(actor, status);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  gate TEXT NOT NULL,
  action TEXT NOT NULL,
  input TEXT,
  ok BOOLEAN NOT NULL,
  error TEXT,
  ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_actor ON events(actor, at);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  alt TEXT,
  meta JSONB,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
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
CREATE INDEX IF NOT EXISTS text_terms_prefix ON text_terms(term text_pattern_ops);

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

const SAFE_IDENT = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const field = (f: string) => {
  if (!SAFE_IDENT.test(f)) throw new Error(`Invalid field name: ${f}`);
  return `data->'${f}'`;
};
const json = (v: unknown) => JSON.stringify(v ?? null);

function entryFrom(r: any): EntryRow {
  return {
    id: r.id,
    model: r.model,
    locale: r.locale,
    data: r.data,
    version: Number(r.version),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
}

function metaJson(c: ChangesetRow): string | null {
  const meta = changesetMeta(c);
  return meta ? json(meta) : null;
}

function changesetFrom(r: any): ChangesetRow {
  return {
    id: r.id,
    actor: r.actor,
    status: r.status,
    note: r.note ?? undefined,
    comment: r.comment ?? undefined,
    reviewReason: r.review_reason ?? undefined,
    items: r.items,
    issues: r.issues,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mergedAt: r.merged_at ?? undefined,
    mergedBy: r.merged_by ?? undefined,
    ...(r.meta ?? {}),
  };
}

function mediaFrom(r: any): MediaRow {
  return {
    id: r.id,
    url: r.url,
    filename: r.filename ?? "",
    mime: r.mime ?? "application/octet-stream",
    size: Number(r.size ?? 0),
    ...(r.width != null ? { width: Number(r.width) } : {}),
    ...(r.height != null ? { height: Number(r.height) } : {}),
    ...(r.alt ? { alt: r.alt } : {}),
    ...(r.meta ? { meta: r.meta } : {}),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

export class PostgresStore implements Store {
  private d: SqlDriver;
  constructor(driver: SqlDriver) {
    this.d = driver;
  }

  private async all(sql: string, params: unknown[] = []) {
    return (await this.d.query(sql, params)).rows;
  }
  private async one(sql: string, params: unknown[] = []) {
    return (await this.d.query(sql, params)).rows[0];
  }

  async init(indexes: IndexSpec[]) {
    await this.d.exec(SCHEMA);
    for (const { model, fields } of indexes) {
      for (const f of fields) {
        if (!SAFE_IDENT.test(model) || !SAFE_IDENT.test(f)) continue;
        await this.d.exec(`CREATE INDEX IF NOT EXISTS idx_${model}_${f} ON entries ((data->'${f}')) WHERE model = '${model}'`);
      }
    }
  }

  close() {
    return this.d.close();
  }

  async getEntry(id: string) {
    const r = await this.one("SELECT * FROM entries WHERE id = $1", [id]);
    return r ? entryFrom(r) : null;
  }

  async findOne(model: string, f: string, value: unknown, locale?: string) {
    const r = locale
      ? await this.one(`SELECT * FROM entries WHERE model = $1 AND locale = $2 AND ${field(f)} = $3::jsonb LIMIT 1`, [model, locale, json(value)])
      : await this.one(`SELECT * FROM entries WHERE model = $1 AND ${field(f)} = $2::jsonb LIMIT 1`, [model, json(value)]);
    return r ? entryFrom(r) : null;
  }

  async list(q: ListQuery) {
    const where = ["model = $1"];
    const params: unknown[] = [q.model];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (q.locale) where.push(`locale = ${p(q.locale)}`);
    for (const [f, value] of Object.entries(q.where ?? {})) {
      if (q.arrayFields?.includes(f)) where.push(`${field(f)} @> ${p(json([value]))}::jsonb`);
      else if (value === null) where.push(`(${field(f)} IS NULL OR ${field(f)} = 'null'::jsonb)`);
      else where.push(`${field(f)} = ${p(json(value))}::jsonb`);
    }
    const clause = where.join(" AND ");
    const order = q.order ? `${field(q.order.field)} ${q.order.desc ? "DESC NULLS LAST" : "ASC NULLS FIRST"}, updated_at DESC` : "updated_at DESC";
    const total = Number((await this.one(`SELECT COUNT(*) AS n FROM entries WHERE ${clause}`, params)).n);
    const items = (await this.all(`SELECT * FROM entries WHERE ${clause} ORDER BY ${order} LIMIT ${p(q.limit)} OFFSET ${p(q.offset)}`, params)).map(entryFrom);
    return { items, total };
  }

  async scan(models: string[], limit: number) {
    if (!models.length) return [];
    return (await this.all("SELECT * FROM entries WHERE model = ANY($1) ORDER BY updated_at DESC LIMIT $2", [models, limit])).map(entryFrom);
  }

  async versions(entryId: string): Promise<VersionRow[]> {
    return (await this.all("SELECT * FROM versions WHERE entry_id = $1 ORDER BY version DESC", [entryId])).map((r) => ({
      entryId: r.entry_id,
      version: Number(r.version),
      data: r.data ?? null,
      changesetId: r.changeset_id ?? null,
      actor: r.actor,
      createdAt: r.created_at,
    }));
  }

  async getChangeset(id: string) {
    const r = await this.one("SELECT * FROM changesets WHERE id = $1", [id]);
    return r ? changesetFrom(r) : null;
  }

  async findOpenChangeset(actor: string) {
    const r = await this.one("SELECT * FROM changesets WHERE actor = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1", [actor]);
    return r ? changesetFrom(r) : null;
  }

  async createChangeset(c: ChangesetRow) {
    await this.d.query(
      `INSERT INTO changesets (id, actor, status, note, comment, review_reason, items, issues, created_at, updated_at, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb)`,
      [c.id, c.actor, c.status, c.note ?? null, c.comment ?? null, c.reviewReason ?? null, json(c.items), json(c.issues), c.createdAt, c.updatedAt, metaJson(c)],
    );
  }

  async saveChangeset(c: ChangesetRow) {
    await this.d.query(
      `UPDATE changesets SET status = $1, note = $2, comment = $3, review_reason = $4, items = $5::jsonb, issues = $6::jsonb,
       updated_at = $7, merged_at = $8, merged_by = $9, meta = $10::jsonb WHERE id = $11`,
      [c.status, c.note ?? null, c.comment ?? null, c.reviewReason ?? null, json(c.items), json(c.issues), c.updatedAt, c.mergedAt ?? null, c.mergedBy ?? null, metaJson(c), c.id],
    );
  }

  async listChangesets(q: { actor?: string; status?: ChangesetRow["status"][]; limit: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.actor) { params.push(q.actor); where.push(`actor = $${params.length}`); }
    if (q.status?.length) { params.push(q.status); where.push(`status = ANY($${params.length})`); }
    params.push(q.limit);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (await this.all(`SELECT * FROM changesets ${clause} ORDER BY updated_at DESC LIMIT $${params.length}`, params)).map(changesetFrom);
  }

  async mergeChangeset(id: string, by: string, at: string) {
    return this.d.transaction(async (tx) => {
      const row = (await tx.query("SELECT * FROM changesets WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!row) throw new Error(`Changeset ${id} not found`);
      const cs = changesetFrom(row);
      const touched: EntryRow[] = [];
      for (const item of cs.items) {
        if (item.op === "install") continue;
        const cur = (await tx.query("SELECT * FROM entries WHERE id = $1 FOR UPDATE", [item.id])).rows[0];
        const current = cur ? entryFrom(cur) : null;
        if (item.op === "create") {
          if (current) throw new ConflictError(item.id, `Entry ${item.id} already exists`);
          const data = item.data ?? {};
          // A restored entry keeps its id, so its history continues where it stopped.
          const version = Number((await tx.query("SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE entry_id = $1", [item.id])).rows[0].v) + 1;
          await tx.query(
            `INSERT INTO entries (id, model, locale, data, version, created_at, updated_at, created_by, updated_by)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6, $7, $7)`,
            [item.id, item.model, item.locale, json(data), version, at, cs.actor],
          );
          await tx.query("INSERT INTO versions VALUES ($1, $2, $3::jsonb, $4, $5, $6)", [item.id, version, json(data), cs.id, cs.actor, at]);
          touched.push({ id: item.id, model: item.model, locale: item.locale, data, version, createdAt: at, updatedAt: at, createdBy: cs.actor, updatedBy: cs.actor });
          continue;
        }
        if (!current) throw new ConflictError(item.id, `Entry ${item.id} was deleted after it was drafted`);
        if (item.baseVersion !== undefined && current.version !== item.baseVersion) {
          throw new ConflictError(item.id, `Entry ${item.id} changed after it was drafted (v${item.baseVersion} → v${current.version})`);
        }
        const version = current.version + 1;
        if (item.op === "delete") {
          await tx.query("DELETE FROM entries WHERE id = $1", [item.id]);
          await tx.query("INSERT INTO versions VALUES ($1, $2, NULL, $3, $4, $5)", [item.id, version, cs.id, cs.actor, at]);
          touched.push({ ...current, version, updatedAt: at, updatedBy: cs.actor });
          continue;
        }
        const data = applyPatch(current.data, item.data ?? {});
        await tx.query("UPDATE entries SET data = $1::jsonb, version = $2, updated_at = $3, updated_by = $4 WHERE id = $5", [json(data), version, at, cs.actor, item.id]);
        await tx.query("INSERT INTO versions VALUES ($1, $2, $3::jsonb, $4, $5, $6)", [item.id, version, json(data), cs.id, cs.actor, at]);
        touched.push({ ...current, data, version, updatedAt: at, updatedBy: cs.actor });
      }
      await tx.query("UPDATE changesets SET status = 'merged', merged_at = $1, merged_by = $2, updated_at = $1, issues = '[]'::jsonb WHERE id = $3", [at, by, id]);
      return touched;
    });
  }

  async logEvent(e: EventRow) {
    await this.d.query("INSERT INTO events (at, actor, gate, action, input, ok, error, ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
      e.at, e.actor, e.gate, e.action, e.input ?? null, e.ok, e.error ?? null, e.ms,
    ]);
  }

  async countEvents(actor: string, sinceIso: string) {
    return Number((await this.one("SELECT COUNT(*) AS n FROM events WHERE actor = $1 AND at >= $2", [actor, sinceIso])).n);
  }

  async listEvents(q: { actor?: string; limit: number; before?: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.actor) { params.push(q.actor); where.push(`actor = $${params.length}`); }
    if (q.before) { params.push(q.before); where.push(`id < $${params.length}`); }
    params.push(q.limit);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (await this.all(`SELECT * FROM events ${clause} ORDER BY id DESC LIMIT $${params.length}`, params)).map((r) => ({
      id: Number(r.id),
      at: r.at,
      actor: r.actor,
      gate: r.gate,
      action: r.action,
      input: r.input ?? undefined,
      ok: !!r.ok,
      error: r.error ?? undefined,
      ms: Number(r.ms),
    }));
  }

  async actorStats(sinceIso: string) {
    return (await this.all("SELECT actor, MAX(at) AS last_at, SUM(CASE WHEN at >= $1 THEN 1 ELSE 0 END) AS recent FROM events GROUP BY actor", [sinceIso])).map((r) => ({
      actor: r.actor,
      lastAt: r.last_at,
      recent: Number(r.recent ?? 0),
    }));
  }

  // ---------- module storage ----------

  async kvGet(scope: string, key: string) {
    return (await this.one("SELECT value FROM kv WHERE scope = $1 AND key = $2", [scope, key]))?.value;
  }
  async kvSet(scope: string, key: string, value: unknown) {
    await this.d.query("INSERT INTO kv (scope, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value", [scope, key, json(value)]);
  }
  async kvDelete(scope: string, key: string) {
    await this.d.query("DELETE FROM kv WHERE scope = $1 AND key = $2", [scope, key]);
  }
  async kvList(scope: string, prefix = "") {
    return (await this.all("SELECT key, value FROM kv WHERE scope = $1 AND starts_with(key, $2) ORDER BY key", [scope, prefix])).map((r) => ({ key: r.key, value: r.value }));
  }

  // ---------- full-text index ----------

  async textUpsert(doc: TextDoc) {
    await this.d.transaction(async (tx) => {
      await tx.query("DELETE FROM text_terms WHERE doc = $1", [doc.id]);
      await tx.query(
        "INSERT INTO text_docs (id, model, locale, title, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET model = EXCLUDED.model, locale = EXCLUDED.locale, title = EXCLUDED.title, body = EXCLUDED.body",
        [doc.id, doc.model, doc.locale, doc.title, doc.body],
      );
      const terms = Object.entries(doc.terms);
      if (terms.length) {
        await tx.query("INSERT INTO text_terms (term, doc, tf) SELECT t, $1, f FROM unnest($2::text[], $3::real[]) AS u(t, f)", [doc.id, terms.map(([t]) => t), terms.map(([, f]) => f)]);
      }
    });
  }

  async textRemove(id: string) {
    await this.d.transaction(async (tx) => {
      await tx.query("DELETE FROM text_terms WHERE doc = $1", [id]);
      await tx.query("DELETE FROM text_docs WHERE id = $1", [id]);
    });
  }

  async textSearch(q: { terms: string[]; prefixLast: boolean; models: string[]; locale?: string; limit: number }): Promise<TextHit[]> {
    if (!q.terms.length || !q.models.length) return [];
    const total = Number((await this.one("SELECT COUNT(*) AS n FROM text_docs")).n) || 1;
    const scores = new Map<string, { score: number; matched: number }>();
    for (const [i, term] of q.terms.entries()) {
      const prefix = q.prefixLast && i === q.terms.length - 1;
      const rows = prefix
        ? await this.all("SELECT doc, MAX(tf) AS tf FROM text_terms WHERE starts_with(term, $1) GROUP BY doc", [term])
        : await this.all("SELECT doc, tf FROM text_terms WHERE term = $1", [term]);
      const idf = Math.log(1 + total / (rows.length || 1));
      for (const r of rows) {
        const s = scores.get(r.doc) ?? { score: 0, matched: 0 };
        s.score += (1 + Math.log(Number(r.tf))) * idf;
        s.matched += 1;
        scores.set(r.doc, s);
      }
    }
    if (!scores.size) return [];
    const params: unknown[] = [[...scores.keys()], q.models];
    let sql = "SELECT * FROM text_docs WHERE id = ANY($1) AND model = ANY($2)";
    if (q.locale) { params.push(q.locale); sql += " AND locale = $3"; }
    const out: TextHit[] = (await this.all(sql, params)).map((r) => {
      const s = scores.get(r.id)!;
      return { id: r.id, model: r.model, locale: r.locale, title: r.title, body: r.body, score: s.score, matched: s.matched };
    });
    return out.sort((a, b) => b.matched - a.matched || b.score - a.score).slice(0, q.limit);
  }

  async textCount() {
    return Number((await this.one("SELECT COUNT(*) AS n FROM text_docs")).n);
  }
  async textClear() {
    await this.d.exec("DELETE FROM text_terms; DELETE FROM text_docs;");
  }

  // ---------- media ----------

  async createMedia(m: MediaRow) {
    await this.d.query(
      "INSERT INTO media (id, url, filename, mime, size, width, height, alt, meta, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)",
      [m.id, m.url, m.filename, m.mime, m.size, m.width ?? null, m.height ?? null, m.alt ?? null, m.meta ? json(m.meta) : null, m.createdAt, m.createdBy],
    );
  }
  async getMedia(id: string) {
    const r = await this.one("SELECT * FROM media WHERE id = $1", [id]);
    return r ? mediaFrom(r) : null;
  }
  async listMedia(q: { query?: string; missingAlt?: boolean; limit: number; offset: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.query) { params.push(`%${q.query}%`); where.push(`(filename ILIKE $${params.length} OR alt ILIKE $${params.length})`); }
    if (q.missingAlt) where.push("(alt IS NULL OR alt = '')");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.one(`SELECT COUNT(*) AS n FROM media ${clause}`, params)).n);
    const items = (await this.all(`SELECT * FROM media ${clause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.limit, q.offset])).map(mediaFrom);
    return { items, total };
  }
  async updateMedia(id: string, patch: Partial<Pick<MediaRow, "alt" | "meta">>) {
    const current = await this.getMedia(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.d.query("UPDATE media SET alt = $1, meta = $2::jsonb WHERE id = $3", [next.alt || null, next.meta ? json(next.meta) : null, id]);
    return next;
  }
  async deleteMedia(id: string) {
    return (await this.d.query("DELETE FROM media WHERE id = $1", [id])).count > 0;
  }

  // ---------- tokens ----------

  async createToken(t: TokenRow) {
    await this.d.query("INSERT INTO tokens (id, agent, hash, created_at, kind, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [t.id, t.agent, t.hash, t.createdAt, t.kind ?? "agent", t.expiresAt ?? null]);
  }
  async findToken(hash: string, nowIso: string) {
    const r = await this.one("SELECT id, agent, kind FROM tokens WHERE hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)", [hash, nowIso]);
    return r ? { id: r.id as string, agent: r.agent as string, kind: r.kind as TokenKind } : null;
  }
  async revokeToken(id: string, at: string) {
    return (await this.d.query("UPDATE tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL", [at, id])).count > 0;
  }
  async revokeTokens(agent: string, at: string) {
    return (await this.d.query("UPDATE tokens SET revoked_at = $1 WHERE agent = $2 AND revoked_at IS NULL", [at, agent])).count;
  }
  async listTokens() {
    return (await this.all("SELECT id, agent, kind, created_at, expires_at, revoked_at FROM tokens WHERE kind <> 'login' ORDER BY created_at DESC")).map((r) => ({
      id: r.id,
      agent: r.agent,
      kind: r.kind as TokenKind,
      createdAt: r.created_at,
      ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
      revokedAt: r.revoked_at ?? null,
    }));
  }
}

/** Shallow patch: `null` removes a key, anything else replaces it. */
function applyPatch(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out;
}
