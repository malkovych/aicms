// @aicms/astro — load AICMS entries into Astro's Content Layer.
//
//   // src/content.config.ts
//   import { defineCollection } from "astro:content"
//   import { aicmsLoader } from "@aicms/astro"
//   export const collections = {
//     posts: defineCollection({ loader: aicmsLoader({ url: import.meta.env.AICMS_URL, model: "post", render: "body" }) }),
//   }

import { blocksToHtml, createClient, type Block, type HtmlOptions, type ListResult } from "@aicms/client";

export * from "@aicms/client";

/** The parts of Astro's LoaderContext this loader uses (kept local so Astro stays an optional peer). */
export interface LoaderContext {
  store: {
    clear(): void;
    set(entry: { id: string; data: Record<string, unknown>; digest?: string; rendered?: { html: string } }): boolean;
  };
  parseData<T extends Record<string, unknown>>(props: { id: string; data: T }): Promise<T>;
  generateDigest(data: Record<string, unknown> | string): string;
  logger: { info(message: string): void };
}

export interface AicmsLoaderOptions {
  url: string;
  model: string;
  /** Needed only if the model isn't publicly readable. */
  token?: string;
  locale?: string;
  /** Exact-match filters, as in `<model>.list`. */
  where?: Record<string, string | number | boolean | null>;
  /** A blocks field to pre-render, so `render(entry)` gives you `<Content />`. */
  render?: string;
  /** Custom HTML for directive blocks such as `cta`. */
  renderers?: HtmlOptions["renderers"];
  fetch?: typeof fetch;
}

export function aicmsLoader(opts: AicmsLoaderOptions) {
  return {
    name: `aicms:${opts.model}`,
    async load({ store, parseData, generateDigest, logger }: LoaderContext): Promise<void> {
      const cms = createClient({ url: opts.url, token: opts.token, fetch: opts.fetch });
      const items: ListResult<Record<string, unknown>>["items"] = [];
      for (let offset = 0; ; ) {
        const page = await cms.call<ListResult<Record<string, unknown>>>(`${opts.model}.list`, {
          limit: 100,
          offset,
          format: "blocks",
          ...(opts.locale ? { locale: opts.locale } : {}),
          ...(opts.where ? { where: opts.where } : {}),
        });
        items.push(...page.items);
        offset += page.items.length;
        if (!page.items.length || offset >= page.total) break;
      }
      store.clear();
      for (const item of items) {
        const data = await parseData({ id: item.id, data: item as Record<string, unknown> });
        const blocks = opts.render ? item[opts.render] : undefined;
        store.set({
          id: item.id,
          data,
          digest: generateDigest(item as Record<string, unknown>),
          ...(Array.isArray(blocks) ? { rendered: { html: blocksToHtml(blocks as Block[], { renderers: opts.renderers }) } } : {}),
        });
      }
      logger.info(`Loaded ${items.length} ${opts.model} entries from AICMS`);
    },
  };
}
