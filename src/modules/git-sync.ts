// File access is loaded on first use: git-sync needs a file system (servers, not the edge).
const fsp = () => import("node:fs/promises");
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { action } from "../kernel/action.ts";
import { AicmsError } from "../kernel/errors.ts";
import { defineModule, type ModuleContext } from "../kernel/modules.ts";
import { blocksToMarkdown, type Block } from "../schema/markdown.ts";
import type { Model } from "../schema/model.ts";

export interface GitSyncOptions {
  /** Folder for the Markdown files, relative to the project. Default "content". */
  dir?: string;
  /** Models to mirror. Default: all. */
  models?: string[];
}

const slugKey = (m: Model) => Object.entries(m.fields).find(([, f]) => f.kind === "slug")?.[0];
const bodyKey = (m: Model) => Object.entries(m.fields).find(([, f]) => f.kind === "blocks")?.[0];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Entry → Markdown with YAML frontmatter. The first blocks field is the body; other block fields become Markdown strings. */
export function toMarkdown(model: Model, entry: { id: string; locale: string; data: Record<string, unknown> }, defaultLocale: string): string {
  const body = bodyKey(model);
  const front: Record<string, unknown> = { id: entry.id };
  if (entry.locale !== defaultLocale) front.locale = entry.locale;
  for (const [key, f] of Object.entries(model.fields)) {
    const v = entry.data[key];
    if (key === body || v === undefined || v === null) continue;
    front[key] = f.kind === "blocks" && Array.isArray(v) ? blocksToMarkdown(v as Block[]) : v;
  }
  const md = body && Array.isArray(entry.data[body]) ? blocksToMarkdown(entry.data[body] as Block[]) : "";
  return `---\n${stringifyYaml(front, { lineWidth: 0 }).trimEnd()}\n---\n${md ? `\n${md}\n` : ""}`;
}

/** Markdown with frontmatter → { front, body }. */
export function fromMarkdown(text: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text.trim() };
  const front = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  return { front, body: m[2].trim() };
}

