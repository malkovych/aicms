import { z } from "zod";
import type { AnyField } from "../schema/fields.ts";
import { isModel, projectData, type Model } from "../schema/model.ts";
import type { MediaRow, TextDoc, TextHit } from "../store/types.ts";
import { fieldsToSchema, normalizeFields, type ActionDef, type Gate, type RegisteredAction } from "./action.ts";
import { deleteEntry, draftEntry, entryWithDrafts, submitChangeset } from "./changesets.ts";
import { AicmsError } from "./errors.ts";
import { allows, modelPermissions, type Actor } from "./policy.ts";
import type { Kernel } from "./cms.ts";

export type EventHandler = (args: { event: string; payload: any; ctx: ModuleContext }) => void | Promise<void>;

/** What a check found. Errors stop the changeset; warnings go to the reviewer. */
export interface CheckFinding {
  level: "error" | "warning";
  /** Dotted path, e.g. "title" or "seo.description". */
  field?: string;
  message: string;
}

/** One proposed entry, as it would be after the change. */
export interface CheckInput {
  op: "create" | "update";
  model: Model;
  id: string;
  locale: string;
  /** The whole entry after the change; block fields as blocks. */
  data: Record<string, unknown>;
  /** The published entry, for updates. */
  before: Record<string, unknown> | null;
  /** Fields this change sets. */
  changed: string[];
  /** Who proposed it: an agent name, "owner", or "module:<name>". */
  author: string;
}

/** A content check: runs on every create and update of the models the module may touch (`uses`). */
export type CheckFn = (input: CheckInput, ctx: ModuleContext) => CheckFinding[] | void | Promise<CheckFinding[] | void>;

/** An HTTP route a module serves, e.g. `"GET /sitemap.xml"` or `"GET /media/:id/:name"`. */
export type RouteHandler = (args: { request: Request; url: URL; params: Record<string, string>; ctx: ModuleContext }) => Response | Promise<Response>;

export interface ModuleDef {
  readonly kind: "module";
  /** Lowercase letters, digits and hyphens, e.g. "seo" or "git-sync". */
  name: string;
  description?: string;
  version?: string;
  /** Capabilities this module offers, e.g. ["payments"]. */
  provides?: string[];
  /** Capabilities that must be provided by another module. */
  requires?: string[];
  /** Models owned by the site or other modules that this module may read and draft. `["*"]` means all. */
  uses?: string[];
  models?: Model[];
  actions?: Record<string, ActionDef>;
  on?: Record<string, EventHandler>;
  /** HTTP routes, keyed by "METHOD /path" with `:params`. */
  routes?: Record<string, RouteHandler>;
  /**
   * Content checks, like CI for content, keyed by name: they run when changes are
   * submitted and again before merging. Errors block; warnings go to the reviewer.
   */
  checks?: Record<string, CheckFn>;
  /** Implementations of the capabilities in `provides`, e.g. `{ search: { query } }`. */
  services?: Record<string, unknown>;
  /** Runs once when the kernel starts (or the module is installed). */
  setup?(ctx: ModuleContext): void | Promise<void>;
}

const MODULE_NAME = /^[a-z][a-z0-9-]*$/;

export function defineModule(def: Omit<ModuleDef, "kind">): ModuleDef {
  if (!MODULE_NAME.test(def.name)) throw new Error(`Module name "${def.name}" must be lowercase letters, digits and hyphens`);
  for (const key of Object.keys(def.actions ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Action "${def.name}.${key}" must be snake_case`);
  }
  for (const route of Object.keys(def.routes ?? {})) {
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD) \/\S*$/.test(route)) throw new Error(`Route "${route}" in module "${def.name}" must look like "GET /path"`);
  }
  for (const key of Object.keys(def.checks ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`Check "${def.name}/${key}" must be lowercase letters, digits and hyphens`);
  }
  for (const cap of Object.keys(def.services ?? {})) {
    if (!(def.provides ?? []).includes(cap)) throw new Error(`Module "${def.name}" has a "${cap}" service but doesn't list it in provides`);
  }
  return { kind: "module", ...def };
}

export const isModule = (v: unknown): v is ModuleDef => !!v && typeof v === "object" && (v as ModuleDef).kind === "module";

/** Small JSON values that belong to one module, persisted in the store. */
export interface ModuleStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list<T = unknown>(prefix?: string): Promise<{ key: string; value: T }[]>;
}

