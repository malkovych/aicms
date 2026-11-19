import type { Model } from "./schema/model.ts";
import type { ModuleDef } from "./kernel/modules.ts";
import type { Budget, ReviewMode } from "./kernel/policy.ts";
import type { SqliteOptions } from "./store/sqlite.ts";
import type { PostgresOptions } from "./store/postgres.ts";
import type { D1Options } from "./store/d1.ts";
import { DEFAULT_REGISTRY } from "./registry.ts";

export interface AgentConfig {
  /** e.g. ["post:draft", "tag:read", "post:update.seo"] */
  scopes: string[];
  /** "human" (default): a person approves. "auto": merged when checks pass and no model requires a person. */
  review?: ReviewMode;
  budget?: Budget;
  description?: string;
}

export interface WebhookConfig {
  url: string;
  /** Event names, e.g. ["changeset.merged"]. Default: all. */
  events?: string[];
  /** Signs the body: header `x-aicms-signature: sha256=<hmac>`. */
  secret?: string;
}

export interface Config {
  /** Shown to agents in cms_describe and llms.txt. */
  name?: string;
  /** sqlite(".aicms/data.db") (default) or postgres({ url }). */
  db?: SqliteOptions | PostgresOptions | D1Options;
  /** The first locale is the default. */
  locales?: string[];
  /** Defaults to every model in ./models when loaded through the CLI. */
  models?: Model[];
  modules?: ModuleDef[];
  agents?: Record<string, AgentConfig>;
  /** Scopes for requests without a token, e.g. ["post:read"]. */
  public?: string[];
  webhooks?: WebhookConfig[];
  /** The module registry used by `aicms search` / `aicms add`: a URL or file, or false. Default: the AICMS registry. */
  registry?: string | false;
}

export interface ResolvedConfig {
  name: string;
  db: SqliteOptions | PostgresOptions | D1Options;
  locales: string[];
  models: Model[];
  modules: ModuleDef[];
  agents: Record<string, AgentConfig>;
  public: string[];
  webhooks: WebhookConfig[];
  registry: string | false;
}

export function defineConfig(config: Config): Config {
  return config;
}

const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;

export function resolveConfig(c: Config): ResolvedConfig {
  const agents = c.agents ?? {};
  for (const [name, a] of Object.entries(agents)) {
    if (!AGENT_NAME.test(name)) throw new Error(`Agent name "${name}" must be lowercase letters, digits, - or _`);
    if (name === "owner" || name === "public") throw new Error(`Agent name "${name}" is reserved`);
    if (!Array.isArray(a.scopes)) throw new Error(`Agent "${name}" needs a scopes array`);
    if (a.review && a.review !== "human" && a.review !== "auto") throw new Error(`Agent "${name}": review must be "human" or "auto"`);
  }
  const locales = c.locales?.length ? c.locales : ["en"];
  return {
    name: c.name ?? "AICMS site",
    db: c.db ?? { kind: "sqlite", path: ".aicms/data.db" },
    locales,
    models: c.models ?? [],
    modules: c.modules ?? [],
    agents,
    public: c.public ?? [],
    webhooks: c.webhooks ?? [],
    registry: c.registry ?? DEFAULT_REGISTRY,
  };
}
