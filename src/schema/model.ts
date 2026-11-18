import { z } from "zod";
import type { AnyField, Format, InferFields } from "./fields.ts";

export type Fields = Record<string, AnyField>;
/** What agents may do with a model. Without `publish`, a person must approve. */
export type ModelOp = "create" | "update" | "delete" | "publish";

export interface ModelAgentOptions {
  /** Style and content instructions handed to every agent with the tool list. */
  guide?: string;
  /** Entries agents should imitate, as `"<field>:<value>"` (e.g. `"slug:how-to-choose-spf"`) or ids. */
  examples?: string[];
  /** Upper bound on agent operations, whatever scopes the agent has. */
  can?: ModelOp[];
}

export interface Model<N extends string = string, F extends Fields = Fields> {
  readonly kind: "model";
  readonly name: N;
  readonly label?: string;
  readonly description?: string;
  readonly fields: F;
  readonly agent?: ModelAgentOptions;
}

/** The shape of an entry's data, inferred from the model. */
export type InferModel<M> = M extends Model<string, infer F> ? InferFields<F> : never;

const MODEL_NAME = /^[a-z][a-z0-9]*$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const RESERVED_MODELS = new Set(["cms", "changesets", "actions", "events", "mcp", "api"]);
const RESERVED_FIELDS = new Set(["id", "locale", "version", "fields", "format", "createdAt", "updatedAt"]);

export function defineModel<const N extends string, F extends Fields>(def: Omit<Model<N, F>, "kind">): Model<N, F> {
  if (!MODEL_NAME.test(def.name)) throw new Error(`Model name "${def.name}" must be lowercase letters and digits, starting with a letter`);
  if (RESERVED_MODELS.has(def.name)) throw new Error(`Model name "${def.name}" is reserved`);
  if (!Object.keys(def.fields).length) throw new Error(`Model "${def.name}" needs at least one field`);
  for (const [key, f] of Object.entries(def.fields)) {
    if (!FIELD_NAME.test(key)) throw new Error(`Field "${def.name}.${key}" has an invalid name`);
    if (RESERVED_FIELDS.has(key)) throw new Error(`Field name "${key}" is reserved (model "${def.name}")`);
    if (f.kind === "slug" && f.options.from) {
      const src = def.fields[f.options.from as string];
      if (!src) throw new Error(`Slug "${def.name}.${key}" is built from "${f.options.from}", which doesn't exist`);
    }
  }
  return { kind: "model", ...def };
}

export const isModel = (v: unknown): v is Model => !!v && typeof v === "object" && (v as Model).kind === "model";

// ---------- runtime helpers ----------

/** The field a person reads as an entry's name: the first required text field, else the first text field. */
export function titleField(m: Model): string | undefined {
  const textual = Object.entries(m.fields).filter(([, f]) => f.kind === "text");
  return (textual.find(([, f]) => f.options.required) ?? textual[0])?.[0];
}

/** The text a person would read as the entry's name. */
export function displayTitle(m: Model, data: Record<string, unknown>): string {
  const key = titleField(m);
  const value = key ? data[key] : undefined;
  return typeof value === "string" && value ? value : "";
}

export function uniqueFields(m: Model): string[] {
  return Object.entries(m.fields).filter(([, f]) => f.options.unique).map(([k]) => k);
}

export function indexedFields(m: Model): string[] {
  return Object.entries(m.fields).filter(([, f]) => f.options.indexed || f.options.unique).map(([k]) => k);
}

/** Fields that can be used in `where` filters: scalar values only. */
export function filterableFields(m: Model): string[] {
  return Object.entries(m.fields)
    .filter(([, f]) => ["text", "number", "boolean", "date", "slug", "enum", "ref", "list", "id"].includes(f.kind))
    .map(([k]) => k);
}

/** Full schema of a stored entry; used by submit checks. */
export function storedSchema(m: Model): z.ZodObject {
  return z.object(
    Object.fromEntries(Object.entries(m.fields).map(([k, f]) => [k, f.options.required ? f.schema : f.schema.optional()])),
  );
}

/**
 * Input schema of `<model>.draft` for a given set of writable fields.
 * Everything is optional (drafts can be built up in steps); `null` clears an optional field.
 */
export function draftSchema(m: Model, writable: string[], requireId: boolean): z.ZodObject {
  const shape: Record<string, z.ZodType> = {
    id: requireId
      ? z.string().min(1).describe(`id of the ${m.name} to change`)
      : z.string().min(1).optional().describe(`Leave out to create a new ${m.name}; pass an id to change an existing one`),
    locale: z.string().optional().describe("Locale of the entry; defaults to the site's first locale"),
  };
  for (const key of writable) {
    const f = m.fields[key];
    let s = f.input ?? f.schema;
    if (!f.options.required) s = s.nullable();
    if (f.options.label && !f.options.description) s = s.describe(f.options.label);
    shape[key] = s.optional();
  }
  return z.strictObject(shape);
}

export function normalizePatch(m: Model, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const f = m.fields[k];
    if (!f) continue;
    out[k] = v === null || v === undefined || !f.normalize ? v : f.normalize(v);
  }
  return out;
}

export function projectData(
  m: Model,
  data: Record<string, unknown>,
  format: Format,
  pick?: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(m.fields)) {
    if (pick && !pick.includes(k)) continue;
    const v = data[k];
    if (v === undefined) continue;
    out[k] = f.project && v !== null ? f.project(v, format) : v;
  }
  return out;
}

/** JSON Schema for an agent-facing tool, without the `$schema` noise. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
