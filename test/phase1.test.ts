import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, generateTypes } from "../src/index.ts";
import { OWNER } from "../src/kernel/policy.ts";
import { makeCms } from "./helpers.ts";

const owner = { actor: OWNER, gate: "internal" as const };

async function publishPost(k: Awaited<ReturnType<typeof makeCms>>, title: string) {
  const d: any = await k.call("post.draft", { title, body: "First version" }, owner);
  await k.call("cms.submit", {}, owner);
  return d.id as string;
}

test("history, restore and revert", async () => {
  const k = await makeCms();
  const id = await publishPost(k, "Original title");

  await k.call("post.draft", { id, title: "Second title", body: "Second version" }, owner);
  await k.call("cms.submit", {}, owner);

  const h: any = await k.call("cms.history", { id }, owner);
  assert.equal(h.current, 2);
  assert.deepEqual(h.versions.map((v: any) => v.version), [2, 1]);
  assert.deepEqual(h.versions[0].changed.sort(), ["body", "title"]);

  const v1: any = await k.call("cms.history", { id, version: 1, format: "markdown" }, owner);
  assert.equal(v1.data.title, "Original title");
  assert.equal(v1.data.body, "First version");

  const restore: any = await k.call("cms.restore", { id, version: 1 }, owner);
  assert.deepEqual(restore.fields.sort(), ["body", "title"]);
  await k.call("cms.submit", {}, owner);
  const now: any = await k.call("post.get", { id, format: "markdown" }, owner);
  assert.equal(now.title, "Original title");
  assert.equal(now.version, 3);
  await assert.rejects(k.call("cms.restore", { id, version: 1 }, owner), /already matches/);

  // Revert an agent's merged changeset: its new tag disappears, its edit is undone.
  const tagger = k.actor("tagger");
  const tag: any = await k.call("tag.draft", { name: "Winter" }, { actor: tagger, gate: "mcp" });
  const merged: any = await k.call("cms.submit", {}, { actor: tagger, gate: "mcp" });
  assert.equal(merged.status, "merged");
  await k.call("cms.revert", { changeset: merged.changeset }, owner);
  await k.call("cms.submit", {}, owner);
  await assert.rejects(k.call("tag.get", { id: tag.id }, owner), /No tag/);

  // A deleted entry comes back with the same id.
  const tagHistory: any = await k.call("cms.history", { id: tag.id }, owner);
  assert.equal(tagHistory.current, null);
  assert.equal(tagHistory.versions[0].deleted, true);
  await k.call("cms.restore", { id: tag.id, version: 1 }, owner);
  await k.call("cms.submit", {}, owner);
  const back: any = await k.call("tag.get", { id: tag.id }, owner);
  assert.equal(back.name, "Winter");
  assert.equal(back.version, 3, "history continues: created, deleted, restored");

  // Entries changed again after the changeset can't be reverted wholesale.
  const second: any = await k.call("post.draft", { id, title: "Third title" }, owner);
  const submitted: any = await k.call("cms.submit", {}, owner);
  await k.call("post.draft", { id, title: "Fourth title" }, owner);
  await k.call("cms.submit", {}, owner);
  assert.ok(second.changeset);
  await assert.rejects(k.call("cms.revert", { changeset: submitted.changeset }, owner), /Changed again/);
  await k.close();
});

