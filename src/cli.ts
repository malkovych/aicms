#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createCMS, type Kernel } from "./kernel/cms.ts";
import { summarize } from "./kernel/changesets.ts";
import { isAicmsError } from "./kernel/errors.ts";
import { OWNER } from "./kernel/policy.ts";
import { createApp } from "./gates/rest.ts";
import { serveStdio } from "./gates/mcp.ts";
import { VERSION } from "./gates/discovery.ts";
import { loadProject } from "./load.ts";
import { generateTypes } from "./typegen.ts";

const HELP = `aicms ${VERSION} — the CMS for AI agents

Usage: aicms <command> [options]

Project
  init [dir]                    Create aicms.config.ts and example models
  dev | start                   Serve Studio, REST, MCP and events (--port 4321, --host 127.0.0.1)
  login [--url <server>]        A one-time Studio sign-in link (valid 15 minutes)
  describe [model]              What the site contains, as JSON
  types [--out <file>]          TypeScript types for @aicms/client (stdout by default)

Agents
  agent create <name>           Issue a token for an agent from aicms.config (or "owner")
  agent revoke <name>           Revoke its tokens and reject its unmerged changes
  agent list                    Tokens and their agents
  mcp --agent <name>            Serve MCP over stdio for a local agent (or --token <t>)

Review
  changes [--all]               Changesets waiting for review (--all: every recent one)
  show <id>                     Before/after for every field in a changeset
  merge <id>                    Publish a changeset
  reject <id> --comment "..."   Send it back to the agent (--final closes it instead)
  log [--limit 20]              Recent actions from people and agents

Roll back
  history <entry-id>            Versions of an entry: who, when, which fields
  restore <entry-id> <version>  Publish an earlier version of an entry
  revert <changeset-id>         Undo a merged changeset

Options: --config <file>  --json`;

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const blue = paint(34);

function fail(message: string): never {
  console.error(red(`✕ ${message}`));
  process.exit(1);
}

async function open(configPath?: string): Promise<Kernel> {
  const project = await loadProject(process.cwd(), configPath);
  return createCMS(project.config, { cwd: project.root });
}

const asOwner = (k: Kernel, name: string, input: unknown = {}) => k.call(name, input, { actor: OWNER, gate: "cli" });

function printChangeset(cs: any) {
  const status = cs.status === "submitted" ? yellow(cs.status) : cs.status === "merged" ? green(cs.status) : cs.status === "rejected" ? red(cs.status) : blue(cs.status);
  console.log(`${bold(cs.id)}  ${status}  by ${bold(cs.actor)}  ${dim(cs.updatedAt)}`);
  if (cs.note) console.log(`  note: ${cs.note}`);
  if (cs.waitingBecause) console.log(dim(`  waiting: ${cs.waitingBecause}`));
  if (cs.comment) console.log(`  comment: ${cs.comment}`);
  for (const issue of cs.issues ?? []) console.log(red(`  ! ${issue.entry}${issue.field ? `.${issue.field}` : ""}: ${issue.message}`));
  for (const item of cs.items) {
    const fields = item.changes ? item.changes.map((c: any) => c.field) : item.fields ?? [];
    console.log(`  ${item.op.padEnd(6)} ${item.model} ${dim(item.id)}${fields.length ? `  ${dim(fields.join(", "))}` : ""}`);
  }
}

function printDiff(cs: any) {
  printChangeset({ ...cs, items: [] });
  for (const item of cs.items) {
    console.log(`\n${bold(item.op)} ${item.model} ${dim(item.id)}`);
    if (item.op === "delete") console.log(red("  (entry will be deleted)"));
    for (const c of item.changes) {
      const show = (v: unknown) => (v === null || v === undefined ? dim("—") : typeof v === "string" ? v : JSON.stringify(v));
      console.log(`  ${bold(c.field)}`);
      if (item.op !== "create") console.log(red(`  - ${show(c.before).split("\n").join("\n    ")}`));
      console.log(green(`  + ${show(c.after).split("\n").join("\n    ")}`));
    }
  }
}

const CONFIG_TEMPLATE = `import { defineConfig, sqlite } from "aicms"

export default defineConfig({
  name: "My site",
  db: sqlite(".aicms/data.db"),
  locales: ["en"],
  // What requests without a token may do
  public: ["post:read", "tag:read"],
  agents: {
    writer: { scopes: ["post:draft", "tag:draft"], review: "human" },
    seo: { scopes: ["post:update.seo"], review: "auto" },
  },
})
`;

const POST_TEMPLATE = `import { defineModel, field } from "aicms"

export default defineModel({
  name: "post",
  label: "Posts",
  fields: {
    title: field.text({ required: true, max: 120 }),
    slug: field.slug({ from: "title" }),
    excerpt: field.text({ max: 280 }),
    cover: field.media(),
    body: field.blocks(["heading", "paragraph", "image", "list", "quote", "code", "cta"]),
    tags: field.ref("tag", { many: true }),
    seo: field.object({ title: field.text({ max: 60 }), description: field.text({ max: 160 }) }),
    publishedAt: field.date({ indexed: true }),
  },
  agent: {
    guide: "Short sentences, friendly expert tone. One idea per paragraph.",
    can: ["create", "update"],
  },
})
`;

