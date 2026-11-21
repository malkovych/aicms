import { randomBytes } from "node:crypto";
import type { Model } from "../schema/model.ts";
import { displayTitle, normalizePatch, projectData, storedSchema, uniqueFields } from "../schema/model.ts";
import { slugify } from "../schema/slug.ts";
import { applyPatch } from "../store/sql.ts";
import { ConflictError, type ChangesetItem, type ChangesetRow, type CheckIssue, type EntryRow } from "../store/types.ts";
import { AicmsError } from "./errors.ts";
import { findCatalog } from "../modules/catalog.ts";
import { catalogEntry, installFromCatalog } from "./install.ts";
import { moduleContext, moduleManifest, type CheckInput } from "./modules.ts";
import { allows, modelPermissions, type Actor } from "./policy.ts";
import type { Kernel } from "./cms.ts";

export const newId = (prefix: string) => `${prefix}_${BigInt("0x" + randomBytes(8).toString("hex")).toString(36)}`;
const now = () => new Date().toISOString();

export interface DraftOptions {
  /** Module Actions authorize with their own scope, so model scopes are skipped. */
  trusted?: boolean;
}

async function openChangeset(k: Kernel, actor: Actor): Promise<ChangesetRow> {
  const existing = await k.store.findOpenChangeset(actor.id);
  if (existing) return existing;
  const at = now();
  const cs: ChangesetRow = { id: newId("cs"), actor: actor.id, status: "open", items: [], issues: [], createdAt: at, updatedAt: at };
  await k.store.createChangeset(cs);
  return cs;
}

/** Fill empty slug fields from their source field (e.g. title → slug). */
function fillSlugs(model: Model, data: Record<string, unknown>) {
  for (const [key, f] of Object.entries(model.fields)) {
    if (f.kind !== "slug" || data[key] || !f.options.from) continue;
    const source = data[f.options.from as string];
    if (typeof source === "string" && source.trim()) data[key] = slugify(source);
  }
}

function itemLimit(actor: Actor) {
  return actor.budget?.maxChangesetItems ?? 100;
}

/** Create or change an entry inside the actor's open changeset. */
export async function draftEntry(
  k: Kernel,
  actor: Actor,
  model: Model,
  input: Record<string, unknown>,
  opts: DraftOptions = {},
) {
  const { id, locale: rawLocale, ...rest } = input as { id?: string; locale?: string } & Record<string, unknown>;
  const changed = Object.keys(rest).filter((key) => rest[key] !== undefined);
  const unknown = changed.filter((key) => !(key in model.fields));
  if (unknown.length) throw new AicmsError("invalid", `Model "${model.name}" has no field ${unknown.map((u) => `"${u}"`).join(", ")}`);
  const patch = normalizePatch(model, rest);
  const perms = modelPermissions(actor, model);

  const requireCreate = () => {
    if (!opts.trusted && !perms.create) throw new AicmsError("forbidden", `You can't create ${model.name} entries`);
  };
  const requireFields = () => {
    if (opts.trusted) return;
    const denied = changed.filter((key) => !perms.updateFields.includes(key));
    if (denied.length) {
      const allowed = perms.updateFields.length ? ` You may change: ${perms.updateFields.join(", ")}.` : "";
      throw new AicmsError("forbidden", `You can't change ${denied.map((d) => `${model.name}.${d}`).join(", ")}.${allowed}`);
    }
  };

  const cs = await openChangeset(k, actor);
  let item: ChangesetItem | undefined = id ? cs.items.find((i) => i.id === id) : undefined;
  let before: Record<string, unknown> = {};

  if (id && item) {
    if (item.model !== model.name) throw new AicmsError("invalid", `${id} is a ${item.model}, not a ${model.name}`);
    if (item.op === "delete") throw new AicmsError("invalid", `You already proposed deleting ${id}. Draft a new entry instead.`);
    if (item.op === "create") {
      requireCreate();
      item.data = applyPatch(item.data ?? {}, patch);
      fillSlugs(model, item.data);
    } else {
      requireFields();
      item.data = { ...item.data, ...patch };
      before = (await k.store.getEntry(id))?.data ?? {};
    }
  } else if (id) {
    const entry = await k.store.getEntry(id);
    if (!entry || entry.model !== model.name) throw new AicmsError("not_found", `No ${model.name} with id ${id}`);
    requireFields();
    before = entry.data;
    item = { op: "update", model: model.name, id, locale: entry.locale, data: patch, baseVersion: entry.version };
    cs.items.push(item);
  } else {
    requireCreate();
    const locale = rawLocale ?? k.defaultLocale;
    if (!k.config.locales.includes(locale)) throw new AicmsError("invalid", `Unknown locale "${locale}". Use one of: ${k.config.locales.join(", ")}`);
    const data = applyPatch({}, patch);
    fillSlugs(model, data);
    item = { op: "create", model: model.name, id: newId(model.name.slice(0, 3)), locale, data };
    cs.items.push(item);
  }

  if (cs.items.length > itemLimit(actor)) {
    throw new AicmsError("budget", `A changeset may hold ${itemLimit(actor)} items. Submit this one with cms_submit first.`);
  }
  cs.updatedAt = now();
  cs.issues = [];
  await k.store.saveChangeset(cs);
  // People in Studio see an agent working on an entry as it happens.
  if (actor.kind === "agent" && item.op === "update") k.presence.touch(actor, item.id, model.name, "editing");

  const result = item.op === "create" ? item.data ?? {} : applyPatch(before, item.data ?? {});
  return {
    changeset: cs.id,
    op: item.op,
    id: item.id,
    model: model.name,
    entry: projectData(model, result, "markdown"),
    next: "Saved as a draft, not public yet. Call cms_submit when your changes are ready.",
  };
}