test("restore respects field permissions", async () => {
  const k = await makeCms();
  const id = await publishPost(k, "Owner post");
  await k.call("post.draft", { id, title: "Owner post, edited" }, owner);
  await k.call("cms.submit", {}, owner);
  const seo = k.actor("seo");
  await assert.rejects(k.call("cms.restore", { id, version: 1 }, { actor: seo, gate: "mcp" }), /can't change/);
  await k.close();
});

test("admin actions: agents, tokens, log", async () => {
  const k = await makeCms();
  const writer = k.actor("writer");
  await k.call("cms.describe", {}, { actor: writer, gate: "mcp" });
  const issued: any = await k.call("cms.token", { agent: "writer" }, owner);
  assert.match(issued.token, /^aicms_/);
  const list: any = await k.call("cms.agents", {}, owner);
  const w = list.agents.find((a: any) => a.name === "writer");
  assert.equal(w.tokens, 1);
  assert.equal(w.actionsLastHour, 1);
  assert.ok(w.lastSeen);

  const log: any = await k.call("cms.log", { actor: "writer" }, owner);
  assert.equal(log.events[0].action, "cms.describe");
  assert.equal(k.tools(writer).some((t) => t.name === "cms.agents" || t.name === "cms.log"), false);

  const revoked: any = await k.call("cms.revoke", { agent: "writer" }, owner);
  assert.equal(revoked.tokens, 1);
  await assert.rejects(k.resolveToken(issued.token), /revoked/);
  await k.close();
});

test("describe gives clients what they need to build forms", async () => {
  const k = await makeCms();
  const d: any = await k.call("cms.describe", { model: "post" }, owner);
  const byName = Object.fromEntries(d.fields.map((f: any) => [f.name, f]));
  assert.equal(byName.title.kind, "text");
  assert.equal(byName.title.max, 120);
  assert.deepEqual(byName.tags, { name: "tags", kind: "ref", type: "ref(tag)[]", model: "tag", many: true, writable: true });
  assert.deepEqual(byName.seo.fields.map((f: any) => f.name), ["title", "description"]);
  assert.ok(byName.body.blocks.includes("cta"));
  await k.close();
});

test("Studio sign-in: one-time code, session cookie, CSRF", async () => {
  const k = await makeCms();
  const app = createApp(k, { studio: false });
  const code = await k.createLoginCode();
  await assert.rejects(k.resolveToken(code), /one-time/);

  const login = await createApp(k).request(`/studio/login?code=${code}`);
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /aicms_session=aicms_[\w-]+/);
  assert.match(cookie, /HttpOnly/);
  const session = cookie.split(";")[0];
  assert.equal((await createApp(k).request(`/studio/login?code=${code}`)).status, 401, "a link works once");

  const me = await (await app.request("/api/v1", { headers: { cookie: session } })).json();
  assert.equal(me.you.name, "owner");

  const post = (headers: Record<string, string>) =>
    app.request("/api/v1/post", { method: "POST", headers: { cookie: session, "content-type": "application/json", ...headers }, body: JSON.stringify({ title: "From Studio" }) });
  assert.equal((await post({})).status, 403, "no Origin: refused");
  assert.equal((await post({ origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ origin: "http://localhost" })).status, 201);

  const log: any = await k.call("cms.log", { limit: 5 }, owner);
  assert.equal(log.events[0].gate, "studio");
  assert.equal(log.events[0].action, "post.draft");
  assert.ok(!log.events.some((e: any) => e.gate === "studio" && e.action === "cms.describe"), "Studio page loads stay out of the log");

  await createApp(k).request("/studio/logout", { method: "POST", headers: { cookie: session, origin: "http://localhost" } });
  const after = await (await app.request("/api/v1", { headers: { cookie: session } })).json();
  assert.equal(after.you.name, "public", "a revoked session falls back to public");
  await k.close();
});

test("read-only Actions answer GET; writes don't", async () => {
  const k = await makeCms();
  const app = createApp(k, { studio: false });
  await publishPost(k, "Cache me");
  const res = await app.request(`/api/v1/actions/post.list?input=${encodeURIComponent(JSON.stringify({ fields: ["title"] }))}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).items[0].title, "Cache me");
  assert.equal((await app.request("/api/v1/actions/post.draft")).status, 422);
  await k.close();
});

async function readEvents(res: Response, count: number) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const events: { event: string; data: any; id?: string }[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = text.indexOf("\n\n")) >= 0) {
      const chunk = text.slice(0, cut);
      text = text.slice(cut + 2);
      const fields = Object.fromEntries(chunk.split("\n").filter((l) => l && !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
      if (fields.event) events.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data) });
    }
  }
  await reader.cancel();
  return events;
}

test("SSE: filtered per actor, resumable", async () => {
  const k = await makeCms();
  const app = createApp(k, { studio: false });
  const writerToken = await k.createToken("writer");
  const ownerToken = await k.createToken("owner");

  const publicStream = await app.request("/api/v1/events");
  assert.equal(publicStream.headers.get("content-type"), "text/event-stream");
  const writerStream = await app.request("/api/v1/events", { headers: { authorization: `Bearer ${writerToken}` } });
  const ownerStream = await app.request("/api/v1/events", { headers: { authorization: `Bearer ${ownerToken}` } });

  const writer = k.actor("writer");
  await k.call("post.draft", { title: "Live" }, { actor: writer, gate: "mcp" });
  const submitted: any = await k.call("cms.submit", {}, { actor: writer, gate: "mcp" });
  await k.call("cms.merge", { id: submitted.changeset }, owner);

  const pub = await readEvents(publicStream, 2);
  assert.deepEqual(pub.map((e) => e.event), ["ready", "changeset.merged"]);
  assert.equal(pub[1].data.payload.actor, undefined, "the public sees what was published, not who did it");

  const mine = await readEvents(writerStream, 3);
  assert.deepEqual(mine.map((e) => e.event), ["ready", "changeset.submitted", "changeset.merged"]);

  const all = await readEvents(ownerStream, 4);
  // An action's own event follows whatever it emitted while running.
  assert.deepEqual(all.slice(1, 4).map((e) => e.event), ["action", "changeset.submitted", "action"]);

  const resumed = await readEvents(await app.request(`/api/v1/events?after=${all[3].id}`, { headers: { authorization: `Bearer ${ownerToken}` } }), 2);
  assert.equal(resumed[1].event, "changeset.merged");
  assert.ok(Number(resumed[1].id) > Number(all[3].id));
  await k.close();
});

test("aicms types", async () => {
  const k = await makeCms();
  const ts = generateTypes([...k.models.values()], k.config.name);
  assert.match(ts, /export interface Post \{\n  title: string;\n  slug\?: string;\n  body\?: Block\[\];\n  tags\?: string\[\];\n  seo\?: \{\n    title\?: string;\n    description\?: string;\n  \};\n  publishedAt\?: string;\n\}/);
  assert.match(ts, /export interface Schema \{\n  post: Post;\n  tag: Tag;\n\}/);
  await k.close();
});
