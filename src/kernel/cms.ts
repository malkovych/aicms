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

/** One item of the live feed behind `/api/v1/events`. `action` items mirror the action log. */
export interface FeedEvent {
  id: number;
  event: string;
  payload: any;
  at: string;
}

export interface Feed {
  /** Buffered events after `id` (the last few hundred, for reconnecting clients). */
  since(id?: number): FeedEvent[];
  /** Id of the newest event so far (0 before any). */
  lastId(): number;
  subscribe(fn: (e: FeedEvent) => void): () => void;
}

const FEED_SIZE = 500;
const LOGIN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 3_600_000;

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
  /** A one-time code for a Studio sign-in link, valid for 15 minutes. */
  createLoginCode(): Promise<string>;
  /** Trade a login code for a 30-day owner session token. */
  startSession(code: string): Promise<{ token: string; expiresAt: string }>;
  endSession(token: string): Promise<void>;
  on(event: string, handler: Handler): () => void;
  emit(event: string, payload: unknown): Promise<void>;
  readonly feed: Feed;
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
  const buffer: FeedEvent[] = [];
  const subscribers = new Set<(e: FeedEvent) => void>();
  let seq = 0;
  const publish = (event: string, payload: unknown) => {
    const item: FeedEvent = { id: ++seq, event, payload, at: new Date().toISOString() };
    buffer.push(item);
    if (buffer.length > FEED_SIZE) buffer.shift();
    for (const fn of subscribers) {
      try {
        fn(item);
      } catch {
        /* a broken subscriber must not break the caller */
      }
    }
  };
  const feed: Feed = {
    since: (id = 0) => buffer.filter((e) => e.id > id),
    lastId: () => seq,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };

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
        // Anonymous reads and Studio's own page loads would flood the log; everything else is recorded.
        const quiet = !error && (actor.kind === "public" || (gate === "studio" && action?.readOnly));
        if (!quiet) {
          let logged: string | undefined;
          try {
            logged = rawInput === undefined ? undefined : JSON.stringify(rawInput).slice(0, 2000);
          } catch {
            logged = undefined;
          }
          const ms = Date.now() - started;
          await store.logEvent({ at: new Date().toISOString(), actor: actor.id, gate, action: name, input: logged, ok: !error, error, ms }).catch(() => {});
          publish("action", { actor: actor.id, gate, action: name, ok: !error, ...(error ? { error } : {}), ms });
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
      const row = await store.findToken(hashToken(token), new Date().toISOString());
      if (!row) throw new AicmsError("unauthorized", "Invalid, expired or revoked token");
      if (row.kind === "login") throw new AicmsError("unauthorized", "This is a one-time Studio sign-in code; open the sign-in link instead");
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

    async createLoginCode() {
      const code = randomBytes(24).toString("base64url");
      const at = new Date();
      await store.createToken({ id: newId("lg"), agent: "owner", hash: hashToken(code), createdAt: at.toISOString(), kind: "login", expiresAt: new Date(at.getTime() + LOGIN_TTL_MS).toISOString() });
      return code;
    },

    async startSession(code) {
      const at = new Date();
      const row = code ? await store.findToken(hashToken(code), at.toISOString()) : null;
      if (!row || row.kind !== "login") throw new AicmsError("unauthorized", "This sign-in link is invalid or expired. Run `aicms login` for a new one.");
      // Single use: a second click on the same link fails.
      if (!(await store.revokeToken(row.id, at.toISOString()))) throw new AicmsError("unauthorized", "This sign-in link was already used");
      const token = `aicms_${randomBytes(24).toString("base64url")}`;
      const expiresAt = new Date(at.getTime() + SESSION_TTL_MS).toISOString();
      await store.createToken({ id: newId("ss"), agent: row.agent, hash: hashToken(token), createdAt: at.toISOString(), kind: "session", expiresAt });
      return { token, expiresAt };
    },

    async endSession(token) {
      const row = await store.findToken(hashToken(token), new Date().toISOString());
      if (row?.kind === "session") await store.revokeToken(row.id, new Date().toISOString());
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
      publish(event, payload);
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

    feed,
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
