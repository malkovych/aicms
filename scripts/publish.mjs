#!/usr/bin/env node
// Publish every npm package whose current version isn't on the registry yet,
// dependencies first. Used by the release workflow; the first release can run
// it by hand after `npm login`.   node scripts/publish.mjs [--dry-run] [--provenance]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const provenance = process.argv.includes("--provenance");
// @aicms/client first: the adapters depend on it. The kernel last, so a half-done release never points at missing packages.
const ORDER = ["packages/client", "packages/next", "packages/astro", "packages/sveltekit", "packages/nuxt", "packages/create-aicms", "."];

const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const tag = process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag.slice(1) !== root.version) {
  console.error(`Tag ${tag} doesn't match package.json version ${root.version}`);
  process.exit(1);
}

function published(name, version) {
  try {
    return execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === version;
  } catch {
    return false; // 404: never published
  }
}

for (const dir of ORDER) {
  const pkg = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8"));
  if (pkg.private) continue;
  if (pkg.version !== root.version) throw new Error(`${pkg.name} is ${pkg.version}, the release is ${root.version}. Run node scripts/version.mjs ${root.version}`);
  if (published(pkg.name, pkg.version)) {
    console.log(`= ${pkg.name}@${pkg.version} is already published`);
    continue;
  }
  const args = ["publish", "--access", "public", ...(provenance ? ["--provenance"] : []), ...(dryRun ? ["--dry-run"] : [])];
  console.log(`↑ ${pkg.name}@${pkg.version}${dryRun ? " (dry run)" : ""}`);
  // The kernel builds in prepublishOnly; workspaces were built by `npm run build` before this.
  execFileSync("npm", args, { cwd: join(repo, dir), stdio: "inherit" });
}
