import { z } from "zod";
import { typeLabel, type AnyField } from "../schema/fields.ts";
import { displayTitle, filterableFields, projectData, uniqueFields, type Model } from "../schema/model.ts";
import type { EntryRow } from "../store/types.ts";
import type { RegisteredAction } from "./action.ts";
import {
  checkDrafts,
  diffChangeset,
  discardDrafts,
  entryHistory,
  entryVersion,
  mergeChangeset,
  proposeModule,
  rejectChangeset,
  restoreEntry,
  revertChangeset,
  submitChangeset,
  summarize,
  unscheduleChangeset,
} from "./changesets.ts";
import {
  AGENT_BRIEF_STATUSES,
  BRIEF_STATUSES,
  briefForSubmit,
  briefWriter,
  getBrief,
  linkSubmission,
  listBriefs,
  updateBrief,
  writeBrief,
  type BriefInput,
  type BriefStatus,
} from "./briefs.ts";
import { AicmsError } from "./errors.ts";
import { catalog } from "../modules/catalog.ts";
import type { SearchService } from "../modules/search.ts";
import { installFromCatalog } from "./install.ts";
import { loadRegistry } from "../registry.ts";
import { join } from "node:path";
import { moduleManifest } from "./modules.ts";
import { allows, describeReview, modelPermissions, type Actor } from "./policy.ts";
import type { Kernel } from "./cms.ts";

const signedIn = (a: Actor) => a.kind !== "public";
const reviewer = (a: Actor) => allows(a.scopes, "changesets:review");
const manager = (a: Actor) => allows(a.scopes, "agents:manage");
const auditor = (a: Actor) => allows(a.scopes, "events:read");
const installer = (a: Actor) => allows(a.scopes, "modules:install");