/** Drop drafted changes from the actor's open changeset: one entry, or all of them. */
export async function discardDrafts(k: Kernel, actor: Actor, id?: string) {
  const cs = await k.store.findOpenChangeset(actor.id);
  if (!cs || !cs.items.length) {
    if (id) throw new AicmsError("not_found", `You have no draft of ${id}`);
    return { changeset: cs?.id ?? null, discarded: 0, left: 0 };
  }
  const before = cs.items.length;
  cs.items = id ? cs.items.filter((i) => i.id !== id) : [];
  if (cs.items.length === before) throw new AicmsError("not_found", `You have no draft of ${id}`);
  cs.issues = [];
  cs.updatedAt = now();
  await k.store.saveChangeset(cs);
  return { changeset: cs.id, discarded: before - cs.items.length, left: cs.items.length };
}

/** Propose deleting an entry, or drop a draft that was never published. */
export async function deleteEntry(k: Kernel, actor: Actor, model: Model, id: string, opts: DraftOptions = {}) {
  if (!opts.trusted && !modelPermissions(actor, model).delete) throw new AicmsError("forbidden", `You can't delete ${model.name} entries`);
  const cs = await openChangeset(k, actor);
  const idx = cs.items.findIndex((i) => i.id === id);
  let op: string;
  if (idx >= 0 && cs.items[idx].op === "create") {
    cs.items.splice(idx, 1);
    op = "discarded";
  } else {
    const entry = await k.store.getEntry(id);
    if (!entry || entry.model !== model.name) throw new AicmsError("not_found", `No ${model.name} with id ${id}`);
    const item: ChangesetItem = { op: "delete", model: model.name, id, locale: entry.locale, baseVersion: entry.version };
    if (idx >= 0) cs.items[idx] = item;
    else cs.items.push(item);
    op = "delete";
  }
  cs.updatedAt = now();
  await k.store.saveChangeset(cs);
  return {
    changeset: cs.id,
    op,
    id,
    next: op === "discarded" ? "The unpublished draft was dropped." : "Deletion proposed. Call cms_submit to send it for review.",
  };
}

/**
 * An entry as this actor sees it: the published version with their open
 * changeset applied on top. `null` if it doesn't exist or they proposed deleting it.
 */
export async function entryWithDrafts(k: Kernel, actor: Actor, id: string): Promise<EntryRow | null> {
  const published = await k.store.getEntry(id);
  const cs = actor.kind === "public" ? null : await k.store.findOpenChangeset(actor.id);
  const item = cs?.items.find((i) => i.id === id);
  if (!item) return published;
  if (item.op === "delete") return null;
  if (item.op === "create") {
    const at = cs!.updatedAt;
    return { id, model: item.model, locale: item.locale, data: item.data ?? {}, version: 0, createdAt: at, updatedAt: at, createdBy: actor.id, updatedBy: actor.id };
  }
  return published ? { ...published, data: applyPatch(published.data, item.data ?? {}) } : null;
}

