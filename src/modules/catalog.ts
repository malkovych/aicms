import type { ModuleDef } from "../kernel/modules.ts";
import { commerce } from "./commerce.ts";
import { gitSync } from "./git-sync.ts";
import { manualPayments, stripe } from "./payments.ts";
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
  { name: "commerce", importName: "commerce", title: "Commerce", summary: "Products, orders and checkout with server-side prices; needs a payments provider.", create: (o) => commerce(o), example: 'commerce({ currency: "EUR" })' },
  { name: "manual-payments", importName: "manualPayments", title: "Manual payments", summary: "Bank transfer or cash on delivery: orders wait until a person marks them paid.", create: (o) => manualPayments(o), example: 'manualPayments({ instructions: "IBAN …" })' },
  { name: "stripe", importName: "stripe", title: "Stripe", summary: "Stripe Checkout pages, signed webhooks and refunds.", create: (o) => stripe(o), example: "stripe({ secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET })" },
];

export const findCatalog = (name: string) => catalog.find((c) => c.name === name || c.importName === name);
