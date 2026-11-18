import { z } from "zod";
import { action } from "../kernel/action.ts";
import { defineModule, type ModuleContext } from "../kernel/modules.ts";
import { entryText, snippet, tokenize } from "./text.ts";

export interface SearchHit {
  model: string;
  id: string;
  locale: string;
  title: string;
  field?: string;
  snippet: string;
  score: number;
}

/** The "search" capability: what cms.search calls when a search module is installed. */
export interface SearchService {
  query(input: { query: string; models: string[]; locale?: string; limit: number }): Promise<SearchHit[]>;
}

export interface SearchOptions {
  /** Models to index. Default: all. */
  models?: string[];
}

/**
 * Full-text search with ranking (TF-IDF, title boost, prefix matching, any language).
 * Keeps an index current on every merge; `cms.search` uses it automatically.
 */
export function search(opts: SearchOptions = {}) {
  let ctx: ModuleContext | undefined;
  const indexed = (model: string) => !opts.models || opts.models.includes(model);

  async function indexEntry(c: ModuleContext, id: string) {
    const e = await c.entry(id);
    if (!e || !indexed(e.model)) return c.text.remove(id);
    const model = c.models().find((m) => m.name === e.model)!;
    const { title, body } = entryText(model, e.data);
    const terms: Record<string, number> = {};
    for (const t of tokenize(title)) terms[t] = (terms[t] ?? 0) + 3;
    for (const t of tokenize(body)) terms[t] = (terms[t] ?? 0) + 1;
    await c.text.upsert({ id, model: e.model, locale: e.locale, title, body, terms });
  }

  async function reindex(c: ModuleContext) {
    await c.text.clear();
    let count = 0;
    for (const m of c.models()) {
      if (!indexed(m.name)) continue;
      for (let offset = 0; ; offset += 200) {
        const page = await c.list(m.name, { limit: 200, offset });
        for (const item of page.items) {
          await indexEntry(c, item.id);
          count++;
        }
        if (offset + 200 >= page.total) break;
      }
    }
    return count;
  }

  const service: SearchService = {
    async query({ query, models, locale, limit }) {
      if (!ctx) return [];
      const terms = tokenize(query);
      const hits = await ctx.text.search({ terms, prefixLast: !/\s$/.test(query), models: models.filter(indexed), locale, limit });
      return hits.map((h) => ({ model: h.model, id: h.id, locale: h.locale, title: h.title, snippet: snippet(h.body || h.title, terms), score: Math.round(h.score * 100) / 100 }));
    },
  };

  return defineModule({
    name: "search",
    description: "Full-text search with ranking, prefix matching and any language. Replaces the simple scan behind cms.search.",
    provides: ["search"],
    uses: ["*"],
    services: { search: service },
    async setup(c) {
      ctx = c;
      if ((await c.text.count()) === 0) await reindex(c);
    },
    on: {
      "changeset.merged": async ({ payload, ctx: c }) => {
        for (const e of payload.entries ?? []) await indexEntry(c, e.id);
      },
    },
    actions: {
      reindex: action({
        description: "Rebuild the search index from scratch.",
        scope: "search:admin",
        input: z.strictObject({}),
        async run({ ctx: c }) {
          // Index what is published, not the caller's drafts: use the module's own context.
          return { indexed: await reindex(ctx ?? c) };
        },
      }),
    },
  });
}
