import { test } from "node:test";
import assert from "node:assert/strict";
import { AicmsError } from "../src/index.ts";
import { makeCms } from "./helpers.ts";

const as = (k: Awaited<ReturnType<typeof makeCms>>, who: string) => {
  const actor = k.actor(who);
  return <T = any>(name: string, input: unknown = {}) => k.call<T>(name, input, { actor, gate: "mcp" });
};

async function rejects(p: Promise<unknown>, code: string, match?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AicmsError, `expected AicmsError, got ${e}`);
    assert.equal(e.code, code);
    if (match) assert.match(e.message, match);
    return true;
  });
}

test("an agent drafts, submits, and a person merges", async () => {
  const k = await makeCms();
  const writer = as(k, "writer");

  const tagDraft = await writer("tag.draft", { name: "Skin care" });
  const draft = await writer("post.draft", {
    title: "Як обрати SPF на зиму",
    body: "## Why\nSnow reflects UV.\n\n:::cta{href=\"/spf\" label=\"Pick\"}",
    tags: [tagDraft.id],
  });
  assert.equal(draft.op, "create");
  assert.equal(draft.entry.slug, "yak-obraty-spf-na-zymu");
  assert.match(draft.entry.body, /^## Why/); // agents get Markdown back

  // Not public yet
  assert.equal((await as(k, "public")("post.list")).total, 0);

  const submitted = await writer("cms.submit", { note: "First post" });
  assert.equal(submitted.status, "submitted");
  assert.match(submitted.reason, /reviewed by a person/);

  const editor = as(k, "editor");
  const queue = await editor("cms.review");
  assert.equal(queue.changesets.length, 1);
  const merged = await editor("cms.merge", { id: submitted.changeset });
  assert.equal(merged.entries.length, 2);

  const pub = as(k, "public");
  const got = await k.call<any>("post.get", { slug: "yak-obraty-spf-na-zymu" }, { actor: k.actor("public"), gate: "rest" });
  assert.equal(got.version, 1);
  assert.equal(got.body[0].type, "heading"); // REST gets blocks
  assert.equal((await pub("tag.list")).total, 1);
  assert.equal((await pub("post.list", { where: { tags: tagDraft.id } })).total, 1);

  const changes = await writer("cms.changes");
  assert.equal(changes.changesets[0].status, "merged");
  await k.close();
});

test("submit returns field-level issues instead of publishing broken data", async () => {
  const k = await makeCms();
  const writer = as(k, "writer");
  await writer("post.draft", { body: "Only a body", tags: ["tag_missing"] });
  const res = await writer("cms.submit");
  assert.equal(res.status, "needs_changes");
  const fields = res.issues.map((i: any) => i.field).sort();
  assert.deepEqual(fields, ["tags", "title"]);
  await k.close();
});

test("an agent with review auto publishes when the model allows it", async () => {
  const k = await makeCms();
  const tagger = as(k, "tagger");
  await tagger("tag.draft", { name: "Winter" });
  const res = await tagger("cms.submit");
  assert.equal(res.status, "merged");
  assert.equal((await tagger("tag.get", { slug: "winter" })).name, "Winter");
  await k.close();
});

test("field-level scopes: the seo agent only sees and changes seo", async () => {
  const k = await makeCms();
  const owner = as(k, "owner");
  const created = await owner("post.draft", { title: "Hello", body: "Hi" });
  await owner("cms.submit");

  const seoTools = k.tools(k.actor("seo")).map((t) => t.tool);
  assert.ok(seoTools.includes("post_draft"));
  assert.ok(!seoTools.includes("post_delete"));
  const schema = k.tools(k.actor("seo")).find((t) => t.tool === "post_draft")!.inputSchema as any;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["id", "locale", "seo"]);

  const seo = as(k, "seo");
  await rejects(seo("post.draft", { id: created.id, title: "Hijacked" }), "forbidden", /post\.title/);
  await seo("post.draft", { id: created.id, seo: { description: "A short hello" } });
  const res = await seo("cms.submit");
  // Model "post" has no "publish" in agent.can, so a person still decides.
  assert.equal(res.status, "submitted");
  assert.match(res.reason, /requires a person/);
  await k.close();
});

