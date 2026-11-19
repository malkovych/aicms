import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createCMS, postgres } from "../src/index.ts";
import { search } from "../src/modules/index.ts";
import { OWNER } from "../src/kernel/policy.ts";
import { post, tag } from "./helpers.ts";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

test("postgres({ url }): node-postgres over the wire, schema, merge, filters, search, concurrency", async () => {
  const db = new PGlite();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();
  try {
    const k = await createCMS(
      { name: "PG", db: postgres({ url: `postgres://postgres@127.0.0.1:${port}/postgres`, max: 1 }), locales: ["en", "uk"], models: [post, tag], modules: [search()], agents: { writer: { scopes: ["post:draft", "tag:draft"] } } },
    );
    const owner = { actor: OWNER, gate: "internal" as const };
    const t: any = await k.call("tag.draft", { name: "Guides" }, owner);
    await k.call("post.draft", { title: "Postgres works", body: "Stored as **JSONB**.", tags: [t.id], publishedAt: "2026-11-19" }, owner);
    await k.call("post.draft", { title: "Друга стаття", body: "Українською.", locale: "uk" }, owner);
    assert.equal(((await k.call("cms.submit", {}, owner)) as any).status, "merged");

    const bySlug: any = await k.call("post.get", { slug: "postgres-works", format: "markdown" }, owner);
    assert.equal(bySlug.body, "Stored as **JSONB**.");
    assert.equal(((await k.call("post.list", { where: { tags: t.id } }, owner)) as any).total, 1, "array contains, on JSONB");
    assert.equal(((await k.call("post.list", { locale: "uk" }, owner)) as any).items[0].title, "Друга стаття");
    assert.equal(((await k.call("cms.search", { query: "jsonb" }, owner)) as any).hits[0].title, "Postgres works");

    // Two agents editing the same entry: the second merge sees the conflict.
    const writer = { actor: k.actor("writer"), gate: "mcp" as const };
    await k.call("post.draft", { id: bySlug.id, title: "Edited by the writer" }, writer);
    const sub: any = await k.call("cms.submit", {}, writer);
    await k.call("post.draft", { id: bySlug.id, title: "Edited by the owner" }, owner);
    await k.call("cms.submit", {}, owner);
    await assert.rejects(k.call("cms.merge", { id: sub.changeset }, owner), /can't be merged/);

    // Unique values are enforced per locale through expression indexes.
    await k.call("post.draft", { title: "Postgres works", slug: "postgres-works" }, owner);
    const dup: any = await k.call("cms.submit", {}, owner);
    assert.equal(dup.status, "needs_changes");
    await k.close();
  } finally {
    await server.stop();
    await db.close();
  }
});