/** Schema, uniqueness, reference and conflict checks for every item. */
export async function checkChangeset(k: Kernel, cs: ChangesetRow): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const created = new Map(cs.items.filter((i) => i.op === "create").map((i) => [i.id, i.model]));
  const deleted = new Set(cs.items.filter((i) => i.op === "delete").map((i) => i.id));
  const seen = new Map<string, string>();

  for (const item of cs.items) {
    const add = (message: string, field?: string) => issues.push({ entry: item.id, model: item.model, ...(field ? { field } : {}), message });
    if (item.op === "install") {
      try {
        catalogEntry(k, item.id);
      } catch (e) {
        add(e instanceof Error ? e.message : String(e));
      }
      continue;
    }
    const model = k.models.get(item.model);
    if (!model) { add(`Model "${item.model}" no longer exists`); continue; }

    let current: EntryRow | null = null;
    if (item.op !== "create") {
      current = await k.store.getEntry(item.id);
      if (!current) { add("This entry was deleted after you drafted the change"); continue; }
      if (item.baseVersion !== undefined && current.version !== item.baseVersion) {
        add(`Someone changed this entry after you drafted (v${item.baseVersion} → v${current.version}). Read it again and redo your change.`);
        continue;
      }
    }
    if (item.op === "delete") continue;

    const doc = item.op === "create" ? item.data ?? {} : applyPatch(current!.data, item.data ?? {});
    const parsed = storedSchema(model).safeParse(doc);
    if (!parsed.success) for (const issue of parsed.error.issues) add(issue.message, issue.path.join(".") || undefined);

    for (const f of uniqueFields(model)) {
      const value = doc[f];
      if (value == null || value === "") continue;
      const key = `${item.model}|${item.locale}|${f}|${String(value)}`;
      if (seen.has(key)) add(`"${value}" is used twice in this changeset (also by ${seen.get(key)})`, f);
      seen.set(key, item.id);
      const other = await k.store.findOne(item.model, f, value, item.locale);
      if (other && other.id !== item.id && !deleted.has(other.id)) add(`"${value}" is already used by ${other.id}`, f);
    }

    for (const [f, def] of Object.entries(model.fields)) {
      if (def.kind !== "ref" || doc[f] == null) continue;
      const target = def.options.model as string;
      const ids = Array.isArray(doc[f]) ? (doc[f] as string[]) : [doc[f] as string];
      for (const ref of ids) {
        if (created.get(ref) === target) continue;
        const entry = deleted.has(ref) ? null : await k.store.getEntry(ref);
        if (!entry || entry.model !== target) add(`No ${target} with id ${ref}`, f);
      }
    }
  }
  return issues;
}

/** Module checks on every create and update: errors block, warnings go to the reviewer. A check that throws becomes a warning. */
export async function runModuleChecks(k: Kernel, cs: ChangesetRow): Promise<{ errors: CheckIssue[]; warnings: CheckIssue[] }> {
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  const checkers = k.modules.filter((m) => m.checks && Object.keys(m.checks).length);
  if (!checkers.length) return { errors, warnings };
  for (const item of cs.items) {
    if (item.op !== "create" && item.op !== "update") continue;
    const model = k.models.get(item.model);
    if (!model) continue;
    const current = item.op === "update" ? await k.store.getEntry(item.id) : null;
    if (item.op === "update" && !current) continue;
    const data = item.op === "create" ? item.data ?? {} : applyPatch(current!.data, item.data ?? {});
    const input: CheckInput = {
      op: item.op,
      model,
      id: item.id,
      locale: item.locale,
      data: projectData(model, data, "blocks"),
      before: current ? projectData(model, current.data, "blocks") : null,
      changed: Object.keys(item.data ?? {}),
      author: cs.actor,
    };
    for (const mod of checkers) {
      const scope = new Set([...(mod.models ?? []).map((m) => m.name), ...(mod.uses ?? [])]);
      if (!scope.has("*") && !scope.has(model.name)) continue;
      const ctx = moduleContext(k, mod, { id: `module:${mod.name}`, kind: "system", scopes: ["*"], review: "auto" }, "internal");
      for (const [name, check] of Object.entries(mod.checks!)) {
        const tag = `${mod.name}/${name}`;
        try {
          for (const f of (await check(input, ctx)) ?? []) {
            const issue: CheckIssue = { entry: item.id, model: model.name, ...(f.field ? { field: f.field } : {}), message: f.message, check: tag };
            (f.level === "error" ? errors : warnings).push(issue);
          }
        } catch (e) {
          warnings.push({ entry: item.id, model: model.name, message: `The ${tag} check failed: ${e instanceof Error ? e.message : String(e)}`, check: tag });
        }
      }
    }
  }
  return { errors, warnings };
}