/** Mirror published content to Markdown files, and turn file edits into changesets for review. */
export function gitSync(opts: GitSyncOptions = {}) {
  const mirrored = (c: ModuleContext) => c.models().filter((m) => !opts.models || opts.models.includes(m.name));
  const root = (c: ModuleContext) => resolve(c.projectDir, opts.dir ?? "content");
  const fileFor = (c: ModuleContext, m: Model, e: { id: string; locale: string; data: Record<string, unknown> }) => {
    const s = slugKey(m);
    const name = (s && typeof e.data[s] === "string" && e.data[s]) || e.id;
    return join(root(c), m.name, `${name}${e.locale !== c.site.defaultLocale ? `.${e.locale}` : ""}.md`);
  };

  async function exportEntry(c: ModuleContext, id: string) {
    const previous = await c.kv.get<string>(`file:${id}`);
    const e = await c.entry(id);
    const m = e && mirrored(c).find((x) => x.name === e.model);
    if (!e || !m) {
      if (previous) await (await fsp()).rm(resolve(c.projectDir, previous), { force: true });
      await c.kv.delete(`file:${id}`);
      return null;
    }
    // A file keeps the name it already has (an author may have named it); new entries are named by slug.
    const file = previous ? resolve(c.projectDir, previous) : fileFor(c, m, e);
    const rel = relative(c.projectDir, file);
    await (await fsp()).mkdir(dirname(file), { recursive: true });
    await (await fsp()).writeFile(file, toMarkdown(m, e, c.site.defaultLocale));
    await c.kv.set(`file:${id}`, rel);
    return rel;
  }

  async function exportAll(c: ModuleContext) {
    let files = 0;
    for (const m of mirrored(c)) {
      for (let offset = 0; ; offset += 200) {
        const page = await c.list(m.name, { limit: 200, offset });
        for (const e of page.items) if (await exportEntry(c, e.id)) files++;
        if (offset + 200 >= page.total) break;
      }
    }
    return { files, dir: relative(c.projectDir, root(c)) || "." };
  }

  async function* walk(dir: string): AsyncGenerator<string> {
    let items: import("node:fs").Dirent[];
    try {
      items = await (await fsp()).readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(dir, it.name);
      if (it.isDirectory()) yield* walk(p);
      else if (it.name.endsWith(".md")) yield p;
    }
  }

  async function importAll(c: ModuleContext, dryRun: boolean) {
    const report = { created: [] as string[], updated: [] as string[], unchanged: 0, errors: [] as { file: string; message: string }[] };
    const base = root(c);
    for await (const file of walk(base)) {
      const rel = relative(c.projectDir, file);
      const modelName = relative(base, file).split(sep)[0];
      const m = mirrored(c).find((x) => x.name === modelName);
      if (!m) {
        report.errors.push({ file: rel, message: `No mirrored model "${modelName}"` });
        continue;
      }
      try {
        const text = await (await fsp()).readFile(file, "utf8");
        const { front, body } = fromMarkdown(text);
        const { id, locale, ...fields } = front as { id?: string; locale?: string } & Record<string, unknown>;
        const unknown = Object.keys(fields).filter((k) => !(k in m.fields));
        if (unknown.length) throw new Error(`Unknown field(s): ${unknown.join(", ")}`);
        const bKey = bodyKey(m);
        const incoming: Record<string, unknown> = { ...fields, ...(bKey && body ? { [bKey]: body } : {}) };
        if (id) {
          const current = await c.entry(id);
          if (!current) throw new Error(`Entry ${id} doesn't exist (anymore). Remove the id to create it again.`);
          // Compare in the file's own terms (block fields as Markdown). Only fields the file
          // mentions count: a missing field means "unchanged"; write `field: null` to clear one.
          const patch: Record<string, unknown> = {};
          for (const [key, f] of Object.entries(m.fields)) {
            if (!(key in incoming)) continue;
            const now = f.kind === "blocks" && Array.isArray(current.data[key]) ? blocksToMarkdown(current.data[key] as Block[]) : current.data[key];
            if (!same(now ?? null, incoming[key] ?? null)) patch[key] = incoming[key] ?? null;
          }
          if (!Object.keys(patch).length) {
            report.unchanged++;
            continue;
          }
          if (!dryRun) await c.draft(m.name, { id, ...patch });
          report.updated.push(rel);
        } else {
          if (!dryRun) {
            const d = await c.draft(m.name, { ...incoming, ...(locale ? { locale } : {}) });
            // Write the new id into the file's frontmatter, leaving the rest as the author wrote it,
            // so the next import updates this entry instead of creating a duplicate.
            await (await fsp()).writeFile(file, /^---\r?\n/.test(text) ? text.replace(/^---\r?\n/, `---\nid: ${d.id}\n`) : `---\nid: ${d.id}\n---\n\n${text}`);
            await c.kv.set(`file:${d.id}`, rel);
          }
          report.created.push(rel);
        }
      } catch (e) {
        report.errors.push({ file: rel, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return report;
  }

  return defineModule({
    name: "git-sync",
    description: "Mirrors published content to Markdown files with frontmatter, and turns file edits into changesets for review.",
    provides: ["git-sync"],
    uses: opts.models ?? ["*"],
    on: {
      "changeset.merged": async ({ payload, ctx }) => {
        for (const e of payload.entries ?? []) await exportEntry(ctx, e.id);
      },
    },
    actions: {
      export: action({
        description: "Write every published entry to Markdown files (the module also does this on every merge).",
        scope: "git-sync:run",
        input: z.strictObject({}),
        run: ({ ctx }) => exportAll(ctx),
      }),
      import: action({
        description: "Read the Markdown files and draft their differences into your changeset: edited files become updates, files without an id become new entries. Submit it with cms_submit for review.",
        scope: "git-sync:run",
        input: z.strictObject({ dryRun: z.boolean().optional().describe("Only report what would change") }),
        async run({ input, ctx }) {
          const r = await importAll(ctx, !!input.dryRun);
          if (!r.created.length && !r.updated.length && !r.errors.length) return { ...r, next: "Files and database already match." };
          if (input.dryRun) return r;
          if (r.errors.length && !r.created.length && !r.updated.length) throw new AicmsError("invalid", `Nothing imported: ${r.errors.map((e) => `${e.file}: ${e.message}`).join("; ")}`);
          return { ...r, next: "Drafted. Call cms_submit to send these changes for review." };
        },
      }),
    },
  });
}
