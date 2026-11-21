// Briefs: work people (or a planning agent) hand to agents. "Write a post about
// the spring menu, publish Friday 9:00." An agent finds its briefs with
// cms_briefs, says what it's doing with cms_brief_update, and answers with
// cms_submit({ brief }). Merging the changeset closes the brief; rejecting it
// sends the reviewer's comment back as a note.

import { AicmsError } from "./errors.ts";
import { newId } from "./changesets.ts";
import { allows, type Actor } from "./policy.ts";
import type { Kernel } from "./cms.ts";

export type BriefStatus = "open" | "in_progress" | "blocked" | "in_review" | "done" | "canceled";
export const BRIEF_STATUSES: BriefStatus[] = ["open", "in_progress", "blocked", "in_review", "done", "canceled"];
/** What an agent working on a brief may set. The rest follows from its changesets or a person's decision. */
export const AGENT_BRIEF_STATUSES = ["in_progress", "blocked", "open", "done"] as const;

export interface BriefNote {
  at: string;
  by: string;
  text: string;
}

export interface Brief {
  id: string;
  title: string;
  /** What to do, in Markdown: audience, sources, tone, must-haves. */
  details?: string;
  /** The agent it's for. Without one, any agent may pick it up. */
  agent?: string;
  /** What to produce, e.g. "post". */
  model?: string;
  /** An existing entry to work on. */
  entry?: string;
  /** When the work should be ready (ISO date or time). */
  due?: string;
  /** When the result should go live; passed on to cms_submit. */
  publishAt?: string;
  status: BriefStatus;
  /** The agent that took it, for briefs without `agent`. */
  claimedBy?: string;
  changesets: string[];
  notes: BriefNote[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const SCOPE = "core:briefs";
const MAX_NOTES = 100;
const now = () => new Date().toISOString();

/** May write and manage briefs: people (the owner) and planning agents with `briefs:write`. */
export const briefWriter = (a: Actor) => allows(a.scopes, "briefs:write");

/** Is this brief for this agent: assigned to it, taken by it, or open to anyone? */
export function briefIsFor(b: Brief, actor: Actor): boolean {
  if (actor.kind !== "agent") return false;
  if (b.agent) return b.agent === actor.id;
  return !b.claimedBy || b.claimedBy === actor.id;
}

const canSee = (b: Brief, actor: Actor) => briefWriter(actor) || briefIsFor(b, actor) || b.createdBy === actor.id;

async function load(k: Kernel, id: string): Promise<Brief | null> {
  return ((await k.store.kvGet(SCOPE, id)) as Brief | undefined) ?? null;
}

async function save(k: Kernel, b: Brief, event: "brief.created" | "brief.updated", by: string) {
  b.updatedAt = now();
  await k.store.kvSet(SCOPE, b.id, b);
  await k.emit(event, { ...briefSummary(b), by });
  return b;
}

/** The list view: everything but the notes. */
export function briefSummary(b: Brief) {
  const { notes, ...rest } = b;
  return { ...rest, notes: notes.length, ...(notes.length ? { lastNote: notes[notes.length - 1] } : {}) };
}

export async function getBrief(k: Kernel, actor: Actor, id: string): Promise<Brief> {
  const b = await load(k, id);
  if (!b || !canSee(b, actor)) throw new AicmsError("not_found", `No brief ${id}`);
  return b;
}

export async function listBriefs(k: Kernel, actor: Actor, q: { status?: BriefStatus[]; agent?: string; limit?: number } = {}) {
  const all = (await k.store.kvList(SCOPE)).map((r) => r.value as Brief);
  const active = (b: Brief) => b.status !== "done" && b.status !== "canceled";
  const items = all
    .filter((b) => canSee(b, actor))
    .filter((b) => (q.status?.length ? q.status.includes(b.status) : active(b)))
    .filter((b) => !q.agent || b.agent === q.agent || b.claimedBy === q.agent)
    // Due soonest first, then newest.
    .sort((a, b) => (a.due ?? "~").localeCompare(b.due ?? "~") || b.createdAt.localeCompare(a.createdAt));
  return { briefs: items.slice(0, q.limit ?? 50).map(briefSummary), total: items.length };
}

export interface BriefInput {
  title?: string;
  details?: string | null;
  agent?: string | null;
  model?: string | null;
  entry?: string | null;
  due?: string | null;
  publishAt?: string | null;
  status?: "open" | "canceled" | "done";
  note?: string;
}

function validDate(label: string, v: string | null | undefined) {
  if (v && Number.isNaN(Date.parse(v))) throw new AicmsError("invalid", `${label} "${v}" isn't a date. Use ISO 8601, e.g. 2026-12-01 or 2026-12-01T09:00:00Z`);
}

/** Create a brief (no id) or change one: people and planning agents. */
export async function writeBrief(k: Kernel, actor: Actor, id: string | undefined, input: BriefInput) {
  if (input.agent) {
    if (!k.config.agents[input.agent]) throw new AicmsError("invalid", `No agent "${input.agent}". Agents: ${Object.keys(k.config.agents).join(", ") || "none"}`);
  }
  if (input.model && !k.models.has(input.model)) throw new AicmsError("invalid", `No model "${input.model}"`);
  if (input.entry && !(await k.store.getEntry(input.entry))) throw new AicmsError("invalid", `No entry ${input.entry}`);
  validDate("due", input.due);
  validDate("publishAt", input.publishAt);
  const set = <K extends keyof Brief>(b: Brief, key: K, v: Brief[K] | null | undefined) => {
    if (v === undefined) return;
    if (v === null || v === "") delete b[key];
    else b[key] = v;
  };

  if (!id) {
    if (!input.title?.trim()) throw new AicmsError("invalid", "A brief needs a title");
    const at = now();
    const b: Brief = { id: newId("br"), title: input.title.trim(), status: "open", changesets: [], notes: [], createdBy: actor.id, createdAt: at, updatedAt: at };
    for (const key of ["details", "agent", "model", "entry", "due", "publishAt"] as const) set(b, key, input[key] ?? undefined);
    if (input.note) b.notes.push({ at, by: actor.id, text: input.note });
    await save(k, b, "brief.created", actor.id);
    return { brief: b, next: b.agent ? `${b.agent} sees it in cms_briefs.` : "Any agent can pick it up from cms_briefs." };
  }

  const b = await getBrief(k, actor, id);
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new AicmsError("invalid", "A brief needs a title");
    b.title = input.title.trim();
  }
  for (const key of ["details", "agent", "model", "entry", "due", "publishAt"] as const) set(b, key, input[key]);
  if (input.agent !== undefined) delete b.claimedBy;
  if (input.status) b.status = input.status;
  else if (b.status === "blocked" && input.note) b.status = b.claimedBy || b.agent ? "in_progress" : "open"; // a person answered
  if (input.note) addNote(b, actor.id, input.note);
  await save(k, b, "brief.updated", actor.id);
  return { brief: b };
}

function addNote(b: Brief, by: string, text: string) {
  b.notes.push({ at: now(), by, text });
  if (b.notes.length > MAX_NOTES) b.notes.splice(0, b.notes.length - MAX_NOTES);
}

/** An agent reports on a brief: takes it, asks a question (blocked), gives it back, or finishes it without content changes. */
export async function updateBrief(k: Kernel, actor: Actor, id: string, input: { status?: (typeof AGENT_BRIEF_STATUSES)[number]; note?: string }) {
  if (briefWriter(actor) && actor.kind !== "agent") return writeBrief(k, actor, id, { note: input.note, status: input.status === "done" || input.status === "open" ? input.status : undefined });
  const b = await load(k, id);
  if (!b || !briefIsFor(b, actor)) throw new AicmsError("not_found", `No brief ${id} for you`);
  if (b.status === "done" || b.status === "canceled") throw new AicmsError("invalid", `Brief ${id} is ${b.status}`);
  if (!input.status && !input.note) throw new AicmsError("invalid", "Send a status, a note, or both");
  if (input.status === "blocked" && !input.note) throw new AicmsError("invalid", "Say what you need in the note: a person reads it");
  if (input.status === "done" && !input.note) throw new AicmsError("invalid", "Say what you did in the note");
  if (input.status) {
    b.status = input.status;
    if (input.status === "open") delete b.claimedBy;
    else if (!b.agent) b.claimedBy = actor.id;
  }
  if (input.note) addNote(b, actor.id, input.note);
  await save(k, b, "brief.updated", actor.id);
  return {
    brief: briefSummary(b),
    next:
      b.status === "blocked"
        ? "A person will answer in the brief's notes. Check cms_briefs { id } later."
        : b.status === "in_progress"
          ? "Draft the work, then cms_submit with { brief } so the reviewer sees what it answers."
          : undefined,
  };
}

/** Before cms_submit links a changeset: is the brief this agent's to answer? Returns its publishAt, if any. */
export async function briefForSubmit(k: Kernel, actor: Actor, id: string) {
  const b = await load(k, id);
  if (!b || (!briefIsFor(b, actor) && !briefWriter(actor))) throw new AicmsError("not_found", `No brief ${id} for you`);
  if (b.status === "done" || b.status === "canceled") throw new AicmsError("invalid", `Brief ${id} is already ${b.status}`);
  return b;
}

/** After cms_submit: link the changeset and move the brief along. */
export async function linkSubmission(k: Kernel, actor: Actor, id: string, changeset: string, status: string) {
  const b = await load(k, id);
  if (!b) return;
  if (!b.changesets.includes(changeset)) b.changesets.push(changeset);
  if (!b.agent && actor.kind === "agent") b.claimedBy = actor.id;
  b.status = status === "merged" ? "done" : status === "needs_changes" ? "in_progress" : "in_review";
  await save(k, b, "brief.updated", actor.id);
}

/** Merges close briefs; rejections bring the reviewer's comment back to the agent. */
export function watchBriefs(k: Kernel) {
  k.on("changeset.merged", async (_event, payload) => {
    const p = payload as { changeset: string; brief?: string; mergedBy: string };
    if (!p.brief) return;
    const b = await load(k, p.brief);
    if (!b || b.status === "done" || b.status === "canceled") return;
    b.status = "done";
    if (!b.changesets.includes(p.changeset)) b.changesets.push(p.changeset);
    await save(k, b, "brief.updated", p.mergedBy);
  });
  k.on("changeset.rejected", async (_event, payload) => {
    const p = payload as { id: string; brief?: string; comment: string; by: string };
    if (!p.brief) return;
    const b = await load(k, p.brief);
    if (!b || b.status === "done" || b.status === "canceled") return;
    b.status = "in_progress";
    addNote(b, p.by, `Changes requested on ${p.id}: ${p.comment}`);
    await save(k, b, "brief.updated", p.by);
  });
}
