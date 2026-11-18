import { Hono, type Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import type { Gate } from "../kernel/action.ts";
import type { Kernel } from "../kernel/cms.ts";
import { AicmsError, isAicmsError } from "../kernel/errors.ts";
import type { Actor } from "../kernel/policy.ts";
import { filterableFields } from "../schema/model.ts";
import { llmsTxt, manifest, VERSION } from "./discovery.ts";
import { eventStream } from "./events.ts";
import { handleMcpRequest } from "./mcp.ts";
import { openapi } from "./openapi.ts";
import { findStudio, mountStudio, SESSION_COOKIE } from "./studio.ts";

type Env = { Variables: { actor: Actor; gate: Gate } };

export interface AppOptions {
  /** Directory of the built Studio, or false to leave Studio out. Found automatically by default. */
  studio?: string | false;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cookie-authenticated writes must come from the same site (CSRF). */
function sameOrigin(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = c.req.header("origin");
  if (!origin) return false;
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const origin = (c: Context) => new URL(c.req.url).origin;

async function body(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  throw new AicmsError("invalid", "Request body must be a JSON object");
}

/** Query strings are strings; turn "true", "42" and "null" into what the schema expects. */
function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * The HTTP surface: REST routes, discovery, OpenAPI and MCP.
 * Everything is a thin wrapper over kernel.call(), so rules are identical across gates.
 */
export function createApp(k: Kernel, opts: AppOptions = {}): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (isAicmsError(err)) return c.json({ error: err.toJSON() }, err.status as 401);
    console.error("[aicms]", err);
    return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
  });

  // A bearer token wins; otherwise a Studio session cookie; otherwise the public actor.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
    const session = bearer ? null : (getCookie(c, SESSION_COOKIE) ?? null);
    if (session && !SAFE_METHODS.has(c.req.method) && !sameOrigin(c)) throw new AicmsError("forbidden", "Cross-site request refused");
    let actor: Actor;
    try {
      actor = await k.resolveToken(bearer ?? session);
    } catch (e) {
      if (!session) throw e;
      deleteCookie(c, SESSION_COOKIE, { path: "/" }); // expired or revoked session
      actor = await k.resolveToken(null);
    }
    c.set("actor", actor);
    c.set("gate", session && actor.kind !== "public" ? "studio" : "rest");
    await next();
  });

  const call = (c: Context<Env>, name: string, input: unknown) => k.call(name, input, { actor: c.get("actor"), gate: c.get("gate") });
  const model = (name: string) => {
    const m = k.models.get(name);
    if (!m) throw new AicmsError("not_found", `No model "${name}". Models: ${[...k.models.keys()].join(", ")}`);
    return m;
  };

  // ---- discovery ----
  app.get("/", (c) =>
    c.json({
      name: k.config.name,
      software: `aicms ${VERSION}`,
      mcp: `${origin(c)}/mcp`,
      rest: `${origin(c)}/api/v1`,
      openapi: `${origin(c)}/openapi.json`,
      llms: `${origin(c)}/llms.txt`,
      events: `${origin(c)}/api/v1/events`,
      studio: `${origin(c)}/studio/`,
    }),
  );
  app.get("/llms.txt", (c) => c.text(llmsTxt(k, c.get("actor"), origin(c))));
  app.get("/.well-known/aicms.json", (c) => c.json(manifest(k, origin(c))));
  app.get("/openapi.json", (c) => c.json(openapi(k, c.get("actor"), origin(c))));

  // ---- MCP ----
  app.all("/mcp", (c) => handleMcpRequest(k, c.get("actor"), c.req.raw));

  // ---- REST ----
  app.get("/api/v1", async (c) => c.json(await call(c, "cms.describe", {})));
  app.get("/api/v1/search", async (c) => c.json(await call(c, "cms.search", { query: c.req.query("q") ?? "", model: c.req.query("model") })));
  app.post("/api/v1/actions/:name", async (c) => c.json(await call(c, c.req.param("name"), await body(c))));
  // Read-only Actions also answer GET, so frontends and CDNs can cache them: ?input=<JSON>.
  app.get("/api/v1/actions/:name", async (c) => {
    const name = c.req.param("name");
    const a = k.actions.get(name);
    if (a && !a.readOnly) throw new AicmsError("invalid", `"${name}" changes data; call it with POST`);
    let input: unknown = {};
    const raw = c.req.query("input");
    if (raw) {
      try {
        input = JSON.parse(raw);
      } catch {
        throw new AicmsError("invalid", "The input query parameter must be JSON");
      }
    }
    return c.json(await call(c, name, input));
  });
  app.get("/api/v1/events", (c) => eventStream(k, c, c.get("actor")));

  app.get("/api/v1/changesets", async (c) =>
    c.json(c.req.query("review") ? await call(c, "cms.review", { status: c.req.query("status") }) : await call(c, "cms.changes", {})),
  );
  app.get("/api/v1/changesets/:id", async (c) => c.json(await call(c, "cms.review", { id: c.req.param("id") })));
  app.post("/api/v1/changesets/submit", async (c) => c.json(await call(c, "cms.submit", await body(c))));
  app.post("/api/v1/changesets/:id/merge", async (c) => c.json(await call(c, "cms.merge", { id: c.req.param("id") })));
  app.post("/api/v1/changesets/:id/reject", async (c) => c.json(await call(c, "cms.reject", { ...(await body(c)), id: c.req.param("id") })));
  app.post("/api/v1/changesets/:id/revert", async (c) => {
    const draft = await call(c, "cms.revert", { changeset: c.req.param("id") });
    if (c.req.query("submit") === "true") return c.json({ draft, submit: await call(c, "cms.submit", { note: `Revert ${c.req.param("id")}` }) });
    return c.json(draft);
  });

  app.get("/api/v1/:model", async (c) => {
    const m = model(c.req.param("model"));
    const q = c.req.query();
    const where: Record<string, unknown> = {};
    for (const f of filterableFields(m)) if (q[f] !== undefined) where[f] = coerce(q[f]);
    return c.json(
      await call(c, `${m.name}.list`, {
        ...(Object.keys(where).length ? { where } : {}),
        ...(q.fields ? { fields: q.fields.split(",") } : {}),
        ...(q.order ? { order: q.order } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
        ...(q.offset ? { offset: Number(q.offset) } : {}),
        ...(q.locale ? { locale: q.locale } : {}),
        ...(q.format ? { format: q.format } : {}),
      }),
    );
  });
  app.get("/api/v1/:model/:id", async (c) => {
    const m = model(c.req.param("model"));
    const q = c.req.query();
    return c.json(await call(c, `${m.name}.get`, { id: c.req.param("id"), ...(q.fields ? { fields: q.fields.split(",") } : {}), ...(q.format ? { format: q.format } : {}) }));
  });
  app.get("/api/v1/:model/:id/history", async (c) => {
    model(c.req.param("model"));
    const v = c.req.query("version");
    return c.json(await call(c, "cms.history", { id: c.req.param("id"), ...(v ? { version: Number(v) } : {}), ...(c.req.query("format") ? { format: c.req.query("format") } : {}) }));
  });
  app.post("/api/v1/:model/:id/restore", async (c) => {
    model(c.req.param("model"));
    const { version } = await body(c);
    const draft = await call(c, "cms.restore", { id: c.req.param("id"), version });
    if (c.req.query("submit") === "true") return c.json({ draft, submit: await call(c, "cms.submit", { note: `Restore ${c.req.param("id")} to v${version}` }) });
    return c.json(draft);
  });
  app.post("/api/v1/:model", async (c) => {
    const m = model(c.req.param("model"));
    const { id: _ignored, ...data } = await body(c);
    const draft = await call(c, `${m.name}.draft`, data);
    if (c.req.query("submit") === "true") return c.json({ draft, submit: await call(c, "cms.submit", {}) }, 201);
    return c.json(draft, 201);
  });
  app.patch("/api/v1/:model/:id", async (c) => {
    const m = model(c.req.param("model"));
    const draft = await call(c, `${m.name}.draft`, { ...(await body(c)), id: c.req.param("id") });
    if (c.req.query("submit") === "true") return c.json({ draft, submit: await call(c, "cms.submit", {}) });
    return c.json(draft);
  });
  app.delete("/api/v1/:model/:id", async (c) => {
    const m = model(c.req.param("model"));
    return c.json(await call(c, `${m.name}.delete`, { id: c.req.param("id") }));
  });

  if (opts.studio !== false) mountStudio(app, k, opts.studio ?? findStudio());

  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404));
  return app;
}
