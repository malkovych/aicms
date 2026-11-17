import { z } from "zod";
import type { Format } from "../schema/fields.ts";
import { draftSchema, filterableFields, projectData, uniqueFields, type Model } from "../schema/model.ts";
import type { EntryRow } from "../store/types.ts";
import type { CallContext, RegisteredAction } from "./action.ts";
import { deleteEntry, draftEntry, entryWithDrafts } from "./changesets.ts";
import { AicmsError } from "./errors.ts";
import { modelPermissions } from "./policy.ts";

const formatSchema = z.enum(["markdown", "blocks"]).optional().describe("How block fields are returned. Defaults to markdown over MCP, blocks elsewhere.");
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function arrayFields(model: Model) {
  return Object.entries(model.fields)
    .filter(([, f]) => f.kind === "list" || (f.kind === "ref" && f.options.many))
    .map(([k]) => k);
}

/** The four Actions every model gets: list, get, draft, delete. */
export function modelActions(model: Model): RegisteredAction[] {
  const name = model.name;
  const fieldNames = Object.keys(model.fields) as [string, ...string[]];
  const filterable = filterableFields(model);
  const uniques = uniqueFields(model);
  const arrays = arrayFields(model);
  const label = model.label ? ` (${model.label})` : "";
  const guide = model.agent?.guide ? ` Guide: ${model.agent.guide}` : "";

  const format = (input: { format?: Format }, ctx: CallContext): Format => input.format ?? (ctx.gate === "mcp" ? "markdown" : "blocks");
  const shape = (e: EntryRow, f: Format, pick?: string[]) => ({
    id: e.id,
    locale: e.locale,
    version: e.version,
    updatedAt: e.updatedAt,
    ...projectData(model, e.data, f, pick),
  });

  const listSchema = z.strictObject({
    where: z
      .strictObject(Object.fromEntries(filterable.map((f) => [f, scalar.optional()])))
      .optional()
      .describe(`Exact-match filters on: ${filterable.join(", ") || "none"}. List and many-ref fields match when they contain the value.`),
    fields: z.array(z.enum(fieldNames)).optional().describe("Return only these fields"),
    order: z.string().optional().describe(`Field to sort by; prefix with "-" for descending, e.g. "-${fieldNames[0]}"`),
    limit: z.number().int().min(1).max(100).optional().describe("Default 20, at most 100"),
    offset: z.number().int().min(0).optional(),
    locale: z.string().optional(),
    format: formatSchema,
  });

  const getSchema = z.strictObject({
    id: z.string().min(1).optional(),
    ...Object.fromEntries(uniques.map((f) => [f, z.string().min(1).optional().describe(`Find by ${f}`)])),
    fields: z.array(z.enum(fieldNames)).optional(),
    locale: z.string().optional(),
    format: formatSchema,
    drafts: z.boolean().optional().describe("Include your own unpublished changes (by id only)"),
  });

  const readable = (a: Parameters<RegisteredAction["visible"]>[0]) => modelPermissions(a, model).read;

  return [
    {
      name: `${name}.list`,
      description: `List ${name} entries${label}, newest first unless you pass "order".`,
      readOnly: true,
      visible: readable,
      schema: () => listSchema,
      async run(input: z.infer<typeof listSchema>, ctx) {
        let order: { field: string; desc: boolean } | null = null;
        if (input.order) {
          const desc = input.order.startsWith("-");
          const field = input.order.replace(/^-/, "");
          if (!(field in model.fields)) throw new AicmsError("invalid", `Can't sort by "${field}"; ${name} has fields: ${fieldNames.join(", ")}`);
          order = { field, desc };
        }
        const limit = input.limit ?? 20;
        const offset = input.offset ?? 0;
        const res = await ctx.kernel.store.list({ model: name, locale: input.locale, where: input.where, arrayFields: arrays, order, limit, offset });
        const f = format(input, ctx);
        return { items: res.items.map((e) => shape(e, f, input.fields)), total: res.total, limit, offset };
      },
    },
    {
      name: `${name}.get`,
      description: `Get one ${name}${label} by id${uniques.length ? ` or by ${uniques.join(" / ")}` : ""}.`,
      readOnly: true,
      visible: readable,
      schema: () => getSchema,
      async run(input: Record<string, any>, ctx) {
        const store = ctx.kernel.store;
        let entry: EntryRow | null = null;
        let by = "";
        if (input.id) {
          by = `id ${input.id}`;
          entry = input.drafts ? await entryWithDrafts(ctx.kernel, ctx.actor, input.id) : await store.getEntry(input.id);
          if (entry && entry.model !== name) entry = null;
        } else {
          const key = uniques.find((f) => input[f]);
          if (!key) throw new AicmsError("invalid", `Pass "id"${uniques.length ? ` or one of: ${uniques.join(", ")}` : ""}`);
          by = `${key} "${input[key]}"`;
          entry = await store.findOne(name, key, input[key], input.locale);
        }
        if (!entry) throw new AicmsError("not_found", `No ${name} with ${by}`);
        return shape(entry, format(input, ctx), input.fields);
      },
    },
    {
      name: `${name}.draft`,
      description: `Create or change a ${name}${label} in your changeset. Send only the fields you want to set; block fields accept Markdown. Nothing is public until cms_submit and review.${guide}`,
      visible: (a) => {
        const p = modelPermissions(a, model);
        return p.create || p.updateFields.length > 0;
      },
      // Validate against every field; draftEntry explains which ones the caller may not change.
      schema: () => draftSchema(model, fieldNames, false),
      advertised: (a) => {
        const p = modelPermissions(a, model);
        return draftSchema(model, p.create ? fieldNames : p.updateFields, !p.create);
      },
      run: (input, ctx) => draftEntry(ctx.kernel, ctx.actor, model, input),
    },
    {
      name: `${name}.delete`,
      description: `Propose deleting a ${name}${label}. Takes effect only after review.`,
      destructive: true,
      visible: (a) => modelPermissions(a, model).delete,
      schema: () => z.strictObject({ id: z.string().min(1) }),
      run: (input: { id: string }, ctx) => deleteEntry(ctx.kernel, ctx.actor, model, input.id),
    },
  ];
}
