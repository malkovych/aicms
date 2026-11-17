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

export type ChangesetStatus = "open" | "submitted" | "merged" | "rejected";

export interface ChangesetItem {
  op: "create" | "update" | "delete";
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
  issues: CheckIssue[];
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergedBy?: string;
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
  listEvents(q: { actor?: string; limit: number }): Promise<EventRow[]>;

  createToken(row: { id: string; agent: string; hash: string; createdAt: string }): Promise<void>;
  findToken(hash: string): Promise<{ id: string; agent: string } | null>;
  revokeTokens(agent: string, at: string): Promise<number>;
  listTokens(): Promise<{ id: string; agent: string; createdAt: string; revokedAt: string | null }[]>;
}

export class ConflictError extends Error {
  readonly entry: string;
  constructor(entry: string, message: string) {
    super(message);
    this.entry = entry;
  }
}
