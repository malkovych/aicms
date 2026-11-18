import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { blocksToHtml, createClient, parseInline, type FeedEvent } from "../packages/client/src/index.ts";
import { aicmsLoader } from "../packages/astro/src/index.ts";
import { Blocks, createAicms, createRevalidateHandler, tagsFor } from "../packages/next/src/index.ts";
import { createApp } from "../src/index.ts";
import { makeCms } from "./helpers.ts";
import { createHmac } from "node:crypto";

const inProcess = (app: ReturnType<typeof createApp>) => ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;

test("inline Markdown: nesting, links, escaping", () => {
  assert.deepEqual(parseInline("**bold [link](/x)** and `code`"), [
    { t: "strong", c: [{ t: "text", v: "bold " }, { t: "link", href: "/x", c: [{ t: "text", v: "link" }] }] },
    { t: "text", v: " and " },
    { t: "code", v: "code" },
  ]);
  const html = blocksToHtml([
    { type: "paragraph", text: "Hi <script>alert(1)</script> **you**\nnext" },
    { type: "paragraph", text: "[bad](javascript:alert) [good](https://a.b)" },
    { type: "image", url: "javascript:alert(1)", alt: "x" },
    { type: "heading", level: 9, text: "Big" },
    { type: "list", ordered: true, items: ["*one*", "two"] },
    { type: "code", lang: "ts\" onload=\"x", code: "<b>" },
    { type: "cta", href: "/sale", label: "Shop <now>", tone: "warm" },
  ]);
  assert.match(html, /<p>Hi &lt;script&gt;alert\(1\)&lt;\/script&gt; <strong>you<\/strong><br>next<\/p>/);
  assert.match(html, /<p>bad <a href="https:\/\/a.b">good<\/a><\/p>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<h6>Big<\/h6>/);
  assert.match(html, /<ol><li><em>one<\/em><\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<pre><code>&lt;b&gt;<\/code><\/pre>/);
  assert.match(html, /<aside data-block="cta" data-tone="warm"><a href="\/sale">Shop &lt;now&gt;<\/a><\/aside>/);
});

test("client: typed calls, GET for reads, errors, events", async () => {
  const k = await makeCms();
  const app = createApp(k, { studio: false });
  const methods: string[] = [];
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(`${init?.method ?? "GET"} ${String(input).replace(/\?.*/, "")}`);
    return app.request(String(input), init);
  }) as typeof globalThis.fetch;
  type Schema = { post: { title: string; slug?: string; body?: { type: string }[] }; tag: { name: string } };
  const writer = createClient<Schema>({ url: "http://localhost", token: await k.createToken("writer"), fetch });
  const owner = createClient<Schema>({ url: "http://localhost", token: await k.createToken("owner"), fetch });

  const d = await writer.post.draft({ title: "From the SDK", body: "Hello **there**" });
  assert.equal(d.op, "create");
  const sub = await writer.submit("SDK test");
  assert.equal(sub.status, "submitted");
  await owner.merge(sub.changeset);
  const got = await writer.post.get({ slug: "from-the-sdk" });
  assert.equal(got.title, "From the SDK");
  assert.equal(got.body?.[0].type, "paragraph");
  const listed = await createClient<Schema>({ url: "http://localhost", fetch }).post.list({ fields: ["title"] });
  assert.equal(listed.items[0].title, "From the SDK");
  assert.ok(methods.includes("GET http://localhost/api/v1/actions/post.get"));
  assert.ok(methods.includes("POST http://localhost/api/v1/actions/post.draft"));

  await assert.rejects(writer.post.draft({ title: 42 as unknown as string }), (e: any) => e.code === "invalid" && e.status === 422);
  await assert.rejects(createClient({ url: "http://localhost", fetch }).submit(), (e: any) => e.code === "unauthorized");

  const ac = new AbortController();
  const seen: FeedEvent[] = [];
  const listening = (async () => {
    for await (const e of owner.events({ signal: ac.signal })) {
      seen.push(e);
      if (e.event === "changeset.merged") ac.abort();
    }
  })();
  await new Promise((r) => setTimeout(r, 30));
  await owner.tag.draft({ name: "Live" });
  await owner.submit();
  await listening;
  assert.ok(seen.some((e) => e.event === "changeset.merged" && e.payload.entries[0].model === "tag"));
  await k.close();
});

test("next: cache tags, revalidation webhook, <Blocks />", async () => {
  const k = await makeCms();
  const app = createApp(k, { studio: false });
  const inits: RequestInit[] = [];
  const cms = createAicms({ url: "http://localhost", fetch: ((input: RequestInfo | URL, init?: RequestInit) => (inits.push(init!), app.request(String(input), init))) as typeof fetch });
  await cms.post.list();
  assert.deepEqual((inits[0] as any).next, { tags: ["aicms", "aicms:post"] });
  assert.equal(inits[0].cache, "force-cache");
  assert.deepEqual(tagsFor("cms.describe"), ["aicms"]);

  const revalidated: string[] = [];
  const handler = createRevalidateHandler({ secret: "s3cret", revalidateTag: (tag) => void revalidated.push(tag) });
  const body = JSON.stringify({ event: "changeset.merged", payload: { entries: [{ model: "post", id: "p1" }, { model: "tag", id: "t1" }, { model: "post", id: "p2" }] } });
  const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal((await handler(new Request("http://x", { method: "POST", body, headers: { "x-aicms-signature": "sha256=bad" } }))).status, 401);
  const ok = await handler(new Request("http://x", { method: "POST", body, headers: { "x-aicms-signature": sig } }));
  assert.deepEqual((await ok.json()).revalidated, ["aicms:post", "aicms:tag"]);
  assert.deepEqual(revalidated, ["aicms:post", "aicms:tag"]);

  const html = renderToStaticMarkup(
    createElement(Blocks, {
      value: [{ type: "heading", level: 2, text: "Hi **there**" }, { type: "cta", href: "/go", label: "Go" }, { type: "image", url: "javascript:x" }],
      components: { cta: ({ block }) => createElement("a", { className: "button", href: String(block.href) }, String(block.label)) },
    }),
  );
  assert.equal(html, '<h2>Hi <strong>there</strong></h2><a class="button" href="/go">Go</a>');
  await k.close();
});

test("astro: Content Layer loader with rendered blocks", async () => {
  const k = await makeCms();
  const app = createApp(k, { studio: false });
  const owner = createClient({ url: "http://localhost", token: await k.createToken("owner"), fetch: inProcess(app) });
  for (let i = 0; i < 3; i++) await owner.post.draft({ title: `Post ${i}`, body: `## Part ${i}\n\nText` });
  await owner.submit();

  const stored = new Map<string, any>();
  const logs: string[] = [];
  await aicmsLoader({ url: "http://localhost", model: "post", render: "body", fetch: inProcess(app) }).load({
    store: { clear: () => stored.clear(), set: (e) => (stored.set(e.id, e), true) },
    parseData: async ({ data }) => data,
    generateDigest: (d) => JSON.stringify(d).length.toString(16),
    logger: { info: (m) => void logs.push(m) },
  });
  assert.equal(stored.size, 3);
  const first = [...stored.values()].find((e) => e.data.title === "Post 0");
  assert.equal(first.rendered.html, "<h2>Part 0</h2>\n<p>Text</p>");
  assert.match(logs[0], /Loaded 3 post entries/);
  await k.close();
});
