import { z } from "zod";
import { typeLabel } from "../schema/fields.ts";
import { filterableFields, projectData, uniqueFields, type Model } from "../schema/model.ts";
import type { EntryRow } from "../store/types.ts";
import type { RegisteredAction } from "./action.ts";
import { diffChangeset, mergeChangeset, rejectChangeset, submitChangeset, summarize } from "./changesets.ts";
import { AicmsError } from "./errors.ts";
import { allows, modelPermissions, type Actor } from "./policy.ts";
import type { Kernel } from "./cms.ts";

const signedIn = (a: Actor) => a.kind !== "public";
const reviewer = (a: Actor) => allows(a.scopes, "changesets:review");

function abilities(actor: Actor, m: Model): string[] {
  const p = modelPermissions(actor, m);
  const out: string[] = [];
  if (p.read) out.push("read");
  if (p.create) out.push("create");
  if (p.updateFields.length === Object.keys(m.fields).length) out.push("update");
  else if (p.updateFields.length) out.push(`update(${p.updateFields.join(", ")})`);
  if (p.delete) out.push("delete");
  return out;
}

/** The text a person would read as the entry's name. */
export function displayTitle(m: Model, data: Record<string, unknown>): string {
  const textual = Object.entries(m.fields).filter(([, f]) => f.kind === "text");
  const preferred = textual.find(([, f]) => f.options.required) ?? textual[0];
  const value = preferred ? data[preferred[0]] : undefined;
  return typeof value === "string" && value ? value : "";
}

async function resolveExamples(k: Kernel, m: Model): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const ex of (m.agent?.examples ?? []).slice(0, 3)) {
    const sep = ex.indexOf(":");
    const entry: EntryRow | null = sep > 0 ? await k.store.findOne(m.name, ex.slice(0, sep), ex.slice(sep + 1)) : await k.store.getEntry(ex);
    if (entry && entry.model === m.name) out.push({ id: entry.id, ...projectData(m, entry.data, "markdown") });
  }
  return out;
}

