import { z } from "zod";
import { blocksToMarkdown, markdownToBlocks, type Block } from "./markdown.ts";
import { SLUG_PATTERN } from "./slug.ts";

export type Format = "markdown" | "blocks";

export interface BaseOptions {
  required?: boolean;
  label?: string;
  description?: string;
  /** Build an index so `where` filters on this field stay fast. */
  indexed?: boolean;
  /** No two entries of the model (per locale) may share this value. */
  unique?: boolean;
}

export type FieldKind =
  | "text" | "number" | "boolean" | "date" | "slug" | "enum" | "ref"
  | "blocks" | "media" | "json" | "list" | "object" | "id";

/**
 * A field knows how to validate itself, what clients may send, how to turn
 * that input into the stored value, and how to show the value to an agent.
 * `T` and `R` exist only for type inference.
 */
export interface Field<T = unknown, R extends boolean = boolean> {
  readonly kind: FieldKind;
  readonly options: BaseOptions & Record<string, unknown>;
  /** Schema of the stored value. */
  readonly schema: z.ZodType;
  /** Schema of what clients may send, when it differs from the stored value. */
  readonly input?: z.ZodType;
  normalize?(value: unknown): unknown;
  project?(value: unknown, format: Format): unknown;
  readonly __type?: T;
  readonly __required?: R;
}

export type AnyField = Field<any, boolean>;
type Req<O> = O extends { required: true } ? true : false;

function make<T, R extends boolean>(
  kind: FieldKind,
  options: BaseOptions & Record<string, unknown>,
  schema: z.ZodType,
  extra: Partial<Pick<Field, "input" | "normalize" | "project">> = {},
): Field<T, R> {
  const described = options.description ? schema.describe(options.description) : schema;
  return { kind, options, schema: described, ...extra } as Field<T, R>;
}

// ---------- option types ----------
export interface TextOptions extends BaseOptions { min?: number; max?: number; multiline?: boolean }
export interface NumberOptions extends BaseOptions { min?: number; max?: number; integer?: boolean }
export interface SlugOptions extends BaseOptions { from?: string }
export interface RefOptions extends BaseOptions { many?: boolean }
export interface MediaValue { url: string; alt?: string; width?: number; height?: number }

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Expected an ISO 8601 date, e.g. 2026-11-17 or 2026-11-17T09:30:00Z" });

