#!/usr/bin/env node
// Set one version everywhere: every package.json (and their @aicms/* ranges),
// the kernel's VERSION, and the Python SDK.   node scripts/version.mjs 0.5.0

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next ?? "")) {
  console.error("Usage: node scripts/version.mjs <x.y.z>");
  process.exit(1);
}
const repo = resolve(import.meta.dirname, "..");
const edit = (file, fn) => {
  const path = join(repo, file);
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`${file}: nothing to change`);
  writeFileSync(path, after);
  console.log(`  ${file}`);
};

const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
for (const dir of [".", ...root.workspaces]) {
  edit(join(dir, "package.json"), (text) => {
    const pkg = JSON.parse(text);
    pkg.version = next;
    for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      for (const name of Object.keys(deps ?? {})) if (name.startsWith("@aicms/")) deps[name] = `^${next}`;
    }
    return JSON.stringify(pkg, null, 2) + "\n";
  });
}
edit("src/gates/discovery.ts", (t) => t.replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${next}";`));
edit("sdk/python/pyproject.toml", (t) => t.replace(/^version = "[^"]+"/m, `version = "${next}"`));
edit("sdk/python/aicms/__init__.py", (t) => t.replace(/__version__ = "[^"]+"/, `__version__ = "${next}"`));
edit("sdk/python/aicms/client.py", (t) => t.replace(/aicms-python\/[\w.-]+"/, `aicms-python/${next}"`));
console.log(`Version ${next}. Run npm install to refresh package-lock.json.`);
