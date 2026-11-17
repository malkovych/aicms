import type { Model } from "../schema/model.ts";

export type ReviewMode = "human" | "auto";

export interface Budget {
  /** Calls of any Action per rolling hour. */
  actionsPerHour?: number;
  /** Items allowed in one changeset. Default 100. */
  maxChangesetItems?: number;
}

export interface Actor {
  /** "owner", "public", an agent name, or "module:<name>". */
  id: string;
  kind: "owner" | "agent" | "public" | "system";
  scopes: string[];
  review: ReviewMode;
  budget?: Budget;
}

export const OWNER: Actor = { id: "owner", kind: "owner", scopes: ["*"], review: "auto" };

/**
 * Scope grammar: `<resource>:<op>[.<field>]`, plus `*` and `<resource>:*`.
 * - any scope on a resource implies `<resource>:read`
 * - `post:draft` covers `post:create` and `post:update` (all fields)
 * - `post:update` covers `post:update.seo`; `post:update.seo` covers only that field
 */
export function allows(granted: readonly string[], required: string): boolean {
  if (granted.includes("*")) return true;
  const [res, opFull = ""] = splitOnce(required, ":");
  const [op, ...field] = opFull.split(".");
  for (const g of granted) {
    const [gres, gopFull = ""] = splitOnce(g, ":");
    if (gres !== res) continue;
    if (gopFull === "*" || gopFull === opFull || op === "read") return true;
    const [gop, ...gfield] = gopFull.split(".");
    if (gop === "draft" && (op === "create" || op === "update")) return true;
    if (gop === op && gfield.length <= field.length && gfield.every((p, i) => field[i] === p)) return true;
  }
  return false;
}

function splitOnce(s: string, sep: string): [string, string?] {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

export interface ModelPermissions {
  read: boolean;
  create: boolean;
  delete: boolean;
  /** Fields the actor may change on existing entries. */
  updateFields: string[];
}

/** What an actor may do with a model: scopes first, then the model's own `agent.can` bound for agents. */
export function modelPermissions(actor: Actor, model: Model): ModelPermissions {
  const s = actor.scopes;
  const fields = Object.keys(model.fields);
  const bound = actor.kind === "agent" ? model.agent?.can : undefined;
  const within = (op: "create" | "update" | "delete") => !bound || bound.includes(op);
  return {
    read: allows(s, `${model.name}:read`),
    create: within("create") && allows(s, `${model.name}:create`),
    delete: within("delete") && allows(s, `${model.name}:delete`),
    updateFields: within("update") ? fields.filter((f) => allows(s, `${model.name}:update.${f}`)) : [],
  };
}
