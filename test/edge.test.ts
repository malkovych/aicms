import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createWorker, d1 } from "../src/edge.ts";
import { media, search } from "../src/modules/index.ts";
import { post, tag } from "./helpers.ts";

/** A D1 stand-in on node:sqlite with D1's API shape: prepare/bind/all/first/run and atomic batch. */
function fakeD1() {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const stmt = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return {
    prepare: (sql: string) => {
      if (/;\s*\S/.test(sql.trim().replace(/;$/, ""))) throw new Error("D1 prepares one statement at a time");
      return stmt(sql);
    },
    async batch(list: { sql: string; params: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        for (const s of list) db.prepare(s.sql).run(...s.params);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return [];
    },
  };
}

function fakeR2() {
  const files = new Map<string, { bytes: Uint8Array; type?: string }>();
  return {
    files,
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      files.set(key, { bytes: value, type: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const f = files.get(key);
      return f ? { body: new Blob([f.bytes as Uint8Array<ArrayBuffer>]).stream(), size: f.bytes.length } : null;
    },
    async delete(key: string) {
      files.delete(key);
    },
  };
}

test("edge: createWorker on D1 + R2 + Assets, owner token, waitUntil for webhooks", async () => {
  const env = {
    DB: fakeD1(),
    MEDIA: fakeR2(),
    ASSETS: { fetch: async (r: Request) => (new URL(r.url).pathname === "/index.html" ? new Response("<!doctype html><title>Studio</title>", { headers: { "content-type": "text/html" } }) : new Response("nope", { status: 404 })) },
    AICMS_OWNER_TOKEN: "edge-owner-token-long-enough-0123456789",
  };
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
  const worker = createWorker({
    name: "Edge",
    db: d1("DB"),
    models: [post, tag],
    modules: [search(), media({ storage: { r2: "MEDIA" } })],
    public: ["post:read"],
    registry: false,
    webhooks: [{ url: "http://127.0.0.1:9/hook" }],
  });
  const call = (action: string, input: unknown, token = env.AICMS_OWNER_TOKEN) =>
    worker.fetch(new Request(`https://cms.test/api/v1/actions/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) }), env, ctx).then((r) => r.json() as Promise<any>);

  assert.equal((await call("cms.describe", {})).you.name, "owner", "the owner token works without a CLI");
  assert.equal((await call("cms.describe", {}, "edge-owner-token-long-enough-01234567XX")).error.code, "unauthorized");
  await call("post.draft", { title: "On the edge", body: "Hello **D1**" });
  assert.equal((await call("cms.submit", {})).status, "merged");
  assert.ok(waited.length > 0, "webhooks are handed to waitUntil");
  const res = await worker.fetch(new Request("https://cms.test/api/v1/post?slug=on-the-edge"), env, ctx);
  assert.equal(((await res.json()) as any).items[0].title, "On the edge");
  assert.equal((await call("cms.search", { query: "d1" })).hits[0].title, "On the edge");

  const up = await call("media.upload", { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"), filename: "x.svg" });
  assert.equal(env.MEDIA.files.size, 1);
  const served = await worker.fetch(new Request(`https://cms.test${up.url}`), env, ctx);
  assert.equal(served.headers.get("content-type"), "image/svg+xml");
  assert.match(served.headers.get("content-security-policy")!, /sandbox/);

  const studio = await worker.fetch(new Request("https://cms.test/studio/inbox"), env, ctx);
  assert.match(await studio.text(), /<title>Studio<\/title>/);
  const login = await call("cms.login_code", {});
  assert.match(login.path, /^\/studio\/login\?code=/);
  const signin = await worker.fetch(new Request(`https://cms.test${login.path}`), env, ctx);
  assert.equal(signin.status, 302);
  assert.match(signin.headers.get("set-cookie")!, /Secure/, "https requests get a Secure cookie");
});