/** What module code can do. Writes always go through the caller's changeset. */
export interface ModuleContext {
  actor: Actor;
  gate: Gate;
  module: string;
  /** Site name, locales and the folder this module may keep files in. */
  site: { name: string; locales: string[]; defaultLocale: string };
  /** The project folder (where aicms.config.ts lives) and a private folder for this module's files. */
  projectDir: string;
  dataDir: string;
  /** Any entry this module may touch, by id (with the caller's drafts), with its model and locale. */
  entry(id: string): Promise<{ id: string; model: string; locale: string; version: number; updatedAt: string; data: Record<string, unknown> } | null>;
  get(model: string, id: string): Promise<(Record<string, unknown> & { id: string }) | null>;
  find(model: string, field: string, value: unknown): Promise<(Record<string, unknown> & { id: string }) | null>;
  list(model: string, q?: { where?: Record<string, unknown>; limit?: number; offset?: number; locale?: string }): Promise<{ items: (Record<string, unknown> & { id: string; locale: string; updatedAt: string })[]; total: number }>;
  draft(model: string, data: Record<string, unknown>): ReturnType<typeof draftEntry>;
  remove(model: string, id: string): ReturnType<typeof deleteEntry>;
  submit(note?: string): ReturnType<typeof submitChangeset>;
  /** Models this module may touch (its own plus `uses`). */
  models(): Model[];
  /** May the current actor read this model? */
  readable(model: string): boolean;
  /** May anyone, without a token, read this model? */
  isPublic(model: string): boolean;
  /** An unpublished draft of this entry in anyone's open, submitted or scheduled changeset (e.g. waiting for review). */
  pending(id: string): Promise<{ changeset: string; actor: string; status: string; op: string; data: Record<string, unknown> } | null>;
  /** The implementation of a capability another module provides. */
  service<T = unknown>(capability: string): T | undefined;
  /** A platform binding (Cloudflare env), e.g. an R2 bucket. */
  binding<T = unknown>(name: string): T;
  /** Publish an event to other modules' `on` handlers, webhooks and the live feed, e.g. "payment.updated". */
  emit(event: string, payload: unknown): Promise<void>;
  /**
   * The same context acting as the module itself (`module:<name>`), for data the module owns,
   * such as orders: written and versioned at once, without waiting for review.
   */
  asSystem(): ModuleContext;
  kv: ModuleStorage;
  /** Low-level storage for search and media providers. */
  text: {
    upsert(doc: TextDoc): Promise<void>;
    remove(id: string): Promise<void>;
    search(q: { terms: string[]; prefixLast: boolean; models: string[]; locale?: string; limit: number }): Promise<TextHit[]>;
    count(): Promise<number>;
    clear(): Promise<void>;
  };
  media: {
    create(row: MediaRow): Promise<void>;
    get(id: string): Promise<MediaRow | null>;
    list(q: { query?: string; missingAlt?: boolean; limit: number; offset: number }): Promise<{ items: MediaRow[]; total: number }>;
    update(id: string, patch: Partial<Pick<MediaRow, "alt" | "meta">>): Promise<MediaRow | null>;
    delete(id: string): Promise<boolean>;
  };
}

const arrayFieldsOf = (m: Model) =>
  Object.entries(m.fields).filter(([, f]) => f.kind === "list" || (f.kind === "ref" && f.options.many)).map(([key]) => key);

export function moduleContext(k: Kernel, mod: ModuleDef, actor: Actor, gate: Gate): ModuleContext {
  const own = new Set([...(mod.models ?? []).map((m) => m.name), ...(mod.uses ?? [])]);
  const all = own.has("*");
  const model = (name: string) => {
    if (!all && !own.has(name)) throw new AicmsError("forbidden", `Module "${mod.name}" may not touch model "${name}". Add it to "uses".`);
    const m = k.models.get(name);
    if (!m) throw new AicmsError("not_found", `No model "${name}"`);
    return m;
  };
  const shape = (m: Model, e: { id: string; locale?: string; updatedAt?: string; data: Record<string, unknown> } | null) =>
    e ? { id: e.id, locale: e.locale ?? k.defaultLocale, updatedAt: e.updatedAt ?? "", ...projectData(m, e.data, "blocks") } : null;
  const s = k.store;
  return {
    actor,
    gate,
    module: mod.name,
    site: { name: k.config.name, locales: k.config.locales, defaultLocale: k.defaultLocale },
    projectDir: k.projectDir,
    get dataDir() {
      return k.moduleDir(mod.name);
    },
    async entry(id) {
      const e = await entryWithDrafts(k, actor, id);
      if (!e || (!all && !own.has(e.model)) || !k.models.has(e.model)) return null;
      return { id: e.id, model: e.model, locale: e.locale, version: e.version, updatedAt: e.updatedAt, data: projectData(k.models.get(e.model)!, e.data, "blocks") };
    },
    async get(name, id) {
      const m = model(name);
      // The caller's own drafts count: a module can check work before it is submitted.
      const e = await entryWithDrafts(k, actor, id);
      return e && e.model === name ? shape(m, e) : null;
    },
    async find(name, f, value) {
      const m = model(name);
      return shape(m, await s.findOne(name, f, value));
    },
    async list(name, q = {}) {
      const m = model(name);
      const res = await s.list({ model: name, locale: q.locale, where: q.where, arrayFields: arrayFieldsOf(m), limit: q.limit ?? 50, offset: q.offset ?? 0 });
      return { items: res.items.map((e) => shape(m, e)!), total: res.total };
    },
    draft: (name, data) => draftEntry(k, actor, model(name), data, { trusted: true }),
    remove: (name, id) => deleteEntry(k, actor, model(name), id, { trusted: true }),
    submit: (note) => submitChangeset(k, actor, { note }),
    models: () => [...k.models.values()].filter((m) => all || own.has(m.name)),
    readable: (name) => {
      const m = k.models.get(name);
      return !!m && modelPermissions(actor, m).read;
    },
    isPublic: (name) => allows(k.config.public, `${name}:read`),
    async pending(id) {
      for (const cs of await s.listChangesets({ status: ["submitted", "scheduled", "open"], limit: 1000 })) {
        const item = cs.items.find((i) => i.id === id && i.op !== "install");
        if (item) return { changeset: cs.id, actor: cs.actor, status: cs.status, op: item.op, data: item.data ?? {} };
      }
      return null;
    },
    service: (cap) => k.service(cap),
    binding: (name) => k.binding(name),
    emit: (event, payload) => {
      if (event.startsWith("changeset.") || event === "action" || event === "presence") throw new AicmsError("invalid", `Modules can't emit "${event}"`);
      return k.emit(event, payload);
    },
    asSystem: () => moduleContext(k, mod, { id: `module:${mod.name}`, kind: "system", scopes: ["*"], review: "auto" }, "internal"),
    kv: {
      get: (key) => s.kvGet(mod.name, key) as Promise<any>,
      set: (key, value) => s.kvSet(mod.name, key, value),
      delete: (key) => s.kvDelete(mod.name, key),
      list: (prefix) => s.kvList(mod.name, prefix) as Promise<any>,
    },
    text: {
      upsert: (doc) => s.textUpsert(doc),
      remove: (id) => s.textRemove(id),
      search: (q) => s.textSearch(q),
      count: () => s.textCount(),
      clear: () => s.textClear(),
    },
    media: {
      create: (row) => s.createMedia(row),
      get: (id) => s.getMedia(id),
      list: (q) => s.listMedia(q),
      update: (id, patch) => s.updateMedia(id, patch),
      delete: (id) => s.deleteMedia(id),
    },
  };
}