/** Everything a changeset must pass: schema, uniqueness, references, conflicts and module checks. */
async function fullCheck(k: Kernel, cs: ChangesetRow) {
  const issues = await checkChangeset(k, cs);
  const { errors, warnings } = await runModuleChecks(k, cs);
  return { issues: [...issues, ...errors], warnings };
}

/** The scope each item needs, for `review: { auto: [...] }` rules. */
function neededScopes(item: ChangesetItem): string[] {
  if (item.op === "install") return ["modules:install"];
  if (item.op === "create") return [`${item.model}:create`];
  if (item.op === "delete") return [`${item.model}:delete`];
  return Object.keys(item.data ?? {}).map((f) => `${item.model}:update.${f}`);
}

function reviewReason(k: Kernel, actor: Actor, cs: ChangesetRow): string | undefined {
  if (actor.kind === "owner" || actor.kind === "system") return undefined;
  const rule = actor.review;
  if (rule === "human") return `Changes from ${actor.id} are reviewed by a person`;
  if (typeof rule === "object") {
    const outside = [...new Set(cs.items.flatMap(neededScopes))].filter((s) => !allows(rule.auto, s));
    if (outside.length) return `${actor.id} publishes without review only ${rule.auto.join(", ") || "nothing"}; this also changes ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? "…" : ""}`;
  }
  for (const item of cs.items) {
    const can = k.models.get(item.model)?.agent?.can;
    if (can && !can.includes("publish")) return `Model "${item.model}" requires a person to publish`;
  }
  const w = cs.warnings?.length ?? 0;
  if (w) return `${w} check warning${w === 1 ? "" : "s"} for a person to look at`;
  return undefined;
}

const SCHEDULE_SLACK_MS = 5_000;

/** A future time as ISO, or undefined for "now". Throws on nonsense. */
export function parsePublishAt(at: string | undefined): string | undefined {
  if (!at || at === "now") return undefined;
  const t = Date.parse(at);
  if (Number.isNaN(t)) throw new AicmsError("invalid", `"${at}" isn't a date. Use ISO 8601, e.g. 2026-12-01T09:00:00Z`);
  if (t > Date.now() + 366 * 86_400_000) throw new AicmsError("invalid", "Schedule at most a year ahead");
  return t > Date.now() + SCHEDULE_SLACK_MS ? new Date(t).toISOString() : undefined;
}

/** Checks on the caller's open changeset, without submitting: what cms_submit would say. */
export async function checkDrafts(k: Kernel, actor: Actor) {
  const cs = await k.store.findOpenChangeset(actor.id);
  if (!cs || !cs.items.length) throw new AicmsError("invalid", "You have no drafted changes. Use a <model>_draft tool first.");
  const { issues, warnings } = await fullCheck(k, cs);
  const reason = issues.length ? undefined : reviewReason(k, actor, { ...cs, warnings });
  return {
    changeset: cs.id,
    ready: !issues.length,
    issues,
    warnings,
    ...(issues.length ? {} : { onSubmit: reason ? `waits for a person: ${reason}` : "merged right away" }),
    next: issues.length
      ? "Fix the issues with the <model>_draft tools, then check again."
      : warnings.length
        ? "Fix the warnings if you can, or explain them in the cms_submit note."
        : "All checks pass. Call cms_submit.",
  };
}

export interface SubmitOptions {
  note?: string;
  /** Ask to publish at this time (ISO 8601). A reviewer approves it as a schedule. */
  publishAt?: string;
  /** The brief this answers. */
  brief?: string;
}

