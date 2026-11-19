import { extname, join, normalize, sep } from "node:path";
import type { Context, Hono } from "hono";
import { builtin } from "../node.ts";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Kernel } from "../kernel/cms.ts";

export const SESSION_COOKIE = "aicms_session";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Where Studio's files come from: a folder on a server, or Workers Assets on the edge. */
export interface StudioSource {
  /** A file by its path under /studio/ (e.g. "assets/index.js"), or null if there is none. */
  read(rel: string): Promise<{ body: Uint8Array | ReadableStream; type?: string } | null>;
}

/** The built Studio: dist/studio next to the compiled kernel, or the repo's dist/ when running from source. */
export function findStudio(): string | null {
  const fs = builtin("node:fs");
  const url = builtin("node:url");
  if (!fs || !url) return null;
  for (const rel of ["../studio/", "../../dist/studio/"]) {
    const dir = url.fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

/** Studio files from a folder. */
export function dirSource(dir: string): StudioSource {
  return {
    async read(rel) {
      const file = normalize(join(dir, rel));
      if (!file.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return null;
      try {
        const body = await (await import("node:fs/promises")).readFile(file);
        return { body: new Uint8Array(body), type: TYPES[extname(file)] };
      } catch {
        return null;
      }
    },
  };
}

/** Studio files from a Cloudflare Workers Assets binding whose directory is dist/studio. */
export function assetsSource(assets: { fetch(request: Request): Promise<Response> }): StudioSource {
  return {
    async read(rel) {
      const res = await assets.fetch(new Request(`https://assets.local/${rel}`));
      if (!res.ok || !res.body) return null;
      return { body: res.body, type: res.headers.get("content-type") ?? TYPES[extname(rel)] };
    },
  };
}

const isHttps = (c: Context) => c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";

function notice(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · AICMS Studio</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,sans-serif;background:#ECEFF3;color:#131A2A}
@media (prefers-color-scheme:dark){body{background:#0D1119;color:#E7EBF3}main{background:#151B27!important}}
main{max-width:440px;margin:16px;padding:32px;border-radius:20px;background:#fff}h1{font-size:20px;margin:0 0 8px}code{font:14px ui-monospace,Menlo,monospace}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

/** Studio: sign-in, sign-out and the single-page app under /studio. */
export function mountStudio(app: Hono<any>, k: Kernel, source: StudioSource | null) {
  app.get("/studio", (c) => c.redirect("/studio/"));

  app.get("/studio/login", async (c) => {
    try {
      const s = await k.startSession(c.req.query("code") ?? "");
      setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "Lax", secure: isHttps(c), path: "/", expires: new Date(s.expiresAt) });
      return c.redirect("/studio/");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.html(notice("Can't sign in", `${message.replace(/`([^`]+)`/g, "<code>$1</code>")}`), 401);
    }
  });

  app.post("/studio/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await k.endSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/studio/*", async (c) => {
    if (!source) {
      return c.html(notice("Studio isn't built", "Run <code>npm run build</code> in the aicms repository, then restart the server."), 503);
    }
    const rel = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/studio\/?/, ""));
    if (rel && extname(rel) && !rel.split("/").includes("..")) {
      const file = await source.read(rel);
      if (!file) return c.text("Not found", 404);
      return c.body(file.body as unknown as ArrayBuffer, 200, {
        "content-type": file.type ?? TYPES[extname(rel)] ?? "application/octet-stream",
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }
    // Client-side routes all get the app shell.
    const shell = await source.read("index.html");
    if (!shell) return c.text("Studio's index.html is missing", 500);
    return c.body(shell.body as unknown as ArrayBuffer, 200, { "content-type": TYPES[".html"], "cache-control": "no-cache" });
  });
}
