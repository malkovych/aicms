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

test("A2A: Agent Card per caller, message/send runs a skill, tasks/get, honest errors", async () => {
  const { createApp } = await import("../src/index.ts");
  const k = await makeCms();
  const app = createApp(k, { studio: false });
  const writer = await k.createToken("writer");
  const rpc = (method: string, params: unknown, token?: string, id: number | string = 1) =>
    app.request("/a2a", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).then((r) => r.json() as Promise<any>);
  const msg = (data: unknown) => ({ message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "data", data }] } });

  const card: any = await (await app.request("/.well-known/agent-card.json")).json();
  assert.equal(card.protocolVersion, "0.3.0");
  assert.equal(card.url, "http://localhost/a2a");
  assert.ok(card.skills.some((s: any) => s.id === "post.list"));
  assert.equal(card.skills.some((s: any) => s.id === "post.draft" || s.id === "cms.token"), false, "anonymous callers see read skills only");
  const writerCard: any = await (await app.request("/.well-known/agent-card.json", { headers: { authorization: `Bearer ${writer}` } })).json();
  assert.ok(writerCard.skills.some((s: any) => s.id === "post.draft"));

  const drafted = await rpc("message/send", msg({ action: "post.draft", input: { title: "From another agent" } }), writer);
  assert.equal(drafted.result.kind, "task");
  assert.equal(drafted.result.status.state, "completed");
  assert.equal(drafted.result.artifacts[0].parts[0].data.op, "create");
  const byTool = await rpc("message/send", msg({ skill: "cms_submit", input: { note: "via A2A" } }), writer);
  assert.equal(byTool.result.artifacts[0].parts[0].data.status, "submitted");

  const got = await rpc("tasks/get", { id: drafted.result.id }, writer);
  assert.equal(got.result.id, drafted.result.id);
  assert.equal((await rpc("tasks/get", { id: drafted.result.id })).error.code, -32001, "tasks belong to whoever created them");
  assert.equal((await rpc("tasks/cancel", { id: drafted.result.id }, writer)).error.code, -32002);
  assert.equal((await rpc("message/stream", msg({}), writer)).error.code, -32004);

  const denied = await rpc("message/send", msg({ action: "post.draft", input: { title: "x" } }));
  assert.equal(denied.result.status.state, "rejected");
  assert.equal(denied.result.status.message.parts[1].data.error.code, "unauthorized");
  const invalid = await rpc("message/send", msg({ action: "post.draft", input: { title: 42 } }), writer);
  assert.equal(invalid.result.status.state, "failed");
  const prose = await rpc("message/send", { message: { kind: "message", role: "user", messageId: "m2", parts: [{ kind: "text", text: "Write a post about winter" }] } }, writer);
  assert.equal(prose.result.status.state, "input-required");
  assert.match(prose.result.status.message.parts[0].text, /data part/);
  assert.equal((await app.request("/a2a", { method: "POST", body: "{" }).then((r) => r.json() as Promise<any>)).error.code, -32700);

  const log: any = await k.call("cms.log", { actor: "writer", limit: 1 }, owner);
  assert.equal(log.events[0].gate, "a2a");
  await k.close();
});
