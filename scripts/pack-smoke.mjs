#!/usr/bin/env node
// Packs aicms, @aicms/client and create-aicms as npm would publish them,
// scaffolds a site from the tarballs in an empty folder, and drives it:
// init files, an agent drafting over REST and MCP (stdio), Studio, types,
// and the typed client. Catches packaging mistakes the unit tests can't.
//
//   npm run build && npm run test:package [-- --keep]

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const repo = resolve(import.meta.dirname, "..");
const keep = process.argv.includes("--keep");
const work = mkdtempSync(join(process.env.AICMS_SMOKE_DIR ?? tmpdir(), "aicms-pack-"));
const step = (s) => console.log(`\n▸ ${s}`);
const sh = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function pack(dir) {
  const [info] = JSON.parse(sh("npm", ["pack", "--json", "--pack-destination", work], dir));
  return { file: join(work, info.filename), files: info.files.map((f) => f.path), size: info.size, unpacked: info.unpackedSize };
}

const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

let server;
try {
  step("npm pack");
  if (!existsSync(join(repo, "dist", "cli.js")) || !existsSync(join(repo, "dist", "studio", "index.html"))) throw new Error("Run npm run build first");
  const core = pack(repo);
  const client = pack(join(repo, "packages", "client"));
  const create = pack(join(repo, "packages", "create-aicms"));
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  console.log(`  aicms          ${kb(core.size)} (${kb(core.unpacked)} unpacked, ${core.files.length} files)`);
  console.log(`  @aicms/client  ${kb(client.size)}`);
  console.log(`  create-aicms   ${kb(create.size)}`);
  for (const f of ["dist/cli.js", "dist/index.js", "dist/index.d.ts", "dist/edge.js", "dist/modules/index.js", "dist/studio/index.html", "README.md", "LICENSE"]) {
    assert.ok(core.files.includes(f), `aicms tarball is missing ${f}`);
  }
  assert.ok(!core.files.some((f) => f.startsWith("src/") || f.startsWith("test/") || f.startsWith("node_modules/") || f.endsWith(".tsbuildinfo")), "aicms tarball carries sources, tests or build info");
  assert.deepEqual(create.files.sort(), ["index.js", "package.json"]);

  step("npm create aicms (from the create-aicms tarball)");
  sh("tar", ["-xzf", create.file, "-C", work]);
  sh(process.execPath, [join(work, "package", "index.js"), "site", "--pm", "npm"], work, { AICMS_PACKAGE: `file:${core.file}`, npm_config_audit: "false", npm_config_fund: "false" });
  const site = join(work, "site");
  for (const f of ["package.json", "aicms.config.ts", "models/post.ts", "models/tag.ts", ".mcp.json", "AGENTS.md", ".gitignore"]) assert.ok(existsSync(join(site, f)), `site is missing ${f}`);
  const mcpJson = JSON.parse(readFileSync(join(site, ".mcp.json"), "utf8"));
  assert.deepEqual(mcpJson.mcpServers.aicms.args, ["aicms", "mcp", "--agent", "writer"]);
  sh("npm", ["install", "--no-audit", "--no-fund", client.file], site);

  const cli = (...args) => sh(process.execPath, [join(site, "node_modules", "aicms", "dist", "cli.js"), ...args], site);
  step("aicms --version, describe, types");
  assert.match(cli("--version"), /^\d+\.\d+\.\d+/);
  assert.ok(JSON.parse(cli("describe")).models.some((m) => m.name === "post"));
  cli("types", "--out", "aicms-types.ts");
  assert.match(readFileSync(join(site, "aicms-types.ts"), "utf8"), /interface Post\b/);

  step("aicms dev");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(site, "node_modules", "aicms", "dist", "cli.js"), "dev", "--port", String(port)], { cwd: site, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; ; i++) {
    if (i > 100) throw new Error(`dev server didn't start:\n${log}`);
    if (await fetch(`${base}/llms.txt`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = log.match(/\/studio\/login\?code=[\w-]+/)?.[0];
  assert.ok(login, `dev printed no Studio sign-in link:\n${log}`);

  step("Studio, discovery, agent card");
  const studio = await fetch(`${base}/studio/`, { redirect: "manual" });
  assert.equal(studio.status, 200);
  const html = await studio.text();
  const asset = html.match(/\/studio\/assets\/[\w.-]+\.js/)?.[0];
  assert.ok(asset, "Studio index has no script");
  assert.equal((await fetch(base + asset)).status, 200);
  assert.equal((await fetch(`${base}/.well-known/agent-card.json`)).status, 200);
  const signIn = await fetch(base + login, { redirect: "manual" });
  assert.equal(signIn.status, 302);
  assert.match(signIn.headers.get("set-cookie") ?? "", /aicms_session=/);

  step("an agent drafts and submits over REST, with the typed client");
  const token = cli("agent", "create", "writer").match(/aicms_[\w-]+/)?.[0];
  assert.ok(token, "agent create printed no token");
  writeFileSync(
    join(site, "client-check.mjs"),
    `import { createClient } from "@aicms/client";
const cms = createClient({ url: ${JSON.stringify(base)}, token: ${JSON.stringify(token)} });
const draft = await cms.call("post.draft", { title: "Hello from a tarball", body: "Installed from npm pack." });
const sent = await cms.call("cms.submit", { note: "smoke test" });
console.log(JSON.stringify({ id: draft.id, status: sent.status }));`,
  );
  const result = JSON.parse(sh(process.execPath, ["client-check.mjs"], site));
  assert.equal(result.status, "submitted");
  assert.match(cli("changes"), /submitted/);

  step("MCP over stdio, as .mcp.json starts it");
  const mcp = spawn("npx", ["aicms", "mcp", "--agent", "writer"], { cwd: site, stdio: ["pipe", "pipe", "inherit"] });
  const reply = new Promise((ok, no) => {
    let buf = "";
    mcp.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) ok(msg);
        } catch {}
      }
    });
    setTimeout(() => no(new Error(`no MCP reply: ${buf}`)), 15000);
  });
  const send = (m) => mcp.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (await reply).result.tools.map((t) => t.name);
  mcp.kill();
  assert.ok(tools.includes("cms_describe") && tools.includes("post_draft"), `unexpected tools: ${tools.join(", ")}`);

  console.log(`\n✓ The packages work when installed from npm.${keep ? ` Kept ${work}` : ""}`);
} finally {
  server?.kill();
  if (!keep) rmSync(work, { recursive: true, force: true });
}
