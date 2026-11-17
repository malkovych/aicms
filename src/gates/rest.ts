import { Hono, type Context } from "hono";
import type { Kernel } from "../kernel/cms.ts";
import { AicmsError, isAicmsError } from "../kernel/errors.ts";
import type { Actor } from "../kernel/policy.ts";
import { filterableFields } from "../schema/model.ts";
import { llmsTxt, manifest, VERSION } from "./discovery.ts";
import { handleMcpRequest } from "./mcp.ts";
import { openapi } from "./openapi.ts";

type Env = { Variables: { actor: Actor } };

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
export function createApp(k: Kernel): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (isAicmsError(err)) return c.json({ error: err.toJSON() }, err.status as 401);
    console.error("[aicms]", err);
    return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
  });

  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
    c.set("actor", await k.resolveToken(token));
    await next();
  });

  const call = (c: Context<Env>, name: string, input: unknown) => k.call(name, input, { actor: c.get("actor"), gate: "rest" });
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

  app.get("/api/v1/changesets", async (c) =>
    c.json(c.req.query("review") ? await call(c, "cms.review", { status: c.req.query("status") }) : await call(c, "cms.changes", {})),
  );
  app.get("/api/v1/changesets/:id", async (c) => c.json(await call(c, "cms.review", { id: c.req.param("id") })));
  app.post("/api/v1/changesets/submit", async (c) => c.json(await call(c, "cms.submit", await body(c))));
  app.post("/api/v1/changesets/:id/merge", async (c) => c.json(await call(c, "cms.merge", { id: c.req.param("id") })));
  app.post("/api/v1/changesets/:id/reject", async (c) => c.json(await call(c, "cms.reject", { ...(await body(c)), id: c.req.param("id") })));

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

  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404));
  return app;
}
