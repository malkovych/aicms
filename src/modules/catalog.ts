import type { ModuleDef } from "../kernel/modules.ts";
import { gitSync } from "./git-sync.ts";
import { i18n } from "./i18n.ts";
import { media } from "./media.ts";
import { search } from "./search.ts";
import { seo } from "./seo.ts";

export interface CatalogEntry {
  /** Module name, as in `aicms add <name>`. */
  name: string;
  /** Named export of "aicms/modules". */
  importName: string;
  title: string;
  summary: string;
  create(options?: Record<string, unknown>): ModuleDef;
  /** How it is written in aicms.config.ts. */
  example: string;
}

/** Official modules that ship with AICMS. */
export const catalog: CatalogEntry[] = [
  { name: "seo", importName: "seo", title: "SEO", summary: "Scores entries 0–100 with concrete fixes; serves sitemap.xml and robots.txt.", create: (o) => seo(o), example: 'seo({ siteUrl: "https://example.com" })' },
  { name: "search", importName: "search", title: "Search", summary: "Ranked full-text search in any language; cms.search uses it automatically.", create: (o) => search(o), example: "search()" },
  { name: "media", importName: "media", title: "Media", summary: "Media library: uploads and URL imports, image sizes, alt text, served under /media.", create: (o) => media(o), example: "media()" },
  { name: "i18n", importName: "i18n", title: "Translations", summary: "Links entries across locales, lists what's missing, drafts translations.", create: (o) => i18n(o), example: "i18n()" },
  { name: "git-sync", importName: "gitSync", title: "git-sync", summary: "Mirrors content to Markdown files and turns file edits into changesets.", create: (o) => gitSync(o), example: 'gitSync({ dir: "content" })' },
];

export const findCatalog = (name: string) => catalog.find((c) => c.name === name || c.importName === name);
