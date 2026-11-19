import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER } from "../src/kernel/policy.ts";
import { viewEvent } from "../src/gates/events.ts";
import { makeCms } from "./helpers.ts";

const owner = { actor: OWNER, gate: "studio" as const };

test("presence: people and agents on an entry, conflicting drafts, private to readers", async () => {
  const k = await makeCms();
  const d: any = await k.call("post.draft", { title: "Shared post" }, owner);
  await k.call("cms.submit", {}, owner);
  const events: any[] = [];
  k.feed.subscribe((e) => e.event === "presence" && events.push(e));

  // An agent drafting a change shows up as editing, live.
  const writer = { actor: k.actor("writer"), gate: "mcp" as const };
  await k.call("post.draft", { id: d.id, title: "Shared post, by the writer" }, writer);
  assert.deepEqual(events.at(-1).payload.here.map((h: any) => [h.actor, h.state]), [["writer", "editing"]]);

  const seen: any = await k.call("cms.presence", { id: d.id, state: "viewing" }, owner);
  assert.deepEqual(seen.here.map((h: any) => [h.actor, h.state]), [["writer", "editing"]], "others, not yourself");
  assert.deepEqual(seen.drafts.map((x: any) => [x.actor, x.status, x.fields]), [["writer", "drafting", ["title"]]]);
  await k.call("cms.submit", {}, writer);
  const after: any = await k.call("cms.presence", { id: d.id }, owner);
  assert.equal(after.drafts[0].status, "waiting for review");
  assert.deepEqual(after.here, [], "submitting ends the agent's editing");
  await k.call("cms.presence", { id: d.id, state: "viewing" }, writer);

  // The writer sees the owner, too; the public sees nothing.
  const writerView: any = await k.call("cms.presence", { id: d.id }, writer);
  assert.deepEqual(writerView.here.map((h: any) => h.actor), ["owner"]);
  const last = events.at(-1);
  assert.equal(viewEvent(k, k.actor("public"), last), null);
  assert.ok(viewEvent(k, k.actor("editor"), last));

  await k.call("cms.presence", { id: d.id, state: "left" }, owner);
  assert.deepEqual(k.presence.list(d.id).map((h) => [h.actor, h.state]), [["writer", "viewing"]]);
  const log: any = await k.call("cms.log", { limit: 50 }, owner);
  assert.equal(log.events.some((e: any) => e.action === "cms.presence"), false, "heartbeats stay out of the log");
  await assert.rejects(k.call("cms.presence", { id: "pos_nope" }, owner), /No entry/);
  await k.close();
});

test("registry: valid, in sync with the official modules, searchable, permission-checked", async () => {
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { parseRegistry, searchRegistry, exceedsDeclared, loadRegistry } = await import("../src/registry.ts");
  const { catalog } = await import("../src/modules/catalog.ts");
  const { moduleManifest, defineModule } = await import("../src/kernel/modules.ts");

  const registry = parseRegistry(JSON.parse(readFileSync(new URL("../docs/registry.json", import.meta.url), "utf8")));
  for (const c of catalog) {
    const entry = registry.modules.find((m) => m.name === c.name);
    assert.ok(entry?.official, `${c.name} is listed as official`);
    assert.deepEqual(exceedsDeclared(entry!, moduleManifest(c.create())), [], `${c.name}: registry and module agree`);
  }
  assert.deepEqual(searchRegistry(registry, "markdown git").map((m) => m.name), ["git-sync"]);
  assert.equal(searchRegistry(registry, "").length, catalog.length);

  const sneaky = defineModule({ name: "seo", uses: ["*"], routes: { "GET /sitemap.xml": () => new Response(""), "POST /admin": () => new Response("") } });
  assert.match(exceedsDeclared(registry.modules[0], moduleManifest(sneaky)).join(), /routes: POST \/admin/);

  // A file registry with a community module, cached, then read offline.
  const dir = mkdtempSync(join(tmpdir(), "aicms-reg-"));
  const file = join(dir, "registry.json");
  const community = { name: "reviews", title: "Reviews", summary: "Product reviews with moderation by agents.", package: "@someone/aicms-reviews", author: "someone", license: "MIT", provides: ["reviews"], requires: [], uses: ["product"], scopes: ["reviews:moderate"], routes: [], hooks: [], tags: ["commerce"] };
  writeFileSync(file, JSON.stringify({ version: 1, updated: "2026-11-19", modules: [...registry.modules, community] }));
  const cache = join(dir, "cache.json");
  assert.equal((await loadRegistry(file, { cacheFile: cache })).modules.length, catalog.length + 1);
  writeFileSync(file, "not json");
  assert.equal((await loadRegistry(file, { cacheFile: cache, maxAgeMs: 0 })).modules.length, catalog.length + 1, "a stale cache beats nothing");
  writeFileSync(file, JSON.stringify({ version: 1, updated: "x", modules: [community, community] }));
  await assert.rejects(loadRegistry(file), /twice/);
  writeFileSync(file, JSON.stringify({ version: 1, updated: "2026-11-19", modules: [community] }));

  const k = await makeCms({ registry: file });
  const mods: any = await k.call("cms.modules", {}, owner);
  assert.deepEqual(mods.community.map((m: any) => [m.name, m.install]), [["reviews", "aicms add reviews"]]);
  await assert.rejects(k.call("cms.propose_module", { module: "reviews", reason: "We sell things and want reviews" }, { actor: k.actor("writer"), gate: "mcp" }), /No module "reviews" in the catalog/, "the server never installs community code");
  await k.close();
});
