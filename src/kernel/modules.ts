import { z } from "zod";
import type { AnyField } from "../schema/fields.ts";
import { isModel, projectData, type Model } from "../schema/model.ts";
import { fieldsToSchema, normalizeFields, type ActionDef, type Gate, type RegisteredAction } from "./action.ts";
import { deleteEntry, draftEntry, entryWithDrafts, submitChangeset } from "./changesets.ts";
import { AicmsError } from "./errors.ts";
import { allows, type Actor } from "./policy.ts";
import type { Kernel } from "./cms.ts";

export type EventHandler = (args: { event: string; payload: any; ctx: ModuleContext }) => void | Promise<void>;

export interface ModuleDef {
  readonly kind: "module";
  name: string;
  description?: string;
  /** Capabilities this module offers, e.g. ["payments"]. */
  provides?: string[];
  /** Capabilities that must be provided by another module. */
  requires?: string[];
  /** Models owned by other modules or the site that this module may read and draft. */
  uses?: string[];
  models?: Model[];
  actions?: Record<string, ActionDef>;
  on?: Record<string, EventHandler>;
}

export function defineModule(def: Omit<ModuleDef, "kind">): ModuleDef {
  if (!/^[a-z][a-z0-9]*$/.test(def.name)) throw new Error(`Module name "${def.name}" must be lowercase letters and digits`);
  for (const key of Object.keys(def.actions ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Action "${def.name}.${key}" must be snake_case`);
  }
  return { kind: "module", ...def };
}

export const isModule = (v: unknown): v is ModuleDef => !!v && typeof v === "object" && (v as ModuleDef).kind === "module";

/** What module code can do. Writes always go through the caller's changeset. */
export interface ModuleContext {
  actor: Actor;
  gate: Gate;
  get(model: string, id: string): Promise<(Record<string, unknown> & { id: string }) | null>;
  find(model: string, field: string, value: unknown): Promise<(Record<string, unknown> & { id: string }) | null>;
  list(model: string, q?: { where?: Record<string, unknown>; limit?: number; offset?: number }): Promise<{ items: Record<string, unknown>[]; total: number }>;
  draft(model: string, data: Record<string, unknown>): ReturnType<typeof draftEntry>;
  remove(model: string, id: string): ReturnType<typeof deleteEntry>;
  submit(note?: string): ReturnType<typeof submitChangeset>;
}

export function moduleContext(k: Kernel, mod: ModuleDef, actor: Actor, gate: Gate): ModuleContext {
  const own = new Set([...(mod.models ?? []).map((m) => m.name), ...(mod.uses ?? [])]);
  const model = (name: string) => {
    if (!own.has(name)) throw new AicmsError("forbidden", `Module "${mod.name}" may not touch model "${name}". Add it to "uses".`);
    const m = k.models.get(name);
    if (!m) throw new AicmsError("not_found", `No model "${name}"`);
    return m;
  };
  const shape = (m: Model, e: { id: string; data: Record<string, unknown> } | null) =>
    e ? { id: e.id, ...projectData(m, e.data, "blocks") } : null;
  return {
    actor,
    gate,
    async get(name, id) {
      const m = model(name);
      // The caller's own drafts count: a module can check work before it is submitted.
      const e = await entryWithDrafts(k, actor, id);
      return e && e.model === name ? shape(m, e) : null;
    },
    async find(name, f, value) {
      const m = model(name);
      return shape(m, await k.store.findOne(name, f, value));
    },
    async list(name, q = {}) {
      const m = model(name);
      const arrayFields = Object.entries(m.fields).filter(([, f]) => f.kind === "list" || (f.kind === "ref" && f.options.many)).map(([key]) => key);
      const res = await k.store.list({ model: name, where: q.where, arrayFields, limit: q.limit ?? 50, offset: q.offset ?? 0 });
      return { items: res.items.map((e) => shape(m, e)!), total: res.total };
    },
    draft: (name, data) => draftEntry(k, actor, model(name), data, { trusted: true }),
    remove: (name, id) => deleteEntry(k, actor, model(name), id, { trusted: true }),
    submit: (note) => submitChangeset(k, actor, note),
  };
}

/** Check the capability graph and turn module Actions into registry entries. */
export function loadModules(k: Kernel, modules: ModuleDef[]): { models: Model[]; actions: RegisteredAction[] } {
  const provided = new Map<string, string>();
  const names = new Set<string>();
  for (const m of modules) {
    if (!isModule(m)) throw new Error("Every entry in `modules` must come from defineModule()");
    if (names.has(m.name)) throw new Error(`Module "${m.name}" is listed twice`);
    names.add(m.name);
    for (const cap of m.provides ?? []) provided.set(cap, m.name);
  }
  for (const m of modules) {
    const missing = (m.requires ?? []).filter((cap) => !provided.has(cap));
    if (missing.length) throw new Error(`Module "${m.name}" requires ${missing.join(", ")}, which no installed module provides`);
  }

  const models: Model[] = [];
  const actions: RegisteredAction[] = [];
  for (const mod of modules) {
    for (const model of mod.models ?? []) {
      if (!isModel(model)) throw new Error(`Module "${mod.name}" lists a model that wasn't made with defineModel()`);
      models.push(model);
    }
    for (const [key, def] of Object.entries(mod.actions ?? {})) {
      // Duck-typed on purpose: the module may have been loaded with its own copy of zod.
      const isZod = !!def.input && typeof (def.input as { safeParse?: unknown }).safeParse === "function";
      const fieldMap = def.input && !isZod ? (def.input as Record<string, AnyField>) : undefined;
      const schema = fieldMap ? fieldsToSchema(fieldMap) : (def.input as z.ZodObject | undefined) ?? z.strictObject({});
      actions.push({
        name: `${mod.name}.${key}`,
        description: def.description,
        module: mod.name,
        readOnly: def.readOnly,
        destructive: def.destructive,
        visible: (actor) => (def.scope ? allows(actor.scopes, def.scope) : def.public || actor.kind !== "public"),
        schema: () => schema,
        run: async (input, ctx) => {
          const normalized = fieldMap ? normalizeFields(fieldMap, input) : input;
          return def.run({ input: normalized, ctx: moduleContext(ctx.kernel, mod, ctx.actor, ctx.gate) });
        },
      });
    }
  }
  return { models, actions };
}
