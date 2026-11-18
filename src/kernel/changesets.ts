import { randomBytes } from "node:crypto";
import type { Model } from "../schema/model.ts";
import { displayTitle, normalizePatch, projectData, storedSchema, uniqueFields } from "../schema/model.ts";
import { slugify } from "../schema/slug.ts";
import { applyPatch } from "../store/sqlite.ts";
import { ConflictError, type ChangesetItem, type ChangesetRow, type CheckIssue, type EntryRow } from "../store/types.ts";
import { AicmsError } from "./errors.ts";
import { modelPermissions, type Actor } from "./policy.ts";
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
    const model = k.models.get(item.model);
    const add = (message: string, field?: string) => issues.push({ entry: item.id, model: item.model, ...(field ? { field } : {}), message });
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

function reviewReason(k: Kernel, actor: Actor, cs: ChangesetRow): string | undefined {
  if (actor.kind === "owner" || actor.kind === "system") return undefined;
  if (actor.review === "human") return `Changes from ${actor.id} are reviewed by a person`;
  for (const item of cs.items) {
    const can = k.models.get(item.model)?.agent?.can;
    if (can && !can.includes("publish")) return `Model "${item.model}" requires a person to publish`;
  }
  return undefined;
}

export async function submitChangeset(k: Kernel, actor: Actor, note?: string) {
  const cs = await k.store.findOpenChangeset(actor.id);
  if (!cs || !cs.items.length) throw new AicmsError("invalid", "You have no drafted changes. Use a <model>_draft tool first.");
  const issues = await checkChangeset(k, cs);
  cs.updatedAt = now();
  if (note) cs.note = note;
  if (issues.length) {
    cs.issues = issues;
    await k.store.saveChangeset(cs);
    return {
      status: "needs_changes",
      changeset: cs.id,
      issues,
      next: "Fix these with the <model>_draft tools, then call cms_submit again.",
    };
  }
  const reason = reviewReason(k, actor, cs);
  cs.issues = [];
  cs.comment = undefined;
  if (reason) {
    cs.status = "submitted";
    cs.reviewReason = reason;
    await k.store.saveChangeset(cs);
    await k.emit("changeset.submitted", summarize(cs));
    return {
      status: "submitted",
      changeset: cs.id,
      reason,
      next: "Waiting for review. Check cms_changes later for the decision and any comment.",
    };
  }
  await k.store.saveChangeset(cs);
  return { status: "merged", ...(await mergeChangeset(k, cs.id, actor.id)) };
}

export async function mergeChangeset(k: Kernel, id: string, by: string) {
  const cs = await k.store.getChangeset(id);
  if (!cs) throw new AicmsError("not_found", `No changeset ${id}`);
  if (cs.status === "merged" || cs.status === "rejected") throw new AicmsError("invalid", `Changeset ${id} is already ${cs.status}`);
  if (!cs.items.length) throw new AicmsError("invalid", `Changeset ${id} is empty`);

  const sendBack = async (issues: CheckIssue[]) => {
    cs.status = "open";
    cs.issues = issues;
    cs.comment = "Checks failed when merging. Fix the issues and submit again.";
    cs.updatedAt = now();
    await k.store.saveChangeset(cs);
    throw new AicmsError("conflict", `Changeset ${id} can't be merged; it went back to ${cs.actor}`, { issues });
  };

  const issues = await checkChangeset(k, cs);
  if (issues.length) await sendBack(issues);

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
    entries: entries.map((e) => ({ id: e.id, model: e.model, op: ops.get(e.id), version: e.version })),
  };
  await k.emit("changeset.merged", summary);
  return summary;
}

export async function rejectChangeset(k: Kernel, id: string, by: string, comment: string, final = false) {
  const cs = await k.store.getChangeset(id);
  if (!cs) throw new AicmsError("not_found", `No changeset ${id}`);
  if (cs.status !== "submitted" && cs.status !== "open") throw new AicmsError("invalid", `Changeset ${id} is already ${cs.status}`);
  const otherOpen = await k.store.findOpenChangeset(cs.actor);
  const reopen = !final && (!otherOpen || otherOpen.id === cs.id);
  cs.status = reopen ? "open" : "rejected";
  cs.comment = comment;
  cs.reviewReason = undefined;
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
    items: cs.items.map((i) => ({ op: i.op, model: i.model, id: i.id, ...(i.data ? { fields: Object.keys(i.data) } : {}) })),
    updatedAt: cs.updatedAt,
  };
}

/** Before/after per field, for reviewers. Block fields are shown as Markdown. */
export async function diffChangeset(k: Kernel, cs: ChangesetRow) {
  const items = [];
  for (const item of cs.items) {
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
