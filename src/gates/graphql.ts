// GraphQL gate, generated from the models. Every resolver calls kernel.call(),
// so permissions, budgets and the action log are the same as for REST and MCP.

import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  execute,
  getOperationAST,
  parse,
  validate,
  type DocumentNode,
  type GraphQLFieldConfigMap,
  type GraphQLOutputType,
  type ValueNode,
} from "graphql";
import type { Kernel } from "../kernel/cms.ts";
import { isAicmsError } from "../kernel/errors.ts";
import type { Actor } from "../kernel/policy.ts";
import type { AnyField } from "../schema/fields.ts";
import { blocksToMarkdown, type Block } from "../schema/markdown.ts";
import { uniqueFields, type Model } from "../schema/model.ts";

interface Ctx {
  k: Kernel;
  actor: Actor;
  /** Per-request cache for reference lookups: "model:id" → entry. */
  cache: Map<string, Promise<unknown>>;
}

const pascal = (s: string) => s.replace(/(^|[_-])([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase());
const plural = (s: string) => (/(s|x|z|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);
const RESERVED = new Set(["Query", "Mutation", "Media", "JSON", "SearchHit"]);
const MAX_DEPTH = 10;

function literal(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return ast.value;
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(literal);
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((f) => [f.name.value, literal(f.value)]));
    default:
      return undefined;
  }
}

const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Any JSON value: blocks, objects, filters, results.",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast) => literal(ast),
});

const MediaType = new GraphQLObjectType({
  name: "Media",
  fields: { url: { type: new GraphQLNonNull(GraphQLString) }, alt: { type: GraphQLString }, width: { type: GraphQLInt }, height: { type: GraphQLInt } },
});

const SearchHit = new GraphQLObjectType({
  name: "SearchHit",
  fields: {
    model: { type: new GraphQLNonNull(GraphQLString) },
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: GraphQLString },
    snippet: { type: GraphQLString },
    score: { type: GraphQLFloat },
  },
});

/** Build the schema for the kernel's current models. */
export function buildSchema(k: Kernel): GraphQLSchema {
  const models = [...k.models.values()];
  const typeNames = new Map(models.map((m) => [m.name, RESERVED.has(pascal(m.name)) ? `${pascal(m.name)}Entry` : pascal(m.name)]));
  const types = new Map<string, GraphQLObjectType>();
  const call = (ctx: Ctx, name: string, input: unknown) => ctx.k.call(name, input, { actor: ctx.actor, gate: "graphql" });
  const load = (ctx: Ctx, model: string, id: string) => {
    const key = `${model}:${id}`;
    if (!ctx.cache.has(key)) ctx.cache.set(key, call(ctx, `${model}.get`, { id }).catch(() => null));
    return ctx.cache.get(key)!;
  };

  function fieldType(owner: string, key: string, f: AnyField): { type: GraphQLOutputType; args?: Record<string, { type: any }>; resolve?: (src: any, args: any, ctx: Ctx) => unknown } {
    switch (f.kind) {
      case "number":
        return { type: f.options.integer ? GraphQLInt : GraphQLFloat };
      case "boolean":
        return { type: GraphQLBoolean };
      case "list":
        return { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) };
      case "json":
        return { type: JSONScalar };
      case "media":
        return { type: MediaType };
      case "blocks":
        return {
          type: JSONScalar,
          args: { markdown: { type: GraphQLBoolean } },
          resolve: (src, args) => (args.markdown && Array.isArray(src[key]) ? blocksToMarkdown(src[key] as Block[]) : src[key]),
        };
      case "object": {
        const sub = new GraphQLObjectType({
          name: `${owner}${pascal(key)}`,
          fields: () => Object.fromEntries(Object.entries(f.options.fields as Record<string, AnyField>).map(([k2, f2]) => [k2, fieldType(`${owner}${pascal(key)}`, k2, f2)])),
        });
        return { type: sub };
      }
      case "ref": {
        // Field maps are thunks, so every model type exists by the time this runs.
        const target = f.options.model as string;
        const type = types.get(target)!;
        return f.options.many
          ? { type: new GraphQLList(new GraphQLNonNull(type)), resolve: async (src, _args, ctx) => (await Promise.all(((src[key] as string[]) ?? []).map((id) => load(ctx, target, id)))).filter(Boolean) }
          : { type, resolve: (src, _args, ctx) => (src[key] ? load(ctx, target, src[key]) : null) };
      }
      default:
        return { type: GraphQLString };
    }
  }

  for (const m of models) {
    const name = typeNames.get(m.name)!;
    types.set(
      m.name,
      new GraphQLObjectType({
        name,
        description: m.label ?? m.description,
        fields: () => {
          const out: GraphQLFieldConfigMap<any, Ctx> = {
            id: { type: new GraphQLNonNull(GraphQLID) },
            locale: { type: new GraphQLNonNull(GraphQLString) },
            version: { type: new GraphQLNonNull(GraphQLInt) },
            updatedAt: { type: GraphQLString },
          };
          for (const [key, f] of Object.entries(m.fields)) {
            out[key] = { ...fieldType(name, key, f), ...(f.options.description ? { description: String(f.options.description) } : {}) };
          }
          return out;
        },
      }),
    );
  }

  const query: GraphQLFieldConfigMap<unknown, Ctx> = {
    search: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SearchHit))),
      args: { query: { type: new GraphQLNonNull(GraphQLString) }, model: { type: GraphQLString }, limit: { type: GraphQLInt } },
      resolve: async (_src, args, ctx) => ((await call(ctx, "cms.search", strip(args))) as { hits: unknown[] }).hits,
    },
    describe: { type: JSONScalar, args: { model: { type: GraphQLString } }, resolve: (_src, args, ctx) => call(ctx, "cms.describe", strip(args)) },
  };
  const mutation: GraphQLFieldConfigMap<unknown, Ctx> = {
    submit: { type: JSONScalar, args: { note: { type: GraphQLString } }, resolve: (_s, a, ctx) => call(ctx, "cms.submit", strip(a)) },
    merge: { type: JSONScalar, args: { id: { type: new GraphQLNonNull(GraphQLID) } }, resolve: (_s, a, ctx) => call(ctx, "cms.merge", a) },
    reject: {
      type: JSONScalar,
      args: { id: { type: new GraphQLNonNull(GraphQLID) }, comment: { type: new GraphQLNonNull(GraphQLString) }, final: { type: GraphQLBoolean } },
      resolve: (_s, a, ctx) => call(ctx, "cms.reject", strip(a)),
    },
  };
  const taken = new Set(models.map((m) => m.name));
  for (const m of models) {
    const t = types.get(m.name)!;
    const P = pascal(m.name);
    const page = new GraphQLObjectType({
      name: `${typeNames.get(m.name)}Page`,
      fields: {
        items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(t))) },
        total: { type: new GraphQLNonNull(GraphQLInt) },
        limit: { type: new GraphQLNonNull(GraphQLInt) },
        offset: { type: new GraphQLNonNull(GraphQLInt) },
      },
    });
    query[m.name] = {
      type: t,
      description: `One ${m.name} by id${uniqueFields(m).length ? ` or ${uniqueFields(m).join(" / ")}` : ""}.`,
      args: { id: { type: GraphQLID }, locale: { type: GraphQLString }, ...Object.fromEntries(uniqueFields(m).map((f) => [f, { type: GraphQLString }])) },
      resolve: (_src, args, ctx) => call(ctx, `${m.name}.get`, strip(args)),
    };
    const many = taken.has(plural(m.name)) ? `${m.name}List` : plural(m.name);
    query[many] = {
      type: new GraphQLNonNull(page),
      description: `List ${m.name} entries. where: exact-match filters on indexed fields; order: "field" or "-field".`,
      args: { where: { type: JSONScalar }, order: { type: GraphQLString }, limit: { type: GraphQLInt }, offset: { type: GraphQLInt }, locale: { type: GraphQLString } },
      resolve: (_src, args, ctx) => call(ctx, `${m.name}.list`, strip(args)),
    };
    mutation[`draft${P}`] = {
      type: JSONScalar,
      description: `Create (no id) or change a ${m.name} in your changeset. data: the fields to set; block fields accept Markdown.`,
      args: { id: { type: GraphQLID }, locale: { type: GraphQLString }, data: { type: new GraphQLNonNull(JSONScalar) } },
      resolve: (_src, args, ctx) => call(ctx, `${m.name}.draft`, { ...(args.data as object), ...strip({ id: args.id, locale: args.locale }) }),
    };
    mutation[`delete${P}`] = { type: JSONScalar, args: { id: { type: new GraphQLNonNull(GraphQLID) } }, resolve: (_src, args, ctx) => call(ctx, `${m.name}.delete`, args) };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: query }),
    mutation: new GraphQLObjectType({ name: "Mutation", fields: mutation }),
  });
}

