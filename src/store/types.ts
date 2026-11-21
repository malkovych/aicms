// The storage contract. SQLite implements it today; Postgres and D1 will
// implement the same interface. Every method is atomic on its own, so the
// kernel never holds a transaction open across an `await`.

export interface EntryRow {
  id: string;
  model: string;
  locale: string;
  data: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface VersionRow {
  entryId: string;
  version: number;
  data: Record<string, unknown> | null; // null = deleted
  changesetId: string | null;
  actor: string;
  createdAt: string;
}

/** `scheduled`: approved by a person, merged automatically at `publishAt`. */
export type ChangesetStatus = "open" | "submitted" | "scheduled" | "merged" | "rejected";

export interface ChangesetItem {
  /** `install` items carry a module proposal (`id` is the module name, `data.options` its options). */
  op: "create" | "update" | "delete" | "install";
  model: string;
  id: string;
  locale: string;
  /** Full data for create, a patch for update (null clears a field), absent for delete. */
  data?: Record<string, unknown>;
  /** Version the change was based on, for conflict detection. */
  baseVersion?: number;
}

export interface CheckIssue {
  entry: string;
  model: string;
  field?: string;
  message: string;
  /** The module check that found it, e.g. "lint/avoid"; absent for schema and conflict checks. */
  check?: string;
}

export interface ChangesetRow {
  id: string;
  actor: string;
  status: ChangesetStatus;
  note?: string;
  /** The reviewer's comment, shown to the agent. */
  comment?: string;
  /** Why the changeset waits for a person, if it does. */
  reviewReason?: string;
  items: ChangesetItem[];
  /** Errors: the changeset can't be merged until they are fixed. */
  issues: CheckIssue[];
  /** Module check warnings: shown to the reviewer; they send an "auto" agent's changes to a person. */
  warnings?: CheckIssue[];
  /** When to publish: asked for by the author, or set by the reviewer when scheduling. */
  publishAt?: string;
  /** Who scheduled it. */
  scheduledBy?: string;
  /** The brief this changeset answers. */
  brief?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergedBy?: string;
}

/** Changeset fields kept together in one JSON column, so new ones need no migration. */
export const CHANGESET_META = ["warnings", "publishAt", "scheduledBy", "brief"] as const;

export function changesetMeta(c: ChangesetRow): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  for (const key of CHANGESET_META) {
    const v = c[key];
    if (v !== undefined && !(Array.isArray(v) && !v.length)) meta[key] = v;
  }
  return Object.keys(meta).length ? meta : null;
}

export interface EventRow {
  id?: number;
  at: string;
  actor: string;
  gate: string;
  action: string;
  input?: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface ListQuery {
  model: string;
  locale?: string;
  /** field → value; array fields match when they contain the value. */
  where?: Record<string, unknown>;
  arrayFields?: string[];
  order?: { field: string; desc: boolean } | null;
  limit: number;
  offset: number;
}

export interface IndexSpec {
  model: string;
  fields: string[];
}

export interface Store {
  init(indexes: IndexSpec[]): Promise<void>;
  close(): Promise<void>;

  getEntry(id: string): Promise<EntryRow | null>;
  findOne(model: string, field: string, value: unknown, locale?: string): Promise<EntryRow | null>;
  list(q: ListQuery): Promise<{ items: EntryRow[]; total: number }>;
  /** Up to `limit` entries of the given models, newest first, for scanning. */
  scan(models: string[], limit: number): Promise<EntryRow[]>;
  versions(entryId: string): Promise<VersionRow[]>;

  getChangeset(id: string): Promise<ChangesetRow | null>;
  findOpenChangeset(actor: string): Promise<ChangesetRow | null>;
  createChangeset(row: ChangesetRow): Promise<void>;
  saveChangeset(row: ChangesetRow): Promise<void>;
  listChangesets(q: { actor?: string; status?: ChangesetStatus[]; limit: number }): Promise<ChangesetRow[]>;
  /**
   * Apply every item and mark the changeset merged, all in one transaction.
   * Throws `ConflictError` if an entry changed since it was drafted.
   */
  mergeChangeset(id: string, by: string, at: string): Promise<EntryRow[]>;

  logEvent(e: EventRow): Promise<void>;
  countEvents(actor: string, sinceIso: string): Promise<number>;
  /** Newest first. `before` is an event id, for paging back. */
  listEvents(q: { actor?: string; limit: number; before?: number }): Promise<EventRow[]>;
  /** Last call and number of calls since `sinceIso`, per actor. */
  actorStats(sinceIso: string): Promise<{ actor: string; lastAt: string; recent: number }[]>;

  // ---- module storage: small JSON values per module ----
  kvGet(scope: string, key: string): Promise<unknown>;
  kvSet(scope: string, key: string, value: unknown): Promise<void>;
  kvDelete(scope: string, key: string): Promise<void>;
  kvList(scope: string, prefix?: string): Promise<{ key: string; value: unknown }[]>;

  // ---- full-text index (used by the search module) ----
  textUpsert(doc: TextDoc): Promise<void>;
  textRemove(id: string): Promise<void>;
  textSearch(q: { terms: string[]; prefixLast: boolean; models: string[]; locale?: string; limit: number }): Promise<TextHit[]>;
  textCount(): Promise<number>;
  textClear(): Promise<void>;

  // ---- media library (used by the media module) ----
  createMedia(row: MediaRow): Promise<void>;
  getMedia(id: string): Promise<MediaRow | null>;
  listMedia(q: { query?: string; missingAlt?: boolean; limit: number; offset: number }): Promise<{ items: MediaRow[]; total: number }>;
  updateMedia(id: string, patch: Partial<Pick<MediaRow, "alt" | "meta">>): Promise<MediaRow | null>;
  deleteMedia(id: string): Promise<boolean>;

  createToken(row: TokenRow): Promise<void>;
  /** An active token: not revoked and not expired at `nowIso`. */
  findToken(hash: string, nowIso: string): Promise<{ id: string; agent: string; kind: TokenKind } | null>;
  revokeToken(id: string, at: string): Promise<boolean>;
  revokeTokens(agent: string, at: string): Promise<number>;
  /** Agent tokens and Studio sessions, newest first (login codes are left out). */
  listTokens(): Promise<(Omit<TokenRow, "hash"> & { revokedAt: string | null })[]>;
}

export interface TextDoc {
  id: string;
  model: string;
  locale: string;
  title: string;
  body: string;
  /** term → weighted frequency; title terms count more. */
  terms: Record<string, number>;
}

export interface TextHit {
  id: string;
  model: string;
  locale: string;
  title: string;
  body: string;
  score: number;
  matched: number;
}

export interface MediaRow {
  id: string;
  url: string;
  filename: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  alt?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
}

/** `agent`: an API token. `session`: a Studio sign-in. `login`: a one-time code that starts a session. */
export type TokenKind = "agent" | "session" | "login";

export interface TokenRow {
  id: string;
  agent: string;
  hash: string;
  createdAt: string;
  kind?: TokenKind;
  expiresAt?: string;
}

export class ConflictError extends Error {
  readonly entry: string;
  constructor(entry: string, message: string) {
    super(message);
    this.entry = entry;
  }
}