export async function submitChangeset(k: Kernel, actor: Actor, input: string | SubmitOptions = {}) {
  const opts: SubmitOptions = typeof input === "string" ? { note: input } : input;
  const cs = await k.store.findOpenChangeset(actor.id);
  if (!cs || !cs.items.length) throw new AicmsError("invalid", "You have no drafted changes. Use a <model>_draft tool first.");
  const publishAt = parsePublishAt(opts.publishAt);
  const { issues, warnings } = await fullCheck(k, cs);
  cs.updatedAt = now();
  if (opts.note) cs.note = opts.note;
  if (opts.brief) cs.brief = opts.brief;
  cs.publishAt = publishAt;
  cs.warnings = warnings;
  if (issues.length) {
    cs.issues = issues;
    await k.store.saveChangeset(cs);
    return {
      status: "needs_changes",
      changeset: cs.id,
      issues,
      ...(warnings.length ? { warnings } : {}),
      next: "Fix these with the <model>_draft tools, then call cms_submit again.",
    };
  }
  const reason = reviewReason(k, actor, cs);
  cs.issues = [];
  cs.comment = undefined;
  // Submitting ends the work on these entries: the agent is no longer "editing" them.
  for (const item of cs.items) if (item.op !== "install") k.presence.leave(actor, item.id);
  if (reason) {
    cs.status = "submitted";
    cs.reviewReason = reason;
    await k.store.saveChangeset(cs);
    await k.emit("changeset.submitted", summarize(cs));
    return {
      status: "submitted",
      changeset: cs.id,
      reason,
      ...(warnings.length ? { warnings } : {}),
      ...(publishAt ? { publishAt } : {}),
      next: publishAt
        ? `Waiting for review. If approved, it is published at ${publishAt}. Check cms_changes later.`
        : "Waiting for review. Check cms_changes later for the decision and any comment.",
    };
  }
  await k.store.saveChangeset(cs);
  if (publishAt) return schedule(k, cs, publishAt, actor.id);
  return { status: "merged", ...(await mergeChangeset(k, cs.id, actor.id, { at: "now" })) };
}

async function schedule(k: Kernel, cs: ChangesetRow, at: string, by: string) {
  cs.status = "scheduled";
  cs.publishAt = at;
  cs.scheduledBy = by;
  cs.reviewReason = undefined;
  cs.updatedAt = now();
  await k.store.saveChangeset(cs);
  await k.emit("changeset.scheduled", summarize(cs));
  return { status: "scheduled", changeset: cs.id, publishAt: at, next: `Published automatically at ${at}.` };
}

export interface MergeOptions {
  /**
   * When to publish: an ISO time schedules it, "now" publishes at once.
   * Omitted: at the time the author asked for, if any, else now.
   */
  at?: string;
}

export async function mergeChangeset(k: Kernel, id: string, by: string, opts: MergeOptions = {}) {
  const cs = await k.store.getChangeset(id);
  if (!cs) throw new AicmsError("not_found", `No changeset ${id}`);
  if (cs.status === "merged" || cs.status === "rejected") throw new AicmsError("invalid", `Changeset ${id} is already ${cs.status}`);
  if (!cs.items.length) throw new AicmsError("invalid", `Changeset ${id} is empty`);
  const install = cs.items.some((i) => i.op === "install");
  const at = install ? undefined : parsePublishAt(opts.at ?? (cs.status === "submitted" ? cs.publishAt : undefined));

  const sendBack = async (issues: CheckIssue[]) => {
    cs.status = "open";
    cs.issues = issues;
    cs.comment = "Checks failed when merging. Fix the issues and submit again.";
    cs.updatedAt = now();
    await k.store.saveChangeset(cs);
    throw new AicmsError("conflict", `Changeset ${id} can't be merged; it went back to ${cs.actor}`, { issues });
  };

  if (install) return mergeInstall(k, cs, by, await checkChangeset(k, cs));
  const { issues, warnings } = await fullCheck(k, cs);
  if (issues.length) await sendBack(issues);
  cs.warnings = warnings;
  if (at) return schedule(k, cs, at, by);

  let entries: EntryRow[];
  try {
    entries = await k.store.mergeChangeset(id, by, now());
  } catch (e) {
    if (e instanceof ConflictError) return sendBack([{ entry: e.entry, model: "", message: e.message }]);
    throw e;
  }
  const ops = new Map(cs.items.map((i) => [i.id, i.op]));
  const summary = {
    changeset: id,
    actor: cs.actor,
    mergedBy: by,
    ...(cs.brief ? { brief: cs.brief } : {}),
    entries: entries.map((e) => ({ id: e.id, model: e.model, op: ops.get(e.id), version: e.version })),
  };
  await k.emit("changeset.merged", summary);
  return summary;
}