test("a changeset based on an old version can't be merged", async () => {
  const k = await makeCms();
  const owner = as(k, "owner");
  const p = await owner("post.draft", { title: "Original" });
  await owner("cms.submit");

  const writer = as(k, "writer");
  await writer("post.draft", { id: p.id, title: "Writer's edit" });
  const sub = await writer("cms.submit");
  assert.equal(sub.status, "submitted");

  await owner("post.draft", { id: p.id, title: "Owner's edit" });
  await owner("cms.submit");

  await rejects(owner("cms.merge", { id: sub.changeset }), "conflict");
  const back = await writer("cms.changes");
  assert.equal(back.changesets[0].status, "open");
  assert.match(back.changesets[0].issues[0].message, /v1 → v2/);
  await k.close();
});

test("reject sends the changeset back with a comment", async () => {
  const k = await makeCms();
  const writer = as(k, "writer");
  await writer("post.draft", { title: "Too long a title that nobody will read" });
  const sub = await writer("cms.submit");
  await as(k, "owner")("cms.reject", { id: sub.changeset, comment: "Shorter title, please" });
  const mine = await writer("cms.changes");
  assert.equal(mine.changesets[0].status, "open");
  assert.equal(mine.changesets[0].comment, "Shorter title, please");
  // The agent fixes it in the same changeset and submits again.
  const item = mine.changesets[0].items[0];
  await writer("post.draft", { id: item.id, title: "Short title" });
  assert.equal((await writer("cms.submit")).status, "submitted");
  await k.close();
});

test("public callers read but can't write; unknown tokens are refused", async () => {
  const k = await makeCms();
  const pub = as(k, "public");
  await rejects(pub("post.draft", { title: "x" }), "unauthorized");
  await rejects(k.resolveToken("aicms_nope"), "unauthorized");
  const token = await k.createToken("writer");
  assert.equal((await k.resolveToken(token)).id, "writer");
  await k.revokeAgent("writer");
  await rejects(k.resolveToken(token), "unauthorized");
  await k.close();
});

test("budgets stop a runaway agent", async () => {
  const k = await makeCms();
  const tiny = as(k, "tiny");
  for (let i = 0; i < 3; i++) await tiny("tag.list");
  await rejects(tiny("tag.list"), "budget");
  await k.close();
});

test("module actions run with the module's scope and are logged", async () => {
  const k = await makeCms();
  const owner = as(k, "owner");
  const p = await owner("post.draft", { title: "Count me", body: "one two three" });
  await owner("cms.submit");
  const res = await as(k, "editor")("stats.word_count", { id: p.id });
  assert.equal(res.words, 3);
  const log = await k.store.listEvents({ limit: 5 });
  assert.equal(log[0].action, "stats.word_count");
  assert.equal(log[0].actor, "editor");
  await k.close();
});

test("modules and get({ drafts: true }) see the caller's unpublished drafts, nobody else does", async () => {
  const k = await makeCms();
  const writer = as(k, "writer");
  const d = await writer("post.draft", { title: "Draft only", body: "four words right here" });
  assert.equal((await as(k, "editor")("stats.word_count", { id: d.id })).words, 0);
  await rejects(writer("post.get", { id: d.id }), "not_found");
  assert.equal((await writer("post.get", { id: d.id, drafts: true })).title, "Draft only");
  const owner = as(k, "owner");
  const own = await owner("post.draft", { title: "Owner draft", body: "one two" });
  assert.equal((await owner("stats.word_count", { id: own.id })).words, 2);
  await k.close();
});

test("delete is a proposal until merged; dropping an unpublished draft discards it", async () => {
  const k = await makeCms();
  const owner = as(k, "owner");
  const a = await owner("tag.draft", { name: "Keep" });
  const b = await owner("tag.draft", { name: "Drop" });
  assert.equal((await owner("tag.delete", { id: b.id })).op, "discarded");
  await owner("cms.submit");
  await owner("tag.delete", { id: a.id });
  assert.equal((await owner("tag.list")).total, 1);
  await owner("cms.submit");
  assert.equal((await owner("tag.list")).total, 0);
  await k.close();
});

test("search finds text inside block content", async () => {
  const k = await makeCms();
  const owner = as(k, "owner");
  await owner("post.draft", { title: "Winter care", body: "Snow reflects up to 80% of UV rays." });
  await owner("cms.submit");
  const res = await as(k, "public")("cms.search", { query: "reflects" });
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].field, "body");
  await k.close();
});