const mediaSchema = z.object({
  url: z.string().min(1),
  alt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const field = {
  text<const O extends TextOptions = {}>(o?: O): Field<string, Req<O>> {
    let s = z.string();
    if (o?.min !== undefined) s = s.min(o.min);
    if (o?.max !== undefined) s = s.max(o.max);
    return make("text", { ...o }, s);
  },

  number<const O extends NumberOptions = {}>(o?: O): Field<number, Req<O>> {
    let s = z.number();
    if (o?.integer) s = s.int();
    if (o?.min !== undefined) s = s.min(o.min);
    if (o?.max !== undefined) s = s.max(o.max);
    return make("number", { ...o }, s);
  },

  boolean<const O extends BaseOptions = {}>(o?: O): Field<boolean, Req<O>> {
    return make("boolean", { ...o }, z.boolean());
  },

  /** ISO 8601 date or date-time string. */
  date<const O extends BaseOptions = {}>(o?: O): Field<string, Req<O>> {
    return make("date", { ...o }, isoDate.describe(o?.description ?? "ISO 8601 date or date-time"));
  },

  /** URL-safe identifier. Unique and indexed unless told otherwise; filled from `from` when missing. */
  slug<const O extends SlugOptions = {}>(o?: O): Field<string, Req<O>> {
    const options = { unique: true, indexed: true, ...o };
    return make("slug", options, z.string().regex(SLUG_PATTERN, "Use lowercase letters, digits and single hyphens"));
  },

  enum<const V extends readonly [string, ...string[]], const O extends BaseOptions = {}>(values: V, o?: O): Field<V[number], Req<O>> {
    return make("enum", { ...o, values: [...values] }, z.enum(values as unknown as [string, ...string[]]));
  },

  /** Reference to an entry of another model by id. */
  ref<const O extends RefOptions = {}>(model: string, o?: O): Field<O extends { many: true } ? string[] : string, Req<O>> {
    const one = z.string().min(1).describe(`id of a ${model} entry`);
    return make("ref", { ...o, model }, o?.many ? z.array(one) : one);
  },

  /** Rich content as an array of blocks. Accepts Markdown on input. */
  blocks<const O extends BaseOptions = {}>(types?: readonly string[], o?: O): Field<Block[], Req<O>> {
    const block = z.looseObject({
      type: types?.length ? z.enum(types as unknown as [string, ...string[]]) : z.string().min(1),
    });
    const stored = z.array(block);
    const allowed = types?.length ? ` Allowed blocks: ${types.join(", ")}.` : "";
    return make("blocks", { ...o, types: types ? [...types] : undefined }, stored, {
      input: z.union([
        z.string().describe(
          `Markdown.${allowed} Blocks without Markdown syntax are directives, e.g. :::cta{href="/sale" label="Shop now"}`,
        ),
        stored,
      ]),
      normalize: (v) => (typeof v === "string" ? markdownToBlocks(v) : v),
      project: (v, format) => (format === "markdown" && Array.isArray(v) ? blocksToMarkdown(v as Block[]) : v),
    });
  },

  /** An image or file: `{ url, alt, width, height }`. A plain URL string is accepted on input. */
  media<const O extends BaseOptions = {}>(o?: O): Field<MediaValue, Req<O>> {
    return make("media", { ...o }, mediaSchema, {
      input: z.union([z.string().min(1).describe("Image URL"), mediaSchema]),
      normalize: (v) => (typeof v === "string" ? { url: v } : v),
    });
  },

  json<const O extends BaseOptions = {}>(o?: O): Field<unknown, Req<O>> {
    return make("json", { ...o }, z.unknown());
  },

  /** A list of short strings, e.g. keywords. */
  list<const O extends BaseOptions & { max?: number } = {}>(o?: O): Field<string[], Req<O>> {
    let s = z.array(z.string());
    if (o?.max !== undefined) s = s.max(o.max);
    return make("list", { ...o }, s);
  },

  /** A group of fields stored together, e.g. `seo: { title, description }`. */
  object<F extends Record<string, AnyField>, const O extends BaseOptions = {}>(fields: F, o?: O): Field<InferFields<F>, Req<O>> {
    const shape = (pick: (f: AnyField) => z.ZodType) =>
      z.object(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.options.required ? pick(f) : pick(f).optional()])));
    return make("object", { ...o, fields }, shape((f) => f.schema), {
      input: shape((f) => f.input ?? f.schema),
      normalize: (v) => {
        if (!v || typeof v !== "object") return v;
        const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
        for (const [k, f] of Object.entries(fields)) if (out[k] != null && f.normalize) out[k] = f.normalize(out[k]);
        return out;
      },
      project: (v, format) => {
        if (!v || typeof v !== "object") return v;
        const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
        for (const [k, f] of Object.entries(fields)) if (out[k] != null && f.project) out[k] = f.project(out[k], format);
        return out;
      },
    });
  },

  /** An entry id, for Action inputs. */
  id<const O extends BaseOptions = {}>(o?: O): Field<string, Req<O>> {
    return make("id", { ...o }, z.string().min(1));
  },
};

// ---------- type inference ----------
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type FieldType<F> = F extends Field<infer T, boolean> ? T : never;
type RequiredKeys<F> = { [K in keyof F]: F[K] extends Field<any, true> ? K : never }[keyof F];
type OptionalKeys<F> = Exclude<keyof F, RequiredKeys<F>>;

/** `{ title: field.text({ required: true }) }` → `{ title: string }` */
export type InferFields<F> = Simplify<
  { [K in RequiredKeys<F>]: FieldType<F[K]> } & { [K in OptionalKeys<F>]?: FieldType<F[K]> }
>;

/** Short human/agent-readable type label, e.g. `ref(tag)[]` or `enum(draft|live)`. */
export function typeLabel(f: AnyField): string {
  const o = f.options;
  switch (f.kind) {
    case "enum": return `enum(${(o.values as string[]).join("|")})`;
    case "ref": return `ref(${o.model})${o.many ? "[]" : ""}`;
    case "blocks": return o.types ? `blocks(${(o.types as string[]).join(", ")})` : "blocks";
    case "text": return o.max ? `text(max ${o.max})` : "text";
    case "number": {
      const range = [o.min !== undefined ? `≥${o.min}` : "", o.max !== undefined ? `≤${o.max}` : ""].filter(Boolean).join(" ");
      return `${o.integer ? "integer" : "number"}${range ? `(${range})` : ""}`;
    }
    case "object": return `object{${Object.keys(o.fields as object).join(", ")}}`;
    default: return f.kind;
  }
}