/** Take a scheduled changeset off the schedule; it waits for review again. */
export async function unscheduleChangeset(k: Kernel, id: string, by: string) {
  const cs = await k.store.getChangeset(id);
  if (!cs) throw new AicmsError("not_found", `No changeset ${id}`);
  if (cs.status !== "scheduled") throw new AicmsError("invalid", `Changeset ${id} isn't scheduled; it is ${cs.status}`);
  cs.status = "submitted";
  cs.reviewReason = `Taken off the schedule by ${by}`;
  cs.publishAt = undefined;
  cs.scheduledBy = undefined;
  cs.updatedAt = now();
  await k.store.saveChangeset(cs);
  await k.emit("changeset.unscheduled", { ...summarize(cs), by });
  return { changeset: id, status: cs.status };
}

/**
 * Merge every scheduled changeset whose time has come. One that no longer
 * passes its checks goes back to its author, like a manual merge would.
 */
export async function publishDue(k: Kernel, at = new Date()) {
  const due = (await k.store.listChangesets({ status: ["scheduled"], limit: 500 })).filter((cs) => cs.publishAt && Date.parse(cs.publishAt) <= at.getTime());
  const merged: string[] = [];
  const failed: { changeset: string; error: string }[] = [];
  for (const cs of due.sort((a, b) => a.publishAt!.localeCompare(b.publishAt!))) {
    try {
      await mergeChangeset(k, cs.id, cs.scheduledBy ?? "owner", { at: "now" });
      merged.push(cs.id);
    } catch (e) {
      failed.push({ changeset: cs.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { merged, failed };
}

/** A module proposal: install each module, then record the changeset as merged. */
async function mergeInstall(k: Kernel, cs: ChangesetRow, by: string, issues: CheckIssue[]) {
  if (issues.length) {
    cs.status = "rejected";
    cs.issues = issues;
    cs.comment = issues.map((i) => i.message).join("; ");
    cs.updatedAt = now();
    await k.store.saveChangeset(cs);
    throw new AicmsError("conflict", `Can't install: ${cs.comment}`, { issues });
  }
  const installed = [];
  for (const item of cs.items) installed.push(await installFromCatalog(k, item.id));
  const at = now();
  cs.status = "merged";
  cs.mergedAt = at;
  cs.mergedBy = by;
  cs.updatedAt = at;
  cs.reviewReason = undefined;
  await k.store.saveChangeset(cs);
  const summary = { changeset: cs.id, actor: cs.actor, mergedBy: by, entries: [], modules: installed.map((i) => i.module), installed };
  await k.emit("changeset.merged", summary);
  return summary;
}

/** An agent's request to install a catalog module; it waits in the Inbox for a person. */
export async function proposeModule(k: Kernel, actor: Actor, name: string, reason: string) {
  const entry = catalogEntry(k, name);
  const pending = await k.store.listChangesets({ status: ["submitted"], limit: 500 });
  if (pending.some((cs) => cs.items.some((i) => i.op === "install" && i.id === entry.name))) throw new AicmsError("conflict", `Installing "${entry.name}" is already waiting for review`);
  const at = now();
  const cs: ChangesetRow = {
    id: newId("cs"),
    actor: actor.id,
    status: "submitted",
    note: reason,
    reviewReason: "Installing a module is decided by a person",
    items: [{ op: "install", model: "", id: entry.name, locale: "" }],
    issues: [],
    createdAt: at,
    updatedAt: at,
  };
  await k.store.createChangeset(cs);
  await k.emit("changeset.submitted", summarize(cs));
  return {
    status: "submitted",
    changeset: cs.id,
    module: moduleManifest(entry.create()),
    next: "A person will see what the module may do and decide. Check cms_changes for the answer.",
  };
}

export async function rejectChangeset(k: Kernel, id: string, by: string, comment: string, final = false) {
  const cs = await k.store.getChangeset(id);
  if (!cs) throw new AicmsError("not_found", `No changeset ${id}`);
  // A module proposal never reopens: it would turn into the agent's content draft.
  if (cs.items.some((i) => i.op === "install")) final = true;
  if (cs.status !== "submitted" && cs.status !== "open" && cs.status !== "scheduled") throw new AicmsError("invalid", `Changeset ${id} is already ${cs.status}`);
  const otherOpen = await k.store.findOpenChangeset(cs.actor);
  const reopen = !final && (!otherOpen || otherOpen.id === cs.id);
  cs.status = reopen ? "open" : "rejected";
  cs.comment = comment;
  cs.reviewReason = undefined;
  cs.scheduledBy = undefined;
  cs.updatedAt = now();
  await k.store.saveChangeset(cs);
  await k.emit("changeset.rejected", { ...summarize(cs), comment, by, reopened: reopen });
  return { changeset: id, status: cs.status, reopened: reopen };
}

export function summarize(cs: ChangesetRow) {
  return {
    id: cs.id,
    actor: cs.actor,
    status: cs.status,
    ...(cs.note ? { note: cs.note } : {}),
    ...(cs.comment ? { comment: cs.comment } : {}),
    ...(cs.reviewReason ? { waitingBecause: cs.reviewReason } : {}),
    ...(cs.issues.length ? { issues: cs.issues } : {}),
    ...(cs.warnings?.length ? { warnings: cs.warnings } : {}),
    ...(cs.publishAt ? { publishAt: cs.publishAt } : {}),
    ...(cs.scheduledBy ? { scheduledBy: cs.scheduledBy } : {}),
    ...(cs.brief ? { brief: cs.brief } : {}),
    items: cs.items.map((i) => ({ op: i.op, model: i.model, id: i.id, ...(i.data ? { fields: Object.keys(i.data) } : {}) })),
    updatedAt: cs.updatedAt,
  };
}

/** Before/after per field, for reviewers. Block fields are shown as Markdown. */
export async function diffChangeset(k: Kernel, cs: ChangesetRow) {
  const items = [];
  for (const item of cs.items) {
    if (item.op === "install") {
      const entry = findCatalog(item.id);
      items.push({ op: item.op, model: "module", id: item.id, title: entry?.title ?? item.id, summary: entry?.summary, module: entry ? moduleManifest(entry.create()) : null, changes: [] });
      continue;
    }
    const model = k.models.get(item.model);
    const current = item.op === "create" ? null : await k.store.getEntry(item.id);
    const before = model && current ? projectData(model, current.data, "markdown") : {};
    const after = model && item.data ? projectData(model, item.data, "markdown") : {};
    const order = model ? Object.keys(model.fields) : [];
    const fields = item.op === "delete" ? [] : Object.keys(item.data ?? {}).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const merged = item.op === "create" ? item.data ?? {} : current ? applyPatch(current.data, item.data ?? {}) : {};
    items.push({
      op: item.op,
      model: item.model,
      id: item.id,
      title: model ? displayTitle(model, item.op === "delete" ? current?.data ?? {} : merged) : "",
      changes: fields.map((f) => ({ field: f, before: before[f] ?? null, after: item.data?.[f] === null ? null : after[f] ?? null })),
    });
  }
  return { ...summarize(cs), items };
}

/** Which model and locale an entry belongs to, even after it was deleted. */
async function locateEntry(k: Kernel, id: string): Promise<{ model: string; locale: string } | null> {
  const current = await k.store.getEntry(id);
  if (current) return { model: current.model, locale: current.locale };
  for (const v of await k.store.versions(id)) {
    if (!v.changesetId) continue;
    const item = (await k.store.getChangeset(v.changesetId))?.items.find((i) => i.id === id);
    if (item) return { model: item.model, locale: item.locale };
  }
  return null;
}

/** Every version of an entry, newest first, with the fields each one changed. */
export async function entryHistory(k: Kernel, actor: Actor, id: string) {
  const where = await locateEntry(k, id);
  const model = where && k.models.get(where.model);
  if (!where || !model || !modelPermissions(actor, model).read) throw new AicmsError("not_found", `No entry ${id}`);
  const versions = await k.store.versions(id);
  const current = await k.store.getEntry(id);
  return {
    id,
    model: model.name,
    locale: where.locale,
    current: current?.version ?? null,
    versions: versions.map((v, i) => {
      const prev = versions[i + 1]?.data ?? {};
      const data = v.data ?? {};
      const changed = v.data === null ? [] : [...new Set([...Object.keys(prev), ...Object.keys(data)])].filter((f) => JSON.stringify(prev[f]) !== JSON.stringify(data[f]));
      return {
        version: v.version,
        at: v.createdAt,
        actor: v.actor,
        changeset: v.changesetId,
        ...(v.data === null ? { deleted: true } : { changed }),
      };
    }),
  };
}

/** One version's data, for reading or comparing. */
export async function entryVersion(k: Kernel, actor: Actor, id: string, version: number) {
  const history = await entryHistory(k, actor, id);
  const row = (await k.store.versions(id)).find((v) => v.version === version);
  if (!row) throw new AicmsError("not_found", `${id} has no version ${version}. Versions: ${history.versions.map((v) => v.version).join(", ")}`);
  const model = k.models.get(history.model)!;
  return { id, model: model.name, version, at: row.createdAt, actor: row.actor, changeset: row.changesetId, deleted: row.data === null, data: row.data };
}

/**
 * Draft a change that brings an entry back to the state it had at `version`.
 * A deleted entry is re-created with the same id. Replaces any draft of that entry in the caller's changeset.
 */
export async function restoreEntry(k: Kernel, actor: Actor, id: string, version: number) {
  const target = await entryVersion(k, actor, id, version);
  if (target.deleted) throw new AicmsError("invalid", `Version ${version} of ${id} is its deletion. Restore an earlier version.`);
  const model = k.models.get(target.model)!;
  const data = Object.fromEntries(Object.entries(target.data ?? {}).filter(([key]) => key in model.fields));
  const perms = modelPermissions(actor, model);
  const current = await k.store.getEntry(id);
  const cs = await openChangeset(k, actor);
  const others = cs.items.filter((i) => i.id !== id);

  let item: ChangesetItem;
  if (current) {
    const patch: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(current.data), ...Object.keys(data)])) {
      if (!(key in model.fields)) continue;
      if (JSON.stringify(current.data[key]) !== JSON.stringify(data[key])) patch[key] = data[key] ?? null;
    }
    const fields = Object.keys(patch);
    if (!fields.length) throw new AicmsError("invalid", `${id} already matches version ${version}`);
    const denied = fields.filter((f) => !perms.updateFields.includes(f));
    if (denied.length) throw new AicmsError("forbidden", `Restoring needs changes to ${denied.map((d) => `${model.name}.${d}`).join(", ")}, which you can't change`);
    item = { op: "update", model: model.name, id, locale: current.locale, data: patch, baseVersion: current.version };
  } else {
    if (!perms.create) throw new AicmsError("forbidden", `Restoring a deleted ${model.name} needs permission to create ${model.name} entries`);
    const locale = (await locateEntry(k, id))!.locale;
    item = { op: "create", model: model.name, id, locale, data };
  }
  cs.items = [...others, item];
  if (cs.items.length > itemLimit(actor)) throw new AicmsError("budget", `A changeset may hold ${itemLimit(actor)} items. Submit this one first.`);
  cs.updatedAt = now();
  cs.issues = [];
  await k.store.saveChangeset(cs);
  return {
    changeset: cs.id,
    op: item.op,
    id,
    model: model.name,
    restores: version,
    fields: Object.keys(item.data ?? {}),
    next: "The restore is drafted. Call cms_submit to publish it.",
  };
}

/** Draft the inverse of a merged changeset: creations are deleted, edits and deletions are undone. */
export async function revertChangeset(k: Kernel, actor: Actor, id: string) {
  const cs = await k.store.getChangeset(id);
  if (!cs) throw new AicmsError("not_found", `No changeset ${id}`);
  if (cs.status !== "merged") throw new AicmsError("invalid", `Only merged changesets can be reverted; ${id} is ${cs.status}`);

  const plan: { item: ChangesetItem; made: number }[] = [];
  const moved: string[] = [];
  for (const item of cs.items) {
    const versions = await k.store.versions(item.id);
    const made = versions.find((v) => v.changesetId === cs.id);
    if (!made) continue;
    if (versions[0].version !== made.version) moved.push(item.id);
    plan.push({ item, made: made.version });
  }
  if (moved.length) {
    throw new AicmsError("conflict", `Changed again after ${id} was merged: ${moved.join(", ")}. Restore those entries from their history instead.`, { entries: moved });
  }

  const done = [];
  for (const { item, made } of plan) {
    const model = k.models.get(item.model);
    if (!model) throw new AicmsError("invalid", `Model "${item.model}" no longer exists`);
    if (item.op === "create") done.push(await deleteEntry(k, actor, model, item.id));
    else done.push(await restoreEntry(k, actor, item.id, made - 1));
  }
  const open = await k.store.findOpenChangeset(actor.id);
  return {
    changeset: open?.id,
    reverts: id,
    items: done.map((d) => ({ op: d.op, id: d.id })),
    next: "The revert is drafted. Call cms_submit to publish it.",
  };
}
