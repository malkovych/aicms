import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksToMarkdown, markdownToBlocks, slugify } from "../src/index.ts";
import { draftSchema, storedSchema, toJsonSchema } from "../src/schema/model.ts";
import { post } from "./helpers.ts";

test("slugs follow the official Ukrainian transliteration", () => {
  assert.equal(slugify("Як обрати SPF на зиму"), "yak-obraty-spf-na-zymu");
  assert.equal(slugify("Згода, Їжак і Юрій"), "zghoda-yizhak-i-yurii");
  assert.equal(slugify("Café déjà vu — 2026!"), "cafe-deja-vu-2026");
});

test("markdown → blocks → markdown keeps every block", () => {
  const md = [
    "## How to choose SPF for winter",
    "Snow reflects up to 80% of UV rays.",
    "",
    "![Snow](/snow.jpg)",
    "",
    "1. Pick SPF 30+",
    "2. Reapply",
    "",
    "> Sunscreen is skincare.",
    "",
    ':::cta{href="/spf" label="Pick a cream"}',
    "",
    ':::callout{tone="warning"}',
    "Patch-test first.",
    ":::",
  ].join("\n");
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "paragraph", "image", "list", "quote", "cta", "callout"],
  );
  assert.deepEqual(blocks[3], { type: "list", ordered: true, items: ["Pick SPF 30+", "Reapply"] });
  assert.deepEqual(blocks[5], { type: "cta", href: "/spf", label: "Pick a cream" });
  assert.deepEqual(markdownToBlocks(blocksToMarkdown(blocks)), blocks);
});

test("stored schema reports problems by field", () => {
  const r = storedSchema(post).safeParse({ slug: "Not A Slug", body: [{ type: "video" }] });
  assert.equal(r.success, false);
  const fields = r.error!.issues.map((i) => i.path.join("."));
  assert.deepEqual(fields.sort(), ["body.0.type", "slug", "title"]);
});

test("a field-level draft tool only advertises the writable fields", () => {
  const json = toJsonSchema(draftSchema(post, ["seo"], true)) as any;
  assert.deepEqual(Object.keys(json.properties).sort(), ["id", "locale", "seo"]);
  assert.deepEqual(json.required, ["id"]);
  assert.equal(json.additionalProperties, false);
});
