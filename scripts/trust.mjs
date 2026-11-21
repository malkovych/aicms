#!/usr/bin/env node
// Let GitHub Actions (release.yml in malkovych/aicms) publish every npm package,
// with no token: npm trusted publishing. Run once after the first manual publish,
// logged in with `npm login` and 2FA on.   node scripts/trust.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const slug = root.repository.url.replace(/^git\+/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

for (const dir of [".", ...root.workspaces]) {
  const pkg = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8"));
  if (pkg.private) continue;
  // `npm trust` needs npm 11.15 or newer; npx fetches it without touching the global npm.
  const args = ["-y", "npm@^11.15.0", "trust", "github", pkg.name, "--file", "release.yml", "--repo", slug, "--allow-publish", "--yes"];
  console.log(`${dryRun ? "would run" : "→"} npx ${args.join(" ")}`);
  if (!dryRun) execFileSync("npx", args, { cwd: repo, stdio: "inherit" });
}
