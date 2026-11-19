import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { action, createApp, defineModule, field } from "../src/index.ts";
import { gitSync, i18n, imageSize, media, search, seo } from "../src/modules/index.ts";
import { isPrivateAddress } from "../src/modules/media.ts";
import { addModuleSource, removeModuleSource } from "../src/config-edit.ts";
import { OWNER } from "../src/kernel/policy.ts";
import { makeCms } from "./helpers.ts";

const owner = { actor: OWNER, gate: "internal" as const };
const tmp = () => mkdtempSync(join(tmpdir(), "aicms-test-"));

/** A valid 3×2 PNG, built by hand so the test needs no fixtures. */
function png(w = 3, h = 2): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c >>> 0);
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("module SDK: routes, services, storage, setup, install at runtime", async () => {
  const calls: string[] = [];
  const greeter = defineModule({
    name: "greeter",
    provides: ["greeting"],
    uses: ["post"],
    services: { greeting: { hello: (n: string) => `Hello, ${n}` } },
    async setup(ctx) {
      calls.push(`setup:${ctx.actor.id}`);
      await ctx.kv.set("boots", ((await ctx.kv.get<number>("boots")) ?? 0) + 1);
    },
    routes: {
      "GET /hello/:name": async ({ params, ctx }) => new Response(`${params.name} as ${ctx.actor.id}, boots ${await ctx.kv.get("boots")}`),
    },
    actions: {
      count: action({ description: "Count posts", scope: "greeter:use", readOnly: true, input: {}, run: async ({ ctx }) => (await ctx.list("post")).total }),
    },
  });
  const k = await makeCms({ modules: [greeter] });
  const app = createApp(k, { studio: false });
  assert.deepEqual(calls, ["setup:module:greeter"]);
  assert.equal(k.service<{ hello(n: string): string }>("greeting")!.hello("you"), "Hello, you");
  assert.equal(await (await app.request("/hello/world")).text(), "world as public, boots 1");
  assert.equal((await app.request("/hello")).status, 404);

  // A second module, installed while the server runs: its tool appears and its route answers.
  const late = defineModule({
    name: "late",
    requires: ["greeting"],
    routes: { "GET /late": () => new Response("here") },
    actions: { ping: action({ description: "Ping", input: {}, run: () => "pong" }) },
  });
  await k.installModule(late);
  assert.equal(await (await app.request("/late")).text(), "here");
  assert.ok(k.tools(k.actor("writer")).some((t) => t.tool === "late_ping"));
  await assert.rejects(k.installModule(defineModule({ name: "orphan", requires: ["payments"] })), /requires payments/);
  assert.throws(() => defineModule({ name: "bad", services: { search: {} } }), /doesn't list it in provides/);
  await k.close();
});

test("search: ranked, any language, prefix, used by cms.search", async () => {
  const k = await makeCms({ modules: [search()] });
  await k.call("post.draft", { title: "Winter skincare", body: "Choosing sunscreen when it's cold. Sunscreen matters." }, owner);
  await k.call("post.draft", { title: "Sunscreen basics", body: "SPF explained." }, owner);
  await k.call("post.draft", { title: "Як обрати SPF узимку", body: "Ультрафіолет проходить крізь хмари.", locale: "uk" }, owner);
  await k.call("cms.submit", {}, owner);

  const r: any = await k.call("cms.search", { query: "sunscreen" }, owner);
  assert.equal(r.ranked, true);
  assert.equal(r.hits[0].title, "Sunscreen basics", "a title match outranks body matches");
  assert.equal(r.hits.length, 2);
  const uk: any = await k.call("cms.search", { query: "ультрафіол" }, owner);
  assert.equal(uk.hits[0].title, "Як обрати SPF узимку", "Cyrillic and prefix matching");
  assert.match(uk.hits[0].snippet, /Ультрафіолет/);
  const both: any = await k.call("cms.search", { query: "winter sunscreen" }, owner);
  assert.equal(both.hits[0].title, "Winter skincare", "documents with every word come first");

  // The index follows edits and deletions.
  const id = r.hits[0].id;
  await k.call("post.delete", { id }, owner);
  await k.call("cms.submit", {}, owner);
  assert.equal(((await k.call("cms.search", { query: "basics" }, owner)) as any).hits.length, 0);
  assert.deepEqual(await k.call("search.reindex", {}, owner), { indexed: 2 });
  await k.close();
});

test("seo: audit with fixes, report, sitemap of public models only", async () => {
  const k = await makeCms({ modules: [seo({ siteUrl: "https://example.com" })] });
  const app = createApp(k, { studio: false });
  const d: any = await k.call("post.draft", { title: "A title that is clearly much longer than sixty characters, sadly", body: "# Big\n\nShort.\n\n![](https://x.dev/a.png)" }, owner);
  const audit: any = await k.call("seo.audit", { model: "post", id: d.id }, owner);
  const messages = audit.issues.map((i: any) => i.message).join(" | ");
  assert.match(messages, /Title is 64 characters/);
  assert.match(messages, /meta description/);
  assert.match(messages, /1 image\(s\) without alt text/);
  assert.match(messages, /already the page's h1/);
  assert.ok(audit.score < 50);

  await k.call("post.draft", { id: d.id, title: "Choosing SPF for winter", seo: { description: "How to pick a sunscreen for cold, bright days: SPF level, filters and texture." }, body: "## Why\n\n" + "word ".repeat(320) + "\n\n![Snow](https://x.dev/a.png) See [the guide](/guides/spf)." }, owner);
  const better: any = await k.call("seo.audit", { model: "post", id: d.id }, owner);
  assert.ok(better.score >= 90, `score ${better.score}: ${JSON.stringify(better.issues)}`);
  await k.call("post.draft", { title: "Choosing SPF for winter", slug: "spf-2" }, owner);
  await k.call("cms.submit", {}, owner);
  const report: any = await k.call("seo.report", { model: "post" }, owner);
  assert.equal(report.duplicateTitles[0].ids.length, 2);

  await k.call("tag.draft", { name: "Guides" }, owner);
  await k.call("cms.submit", {}, owner);
  const sitemap = await (await app.request("/sitemap.xml")).text();
  // The slug was filled from the first title and stays when the title changes, so links don't break.
  assert.match(sitemap, /<loc>https:\/\/example.com\/post\/a-title-that-is-clearly-much-longer-than-sixty-characters-sadly<\/loc><lastmod>\d{4}-\d\d-\d\d<\/lastmod>/);
  assert.match(sitemap, /<loc>https:\/\/example.com\/post\/spf-2<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/example.com\/tag\/guides<\/loc>/);
  assert.match(await (await app.request("/robots.txt")).text(), /Sitemap: https:\/\/example.com\/sitemap.xml/);
  assert.equal(k.tools(k.actor("writer")).some((t) => t.tool === "seo_audit"), false, "seo tools need the seo:audit scope");
  await k.close();
});

test("media: uploads, sizes, safe serving, alt text, SSRF guard", async () => {
  const dir = tmp();
  const k = await makeCms({ modules: [media()], agents: { illustrator: { scopes: ["media:upload", "media:read", "media:update"] }, reader: { scopes: ["media:read"] } } }, { dataDir: dir });
  const app = createApp(k, { studio: false });
  assert.deepEqual(imageSize(png(3, 2)), { width: 3, height: 2 });

  const illustrator = { actor: k.actor("illustrator"), gate: "mcp" as const };
  const up: any = await k.call("media.upload", { data: png(3, 2).toString("base64"), filename: "Зимовий кадр.PNG" }, illustrator);
  assert.equal(up.mime, "image/png");
  assert.deepEqual([up.width, up.height], [3, 2]);
  assert.match(up.url, /^\/media\/med_\w+\/zymovyi-kadr\.png$/);
  const served = await app.request(up.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.match(served.headers.get("cache-control")!, /immutable/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png(3, 2));

  // Raw-body upload over HTTP needs the scope; an SVG is served inert.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const readerToken = await k.createToken("reader");
  const denied = await app.request("/media/upload", { method: "POST", headers: { authorization: `Bearer ${readerToken}`, "x-filename": "x.svg" }, body: svg });
  assert.equal(denied.status, 403);
  const token = await k.createToken("illustrator");
  const posted = await app.request("/media/upload", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-filename": "logo.svg", "x-alt": encodeURIComponent("Логотип") }, body: svg });
  assert.equal(posted.status, 201);
  const svgRow: any = await posted.json();
  assert.equal(svgRow.alt, "Логотип");
  assert.match((await app.request(svgRow.url)).headers.get("content-security-policy")!, /sandbox/);
  assert.equal((await app.request("/media/upload", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "just text" })).status, 422);

  const missing: any = await k.call("media.list", { missingAlt: true }, illustrator);
  assert.deepEqual(missing.items.map((m: any) => m.id), [up.id]);
  await k.call("media.update", { id: up.id, alt: "Snow on pine trees" }, illustrator);
  assert.equal(((await k.call("media.list", { missingAlt: true }, illustrator)) as any).total, 0);

  await assert.rejects(k.call("media.upload", { url: "http://127.0.0.1:9/secret.png" }, illustrator), /private network/);
  await assert.rejects(k.call("media.upload", { url: "http://169.254.169.254/latest" }, illustrator), /private network/);
  assert.ok(isPrivateAddress("10.1.2.3") && isPrivateAddress("::1") && isPrivateAddress("::ffff:192.168.0.1") && !isPrivateAddress("93.184.216.34"));
  await assert.rejects(k.call("media.delete", { id: up.id }, illustrator), /may not call/);
  await k.call("media.delete", { id: up.id }, owner);
  assert.equal((await app.request(up.url)).status, 404);
  await k.close();
});

test("i18n: translate, find what's missing, unlink on delete", async () => {
  const k = await makeCms({ modules: [i18n()], agents: { translator: { scopes: ["post:read", "i18n:translate"], review: "human" } } });
  const en: any = await k.call("post.draft", { title: "Winter SPF", body: "Use SPF 30." }, owner);
  await k.call("post.draft", { title: "Untranslated" }, owner);
  await k.call("cms.submit", {}, owner);

  const missing: any = await k.call("i18n.missing", { model: "post" }, owner);
  assert.equal(missing.missing.uk.count, 2);

  const translator = { actor: k.actor("translator"), gate: "mcp" as const };
  const t: any = await k.call("i18n.translate", { id: en.id, locale: "uk", fields: { title: "SPF узимку", body: "Використовуйте SPF 30." } }, translator);
  assert.equal(t.translationOf, en.id);
  const before: any = await k.call("i18n.translations", { id: en.id }, translator);
  assert.equal(before.translations.uk.published, false);
  const ownerView: any = await k.call("i18n.translations", { id: en.id }, owner);
  assert.equal(ownerView.translations.uk.waiting.actor, "translator", "others see the draft as waiting, not missing");
  await assert.rejects(k.call("i18n.translate", { id: en.id, locale: "uk" }, owner), /already drafted by translator/);
  const sub: any = await k.call("cms.submit", {}, translator);
  assert.equal(sub.status, "submitted", "translations are reviewed like any draft");
  await k.call("cms.merge", { id: sub.changeset }, owner);

  const after: any = await k.call("i18n.translations", { id: en.id }, owner);
  assert.deepEqual(after.missing, []);
  assert.equal(after.translations.uk.title, "SPF узимку");
  const ukPost: any = await k.call("post.get", { id: t.id, format: "markdown" }, owner);
  assert.equal(ukPost.locale, "uk");
  assert.equal(ukPost.body, "Використовуйте SPF 30.");
  assert.equal(((await k.call("i18n.missing", { model: "post" }, owner)) as any).missing.uk.count, 1);
  await assert.rejects(k.call("i18n.translate", { id: en.id, locale: "uk" }, translator), /already has a uk translation/);

  await k.call("post.delete", { id: t.id }, owner);
  await k.call("cms.submit", {}, owner);
  assert.deepEqual(((await k.call("i18n.translations", { id: en.id }, owner)) as any).missing, ["uk"]);
  await k.close();
});

test("git-sync: files mirror merges; file edits come back as a reviewed changeset", async () => {
  const dir = tmp();
  const k = await makeCms({ modules: [gitSync({ dir: "content" })], agents: { git: { scopes: ["git-sync:run"], review: "human" } } }, { cwd: dir });
  const d: any = await k.call("post.draft", { title: "Hello files", body: "## One\n\nFirst." }, owner);
  await k.call("cms.submit", {}, owner);
  const file = join(dir, "content/post/hello-files.md");
  assert.ok(existsSync(file));
  const text = readFileSync(file, "utf8");
  assert.match(text, new RegExp(`^---\\nid: ${d.id}\\ntitle: Hello files\\nslug: hello-files\\n---\\n\\n## One\\n\\nFirst.\\n$`));

  writeFileSync(file, text.replace("First.", "First, edited in git."));
  writeFileSync(join(dir, "content/post/new.md"), "---\ntitle: From a file\n---\n\nNew body.\n");
  const git = { actor: k.actor("git"), gate: "cli" as const };
  const dry: any = await k.call("git-sync.import", { dryRun: true }, git);
  assert.deepEqual([dry.created.length, dry.updated.length], [1, 1]);
  const imported: any = await k.call("git-sync.import", {}, git);
  assert.equal(imported.updated[0], "content/post/hello-files.md");
  const sub: any = await k.call("cms.submit", {}, git);
  assert.equal(sub.status, "submitted");
  await k.call("cms.merge", { id: sub.changeset }, owner);
  assert.equal(((await k.call("post.get", { id: d.id, format: "markdown" }, owner)) as any).body, "## One\n\nFirst, edited in git.");
  assert.match(readFileSync(join(dir, "content/post/new.md"), "utf8"), /^---\nid: pos_/, "the new entry's id is written into its file");
  assert.deepEqual(readdirSync(join(dir, "content/post")).sort(), ["hello-files.md", "new.md"], "no duplicate files after the merge");
  const again: any = await k.call("git-sync.import", {}, git);
  assert.equal(again.unchanged, 2);
  await k.close();
});

test("module proposals: an agent asks, a person installs from the Inbox", async () => {
  const dir = tmp();
  const config = join(dir, "aicms.config.ts");
  writeFileSync(config, 'import { defineConfig } from "aicms"\n\nexport default defineConfig({\n  name: "Test",\n})\n');
  const k = await makeCms({}, { configFile: config, dataDir: dir });
  const writer = { actor: k.actor("writer"), gate: "mcp" as const };
  const list: any = await k.call("cms.modules", {}, writer);
  assert.equal(list.youCan, "propose");
  assert.ok(list.available.some((m: any) => m.name === "seo" && m.scopes.includes("seo:audit")));

  const p: any = await k.call("cms.propose_module", { module: "seo", reason: "So I can check posts before submitting them" }, writer);
  assert.equal(p.status, "submitted");
  await assert.rejects(k.call("cms.propose_module", { module: "seo", reason: "Asking twice, which shouldn't work" }, writer), /already waiting/);
  const review: any = await k.call("cms.review", { id: p.changeset }, owner);
  assert.equal(review.items[0].op, "install");
  assert.deepEqual(review.items[0].module.routes, ["GET /sitemap.xml", "GET /robots.txt"]);

  await assert.rejects(k.call("cms.merge", { id: p.changeset }, { actor: k.actor("editor"), gate: "mcp" }), /modules:install/);
  const merged: any = await k.call("cms.merge", { id: p.changeset }, owner);
  assert.deepEqual(merged.modules, ["seo"]);
  assert.ok(k.modules.some((m) => m.name === "seo"));
  assert.match(readFileSync(config, "utf8"), /import \{ seo \} from "aicms\/modules"[\s\S]*modules: \[seo\(\)\]/);
  assert.ok(k.actions.has("seo.audit"));

  const second: any = await k.call("cms.propose_module", { module: "search", reason: "Searching posts by keyword is slow" }, writer);
  const rejected: any = await k.call("cms.reject", { id: second.changeset, comment: "Not now" }, owner);
  assert.equal(rejected.status, "rejected", "a declined proposal closes instead of reopening");
  await assert.rejects(k.call("cms.install_module", { module: "search" }, writer), /may not call/);
  await k.call("cms.install_module", { module: "search" }, owner);
  assert.match(readFileSync(config, "utf8"), /modules: \[seo\(\), search\(\)\]/);
  await k.close();
});

test("GraphQL: typed queries, refs resolved, same permissions", async () => {
  const k = await makeCms();
  const app = createApp(k, { studio: false });
  const t: any = await k.call("tag.draft", { name: "Guides" }, owner);
  await k.call("post.draft", { title: "Graph me", body: "Hello **there**", tags: [t.id], seo: { title: "SEO title" } }, owner);
  await k.call("cms.submit", {}, owner);
  const gql = (query: string, token?: string, variables?: object) =>
    app.request("/graphql", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });

  const res: any = await (await gql(`{ posts(order: "-title") { total items { title slug body(markdown: true) tags { name } seo { title } } } }`)).json();
  assert.deepEqual(res.data.posts, { total: 1, items: [{ title: "Graph me", slug: "graph-me", body: "Hello **there**", tags: [{ name: "Guides" }], seo: { title: "SEO title" } }] });
  const one: any = await (await gql(`query ($s: String) { post(slug: $s) { id title } }`, undefined, { s: "graph-me" })).json();
  assert.equal(one.data.post.title, "Graph me");

  const anon: any = await (await gql(`mutation { draftPost(data: { title: "nope" }) }`)).json();
  assert.equal(anon.errors[0].extensions.code, "unauthorized");
  const writer = await k.createToken("writer");
  const ok: any = await (await gql(`mutation { draftPost(data: { title: "Via GraphQL", body: "# Hi" }) }`, writer)).json();
  assert.equal(ok.data.draftPost.op, "create");
  const bad: any = await (await gql(`mutation { draftPost(data: { title: 42 }) }`, writer)).json();
  assert.equal(bad.errors[0].extensions.code, "invalid");

  assert.equal((await app.request(`/graphql?query=${encodeURIComponent("mutation { submit }")}`)).status, 405);
  const deep = "{ posts { items { tags { " + "name ".repeat(1) + "} } } }";
  assert.equal((await gql(deep)).status, 200);
  const tooDeep = "{ " + "a { ".repeat(11) + "b" + " }".repeat(12);
  assert.equal((await gql(tooDeep)).status, 400);
  const log: any = await k.call("cms.log", { actor: "writer", limit: 1 }, owner);
  assert.equal(log.events[0].gate, "graphql");
  await k.close();
});

test("config editing: add and remove modules without touching anything else", () => {
  const src = `import { defineConfig } from "aicms"\nimport blog from "./modules/blog.ts"\n\nexport default defineConfig({\n  name: "x [y]", // modules: [nope]\n  agents: { seo: { scopes: ["seo:audit"] } },\n  modules: [\n    blog,\n  ],\n})\n`;
  const added = addModuleSource(src, { name: "seo", from: "aicms/modules", isDefault: false, call: 'seo({ siteUrl: "https://a.b" })' });
  assert.match(added, /import \{ seo \} from "aicms\/modules"/);
  assert.match(added, /modules: \[\n    blog,\n    seo\(\{ siteUrl: "https:\/\/a.b" \}\),\n  \]/);
  assert.equal(removeModuleSource(added, "seo"), src, "removing restores the file exactly, even with an agent named seo");
  assert.throws(() => addModuleSource(added, { name: "seo", from: "aicms/modules", isDefault: false, call: "seo()" }), /already in modules/);
  const bare = addModuleSource(`export default defineConfig({\n  name: "a",\n})\n`, { name: "search", from: "aicms/modules", isDefault: false, call: "search()" });
  assert.match(bare, /^import \{ search \} from "aicms\/modules"\nexport default defineConfig\(\{\n  modules: \[search\(\)\],\n  name: "a",/);
  assert.throws(() => addModuleSource("export default {}", { name: "x", from: "y", isDefault: true, call: "x" }), /defineConfig/);
});