export function coreActions(): RegisteredAction[] {
  return [
    {
      name: "cms.describe",
      description: "Start here. Lists the models you can work with, their fields and writing guides, your permissions and how publishing works. Pass { model } for full field details and examples.",
      readOnly: true,
      visible: () => true,
      schema: () => z.strictObject({ model: z.string().optional().describe("Model name for full details") }),
      async run(input: { model?: string }, { actor, kernel: k }) {
        const readable = [...k.models.values()].filter((m) => modelPermissions(actor, m).read);
        if (input.model) {
          const m = readable.find((x) => x.name === input.model);
          if (!m) throw new AicmsError("not_found", `No readable model "${input.model}". Available: ${readable.map((x) => x.name).join(", ") || "none"}`);
          const p = modelPermissions(actor, m);
          return {
            name: m.name,
            label: m.label,
            description: m.description,
            guide: m.agent?.guide,
            youCan: abilities(actor, m),
            humanPublishes: !!m.agent?.can && !m.agent.can.includes("publish"),
            fields: Object.entries(m.fields).map(([key, f]) => ({
              name: key,
              type: typeLabel(f),
              ...(f.options.required ? { required: true } : {}),
              ...(f.options.unique ? { unique: true } : {}),
              ...(f.options.description || f.options.label ? { description: f.options.description ?? f.options.label } : {}),
              ...(f.kind === "slug" && f.options.from ? { filledFrom: f.options.from } : {}),
              writable: p.create || p.updateFields.includes(key),
            })),
            filterBy: filterableFields(m),
            findBy: ["id", ...uniqueFields(m)],
            examples: await resolveExamples(k, m),
          };
        }
        const open = signedIn(actor) ? await k.store.findOpenChangeset(actor.id) : null;
        return {
          site: k.config.name,
          you: { name: actor.id, scopes: actor.scopes, review: actor.kind === "agent" ? actor.review : undefined },
          locales: k.config.locales,
          models: await Promise.all(
            readable.map(async (m) => ({
              name: m.name,
              ...(m.label ? { label: m.label } : {}),
              entries: (await k.store.list({ model: m.name, limit: 0, offset: 0 })).total,
              fields: Object.entries(m.fields).map(([key, f]) => key + (f.options.required ? "*" : "")).join(", "),
              youCan: abilities(actor, m),
              ...(m.agent?.guide ? { guide: m.agent.guide } : {}),
            })),
          ),
          openChangeset: open ? { id: open.id, items: open.items.length } : null,
          workflow: signedIn(actor)
            ? "Read with <model>_list / <model>_get. Write with <model>_draft (block fields accept Markdown). Then call cms_submit. Nothing is public until it is merged; cms_changes shows review decisions and comments."
            : "Read-only access. Ask the site owner for an agent token (aicms agent create <name>) to propose changes.",
        };
      },
    },
    {
      name: "cms.search",
      description: "Full-text search across the models you can read. Returns ids and short snippets; fetch full entries with <model>_get.",
      readOnly: true,
      visible: () => true,
      schema: () =>
        z.strictObject({
          query: z.string().min(2),
          model: z.string().optional(),
          limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
        }),
      async run(input: { query: string; model?: string; limit?: number }, { actor, kernel: k }) {
        const models = [...k.models.values()].filter((m) => modelPermissions(actor, m).read && (!input.model || m.name === input.model));
        const rows = await k.store.scan(models.map((m) => m.name), 5000);
        const q = input.query.toLocaleLowerCase();
        const hits = [];
        for (const row of rows) {
          const m = k.models.get(row.model)!;
          for (const [key, f] of Object.entries(m.fields)) {
            const raw = row.data[key];
            if (raw == null) continue;
            const text = f.kind === "blocks" ? String(projectData(m, { [key]: raw }, "markdown")[key]) : Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "";
            const at = text.toLocaleLowerCase().indexOf(q);
            if (at < 0) continue;
            const start = Math.max(0, at - 50);
            hits.push({
              model: row.model,
              id: row.id,
              title: displayTitle(m, row.data),
              field: key,
              snippet: (start ? "…" : "") + text.slice(start, at + q.length + 70).replace(/\s+/g, " ") + (at + q.length + 70 < text.length ? "…" : ""),
            });
            break;
          }
          if (hits.length >= (input.limit ?? 10)) break;
        }
        return { query: input.query, hits };
      },
    },
    {
      name: "cms.submit",
      description: "Run checks on your drafted changes and send them for review. If checks fail you get field-level issues to fix. Depending on your review mode the changes are merged right away or wait for a person.",
      visible: signedIn,
      schema: () => z.strictObject({ note: z.string().max(2000).optional().describe("What you changed and why, for the reviewer") }),
      run: (input: { note?: string }, { actor, kernel }) => submitChangeset(kernel, actor, input.note),
    },
    {
      name: "cms.changes",
      description: "Your recent changesets: status, failed checks and reviewer comments. Use it to learn whether your changes were merged or sent back.",
      readOnly: true,
      visible: signedIn,
      schema: () => z.strictObject({ limit: z.number().int().min(1).max(50).optional() }),
      async run(input: { limit?: number }, { actor, kernel }) {
        const rows = await kernel.store.listChangesets({ actor: actor.id, limit: input.limit ?? 10 });
        return { changesets: rows.map(summarize) };
      },
    },
    {
      name: "cms.review",
      description: "For reviewers: changesets waiting for a decision, with before/after for every changed field. Pass { id } for one changeset.",
      readOnly: true,
      visible: reviewer,
      schema: () =>
        z.strictObject({
          id: z.string().optional(),
          status: z.enum(["submitted", "open", "merged", "rejected"]).optional().describe("Default: submitted"),
          limit: z.number().int().min(1).max(50).optional(),
        }),
      async run(input: { id?: string; status?: "submitted" | "open" | "merged" | "rejected"; limit?: number }, { kernel }) {
        if (input.id) {
          const cs = await kernel.store.getChangeset(input.id);
          if (!cs) throw new AicmsError("not_found", `No changeset ${input.id}`);
          return diffChangeset(kernel, cs);
        }
        const rows = await kernel.store.listChangesets({ status: [input.status ?? "submitted"], limit: input.limit ?? 20 });
        return { changesets: await Promise.all(rows.map((cs) => diffChangeset(kernel, cs))) };
      },
    },
    {
      name: "cms.merge",
      description: "For reviewers: publish a changeset. Checks run again first; if something changed meanwhile, the changeset goes back to its author.",
      visible: reviewer,
      schema: () => z.strictObject({ id: z.string().min(1) }),
      run: (input: { id: string }, { actor, kernel }) => mergeChangeset(kernel, input.id, actor.id),
    },
    {
      name: "cms.reject",
      description: "For reviewers: send a changeset back to its author with a comment. With final: true it is closed instead.",
      visible: reviewer,
      schema: () =>
        z.strictObject({
          id: z.string().min(1),
          comment: z.string().min(1).describe("What to change; the author sees this"),
          final: z.boolean().optional(),
        }),
      run: (input: { id: string; comment: string; final?: boolean }, { actor, kernel }) =>
        rejectChangeset(kernel, input.id, actor.id, input.comment, input.final),
    },
  ];
}
