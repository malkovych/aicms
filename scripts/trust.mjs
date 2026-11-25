#!/usr/bin/env node
// Let GitHub Actions (release.yml in malkovych/aicms) publish every npm package,
// with no token: npm trusted publishing. Run once after the first publish,
// logged in with `npm login` and 2FA on, or set it up per package on npmjs.com.
//   node scripts/trust.mjs [--dry-run]
//
// --check, inside release.yml (Actions → Release → Run workflow → check trust):
// asks npm for a short-lived publish token for each package the way `npm publish`
// does, without publishing anything, and fails if a package doesn't trust release.yml.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const check = process.argv.includes("--check");
const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const slug = root.repository.url.replace(/^git\+/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
const packages = [".", ...root.workspaces]
  .map((dir) => JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")))
  .filter((pkg) => !pkg.private)
  .map((pkg) => pkg.name);

if (check) {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env;
  if (!url || !bearer) {
    console.error("--check runs inside GitHub Actions with `permissions: id-token: write`");
    process.exit(1);
  }
  let failed = 0;
  for (const name of packages) {
    // A fresh GitHub OIDC token per package, exchanged exactly as npm publish does.
    const id = await fetch(`${url}&audience=npm:registry.npmjs.org`, { headers: { authorization: `Bearer ${bearer}` } }).then((r) => r.json());
    const res = await fetch(`https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${name.replace("/", "%2f")}`, {
      method: "POST",
      headers: { authorization: `Bearer ${id.value}` },
    });
    const ok = res.ok && typeof (await res.json().catch(() => ({}))).token === "string";
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` (HTTP ${res.status}: no trusted publisher for ${slug} release.yml)`}`);
  }
  process.exit(failed ? 1 : 0);
}

for (const name of packages) {
  // `npm trust` needs npm 11.15 or newer; npx fetches it without touching the global npm.
  const args = ["-y", "npm@^11.15.0", "trust", "github", name, "--file", "release.yml", "--repo", slug, "--allow-publish", "--yes"];
  console.log(`${dryRun ? "would run" : "→"} npx ${args.join(" ")}`);
  if (!dryRun) execFileSync("npx", args, { cwd: repo, stdio: "inherit" });
}
