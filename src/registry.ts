// The module registry: a reviewed JSON index of modules anyone can add.
// Official modules ship inside aicms; community modules are npm packages
// listed by pull request to docs/registry.json. Each entry declares what the
// module asks for, and `aicms add` refuses a package that asks for more.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ModuleManifest } from "./kernel/modules.ts";

export const DEFAULT_REGISTRY = "https://malkovych.github.io/aicms/registry.json";

export const RegistryEntrySchema = z.strictObject({
  /** The module's name, as in `aicms add <name>` and defineModule({ name }). */
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1).max(60),
  summary: z.string().min(10).max(200),
  /** "aicms/modules" for official modules, else the npm package. */
  package: z.string().min(1),
  official: z.boolean().optional(),
  author: z.string().min(1),
  homepage: z.string().url().optional(),
  license: z.string().min(1),
  provides: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
  /** Declared permissions; the installed module may not exceed them. */
  uses: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
  routes: z.array(z.string()).default([]),
  hooks: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const RegistrySchema = z.strictObject({
  version: z.literal(1),
  updated: z.string(),
  modules: z.array(RegistryEntrySchema),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type Registry = z.infer<typeof RegistrySchema>;

export function parseRegistry(data: unknown): Registry {
  const r = RegistrySchema.parse(data);
  const names = new Set<string>();
  for (const m of r.modules) {
    if (names.has(m.name)) throw new Error(`Registry lists "${m.name}" twice`);
    names.add(m.name);
  }
  return r;
}

/**
 * The registry, from `url` (http(s) or a file path), cached in `cacheFile` for an hour.
 * Offline, a stale cache is better than nothing; with no cache it throws.
 */
export async function loadRegistry(url = DEFAULT_REGISTRY, opts: { cacheFile?: string; maxAgeMs?: number; fetch?: typeof fetch } = {}): Promise<Registry> {
  const maxAge = opts.maxAgeMs ?? 3_600_000;
  let cached: { at: number; url: string; data: unknown } | undefined;
  if (opts.cacheFile) {
    try {
      cached = JSON.parse(await readFile(opts.cacheFile, "utf8"));
    } catch {
      /* no cache yet */
    }
    if (cached && cached.url === url && Date.now() - cached.at < maxAge) return parseRegistry(cached.data);
  }
  try {
    let data: unknown;
    if (/^https?:\/\//.test(url)) {
      const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } else {
      data = JSON.parse(await readFile(url.replace(/^file:\/\//, ""), "utf8"));
    }
    const registry = parseRegistry(data);
    if (opts.cacheFile) {
      await mkdir(dirname(opts.cacheFile), { recursive: true });
      await writeFile(opts.cacheFile, JSON.stringify({ at: Date.now(), url, data }));
    }
    return registry;
  } catch (e) {
    if (cached && cached.url === url) return parseRegistry(cached.data);
    throw new Error(`Couldn't load the module registry from ${url}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Modules matching every word of the query in name, title, summary, provides or tags. */
export function searchRegistry(registry: Registry, query = ""): RegistryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return registry.modules.filter((m) => {
    const hay = [m.name, m.title, m.summary, ...m.provides, ...m.tags].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** What the installed module asks for beyond what its registry entry declared. Empty means it matches. */
export function exceedsDeclared(entry: RegistryEntry, manifest: ModuleManifest): string[] {
  const out: string[] = [];
  const extra = (label: string, got: string[], declared: string[]) => {
    const more = got.filter((x) => !declared.includes(x) && !declared.includes("*"));
    if (more.length) out.push(`${label}: ${more.join(", ")}`);
  };
  if (manifest.name !== entry.name) out.push(`name: the package defines "${manifest.name}", the registry says "${entry.name}"`);
  extra("uses", manifest.uses, entry.uses);
  extra("scopes", manifest.scopes, entry.scopes);
  extra("routes", manifest.routes, entry.routes);
  extra("hooks", manifest.hooks, entry.hooks);
  extra("requires", manifest.requires, entry.requires);
  return out;
}
