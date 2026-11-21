#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createCMS, type Kernel } from "./kernel/cms.ts";
import { summarize } from "./kernel/changesets.ts";
import { isAicmsError } from "./kernel/errors.ts";
import { OWNER, describeReview } from "./kernel/policy.ts";
import { createApp } from "./gates/rest.ts";
import { serveStdio } from "./gates/mcp.ts";
import { VERSION } from "./gates/discovery.ts";
import { importFrom, loadProject } from "./load.ts";
import { addModuleSource, listModuleCalls, removeModuleSource, type ModuleRef } from "./config-edit.ts";
import { catalog, findCatalog } from "./modules/catalog.ts";
import { DEFAULT_REGISTRY, exceedsDeclared, loadRegistry, searchRegistry, type RegistryEntry } from "./registry.ts";
import { isModule, moduleManifest, type ModuleDef } from "./kernel/modules.ts";
import { generateTypes } from "./typegen.ts";

const HELP = `aicms ${VERSION} — the CMS for AI agents

Usage: aicms <command> [options]

Project
  init [dir]                    Create aicms.config.ts and example models
  dev | start                   Serve Studio, REST, MCP and events (--port 4321, --host 127.0.0.1)
  login [--url <server>]        A one-time Studio sign-in link (valid 15 minutes);
                                add --token <owner token> for a remote server
  describe [model]              What the site contains, as JSON
  types [--out <file>]          TypeScript types for @aicms/client (stdout by default)

Agents
  agent create <name>           Issue a token for an agent from aicms.config (or "owner")
  agent revoke <name>           Revoke its tokens and reject its unmerged changes
  agent list                    Tokens and their agents
  mcp --agent <name>            Serve MCP over stdio for a local agent (or --token <t>)

Modules
  modules                       Installed modules, their permissions, and official ones to add
  search [query]                Find modules in the registry
  add <name|path|package>       Add a module: an official one (seo, search, media, i18n, git-sync),
                                a local folder or an npm package; writes aicms.config.ts
  remove <name>                 Take a module out of aicms.config.ts
  module new <name>             Scaffold modules/<name>/module.ts and add it
  sync export | import          git-sync: write content to Markdown, or draft file edits
                                (--agent <name> to import as an agent, --submit to send for review)

Briefs
  brief "Title" [--agent <a>]   Hand an agent work (--details, --model, --due, --at <publish time>)
  briefs [--all]                Briefs not done yet (--all: every brief)

Review
  changes [--all]               Changesets waiting for review (--all: every recent one)
  show <id>                     Before/after for every field in a changeset
  merge <id> [--at <time>]      Publish a changeset, now or at an ISO time
  unschedule <id>               Take a scheduled changeset off the schedule
  publish-due                   Publish scheduled changesets that are due (for cron without a server)
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
  return createCMS(project.config, { cwd: project.root, configFile: project.file });
}

const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function printManifest(m: ReturnType<typeof moduleManifest>, indent = "  ") {
  if (m.description) console.log(`${indent}${dim(m.description)}`);
  const line = (label: string, items: string[]) => items.length && console.log(`${indent}${dim(label.padEnd(9))} ${items.join(", ")}`);
  line("provides", m.provides);
  line("requires", m.requires);
  line("uses", m.uses.map((u) => (u === "*" ? "all models" : u)));
  line("models", m.models.map((x) => x.name));
  line("actions", m.actions.map((a) => `${a.name}${a.scope.includes(":") ? dim(` (${a.scope})`) : ""}`));
  line("routes", m.routes);
  line("hooks", m.hooks);
}

async function registryFor(root: string, url: string | false | undefined): Promise<RegistryEntry[]> {
  if (url === false) return [];
  try {
    return (await loadRegistry(url ?? DEFAULT_REGISTRY, { cacheFile: join(root, ".aicms", "registry-cache.json") })).modules;
  } catch (e) {
    console.log(dim(`(registry unavailable: ${e instanceof Error ? e.message : e})`));
    return [];
  }
}

/** Resolve what `aicms add <target>` means: a catalog module, a local file/folder, a registry module or an npm package. */
async function resolveModule(root: string, configDir: string, target: string, registry: string | false | undefined, force: boolean): Promise<{ ref: ModuleRef; def: ModuleDef; hint?: string }> {
  const entry = findCatalog(target);
  if (entry) {
    const def = entry.create();
    return { ref: { name: entry.importName, from: "aicms/modules", isDefault: false, call: `${entry.importName}()` }, def, hint: `Options: ${entry.example}` };
  }
  let specifier = target;
  if (target.startsWith(".") || target.startsWith("/")) {
    let file = resolve(process.cwd(), target);
    if (existsSync(file) && statSync(file).isDirectory()) file = ["module.ts", "index.ts", "module.js", "index.js"].map((f) => join(file, f)).find(existsSync) ?? file;
    if (!existsSync(file)) fail(`No module file at ${target}`);
    specifier = "./" + relative(configDir, file).split("\\").join("/");
    if (specifier.startsWith("./../")) specifier = specifier.slice(2);
  } else {
    // A registry name maps to a reviewed npm package with declared permissions.
    const listed = (await registryFor(root, registry)).find((m) => m.name === target && !m.official);
    if (listed) {
      specifier = listed.package;
      console.log(`${bold(listed.title)} ${dim(`by ${listed.author} · ${listed.license}`)}\n  ${listed.summary}`);
    }
    console.log(dim(`npm install ${specifier}`));
    const r = spawnSync("npm", ["install", specifier], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) fail(`npm install ${specifier} failed`);
    if (listed) {
      const loaded = await importFrom(configDir, specifier);
      const def = isModule(loaded) ? loaded : typeof loaded === "function" ? (loaded as () => ModuleDef)() : null;
      if (def && isModule(def)) {
        const extra = exceedsDeclared(listed, moduleManifest(def));
        if (extra.length && !force) {
          fail(`${specifier} asks for more than its registry entry declares (${extra.join("; ")}). It was not added to aicms.config. Review it, then use --force to add it anyway.`);
        }
      }
    }
  }
  const loaded = await importFrom(configDir, specifier.startsWith(".") ? resolve(configDir, specifier) : specifier);
  const def = isModule(loaded) ? loaded : typeof loaded === "function" ? (loaded as () => ModuleDef)() : null;
  if (!def || !isModule(def)) fail(`${target} doesn't export a module (defineModule) or a function that returns one`);
  const name = camel(def.name);
  return { ref: { name, from: specifier, isDefault: true, call: isModule(loaded) ? name : `${name}()` }, def };
}