/** Drop null/undefined arguments so the kernel's strict schemas don't see them. */
function strip(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
}

function depth(doc: DocumentNode): number {
  let max = 0;
  const walk = (node: any, d: number) => {
    if (!node || typeof node !== "object") return;
    if (node.kind === Kind.SELECTION_SET) {
      max = Math.max(max, d);
      for (const s of node.selections) walk(s, d + 1);
      return;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((x) => walk(x, d));
      else if (v && typeof v === "object" && "kind" in (v as object)) walk(v, d);
    }
  };
  walk(doc, 0);
  return max;
}

export interface GraphQLRequest {
  query?: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

/** Run one GraphQL request for an actor. `readOnly` (GET) refuses mutations. */
export async function runGraphQL(k: Kernel, schema: GraphQLSchema, actor: Actor, req: GraphQLRequest, readOnly = false) {
  if (!req.query) return { status: 400, body: { errors: [{ message: "Send { query, variables, operationName }" }] } };
  let doc: DocumentNode;
  try {
    doc = parse(req.query);
  } catch (e) {
    return { status: 400, body: { errors: [{ message: (e as Error).message }] } };
  }
  if (depth(doc) > MAX_DEPTH) return { status: 400, body: { errors: [{ message: `Query is nested deeper than ${MAX_DEPTH} levels` }] } };
  const invalid = validate(schema, doc);
  if (invalid.length) return { status: 400, body: { errors: invalid.map((e) => ({ message: e.message, locations: e.locations })) } };
  const op = getOperationAST(doc, req.operationName ?? undefined);
  if (readOnly && op?.operation === "mutation") return { status: 405, body: { errors: [{ message: "Mutations need POST" }] } };
  const result = await execute({ schema, document: doc, variableValues: req.variables ?? undefined, operationName: req.operationName ?? undefined, contextValue: { k, actor, cache: new Map() } satisfies Ctx });
  const errors = result.errors?.map((e: GraphQLError) => {
    const orig = e.originalError;
    return { message: e.message, path: e.path, locations: e.locations, extensions: { code: isAicmsError(orig) ? orig.code : "graphql", ...(isAicmsError(orig) && orig.details ? { details: orig.details } : {}) } };
  });
  return { status: 200, body: { ...(result.data !== undefined ? { data: result.data } : {}), ...(errors?.length ? { errors } : {}) } };
}
