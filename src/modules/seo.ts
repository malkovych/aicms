import { z } from "zod";
import { action } from "../kernel/action.ts";
import { AicmsError } from "../kernel/errors.ts";
import { defineModule, type ModuleContext } from "../kernel/modules.ts";
import type { Block } from "../schema/markdown.ts";
import { displayTitle, titleField, type Model } from "../schema/model.ts";
import { entryText, tokenize } from "./text.ts";

export interface SeoOptions {
  /** The public site's origin, e.g. "https://example.com". Used for sitemap.xml. */
  siteUrl?: string;
  /** Models to audit and list in the sitemap. Default: every model with a slug field. */
  models?: string[];
  /** Public path of an entry. Default: `/${model}/${slug}`. */
  path?: (model: string, entry: Record<string, unknown> & { id: string; locale: string }) => string;
  /** Turn SEO problems in changed fields into warnings for the reviewer. Default true. */
  checks?: boolean;
}

export interface SeoIssue {
  level: "error" | "warning" | "tip";
  field?: string;
  message: string;
}

const slugField = (m: Model) => Object.entries(m.fields).find(([, f]) => f.kind === "slug")?.[0];
const blocksField = (m: Model) => Object.entries(m.fields).find(([, f]) => f.kind === "blocks")?.[0];
const descriptionOf = (m: Model, d: Record<string, any>): [string | undefined, string] => {
  if (d.seo?.description) return [d.seo.description, "seo.description"];
  for (const key of ["description", "excerpt", "summary"]) if (key in m.fields && typeof d[key] === "string" && d[key]) return [d[key], key];
  return [undefined, "seo" in m.fields ? "seo.description" : "excerpt"];
};

