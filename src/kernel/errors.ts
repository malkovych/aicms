export type ErrorCode = "invalid" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "budget";

const STATUS: Record<ErrorCode, number> = {
  invalid: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  budget: 429,
};

/** An error an agent or person can act on: a code, a plain message, and details. */
export class AicmsError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
  get status() {
    return STATUS[this.code];
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

export const isAicmsError = (e: unknown): e is AicmsError => e instanceof AicmsError;