/** Turn a module's Actions into registry entries. */
export function moduleActions(mod: ModuleDef): RegisteredAction[] {
  const out: RegisteredAction[] = [];
  for (const [key, def] of Object.entries(mod.actions ?? {})) {
    // Duck-typed on purpose: the module may have been loaded with its own copy of zod.
    const isZod = !!def.input && typeof (def.input as { safeParse?: unknown }).safeParse === "function";
    const fieldMap = def.input && !isZod ? (def.input as Record<string, AnyField>) : undefined;
    const schema = fieldMap ? fieldsToSchema(fieldMap) : (def.input as z.ZodObject | undefined) ?? z.strictObject({});
    out.push({
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
  return out;
}

/** Check names and the capability graph for a set of modules. */
export function checkModules(modules: ModuleDef[]) {
  const provided = new Map<string, string>();
  const names = new Set<string>();
  for (const m of modules) {
    if (!isModule(m)) throw new Error("Every entry in `modules` must come from defineModule()");
    if (names.has(m.name)) throw new Error(`Module "${m.name}" is listed twice`);
    names.add(m.name);
    for (const cap of m.provides ?? []) {
      if (provided.has(cap)) throw new Error(`Modules "${provided.get(cap)}" and "${m.name}" both provide "${cap}"; keep one`);
      provided.set(cap, m.name);
    }
  }
  for (const m of modules) {
    const missing = (m.requires ?? []).filter((cap) => !provided.has(cap));
    if (missing.length) throw new Error(`Module "${m.name}" requires ${missing.join(", ")}, which no installed module provides`);
    for (const model of m.models ?? []) if (!isModel(model)) throw new Error(`Module "${m.name}" lists a model that wasn't made with defineModel()`);
  }
}

/** What a module asks for, shown before it is installed: like a phone app's permissions. */
export function moduleManifest(mod: ModuleDef) {
  return {
    name: mod.name,
    ...(mod.description ? { description: mod.description } : {}),
    ...(mod.version ? { version: mod.version } : {}),
    provides: mod.provides ?? [],
    requires: mod.requires ?? [],
    uses: mod.uses ?? [],
    models: (mod.models ?? []).map((m) => ({ name: m.name, fields: Object.keys(m.fields) })),
    actions: Object.entries(mod.actions ?? {}).map(([key, a]) => ({
      name: `${mod.name}.${key}`,
      description: a.description,
      scope: a.scope ?? (a.public ? "public" : "any signed-in caller"),
      ...(a.readOnly ? { readOnly: true } : {}),
      ...(a.destructive ? { destructive: true } : {}),
    })),
    scopes: [...new Set(Object.values(mod.actions ?? {}).map((a) => a.scope).filter(Boolean) as string[])],
    routes: Object.keys(mod.routes ?? {}),
    hooks: Object.keys(mod.on ?? {}),
    checks: Object.keys(mod.checks ?? {}).map((c) => `${mod.name}/${c}`),
  };
}

export type ModuleManifest = ReturnType<typeof moduleManifest>;

export interface ModuleRoute {
  module: string;
  method: string;
  path: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

export function compileRoute(module: string, key: string, handler: RouteHandler): ModuleRoute {
  const [method, path] = key.split(" ");
  const keys: string[] = [];
  const pattern = path
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { module, method, path, regex: new RegExp(`^${pattern}$`), keys, handler };
}