const TAG_TEMPLATE = `import { defineModel, field } from "aicms"

export default defineModel({
  name: "tag",
  label: "Tags",
  fields: {
    name: field.text({ required: true, max: 40 }),
    slug: field.slug({ from: "name" }),
  },
  agent: { can: ["create", "update", "publish"] },
})
`;

function init(dir: string) {
  const root = resolve(process.cwd(), dir);
  if (existsSync(join(root, "aicms.config.ts"))) fail(`${root} already has an aicms.config.ts`);
  mkdirSync(join(root, "models"), { recursive: true });
  writeFileSync(join(root, "aicms.config.ts"), CONFIG_TEMPLATE);
  writeFileSync(join(root, "models", "post.ts"), POST_TEMPLATE);
  writeFileSync(join(root, "models", "tag.ts"), TAG_TEMPLATE);
  const gi = join(root, ".gitignore");
  if (!existsSync(gi) || !readFileSync(gi, "utf8").includes(".aicms")) appendFileSync(gi, "\n.aicms/\n");
  console.log(`${green("✓")} Created ${bold("aicms.config.ts")}, ${bold("models/post.ts")} and ${bold("models/tag.ts")} in ${root}

Next:
  aicms agent create writer   ${dim("# a token for your first agent")}
  aicms dev                   ${dim("# Studio, REST and MCP on http://127.0.0.1:4321")}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      agent: { type: "string" },
      token: { type: "string" },
      comment: { type: "string", short: "m" },
      final: { type: "boolean" },
      config: { type: "string", short: "c" },
      limit: { type: "string" },
      url: { type: "string" },
      out: { type: "string", short: "o" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.version) return console.log(VERSION);
  if (!cmd || values.help || cmd === "help") return console.log(HELP);

  if (cmd === "init") return init(args[0] ?? ".");

  const k = await open(values.config);

  switch (cmd) {
    case "dev":
    case "start": {
      const port = Number(values.port ?? process.env.PORT ?? 4321);
      const hostname = values.host ?? process.env.HOST ?? "127.0.0.1";
      const app = createApp(k);
      const code = await k.createLoginCode();
      serve({ fetch: app.fetch, port, hostname }, (info) => {
        const base = `http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${info.port}`;
        const agents = Object.keys(k.config.agents);
        console.log(`${bold("AICMS")} ${VERSION} · ${k.config.name}
  ${dim("Studio")}   ${bold(`${base}/studio/login?code=${code}`)}  ${dim("(one-time link, 15 min; aicms login makes another)")}
  ${dim("MCP")}      ${base}/mcp
  ${dim("REST")}     ${base}/api/v1
  ${dim("OpenAPI")}  ${base}/openapi.json
  ${dim("events")}   ${base}/api/v1/events
  ${dim("llms.txt")} ${base}/llms.txt
  ${dim("models")}   ${[...k.models.keys()].join(", ") || "none"}
  ${dim("agents")}   ${agents.join(", ") || "none"}  ${dim("(aicms agent create <name> issues a token)")}`);
      });
      const stop = async () => {
        await k.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "mcp": {
      const actor = values.token ? await k.resolveToken(values.token) : values.agent ? k.actor(values.agent) : fail("Pass --agent <name> or --token <token>");
      await serveStdio(k, actor);
      return; // keep running; stdio transport owns the process
    }

    case "login": {
      const base = (values.url ?? `http://127.0.0.1:${process.env.PORT ?? 4321}`).replace(/\/+$/, "");
      const code = await k.createLoginCode();
      console.log(`${green("✓")} Open this link within 15 minutes to sign in to Studio (it works once):\n\n  ${bold(`${base}/studio/login?code=${code}`)}`);
      break;
    }

    case "types": {
      const text = generateTypes([...k.models.values()], k.config.name);
      if (values.out) {
        writeFileSync(resolve(process.cwd(), values.out), text);
        console.log(`${green("✓")} Wrote ${bold(values.out)} ${dim(`(${k.models.size} models)`)}`);
      } else process.stdout.write(text);
      break;
    }

    case "history": {
      if (!args[0]) fail("Usage: aicms history <entry-id>");
      const h: any = await asOwner(k, "cms.history", { id: args[0] });
      if (values.json) console.log(JSON.stringify(h, null, 2));
      else {
        console.log(`${bold(h.id)} ${h.model} ${dim(h.current ? `current v${h.current}` : "deleted")}`);
        for (const v of h.versions) {
          console.log(`  v${String(v.version).padEnd(3)} ${dim(v.at)} ${v.actor.padEnd(12)} ${v.deleted ? red("deleted") : dim(v.changed.join(", ") || "—")}  ${dim(v.changeset ?? "")}`);
        }
      }
      break;
    }

    case "restore": {
      const version = Number(args[1]);
      if (!args[0] || !Number.isInteger(version)) fail("Usage: aicms restore <entry-id> <version>");
      await asOwner(k, "cms.restore", { id: args[0], version });
      const r: any = await asOwner(k, "cms.submit", { note: `Restore ${args[0]} to v${version}` });
      console.log(`${green("✓")} Restored ${bold(args[0])} to v${version}${r.entries ? dim(` (now v${r.entries.find((e: any) => e.id === args[0])?.version})`) : ""}`);
      break;
    }

    case "revert": {
      if (!args[0]) fail("Usage: aicms revert <changeset-id>");
      const d: any = await asOwner(k, "cms.revert", { changeset: args[0] });
      await asOwner(k, "cms.submit", { note: `Revert ${args[0]}` });
      console.log(`${green("✓")} Reverted ${bold(args[0])}`);
      for (const i of d.items) console.log(`  ${i.op.padEnd(6)} ${dim(i.id)}`);
      break;
    }

    case "describe": {
      console.log(JSON.stringify(await asOwner(k, "cms.describe", args[0] ? { model: args[0] } : {}), null, 2));
      break;
    }

    case "agent": {
      const [sub, name] = args;
      if (sub === "list") {
        const tokens = await k.store.listTokens();
        if (values.json) console.log(JSON.stringify(tokens, null, 2));
        else if (!tokens.length) console.log(dim("No tokens yet. aicms agent create <name>"));
        else for (const t of tokens) console.log(`${t.agent.padEnd(14)} ${dim(t.id)}  ${t.revokedAt ? red(`revoked ${t.revokedAt}`) : green("active")}  ${dim(t.createdAt)}`);
        break;
      }
      if (!name) fail(`Usage: aicms agent ${sub ?? "create"} <name>`);
      if (sub === "create") {
        const token = await k.createToken(name);
        const actor = k.actor(name);
        console.log(`${green("✓")} Token for ${bold(name)} ${dim(`(scopes: ${actor.scopes.join(", ")}; review: ${actor.review})`)}\n\n  ${bold(token)}\n\n${dim("Shown once. Connect an MCP client:")}\n  claude mcp add --transport http aicms http://127.0.0.1:4321/mcp --header "Authorization: Bearer ${token}"`);
      } else if (sub === "revoke") {
        const r = await k.revokeAgent(name);
        console.log(`${green("✓")} Revoked ${r.tokens} token(s) of ${bold(name)}; rejected ${r.changesets} unmerged changeset(s)`);
      } else fail(`Unknown: aicms agent ${sub}. Use create, revoke or list.`);
      break;
    }

    case "changes": {
      const res: any = values.all
        ? { changesets: (await k.store.listChangesets({ limit: Number(values.limit ?? 20) })).map(summarize) }
        : await asOwner(k, "cms.review", {});
      if (values.json) console.log(JSON.stringify(res, null, 2));
      else if (!res.changesets.length) console.log(dim(values.all ? "No changesets yet." : "Nothing waiting for review."));
      else res.changesets.forEach((cs: any, i: number) => (i && console.log(), printChangeset(cs)));
      break;
    }

    case "show": {
      if (!args[0]) fail("Usage: aicms show <changeset-id>");
      const cs = await asOwner(k, "cms.review", { id: args[0] });
      values.json ? console.log(JSON.stringify(cs, null, 2)) : printDiff(cs);
      break;
    }

    case "merge": {
      if (!args[0]) fail("Usage: aicms merge <changeset-id>");
      const r: any = await asOwner(k, "cms.merge", { id: args[0] });
      console.log(`${green("✓")} Merged ${bold(r.changeset)} from ${r.actor}`);
      for (const e of r.entries) console.log(`  ${e.op.padEnd(6)} ${e.model} ${dim(e.id)} v${e.version}`);
      break;
    }

    case "reject": {
      if (!args[0] || !values.comment) fail('Usage: aicms reject <changeset-id> --comment "what to change"');
      const r: any = await asOwner(k, "cms.reject", { id: args[0], comment: values.comment, final: !!values.final });
      console.log(`${green("✓")} ${r.reopened ? `Sent ${bold(r.changeset)} back to its author` : `Closed ${bold(r.changeset)}`}`);
      break;
    }

    case "log": {
      const events = await k.store.listEvents({ limit: Number(values.limit ?? 20) });
      if (values.json) console.log(JSON.stringify(events, null, 2));
      else for (const e of events.reverse()) console.log(`${dim(e.at)} ${(e.ok ? green : red)(e.ok ? "ok " : "err")} ${e.actor.padEnd(12)} ${e.gate.padEnd(5)} ${bold(e.action)}${e.error ? red(`  ${e.error}`) : ""}`);
      break;
    }

    default:
      fail(`Unknown command "${cmd}". Run aicms help.`);
  }
  await k.close();
}

main().catch((e) => {
  if (isAicmsError(e)) fail(e.message);
  fail(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
