import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { makeCms } from "./helpers.ts";

const json = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });

test("REST: drafts, review and public reads", async () => {
  const k = await makeCms();
  const app = createApp(k);
  const writer = await k.createToken("writer");
  const owner = await k.createToken("owner");

  const created = await app.request("/api/v1/post", json({ title: "Hello REST", body: "Hi there" }, writer));
  assert.equal(created.status, 201);
  const draft = await created.json();
  assert.equal(draft.entry.slug, "hello-rest");

  const submit = await (await app.request("/api/v1/changesets/submit", json({}, writer))).json();
  assert.equal(submit.status, "submitted");

  const merge = await app.request(`/api/v1/changesets/${submit.changeset}/merge`, json({}, owner));
  assert.equal(merge.status, 200);

  const list = await (await app.request("/api/v1/post?slug=hello-rest&fields=title,body")).json();
  assert.equal(list.total, 1);
  assert.deepEqual(Object.keys(list.items[0]).filter((key) => !["id", "locale", "version", "updatedAt"].includes(key)).sort(), ["body", "title"]);
  assert.equal(list.items[0].body[0].type, "paragraph");

  const denied = await app.request("/api/v1/post", json({ title: "nope" }));
  assert.equal(denied.status, 401);
  const bad = await app.request("/api/v1/post", { headers: { authorization: "Bearer aicms_wrong" } });
  assert.equal(bad.status, 401);
  const invalid = await app.request("/api/v1/post", json({ title: 42 }, writer));
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error.details.issues[0].field, "title");
  await k.close();
});

test("discovery: llms.txt, manifest and OpenAPI", async () => {
  const k = await makeCms();
  const app = createApp(k);
  const llms = await (await app.request("/llms.txt")).text();
  assert.match(llms, /# Test site/);
  assert.match(llms, /### post — Posts/);
  assert.match(llms, /Guide: Short sentences\./);

  const manifest = await (await app.request("/.well-known/aicms.json")).json();
  assert.equal(manifest.endpoints.mcp, "http://localhost/mcp");

  const writer = await k.createToken("writer");
  const spec = await (await app.request("/openapi.json", { headers: { authorization: `Bearer ${writer}` } })).json();
  const ops = Object.values(spec.paths).map((p: any) => p.post.operationId);
  assert.ok(ops.includes("post_draft"));
  assert.ok(ops.includes("cms_submit"));
  assert.ok(!ops.includes("cms_merge"), "writers are not reviewers");
  await k.close();
});

test("webhooks fire on merge with an HMAC signature", async () => {
  const { createServer } = await import("node:http");
  const { createHmac } = await import("node:crypto");
  const received: { headers: Record<string, unknown>; body: string }[] = [];
  let resolveHit!: () => void;
  const hit = new Promise<void>((r) => (resolveHit = r));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      received.push({ headers: req.headers, body });
      res.end("ok");
      resolveHit();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const k = await makeCms({ webhooks: [{ url: `http://127.0.0.1:${port}/hook`, events: ["changeset.merged"], secret: "s3cret" }] });
  await k.call("tag.draft", { name: "Hooked" }, { actor: k.actor("owner"), gate: "cli" });
  await k.call("cms.submit", {}, { actor: k.actor("owner"), gate: "cli" });
  await hit;
  server.close();

  const [{ headers, body }] = received;
  assert.equal(headers["x-aicms-event"], "changeset.merged");
  assert.equal(headers["x-aicms-signature"], `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`);
  assert.equal(JSON.parse(body).payload.entries[0].model, "tag");
  await k.close();
});

test("MCP over Streamable HTTP: initialize, list tools, draft", async () => {
  const k = await makeCms();
  const app = createApp(k);
  const token = await k.createToken("writer");

  const init = await app.request(
    "/mcp",
    json(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }), token),
  );
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, "aicms");
  assert.match(initBody.result.instructions, /cms_describe/);

  const list = await (await app.request("/mcp", json(rpc(2, "tools/list"), token))).json();
  const names = list.result.tools.map((t: any) => t.name);
  for (const expected of ["cms_describe", "cms_search", "cms_submit", "cms_changes", "post_list", "post_get", "post_draft", "tag_draft"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  assert.ok(!names.includes("cms_merge"));
  assert.ok(names.every((n: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)), "tool names must be valid for LLM APIs");

  const call = await (
    await app.request("/mcp", json(rpc(3, "tools/call", { name: "post_draft", arguments: { title: "From MCP", body: "## Hi\nText" } }), token))
  ).json();
  const result = JSON.parse(call.result.content[0].text);
  assert.equal(result.entry.slug, "from-mcp");
  assert.equal(result.entry.body, "## Hi\n\nText");

  const err = await (await app.request("/mcp", json(rpc(4, "tools/call", { name: "post_draft", arguments: { title: 7 } }), token))).json();
  assert.equal(err.result.isError, true);
  assert.match(err.result.content[0].text, /"code": "invalid"/);
  await k.close();
});