const asOwner = (k: Kernel, name: string, input: unknown = {}) => k.call(name, input, { actor: OWNER, gate: "cli" });

function printChangeset(cs: any) {
  const status = cs.status === "submitted" ? yellow(cs.status) : cs.status === "merged" ? green(cs.status) : cs.status === "rejected" ? red(cs.status) : blue(cs.status);
  console.log(`${bold(cs.id)}  ${status}  by ${bold(cs.actor)}  ${dim(cs.updatedAt)}`);
  if (cs.note) console.log(`  note: ${cs.note}`);
  if (cs.waitingBecause) console.log(dim(`  waiting: ${cs.waitingBecause}`));
  if (cs.comment) console.log(`  comment: ${cs.comment}`);
  if (cs.brief) console.log(`  brief: ${cs.brief}`);
  if (cs.publishAt) console.log(`  ${cs.status === "scheduled" ? "publishes" : "asks to publish"} at ${bold(cs.publishAt)}`);
  for (const issue of cs.issues ?? []) console.log(red(`  ! ${issue.entry}${issue.field ? `.${issue.field}` : ""}: ${issue.message}`));
  for (const w of cs.warnings ?? []) console.log(yellow(`  ⚠ ${w.entry}${w.field ? `.${w.field}` : ""}: ${w.message}${w.check ? dim(` (${w.check})`) : ""}`));
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

const MODULE_TEMPLATE = (name: string) => `import { action, defineModule, field } from "aicms"

// A module is one file: what it provides, what it needs, its Actions and hooks.
// Docs: https://github.com/malkovych/aicms/blob/main/ARCHITECTURE.md#6-modules-like-lego
export default defineModule({
  name: "${name}",
  description: "What this module does, in one sentence",
  provides: ["${name}"],
  uses: [],            // models this module may read and draft, e.g. ["post"]

  actions: {
    hello: action({
      description: "Say hello. Agents read this text to decide when to call the tool.",
      scope: "${name}:use",  // give agents this scope in aicms.config to see the tool
      readOnly: true,
      input: { name: field.text({ required: true }) },
      run: ({ input }) => ({ message: \`Hello, \${input.name}!\` }),
    }),
  },

  on: {
    "changeset.merged": async ({ payload }) => {
      // React to published changes: notify, reindex, sync…
    },
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

// Coding agents that read .mcp.json (Claude Code, Cursor…) get the site's tools as "writer".
const MCP_JSON = `${JSON.stringify({ mcpServers: { aicms: { command: "npx", args: ["aicms", "mcp", "--agent", "writer"] } } }, null, 2)}\n`;

const AGENTS_TEMPLATE = `# AGENTS.md

This site runs on [AICMS](https://github.com/malkovych/aicms), a CMS for AI agents.

## Content

Content lives in a database, not in files. Don't edit \`.aicms/\` directly.

- Read and change content through the AICMS tools. In this folder, \`.mcp.json\` connects
  you as the \`writer\` agent: \`npx aicms mcp --agent writer\`.
- Start with \`cms_describe\`: it lists the models, their fields and what you may do.
- \`cms_briefs\` lists work people assigned to you.
- Your changes are drafts until you call \`cms_submit\`. A person reviews them in Studio
  (\`npm run dev\`, then the sign-in link it prints) before anything is published.
- If \`cms_submit\` returns issues or warnings, fix them with the \`<model>_draft\` tools and submit again.

## Code

- Models: \`models/*.ts\` (\`defineModel\`). Config, agents and permissions: \`aicms.config.ts\`.
- Modules: \`npx aicms modules\`, \`npx aicms add <name>\`.
- Types for a frontend: \`npm run types\` writes \`aicms-types.ts\` for \`@aicms/client\`.
- Docs: https://github.com/malkovych/aicms/blob/main/ARCHITECTURE.md
`;

function init(dir: string) {
  const root = resolve(process.cwd(), dir);
  if (existsSync(join(root, "aicms.config.ts"))) fail(`${root} already has an aicms.config.ts`);
  mkdirSync(join(root, "models"), { recursive: true });
  writeFileSync(join(root, "aicms.config.ts"), CONFIG_TEMPLATE);
  writeFileSync(join(root, "models", "post.ts"), POST_TEMPLATE);
  writeFileSync(join(root, "models", "tag.ts"), TAG_TEMPLATE);
  const made = ["aicms.config.ts", "models/post.ts", "models/tag.ts"];
  for (const [file, text] of [[".mcp.json", MCP_JSON], ["AGENTS.md", AGENTS_TEMPLATE]] as const) {
    if (existsSync(join(root, file))) continue;
    writeFileSync(join(root, file), text);
    made.push(file);
  }
  const gi = join(root, ".gitignore");
  const ignored = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const missing = [".aicms/", "node_modules/"].filter((line) => !ignored.split(/\r?\n/).includes(line));
  if (missing.length) appendFileSync(gi, `${ignored && !ignored.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  console.log(`${green("✓")} Created ${made.map((f) => bold(f)).join(", ")} in ${root}

Next:
  aicms dev                   ${dim("# Studio, REST and MCP on http://127.0.0.1:4321")}
  aicms agent create writer   ${dim("# a token for an agent that connects over HTTP")}`);
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
      submit: { type: "boolean" },
      force: { type: "boolean" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      at: { type: "string" },
      details: { type: "string", short: "d" },
      model: { type: "string" },
      due: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.version) return console.log(VERSION);
  if (!cmd || values.help || cmd === "help") return console.log(HELP);

  if (cmd === "init") return init(args[0] ?? ".");

  if (cmd === "add" || cmd === "remove" || (cmd === "module" && args[0] === "new")) {
    const project = await loadProject(process.cwd(), values.config);
    const file = project.file;
    const before = readFileSync(file, "utf8");
    const installed = project.config.modules ?? [];
    let next = before;
    let added: ModuleDef | undefined;
    let hint: string | undefined;

    if (cmd === "add") {
      if (!args[0]) fail(`Usage: aicms add <name|path|package>. Official modules: ${catalog.map((c) => c.name).join(", ")}`);
      const { ref, def, hint: h } = await resolveModule(project.root, dirname(file), args[0], project.config.registry, !!values.force);
      if (installed.some((m) => m.name === def.name)) fail(`Module "${def.name}" is already in aicms.config`);
      // Lego: pull in official modules that provide what this one requires.
      const provided = new Set(installed.flatMap((m) => m.provides ?? []));
      for (const cap of def.requires ?? []) {
        if (provided.has(cap)) continue;
        const dep = catalog.find((c) => (c.create().provides ?? []).includes(cap));
        if (!dep) fail(`"${def.name}" requires "${cap}", and no installed or official module provides it`);
        next = addModuleSource(next, { name: dep.importName, from: "aicms/modules", isDefault: false, call: `${dep.importName}()` });
        console.log(`${green("+")} ${bold(dep.name)} ${dim(`(provides ${cap}, required by ${def.name})`)}`);
      }
      next = addModuleSource(next, ref);
      added = def;
      hint = h;
    } else if (cmd === "remove") {
      if (!args[0]) fail("Usage: aicms remove <name>");
      const mod = installed.find((m) => m.name === args[0] || m.name === findCatalog(args[0])?.name);
      if (!mod) fail(`No module "${args[0]}" in aicms.config. Installed: ${installed.map((m) => m.name).join(", ") || "none"}`);
      const dependents = installed.filter((m) => m !== mod && (m.requires ?? []).some((cap) => (mod.provides ?? []).includes(cap)));
      if (dependents.length) fail(`${dependents.map((m) => m.name).join(", ")} require what ${mod.name} provides; remove them first`);
      const calls = listModuleCalls(before);
      const ident = [findCatalog(mod.name)?.importName, camel(mod.name), mod.name].find((n) => n && calls.some((c) => c === n || c.startsWith(`${n}(`)));
      if (!ident) fail(`Couldn't find ${mod.name} in the modules array of ${relative(process.cwd(), file)}; remove it by hand`);
      next = removeModuleSource(before, ident);
    } else {
      const name = args[1];
      if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) fail("Usage: aicms module new <name> (lowercase letters, digits, hyphens)");
      const dir = join(project.root, "modules", name);
      const path = join(dir, "module.ts");
      if (existsSync(path)) fail(`${relative(process.cwd(), path)} already exists`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, MODULE_TEMPLATE(name));
      console.log(`${green("✓")} Created ${bold(relative(process.cwd(), path))}`);
      next = addModuleSource(before, { name: camel(name), from: `./modules/${name}/module.ts`, isDefault: true, call: camel(name) });
    }

    writeFileSync(file, next);
    // Make sure the project still starts; put the file back if it doesn't.
    try {
      const check = await loadProject(process.cwd(), values.config);
      const k = await createCMS(check.config, { cwd: check.root, configFile: check.file });
      await k.close();
    } catch (e) {
      writeFileSync(file, before);
      fail(`aicms.config was left unchanged: ${e instanceof Error ? e.message : e}`);
    }
    if (cmd === "remove") console.log(`${green("✓")} Removed ${bold(args[0])} from ${relative(process.cwd(), file)} ${dim("(its data stays in the database)")}`);
    else if (added) {
      console.log(`${green("✓")} Added ${bold(added.name)} to ${relative(process.cwd(), file)}`);
      printManifest(moduleManifest(added));
      const scopes = moduleManifest(added).scopes;
      if (scopes.length) console.log(`\n${dim("Give agents these scopes in aicms.config to use it:")} ${scopes.join(", ")}`);
      if (hint) console.log(dim(hint));
    }
    return;
  }

  const k = await open(values.config);

  switch (cmd) {
    case "dev":
    case "start": {
      const port = Number(values.port ?? process.env.PORT ?? 4321);
      const hostname = values.host ?? process.env.HOST ?? "127.0.0.1";
      const app = createApp(k);
      const code = await k.createLoginCode();
      k.startScheduler();
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
      if (values.token) {
        // A remote server (e.g. on the edge): ask it for a code with the owner token.
        const res = await fetch(`${base}/api/v1/actions/cms.login_code`, { method: "POST", headers: { authorization: `Bearer ${values.token}`, "content-type": "application/json" }, body: "{}" });
        const body: any = await res.json().catch(() => ({}));
        if (!res.ok) fail(body?.error?.message ?? `HTTP ${res.status} from ${base}`);
        console.log(`${green("✓")} Open this link within 15 minutes to sign in to Studio (it works once):\n\n  ${bold(base + body.path)}`);
        break;
      }
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

    case "modules": {
      const res: any = await asOwner(k, "cms.modules");
      if (values.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(bold(`Installed (${res.installed.length})`));
        if (!res.installed.length) console.log(dim("  none"));
        for (const m of res.installed) {
          console.log(`\n  ${bold(m.name)}${m.version ? dim(` v${m.version}`) : ""}`);
          printManifest(m, "    ");
        }
        if (res.available.length) {
          console.log(`\n${bold("Official, not installed")}`);
          for (const m of res.available) console.log(`  ${bold(m.name.padEnd(9))} ${m.summary}  ${dim(`aicms add ${m.name}`)}`);
        }
      }
      break;
    }

    case "search": {
      const reg = k.config.registry;
      if (!reg) fail("The module registry is turned off (registry: false in aicms.config)");
      const found = searchRegistry(await loadRegistry(reg, { cacheFile: join(k.projectDir, ".aicms", "registry-cache.json") }), args.join(" "));
      const installed = new Set(k.modules.map((m) => m.name));
      if (values.json) console.log(JSON.stringify(found, null, 2));
      else if (!found.length) console.log(dim("No modules match."));
      else for (const m of found) {
        console.log(`${bold(m.name.padEnd(12))} ${m.summary}${installed.has(m.name) ? green("  installed") : ""}`);
        console.log(dim(`${"".padEnd(12)} ${m.official ? "official" : `by ${m.author}`} · ${[m.provides.length ? `provides ${m.provides.join(", ")}` : "", m.scopes.length ? `scopes ${m.scopes.join(", ")}` : ""].filter(Boolean).join(" · ")}`));
      }
      break;
    }

    case "sync": {
      const sub = args[0];
      if (sub !== "export" && sub !== "import") fail("Usage: aicms sync export | import [--agent <name>] [--submit]");
      if (!k.modules.some((m) => m.name === "git-sync")) fail("git-sync isn't installed. Run: aicms add git-sync");
      const actor = values.agent ? k.actor(values.agent) : OWNER;
      const r: any = await k.call(`git-sync.${sub}`, {}, { actor, gate: "cli" });
      if (sub === "export") console.log(`${green("✓")} Wrote ${r.files} file(s) to ${bold(r.dir)}`);
      else {
        console.log(`${green("✓")} ${r.created.length} new, ${r.updated.length} changed, ${r.unchanged} unchanged`);
        for (const f of r.created) console.log(`  ${green("+")} ${f}`);
        for (const f of r.updated) console.log(`  ${yellow("~")} ${f}`);
        for (const e of r.errors) console.log(red(`  ! ${e.file}: ${e.message}`));
        if ((r.created.length || r.updated.length) && values.submit) {
          const s2: any = await k.call("cms.submit", { note: "Import from Markdown files" }, { actor, gate: "cli" });
          console.log(`${green("✓")} ${s2.status === "merged" ? "Merged" : s2.status === "submitted" ? `Sent for review as ${bold(s2.changeset)}` : "Checks failed"}`);
          for (const i of s2.issues ?? []) console.log(red(`  ! ${i.entry}${i.field ? `.${i.field}` : ""}: ${i.message}`));
        } else if (r.created.length || r.updated.length) console.log(dim("Drafted. Add --submit to send them for review."));
      }
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
        console.log(`${green("✓")} Token for ${bold(name)} ${dim(`(scopes: ${actor.scopes.join(", ")}; review: ${describeReview(actor.review)})`)}\n\n  ${bold(token)}\n\n${dim("Shown once. Connect an MCP client:")}\n  claude mcp add --transport http aicms http://127.0.0.1:4321/mcp --header "Authorization: Bearer ${token}"`);
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
      if (!args[0]) fail("Usage: aicms merge <changeset-id> [--at <ISO time>|now]");
      const r: any = await asOwner(k, "cms.merge", { id: args[0], ...(values.at ? { at: values.at } : {}) });
      if (r.status === "scheduled") {
        console.log(`${green("✓")} Scheduled ${bold(r.changeset)} for ${bold(r.publishAt)} ${dim("(published by aicms dev/start while it runs)")}`);
        break;
      }
      console.log(`${green("✓")} Merged ${bold(r.changeset)} from ${r.actor}`);
      for (const e of r.entries) console.log(`  ${e.op.padEnd(6)} ${e.model} ${dim(e.id)} v${e.version}`);
      break;
    }

    case "unschedule": {
      if (!args[0]) fail("Usage: aicms unschedule <changeset-id>");
      await asOwner(k, "cms.unschedule", { id: args[0] });
      console.log(`${green("✓")} ${bold(args[0])} is off the schedule and waits for review`);
      break;
    }

    case "publish-due": {
      const r = await k.publishDue();
      console.log(r.merged.length ? `${green("✓")} Published ${r.merged.join(", ")}` : dim("Nothing due."));
      for (const f of r.failed) console.log(red(`  ! ${f.changeset}: ${f.error}`));
      break;
    }

    case "briefs": {
      const res: any = await asOwner(k, "cms.briefs", values.all ? { status: ["open", "in_progress", "blocked", "in_review", "done", "canceled"] } : {});
      if (values.json) console.log(JSON.stringify(res, null, 2));
      else if (!res.briefs.length) console.log(dim('No open briefs. Write one: aicms brief "Title" --agent writer'));
      for (const b of values.json ? [] : res.briefs) {
        const tone = b.status === "blocked" ? red : b.status === "done" ? green : b.status === "in_review" ? yellow : blue;
        console.log(`${bold(b.id)}  ${tone(b.status)}  ${b.title}  ${dim([b.agent ?? b.claimedBy ?? "any agent", b.due && `due ${b.due}`].filter(Boolean).join(" · "))}`);
        if (b.lastNote) console.log(dim(`  ${b.lastNote.by}: ${b.lastNote.text}`));
      }
      break;
    }

    case "brief": {
      if (!args[0]) fail('Usage: aicms brief "Title" [--details "..."] [--agent writer] [--model post] [--due 2026-12-01] [--at <publish time>]');
      const r: any = await asOwner(k, "cms.brief", {
        title: args.join(" "),
        ...(values.details ? { details: values.details } : {}),
        ...(values.agent ? { agent: values.agent } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.due ? { due: values.due } : {}),
        ...(values.at ? { publishAt: values.at } : {}),
      });
      console.log(`${green("✓")} Brief ${bold(r.brief.id)}: ${r.brief.title}\n  ${dim(r.next)}`);
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
