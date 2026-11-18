import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
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

/** The built Studio: dist/studio next to the compiled kernel, or the repo's dist/ when running from source. */
export function findStudio(): string | null {
  for (const rel of ["../studio/", "../../dist/studio/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
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
export function mountStudio(app: Hono<any>, k: Kernel, dir: string | null) {
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
    if (!dir) {
      return c.html(notice("Studio isn't built", "Run <code>npm run build</code> in the aicms repository, then restart the server."), 503);
    }
    const rel = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/studio\/?/, ""));
    const file = normalize(join(dir, rel));
    const inside = file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
    if (rel && inside && extname(file)) {
      try {
        const body = await readFile(file);
        const immutable = rel.startsWith("assets/");
        return c.body(body, 200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        });
      } catch {
        return c.text("Not found", 404);
      }
    }
    // Client-side routes all get the app shell.
    return c.body(await readFile(join(dir, "index.html")), 200, { "content-type": TYPES[".html"], "cache-control": "no-cache" });
  });
}