/** A field as clients need it to render a form or write valid input. */
export function describeField(name: string, f: AnyField, writable?: boolean): Record<string, unknown> {
  const o = f.options;
  return {
    name,
    kind: f.kind,
    type: typeLabel(f),
    ...(o.required ? { required: true } : {}),
    ...(o.unique ? { unique: true } : {}),
    ...(o.label ? { label: o.label } : {}),
    ...(o.description ? { description: o.description } : {}),
    ...(f.kind === "slug" && o.from ? { filledFrom: o.from } : {}),
    ...(o.min !== undefined ? { min: o.min } : {}),
    ...(o.max !== undefined ? { max: o.max } : {}),
    ...(o.multiline ? { multiline: true } : {}),
    ...(f.kind === "enum" ? { values: o.values } : {}),
    ...(f.kind === "ref" ? { model: o.model, ...(o.many ? { many: true } : {}) } : {}),
    ...(f.kind === "blocks" && o.types ? { blocks: o.types } : {}),
    ...(f.kind === "object" ? { fields: Object.entries(o.fields as Record<string, AnyField>).map(([k, sub]) => describeField(k, sub)) } : {}),
    ...(writable !== undefined ? { writable } : {}),
  };
}

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
            fields: Object.entries(m.fields).map(([key, f]) => describeField(key, f, p.create || p.updateFields.includes(key))),
            filterBy: filterableFields(m),
            findBy: ["id", ...uniqueFields(m)],
            examples: await resolveExamples(k, m),
          };
        }
        const open = signedIn(actor) ? await k.store.findOpenChangeset(actor.id) : null;
        const briefs = actor.kind === "agent" ? (await listBriefs(k, actor)).total : 0;
        return {
          site: k.config.name,
          you: { name: actor.id, scopes: actor.scopes, review: actor.kind === "agent" ? describeReview(actor.review) : undefined },
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
          ...(briefs ? { briefs: `${briefs} brief${briefs === 1 ? "" : "s"} for you: see cms_briefs` } : {}),
          workflow: signedIn(actor)
            ? "Read with <model>_list / <model>_get. Write with <model>_draft (block fields accept Markdown). cms_check runs the checks; cms_submit sends the changes for review. Nothing is public until it is merged; cms_changes shows review decisions and comments. cms_briefs lists work people gave you."
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
        // A module that provides "search" (e.g. the official search module) answers with ranked results.
        const provider = k.service<SearchService>("search");
        if (provider) {
          const hits = await provider.query({ query: input.query, models: models.map((m) => m.name), limit: input.limit ?? 10 });
          return { query: input.query, ranked: true, hits };
        }
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
      name: "cms.check",
      description: "Run every check on your drafted changes without submitting: schema, conflicts and the site's content checks. Returns errors to fix, warnings a reviewer will see, and what cms_submit would do.",
      readOnly: true,
      visible: signedIn,
      schema: () => z.strictObject({}),
      run: (_input: Record<string, never>, { actor, kernel }) => checkDrafts(kernel, actor),
    },
    {
      name: "cms.submit",
      description: "Run checks on your drafted changes and send them for review. If checks fail you get field-level issues to fix. Depending on your review mode the changes are merged right away or wait for a person. Pass { brief } when the changes answer a brief, and { publishAt } to ask for a publish time.",
      visible: signedIn,
      schema: () =>
        z.strictObject({
          note: z.string().max(2000).optional().describe("What you changed and why, for the reviewer"),
          brief: z.string().optional().describe("The brief these changes answer (from cms_briefs)"),
          publishAt: z.string().optional().describe("ISO 8601 time to publish at, e.g. 2026-12-01T09:00:00Z. A reviewer approves it as a schedule."),
        }),
      async run(input: { note?: string; brief?: string; publishAt?: string }, { actor, kernel }) {
        const brief = input.brief ? await briefForSubmit(kernel, actor, input.brief) : null;
        const publishAt = input.publishAt ?? (brief?.publishAt && Date.parse(brief.publishAt) > Date.now() ? brief.publishAt : undefined);
        const result = await submitChangeset(kernel, actor, { note: input.note, brief: brief?.id, publishAt });
        if (brief) await linkSubmission(kernel, actor, brief.id, result.changeset, result.status);
        return result;
      },
    },
    {
      name: "cms.discard",
      description: "Drop drafted changes you haven't submitted: one entry with { id }, or all of them without it.",
      visible: signedIn,
      schema: () => z.strictObject({ id: z.string().min(1).optional() }),
      run: (input: { id?: string }, { actor, kernel }) => discardDrafts(kernel, actor, input.id),
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
          status: z.enum(["submitted", "scheduled", "open", "merged", "rejected"]).optional().describe("Default: submitted"),
          limit: z.number().int().min(1).max(50).optional(),
        }),
      async run(input: { id?: string; status?: "submitted" | "scheduled" | "open" | "merged" | "rejected"; limit?: number }, { kernel }) {
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
      description: "For reviewers: publish a changeset, now or at a time. Checks run again first; if something changed meanwhile, the changeset goes back to its author. Without { at }, a changeset whose author asked for a publish time is scheduled for it.",
      visible: reviewer,
      schema: () =>
        z.strictObject({
          id: z.string().min(1),
          at: z.string().optional().describe('ISO 8601 time to publish at, or "now"'),
        }),
      async run(input: { id: string; at?: string }, { actor, kernel }) {
        const cs = await kernel.store.getChangeset(input.id);
        if (cs?.items.some((i) => i.op === "install") && !installer(actor)) {
          throw new AicmsError("forbidden", "Installing a module needs the modules:install scope (the site owner has it)");
        }
        return mergeChangeset(kernel, input.id, actor.id, { at: input.at });
      },
    },
    {
      name: "cms.unschedule",
      description: "For reviewers: take a scheduled changeset off the schedule. It waits for review again.",
      visible: reviewer,
      schema: () => z.strictObject({ id: z.string().min(1) }),
      run: (input: { id: string }, { actor, kernel }) => unscheduleChangeset(kernel, input.id, actor.id),
    },
    {
      name: "cms.briefs",
      description: "Work people gave you: briefs with a title, details, what to produce and when. Without filters: the ones not done yet. Pass { id } for one brief with its notes.",
      readOnly: true,
      visible: signedIn,
      schema: () =>
        z.strictObject({
          id: z.string().optional(),
          status: z.array(z.enum(BRIEF_STATUSES as [BriefStatus, ...BriefStatus[]])).optional().describe("Default: everything not done or canceled"),
          agent: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        }),
      async run(input: { id?: string; status?: BriefStatus[]; agent?: string; limit?: number }, { actor, kernel }) {
        if (input.id) return { brief: await getBrief(kernel, actor, input.id) };
        return listBriefs(kernel, actor, input);
      },
    },
    {
      name: "cms.brief",
      description: "For people and planning agents: write a brief for an agent, or change one ({ id }). Give it a title, details in Markdown, the agent, what to produce (model or entry), a due date and a publish time.",
      visible: briefWriter,
      schema: () =>
        z.strictObject({
          id: z.string().optional().describe("Omit to create a new brief"),
          title: z.string().max(200).optional(),
          details: z.string().max(20000).nullable().optional(),
          agent: z.string().nullable().optional().describe("Omit to let any agent pick it up"),
          model: z.string().nullable().optional(),
          entry: z.string().nullable().optional(),
          due: z.string().nullable().optional(),
          publishAt: z.string().nullable().optional(),
          status: z.enum(["open", "canceled", "done"]).optional(),
          note: z.string().max(4000).optional().describe("Added to the brief's notes, e.g. an answer to a blocked agent"),
        }),
      run: (input: BriefInput & { id?: string }, { actor, kernel }) => writeBrief(kernel, actor, input.id, input),
    },
    {
      name: "cms.brief_update",
      description: 'Report on a brief: take it ("in_progress"), ask a person something ("blocked" with a note), give it back ("open"), or finish work that needed no content change ("done" with a note). Content changes are answered with cms_submit({ brief }).',
      visible: signedIn,
      schema: () =>
        z.strictObject({
          id: z.string().min(1),
          status: z.enum(AGENT_BRIEF_STATUSES).optional(),
          note: z.string().max(4000).optional(),
        }),
      run: (input: { id: string; status?: (typeof AGENT_BRIEF_STATUSES)[number]; note?: string }, { actor, kernel }) => updateBrief(kernel, actor, input.id, input),
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
    {
      name: "cms.history",
      description: "Versions of one entry, newest first: who changed it, when, in which changeset and which fields. Pass { version } to read that version's data.",
      readOnly: true,
      visible: signedIn,
      schema: () =>
        z.strictObject({
          id: z.string().min(1),
          version: z.number().int().min(1).optional(),
          format: z.enum(["markdown", "blocks"]).optional(),
        }),
      async run(input: { id: string; version?: number; format?: "markdown" | "blocks" }, { actor, gate, kernel }) {
        if (input.version === undefined) return entryHistory(kernel, actor, input.id);
        const v = await entryVersion(kernel, actor, input.id, input.version);
        const m = kernel.models.get(v.model)!;
        const format = input.format ?? (gate === "mcp" ? "markdown" : "blocks");
        return { ...v, data: v.data ? projectData(m, v.data, format) : null };
      },
    },
    {
      name: "cms.restore",
      description: "Draft a change that brings an entry back to an earlier version (a deleted entry comes back with the same id). Publish it with cms_submit like any other change.",
      visible: signedIn,
      schema: () => z.strictObject({ id: z.string().min(1), version: z.number().int().min(1) }),
      run: (input: { id: string; version: number }, { actor, kernel }) => restoreEntry(kernel, actor, input.id, input.version),
    },
    {
      name: "cms.revert",
      description: "Draft the undo of a merged changeset: entries it created are deleted, edits and deletions are rolled back. Publish it with cms_submit.",
      visible: signedIn,
      schema: () => z.strictObject({ changeset: z.string().min(1) }),
      run: (input: { changeset: string }, { actor, kernel }) => revertChangeset(kernel, actor, input.changeset),
    },
    {
      name: "cms.agents",
      description: "For admins: configured agents with their scopes, review mode, budget, active tokens, recent activity and pending changesets.",
      readOnly: true,
      visible: manager,
      schema: () => z.strictObject({}),
      async run(_input: Record<string, never>, { kernel: k }) {
        const tokens = await k.store.listTokens();
        const stats = new Map((await k.store.actorStats(new Date(Date.now() - 3_600_000).toISOString())).map((s) => [s.actor, s]));
        const pending = await k.store.listChangesets({ status: ["open", "submitted"], limit: 1000 });
        return {
          agents: Object.entries(k.config.agents).map(([name, a]) => {
            const mine = pending.filter((cs) => cs.actor === name);
            return {
              name,
              ...(a.description ? { description: a.description } : {}),
              scopes: a.scopes,
              review: a.review ?? "human",
              ...(a.budget ? { budget: a.budget } : {}),
              tokens: tokens.filter((t) => t.agent === name && t.kind === "agent" && !t.revokedAt).length,
              lastSeen: stats.get(name)?.lastAt ?? null,
              actionsLastHour: stats.get(name)?.recent ?? 0,
              waiting: mine.filter((cs) => cs.status === "submitted").length,
              drafting: mine.find((cs) => cs.status === "open")?.items.length ?? 0,
            };
          }),
          sessions: tokens.filter((t) => t.kind === "session" && !t.revokedAt && (!t.expiresAt || t.expiresAt > new Date().toISOString())).length,
        };
      },
    },
    {
      name: "cms.token",
      description: "For admins: issue a new token for an agent from the config. The token is shown once.",
      visible: manager,
      schema: () => z.strictObject({ agent: z.string().min(1) }),
      async run(input: { agent: string }, { kernel: k }) {
        if (input.agent === "owner") throw new AicmsError("invalid", "Owner tokens are issued from the command line: aicms agent create owner");
        const token = await k.createToken(input.agent);
        const a = k.actor(input.agent);
        return { agent: input.agent, token, scopes: a.scopes, review: a.review, next: "Store it now; it can't be shown again." };
      },
    },
    {
      name: "cms.revoke",
      description: "For admins: revoke every token of an agent and reject its unmerged changesets.",
      destructive: true,
      visible: manager,
      schema: () => z.strictObject({ agent: z.string().min(1) }),
      async run(input: { agent: string }, { kernel: k }) {
        if (!(input.agent in k.config.agents)) throw new AicmsError("not_found", `No agent "${input.agent}"`);
        return { agent: input.agent, ...(await k.revokeAgent(input.agent)) };
      },
    },
    {
      name: "cms.log",
      description: "For admins: the action log, newest first. Filter by actor; page back with { before: <id of the oldest event you have> }.",
      readOnly: true,
      visible: auditor,
      schema: () =>
        z.strictObject({
          actor: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
          before: z.number().int().min(1).optional(),
        }),
      async run(input: { actor?: string; limit?: number; before?: number }, { kernel }) {
        return { events: await kernel.store.listEvents({ actor: input.actor, limit: input.limit ?? 50, before: input.before }) };
      },
    },
    {
      name: "cms.presence",
      description: "Who is looking at or editing an entry right now, plus unpublished drafts of it (yours or others', e.g. waiting for review). Pass state to announce yourself: viewing, editing or left.",
      visible: signedIn,
      schema: () => z.strictObject({ id: z.string().min(1), state: z.enum(["viewing", "editing", "left"]).optional() }),
      async run(input: { id: string; state?: "viewing" | "editing" | "left" }, { actor, kernel: k }) {
        const entry = await k.store.getEntry(input.id);
        const model = entry ? k.models.get(entry.model) : undefined;
        if (!entry || !model || !modelPermissions(actor, model).read) throw new AicmsError("not_found", `No entry ${input.id}`);
        if (input.state === "left") k.presence.leave(actor, input.id);
        else if (input.state) k.presence.touch(actor, input.id, model.name, input.state);
        const drafts = [];
        for (const cs of await k.store.listChangesets({ status: ["open", "submitted"], limit: 1000 })) {
          const item = cs.items.find((i) => i.id === input.id && i.op !== "install");
          if (item) drafts.push({ actor: cs.actor, changeset: cs.id, status: cs.status === "submitted" ? "waiting for review" : "drafting", op: item.op, fields: Object.keys(item.data ?? {}), mine: cs.actor === actor.id });
        }
        return { id: input.id, model: model.name, version: entry.version, here: k.presence.list(input.id).filter((p) => p.actor !== actor.id), drafts };
      },
    },
    {
      name: "cms.login_code",
      description: "For the owner: a one-time Studio sign-in code (15 minutes), for servers without a terminal such as the edge. Open /studio/login?code=<code>.",
      visible: (a) => allows(a.scopes, "studio:login"),
      schema: () => z.strictObject({}),
      async run(_input: Record<string, never>, { kernel }) {
        const code = await kernel.createLoginCode();
        return { code, path: `/studio/login?code=${code}`, expiresInMinutes: 15 };
      },
    },
    {
      name: "cms.modules",
      description: "Installed modules and what each may do (models, Actions, scopes, routes, hooks), plus official modules that can be installed. Propose one with cms_propose_module.",
      readOnly: true,
      visible: signedIn,
      schema: () => z.strictObject({}),
      async run(_input: Record<string, never>, { actor, kernel: k }) {
        const installed = new Set(k.modules.map((m) => m.name));
        // Community modules from the registry are added in a terminal (aicms add), never installed by the server.
        let community: unknown[] = [];
        let registryError: string | undefined;
        if (k.config.registry) {
          try {
            const reg = await loadRegistry(k.config.registry, { cacheFile: join(k.moduleDir("registry"), "cache.json") });
            community = reg.modules.filter((m) => !m.official && !installed.has(m.name)).map((m) => ({ ...m, install: `aicms add ${m.name}` }));
          } catch (e) {
            registryError = e instanceof Error ? e.message : String(e);
          }
        }
        return {
          installed: k.modules.map(moduleManifest),
          available: catalog.filter((c) => !installed.has(c.name)).map((c) => ({ ...moduleManifest(c.create()), title: c.title, summary: c.summary })),
          community,
          ...(registryError ? { registryError } : {}),
          youCan: installer(actor) ? "install" : "propose",
        };
      },
    },
    {
      name: "cms.propose_module",
      description: "Ask the site owner to install an official module (see cms_modules). The proposal waits in their Inbox with the module's permissions; you can't install code yourself.",
      visible: signedIn,
      schema: () => z.strictObject({ module: z.string().min(1), reason: z.string().min(10).max(2000).describe("Why the site needs it, for the person who decides") }),
      run: (input: { module: string; reason: string }, { actor, kernel }) => proposeModule(kernel, actor, input.module, input.reason),
    },
    {
      name: "cms.install_module",
      description: "For admins: install an official module now. It is loaded into the running server and written to aicms.config.",
      visible: installer,
      schema: () => z.strictObject({ module: z.string().min(1) }),
      run: (input: { module: string }, { kernel }) => installFromCatalog(kernel, input.module),
    },
  ];
}
