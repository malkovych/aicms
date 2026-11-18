// @aicms/client — a typed client for one AICMS site. Works in Node 18+,
// browsers, Deno, Bun and edge runtimes: it only needs fetch.
//
//   import { createClient } from "@aicms/client"
//   import type { Schema } from "./aicms-types"   // from `aicms types`
//   const cms = createClient<Schema>({ url: "https://cms.example.com", token })
//   const post = await cms.post.get({ slug: "hello" })

export { blocksToHtml, parseInline, inlineToHtml, escapeHtml, safeUrl, type Block, type Inline, type HtmlOptions, type BlockRenderer } from "./blocks.ts";
import type { Block } from "./blocks.ts";

export interface Media {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

/** Model name → entry data. `aicms types` generates one for your site. */
export type AnySchema = Record<string, Record<string, any>>;

export type Entry<T> = T & { id: string; locale: string; version: number; updatedAt: string };

/** What a draft may send: Markdown for block fields, a URL for media, null to clear. */
export type DraftData<T> = {
  [K in keyof T]?: (NonNullable<T[K]> extends Block[] ? T[K] | string : NonNullable<T[K]> extends Media ? T[K] | string : T[K]) | null;
};

type Scalar = string | number | boolean | null;
type Key<T> = Extract<keyof T, string>;

export interface ListParams<T> {
  /** Exact-match filters on indexed fields; list fields match when they contain the value. */
  where?: Partial<Record<Key<T>, Scalar>>;
  fields?: Key<T>[];
  /** A field name; prefix with "-" for descending. */
  order?: Key<T> | `-${Key<T>}`;
  limit?: number;
  offset?: number;
  locale?: string;
  format?: "blocks" | "markdown";
}

export type GetParams<T> = {
  id?: string;
  fields?: Key<T>[];
  locale?: string;
  format?: "blocks" | "markdown";
  /** Include your own unpublished changes (by id only). */
  drafts?: boolean;
} & (string extends Key<T> ? Record<string, unknown> : Partial<Record<Key<T>, string>>);

export interface ListResult<T> {
  items: Entry<T>[];
  total: number;
  limit: number;
  offset: number;
}

export interface DraftResult {
  changeset: string;
  op: "create" | "update";
  id: string;
  model: string;
  entry: Record<string, unknown>;
  next: string;
}

export interface CheckIssue {
  entry: string;
  model: string;
  field?: string;
  message: string;
}

export interface SubmitResult {
  status: "merged" | "submitted" | "needs_changes";
  changeset: string;
  reason?: string;
  issues?: CheckIssue[];
  entries?: { id: string; model: string; op: string; version: number }[];
}

export interface FeedEvent<P = any> {
  id: number;
  event: string;
  payload: P;
  at: string;
}

export interface ModelClient<T> {
  list(params?: ListParams<T>): Promise<ListResult<T>>;
  /** By id (`get("pos_1")`) or by a unique field (`get({ slug: "hello" })`). */
  get(params: string | GetParams<T>): Promise<Entry<T>>;
  /** Create (no id) or change (with id) an entry in your changeset. */
  draft(data: DraftData<T> & { id?: string; locale?: string }): Promise<DraftResult>;
  delete(id: string): Promise<{ changeset: string; op: string; id: string }>;
}

export interface ClientOptions {
  /** The site's origin, e.g. "https://cms.example.com". Empty for same-origin requests in a browser. */
  url: string;
  /** An agent or owner token. Leave out for public reads (or a Studio session cookie). */
  token?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  /** Extra fetch options per request, e.g. Next.js cache tags. */
  init?: (request: { action: string; method: "GET" | "POST" }) => RequestInit | undefined;
}

export class AicmsClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "AicmsClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const READ_ONLY = new Set(["cms.describe", "cms.search", "cms.changes", "cms.review", "cms.history", "cms.agents", "cms.log"]);
/** Read-only Actions go over GET so HTTP caches and frameworks can keep them. */
const isRead = (action: string) => READ_ONLY.has(action) || /\.(list|get)$/.test(action);

export interface BaseClient<S extends AnySchema> {
  /** Call any Action by name, e.g. `call("seo.audit", { id })`. */
  call<R = any>(action: string, input?: Record<string, unknown>, opts?: { method?: "GET" | "POST" }): Promise<R>;
  /** A model by name, for names that clash with client methods. */
  model<K extends Key<S>>(name: K): ModelClient<S[K]>;
  describe(model?: Key<S>): Promise<any>;
  search(query: string, opts?: { model?: Key<S>; limit?: number }): Promise<{ query: string; hits: { model: string; id: string; title: string; field: string; snippet: string }[] }>;
  /** Run checks and send your drafts for review (or merge them, depending on your review mode). */
  submit(note?: string): Promise<SubmitResult>;
  /** Drop drafts you haven't submitted: one entry, or all of them. */
  discard(id?: string): Promise<{ changeset: string | null; discarded: number; left: number }>;
  /** Your recent changesets with decisions and reviewer comments. */
  changes(limit?: number): Promise<{ changesets: any[] }>;
  review(id?: string): Promise<any>;
  merge(id: string): Promise<any>;
  reject(id: string, comment: string, opts?: { final?: boolean }): Promise<any>;
  history(id: string, version?: number): Promise<any>;
  /** Draft a change that restores an entry to an earlier version. Then `submit()`. */
  restore(id: string, version: number): Promise<any>;
  /** Draft the undo of a merged changeset. Then `submit()`. */
  revert(changeset: string): Promise<any>;
  /** Live events (SSE) from now on, or after event id `after`. Reconnects and resumes until `signal` aborts. */
  events(opts?: { after?: number; signal?: AbortSignal }): AsyncGenerator<FeedEvent>;
}

export type Client<S extends AnySchema = AnySchema> = BaseClient<S> & { readonly [K in Key<S>]: ModelClient<S[K]> };

export function createClient<S extends AnySchema = AnySchema>(opts: ClientOptions): Client<S> {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const headers = (extra: Record<string, string> = {}) => ({
    ...opts.headers,
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...extra,
  });

  async function call<R>(action: string, input: Record<string, unknown> = {}, o: { method?: "GET" | "POST" } = {}): Promise<R> {
    const method = o.method ?? (isRead(action) ? "GET" : "POST");
    const path = `${base}/api/v1/actions/${encodeURIComponent(action)}`;
    const hasInput = Object.keys(input).length > 0;
    const url = method === "GET" && hasInput ? `${path}?input=${encodeURIComponent(JSON.stringify(input))}` : path;
    const res = await doFetch(url, {
      method,
      headers: headers(method === "POST" ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" }),
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      ...opts.init?.({ action, method }),
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new AicmsClientError("bad_response", `Expected JSON from ${url}, got: ${text.slice(0, 120)}`, res.status);
    }
    if (!res.ok) {
      const e = body?.error ?? {};
      throw new AicmsClientError(e.code ?? "http_error", e.message ?? `HTTP ${res.status}`, res.status, e.details);
    }
    return body as R;
  }

  const models = new Map<string, ModelClient<any>>();
  const model = (name: string): ModelClient<any> => {
    let m = models.get(name);
    if (!m) {
      m = {
        list: (params = {}) => call(`${name}.list`, params as Record<string, unknown>),
        get: (params) => call(`${name}.get`, typeof params === "string" ? { id: params } : (params as Record<string, unknown>)),
        draft: (data) => call(`${name}.draft`, data as Record<string, unknown>),
        delete: (id) => call(`${name}.delete`, { id }),
      };
      models.set(name, m);
    }
    return m;
  };

  async function* events(o: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<FeedEvent> {
    let last = o.after ?? 0;
    let delay = 1000;
    while (!o.signal?.aborted) {
      try {
        const res = await doFetch(`${base}/api/v1/events`, {
          headers: headers({ accept: "text/event-stream", ...(last ? { "last-event-id": String(last) } : {}) }),
          signal: o.signal,
          ...(opts.credentials ? { credentials: opts.credentials } : {}),
        });
        if (res.status === 401 || res.status === 403) {
          const e = (await res.json().catch(() => ({})))?.error ?? {};
          throw new AicmsClientError(e.code ?? "unauthorized", e.message ?? "Not allowed to listen", res.status);
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        delay = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        // Not every fetch errors the body on abort, so cancel the read ourselves.
        const stop = () => void reader.cancel().catch(() => {});
        o.signal?.addEventListener("abort", stop, { once: true });
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let cut: number;
          while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
            const chunk = buf.slice(0, cut);
            buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
            let event = "message";
            let data = "";
            let id: string | undefined;
            for (const line of chunk.split(/\r?\n/)) {
              if (!line || line.startsWith(":")) continue;
              const i = line.indexOf(":");
              const field = i < 0 ? line : line.slice(0, i);
              const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
              if (field === "event") event = val;
              else if (field === "data") data += (data ? "\n" : "") + val;
              else if (field === "id") id = val;
            }
            if (id) last = Number(id) || last;
            if (event === "ready") {
              try {
                last = Math.max(last, Number(JSON.parse(data).last) || 0);
              } catch {
                /* older server */
              }
              continue;
            }
            if (!data) continue;
            try {
              yield JSON.parse(data) as FeedEvent;
            } catch {
              /* not one of ours */
            }
          }
        }
      } catch (e) {
        if (o.signal?.aborted) return;
        if (e instanceof AicmsClientError) throw e;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  const client: BaseClient<S> = {
    call,
    model: model as BaseClient<S>["model"],
    describe: (m) => call("cms.describe", m ? { model: m } : {}),
    search: (query, o = {}) => call("cms.search", { query, ...o }),
    submit: (note) => call("cms.submit", note ? { note } : {}),
    discard: (id) => call("cms.discard", id ? { id } : {}),
    changes: (limit) => call("cms.changes", limit ? { limit } : {}),
    review: (id) => call("cms.review", id ? { id } : {}),
    merge: (id) => call("cms.merge", { id }),
    reject: (id, comment, o = {}) => call("cms.reject", { id, comment, ...o }),
    history: (id, version) => call("cms.history", version ? { id, version } : { id }),
    restore: (id, version) => call("cms.restore", { id, version }),
    revert: (changeset) => call("cms.revert", { changeset }),
    events,
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" || prop in target) return Reflect.get(target, prop, receiver);
      if (prop === "then") return undefined; // not a thenable
      return model(prop);
    },
  }) as Client<S>;
}
