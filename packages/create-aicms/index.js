#!/usr/bin/env node
// npm create aicms@latest [dir] -- [--no-install]
// Writes package.json, installs aicms, and runs `aicms init` so the starter
// files always come from the aicms version you installed. No dependencies.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const own = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const red = paint(31);

const HELP = `create-aicms ${own.version}: start a site on AICMS, the CMS for AI agents

Usage: npm create aicms@latest [dir] [-- options]

Options
  --no-install     Only write package.json; install and run "aicms init" yourself
  --pm <name>      npm, pnpm, yarn or bun (default: the one running this)
  -h, --help       This help`;

function fail(message) {
  console.error(`${red("✗")} ${message}`);
  process.exit(1);
}

/** The package manager that ran us, from npm_config_user_agent ("pnpm/9.1.0 npm/? node/…"). */
function detectPm() {
  const ua = process.env.npm_config_user_agent ?? "";
  for (const pm of ["pnpm", "yarn", "bun"]) if (ua.startsWith(`${pm}/`)) return pm;
  return "npm";
}

/** A valid npm package name from a folder name. */
function packageName(dir) {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[-._]+$/g, "");
  return name || "aicms-site";
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      install: { type: "boolean", default: true },
      "no-install": { type: "boolean" },
      pm: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const install = values.install && !values["no-install"];
  const pm = values.pm ?? detectPm();
  if (!["npm", "pnpm", "yarn", "bun"].includes(pm)) fail(`Unknown package manager "${pm}"`);

  let dir = positionals[0];
  if (!dir && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    dir = (await rl.question(`Project folder ${dim("(my-site)")}: `)).trim();
    rl.close();
  }
  dir ||= "my-site";
  const root = resolve(process.cwd(), dir);
  if (existsSync(root) && readdirSync(root).some((f) => f !== ".git" && f !== ".DS_Store")) {
    fail(`${root} isn't empty. Pick a new folder, or run "npx aicms init" inside an existing project.`);
  }
  mkdirSync(root, { recursive: true });

  // AICMS_PACKAGE lets tests install a local tarball instead of the registry version.
  const dependency = process.env.AICMS_PACKAGE ?? `^${own.version}`;
  const pkg = {
    name: packageName(root),
    private: true,
    type: "module",
    scripts: {
      dev: "aicms dev",
      start: "aicms start",
      types: "aicms types --out aicms-types.ts",
    },
    dependencies: { aicms: dependency },
    engines: { node: ">=22.13" },
  };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${green("✓")} Created ${bold(join(relative(process.cwd(), root) || ".", "package.json"))}`);

  const where = relative(process.cwd(), root) || ".";
  const runScript = pm === "npm" ? "npm run" : pm;
  if (!install) {
    console.log(`
Next:
  cd ${where}
  ${pm} install
  npx aicms init              ${dim("# aicms.config.ts, models, .mcp.json")}
  ${runScript} dev`);
    return;
  }

  console.log(dim(`\n${pm} install…`));
  if (!run(pm, ["install"], root)) fail(`${pm} install failed. Fix the error above, then run "${pm} install" and "npx aicms init" in ${where}.`);
  const cli = join(root, "node_modules", "aicms", "dist", "cli.js");
  if (!existsSync(cli)) fail(`aicms didn't install into ${where}/node_modules`);
  if (!run(process.execPath, [cli, "init", "."], root)) fail(`"aicms init" failed in ${where}`);

  console.log(`
${green("✓")} ${bold(pkg.name)} is ready.

  cd ${where}
  ${runScript} dev            ${dim("# Studio, REST, MCP and events on http://127.0.0.1:4321")}

Coding agents that read .mcp.json (Claude Code, Cursor) get the site's tools
as the "writer" agent when you open the folder. Others: see AGENTS.md.`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