/** Score an entry 0–100 with concrete fixes. Pure: works on drafts and published data alike. */
export function auditEntry(model: Model, data: Record<string, any>) {
  const issues: SeoIssue[] = [];
  const tKey = titleField(model);
  const title: string = data.seo?.title || displayTitle(model, data);
  const titleAt = data.seo?.title ? "seo.title" : tKey;
  if (!title) issues.push({ level: "error", field: titleAt, message: "Add a title" });
  else if (title.length > 60) issues.push({ level: "warning", field: titleAt, message: `Title is ${title.length} characters; search results cut it at about 60` });
  else if (title.length < 15) issues.push({ level: "tip", field: titleAt, message: `Title is only ${title.length} characters; say what the page is about` });

  const [desc, descAt] = descriptionOf(model, data);
  if (!desc) issues.push({ level: "error", field: descAt, message: "Add a meta description (50–160 characters)" });
  else if (desc.length > 160) issues.push({ level: "warning", field: descAt, message: `Description is ${desc.length} characters; keep it under 160` });
  else if (desc.length < 50) issues.push({ level: "tip", field: descAt, message: `Description is ${desc.length} characters; aim for 50–160` });

  const sKey = slugField(model);
  if (sKey) {
    const slug = String(data[sKey] ?? "");
    if (!slug) issues.push({ level: "error", field: sKey, message: "Add a slug" });
    else if (slug.length > 75) issues.push({ level: "tip", field: sKey, message: `Slug is ${slug.length} characters; shorter URLs read better` });
  }

  const bKey = blocksField(model);
  const blocks: Block[] = bKey && Array.isArray(data[bKey]) ? data[bKey] : [];
  const words = tokenize(entryText(model, data).body).length;
  const headings = blocks.filter((b) => b.type === "heading").map((b) => Number(b.level) || 2);
  const images = blocks.filter((b) => b.type === "image");
  const links = blocks.map((b) => String(b.text ?? "") + JSON.stringify(b.items ?? "")).join(" ").match(/\]\((\/[^)\s]*)\)/g) ?? [];
  if (bKey) {
    if (words < 300) issues.push({ level: words < 150 ? "warning" : "tip", field: bKey, message: `${words} words; pages under 300 words rarely rank` });
    if (headings.includes(1)) issues.push({ level: "warning", field: bKey, message: "The title is already the page's h1; start body headings at ##" });
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        issues.push({ level: "tip", field: bKey, message: `Heading levels skip from h${headings[i - 1]} to h${headings[i]}` });
        break;
      }
    }
    if (words > 500 && !headings.length) issues.push({ level: "tip", field: bKey, message: "Long text without headings; add ## sections" });
    const noAlt = images.filter((b) => !String(b.alt ?? "").trim()).length;
    if (noAlt) issues.push({ level: "error", field: bKey, message: `${noAlt} image(s) without alt text` });
    if (words >= 300 && !links.length) issues.push({ level: "tip", field: bKey, message: "No links to other pages of the site" });
  }
  for (const [key, f] of Object.entries(model.fields)) {
    if (f.kind === "media" && data[key]?.url && !String(data[key].alt ?? "").trim()) issues.push({ level: "warning", field: key, message: `${key} has no alt text` });
  }
  const penalty = { error: 20, warning: 8, tip: 3 };
  const score = Math.max(0, 100 - issues.reduce((sum, i) => sum + penalty[i.level], 0));
  return { score, issues, stats: { words, headings: headings.length, images: images.length, internalLinks: links.length, titleLength: title.length, descriptionLength: desc?.length ?? 0 } };
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** SEO checks for agents and people, plus sitemap.xml and robots.txt. */
export function seo(opts: SeoOptions = {}) {
  const audited = (c: ModuleContext) => c.models().filter((m) => (opts.models ? opts.models.includes(m.name) : !!slugField(m)));
  const pathOf = (model: Model, e: Record<string, unknown> & { id: string; locale: string }) => {
    if (opts.path) return opts.path(model.name, e);
    const slug = slugField(model) ? e[slugField(model)!] : undefined;
    return `/${model.name}/${slug ?? e.id}`;
  };
  const modelOf = (c: ModuleContext, name: string) => {
    const m = audited(c).find((x) => x.name === name);
    if (!m) throw new AicmsError("not_found", `SEO doesn't cover model "${name}". Covered: ${audited(c).map((x) => x.name).join(", ") || "none"}`);
    return m;
  };

  return defineModule({
    name: "seo",
    description: "Scores entries for search engines with concrete fixes, and serves sitemap.xml and robots.txt.",
    provides: ["seo"],
    uses: ["*"],
    checks:
      opts.checks === false
        ? {}
        : {
            // Errors and warnings from the audit, for the fields this change touches. Tips stay in seo.audit.
            audit: ({ model, data, op, changed }) => {
              if (opts.models ? !opts.models.includes(model.name) : !slugField(model)) return [];
              return auditEntry(model, data)
                .issues.filter((i) => i.level !== "tip" && (op === "create" || !i.field || changed.includes(i.field.split(".")[0])))
                .map((i) => ({ level: "warning" as const, field: i.field, message: `SEO: ${i.message}` }));
            },
          },
    actions: {
      audit: action({
        description: "Score one entry 0–100 for SEO with concrete fixes: title and description length, slug, word count, heading order, image alt text, internal links. Includes your unsubmitted drafts, so run it before cms_submit.",
        scope: "seo:audit",
        readOnly: true,
        input: z.strictObject({ model: z.string().min(1), id: z.string().min(1) }),
        async run({ input, ctx }) {
          const m = modelOf(ctx, input.model);
          const e = await ctx.get(m.name, input.id);
          if (!e) throw new AicmsError("not_found", `No ${m.name} with id ${input.id}`);
          return { model: m.name, id: input.id, title: displayTitle(m, e), ...auditEntry(m, e) };
        },
      }),
      report: action({
        description: "SEO overview of a model: average score, the most common problems and the weakest entries.",
        scope: "seo:audit",
        readOnly: true,
        input: z.strictObject({ model: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
        async run({ input, ctx }) {
          const models = input.model ? [modelOf(ctx, input.model)] : audited(ctx);
          const rows: { model: string; id: string; title: string; score: number; issues: number }[] = [];
          const common = new Map<string, number>();
          const titles = new Map<string, string[]>();
          for (const m of models) {
            for (let offset = 0; ; offset += 200) {
              const page = await ctx.list(m.name, { limit: 200, offset });
              for (const e of page.items) {
                const a = auditEntry(m, e);
                const title = displayTitle(m, e);
                rows.push({ model: m.name, id: e.id, title, score: a.score, issues: a.issues.length });
                for (const i of a.issues) {
                  const key = i.message.replace(/\d+/g, "N");
                  common.set(key, (common.get(key) ?? 0) + 1);
                }
                const t = `${m.name}|${e.locale}|${title.toLowerCase()}`;
                if (title) titles.set(t, [...(titles.get(t) ?? []), e.id]);
              }
              if (offset + 200 >= page.total) break;
            }
          }
          const duplicates = [...titles.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ title: key.split("|")[2], ids }));
          return {
            entries: rows.length,
            averageScore: rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : null,
            commonProblems: [...common.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([problem, count]) => ({ problem, count })),
            duplicateTitles: duplicates,
            weakest: rows.sort((a, b) => a.score - b.score).slice(0, input.limit ?? 10),
          };
        },
      }),
    },
    routes: {
      "GET /sitemap.xml": async ({ url, ctx }) => {
        const base = (opts.siteUrl ?? url.origin).replace(/\/+$/, "");
        const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
        for (const m of audited(ctx)) {
          if (!ctx.isPublic(m.name)) continue;
          for (let offset = 0; ; offset += 500) {
            const page = await ctx.list(m.name, { limit: 500, offset });
            for (const e of page.items) {
              lines.push(`  <url><loc>${xml(base + pathOf(m, e))}</loc>${e.updatedAt ? `<lastmod>${e.updatedAt.slice(0, 10)}</lastmod>` : ""}</url>`);
            }
            if (offset + 500 >= page.total) break;
          }
        }
        lines.push("</urlset>", "");
        return new Response(lines.join("\n"), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
      },
      "GET /robots.txt": async ({ url }) => {
        const base = (opts.siteUrl ?? url.origin).replace(/\/+$/, "");
        return new Response(`User-agent: *\nAllow: /\nDisallow: /studio/\n\nSitemap: ${base}/sitemap.xml\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
      },
    },
  });
}
