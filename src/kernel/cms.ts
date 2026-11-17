import { createHash, createHmac, randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { resolveConfig, type Config, type ResolvedConfig } from "../config.ts";
import { indexedFields, isModel, toJsonSchema, type Model } from "../schema/model.ts";
import { SqliteStore } from "../store/sqlite.ts";
import type { Store } from "../store/types.ts";
import { toolName, type Gate, type RegisteredAction } from "./action.ts";
import { newId, rejectChangeset } from "./changesets.ts";
import { coreActions } from "./core-actions.ts";
import { AicmsError } from "./errors.ts";
import { modelActions } from "./model-actions.ts";
import { loadModules, moduleContext, type ModuleDef } from "./modules.ts";
import { OWNER, type Actor } from "./policy.ts";

export interface ToolInfo {
  /** Action name, e.g. "post.draft" (REST, code). */
  name: string;
  /** MCP tool name, e.g. "post_draft". */
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
}

type Handler = (event: string, payload: unknown) => void | Promise<void>;

export interface Kernel {
  readonly config: ResolvedConfig;
  readonly store: Store;
  readonly models: Map<string, Model>;
  readonly actions: Map<string, RegisteredAction>;
  readonly modules: ModuleDef[];
  readonly defaultLocale: string;
  /** Run an Action through the full pipeline: visibility, budget, validation, run, event log. */
  call<T = any>(name: string, input: unknown, opts: { actor: Actor; gate: Gate }): Promise<T>;
  /** Actions this actor can see, as tool descriptions. */
  tools(actor: Actor): ToolInfo[];
  actor(name: string): Actor;
  /** No token → public actor. Unknown or revoked token → `unauthorized`. */
  resolveToken(token: string | null | undefined): Promise<Actor>;
  createToken(agent: string): Promise<string>;
  revokeAgent(agent: string): Promise<{ tokens: number; changesets: number }>;
  on(event: string, handler: Handler): () => void;
  emit(event: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface CreateOptions {
  /** Base directory for relative paths such as the SQLite file. */
  cwd?: string;
  /** Bring your own store (tests, other databases). */
  store?: Store;
}

export async function createCMS(input: Config, opts: CreateOptions = {}): Promise<Kernel> {
  const config = resolveConfig(input);
  const cwd = opts.cwd ?? process.cwd();
  const dbPath = config.db.path === ":memory:" || isAbsolute(config.db.path) ? config.db.path : resolve(cwd, config.db.path);
  const store = opts.store ?? new SqliteStore(dbPath);

  const models = new Map<string, Model>();
  const actions = new Map<string, RegisteredAction>();
  const handlers = new Map<string, Set<Handler>>();

  const addModel = (m: Model, source: string) => {
    if (!isModel(m)) throw new Error(`${source} contains something that wasn't made with defineModel()`);
    if (models.has(m.name)) throw new Error(`Model "${m.name}" is defined twice`);
    models.set(m.name, m);
  };
  const addAction = (a: RegisteredAction) => {
    if (actions.has(a.name)) throw new Error(`Action "${a.name}" is defined twice`);
    const clash = [...actions.values()].find((x) => toolName(x.name) === toolName(a.name));
    if (clash) throw new Error(`Actions "${clash.name}" and "${a.name}" would share the tool name ${toolName(a.name)}`);
    actions.set(a.name, a);
  };

  const kernel: Kernel = {
    config,
    store,
    models,
    actions,
    modules: config.modules,
    defaultLocale: config.locales[0],

    async call(name, rawInput, { actor, gate }) {
      const started = Date.now();
      let error: string | undefined;
      const action = actions.get(name);
      try {
        if (!action) throw new AicmsError("not_found", `No action "${name}"`);
        if (!action.visible(actor)) {
          throw actor.kind === "public"
            ? new AicmsError("unauthorized", `"${name}" needs an agent token`)
            : new AicmsError("forbidden", `${actor.id} may not call "${name}"`);
        }
        const perHour = actor.budget?.actionsPerHour;
        if (perHour) {
          const used = await store.countEvents(actor.id, new Date(Date.now() - 3_600_000).toISOString());
          if (used >= perHour) throw new AicmsError("budget", `${actor.id} used its budget of ${perHour} actions per hour. Try again later.`);
        }
        const parsed = action.schema(actor).safeParse(rawInput ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => ({ field: i.path.join(".") || undefined, message: i.message }));
          const first = issues[0];
          throw new AicmsError("invalid", `Invalid input${first?.field ? ` for "${first.field}"` : ""}: ${first?.message}`, { issues });
        }
        return (await action.run(parsed.data, { actor, gate, kernel })) as any;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        // Anonymous reads would flood the log; everything else is recorded.
        if (!(actor.kind === "public" && !error)) {
          let logged: string | undefined;
          try {
            logged = rawInput === undefined ? undefined : JSON.stringify(rawInput).slice(0, 2000);
          } catch {
            logged = undefined;
          }
          await store
            .logEvent({ at: new Date().toISOString(), actor: actor.id, gate, action: name, input: logged, ok: !error, error, ms: Date.now() - started })
            .catch(() => {});
        }
      }
    },

    tools(actor) {
      return [...actions.values()]
        .filter((a) => a.visible(actor))
        .map((a) => ({
          name: a.name,
          tool: toolName(a.name),
          description: a.description,
          inputSchema: toJsonSchema(a.advertised?.(actor) ?? a.schema(actor)),
          ...(a.readOnly ? { readOnly: true } : {}),
          ...(a.destructive ? { destructive: true } : {}),
        }));
    },

    actor(name) {
      if (name === "owner") return OWNER;
      if (name === "public") return { id: "public", kind: "public", scopes: config.public, review: "human" };
      const agent = config.agents[name];
      if (!agent) throw new AicmsError("not_found", `No agent "${name}" in aicms.config. Known agents: ${Object.keys(config.agents).join(", ") || "none"}`);
      return { id: name, kind: "agent", scopes: agent.scopes, review: agent.review ?? "human", budget: agent.budget };
    },

    async resolveToken(token) {
      if (!token) return kernel.actor("public");
      const row = await store.findToken(hashToken(token));
      if (!row) throw new AicmsError("unauthorized", "Invalid or revoked token");
      try {
        return kernel.actor(row.agent);
      } catch {
        throw new AicmsError("unauthorized", `Agent "${row.agent}" is no longer configured`);
      }
    },

    async createToken(agent) {
      kernel.actor(agent); // throws for unknown agents
      if (agent === "public") throw new AicmsError("invalid", "The public actor doesn't use tokens");
      const token = `aicms_${randomBytes(24).toString("base64url")}`;
      await store.createToken({ id: newId("tk"), agent, hash: hashToken(token), createdAt: new Date().toISOString() });
      return token;
    },

    async revokeAgent(agent) {
      const tokens = await store.revokeTokens(agent, new Date().toISOString());
      const pending = await store.listChangesets({ actor: agent, status: ["open", "submitted"], limit: 1000 });
      for (const cs of pending) await rejectChangeset(kernel, cs.id, "owner", "Access revoked", true);
      return { tokens, changesets: pending.length };
    },

    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    },

    async emit(event, payload) {
      for (const h of [...(handlers.get(event) ?? []), ...(handlers.get("*") ?? [])]) {
        try {
          await h(event, payload);
        } catch (e) {
          console.error(`[aicms] handler for ${event} failed:`, e);
        }
      }
      for (const hook of config.webhooks) {
        if (hook.events && !hook.events.includes(event)) continue;
        const body = JSON.stringify({ event, payload, at: new Date().toISOString() });
        const headers: Record<string, string> = { "content-type": "application/json", "x-aicms-event": event };
        if (hook.secret) headers["x-aicms-signature"] = `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`;
        fetch(hook.url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) }).catch((e) =>
          console.warn(`[aicms] webhook ${hook.url} failed: ${e.message}`),
        );
      }
    },

    close: () => store.close(),
  };

  // ---- assemble the registry ----
  for (const m of config.models) addModel(m, "config.models");
  const fromModules = loadModules(kernel, config.modules);
  for (const m of fromModules.models) addModel(m, "a module");
  for (const m of models.values()) {
    for (const [key, f] of Object.entries(m.fields)) {
      if (f.kind === "ref" && !models.has(f.options.model as string)) {
        throw new Error(`${m.name}.${key} references model "${f.options.model}", which doesn't exist`);
      }
    }
  }
  for (const a of coreActions()) addAction(a);
  for (const m of models.values()) for (const a of modelActions(m)) addAction(a);
  for (const a of fromModules.actions) addAction(a);

  for (const mod of config.modules) {
    const system: Actor = { id: `module:${mod.name}`, kind: "system", scopes: ["*"], review: "auto" };
    for (const [event, handler] of Object.entries(mod.on ?? {})) {
      kernel.on(event, (ev, payload) => handler({ event: ev, payload, ctx: moduleContext(kernel, mod, system, "internal") }));
    }
  }

  await store.init([...models.values()].map((m) => ({ model: m.name, fields: indexedFields(m) })));
  return kernel;
}
