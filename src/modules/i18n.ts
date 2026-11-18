import { z } from "zod";
import { action } from "../kernel/action.ts";
import { AicmsError } from "../kernel/errors.ts";
import { defineModule, type ModuleContext } from "../kernel/modules.ts";
import { displayTitle, uniqueFields } from "../schema/model.ts";

export interface I18nOptions {
  /** Models whose entries get translations. Default: all. */
  models?: string[];
}

// Storage: "g:<group>" → { [locale]: entryId }, "e:<entryId>" → group.
type Group = Record<string, string>;

/** Translations: links entries across locales, shows what's missing, drafts translations for agents. */
export function i18n(opts: I18nOptions = {}) {
  const covered = (model: string) => !opts.models || opts.models.includes(model);

  async function groupOf(ctx: ModuleContext, id: string): Promise<{ key: string; members: Group } | null> {
    const key = await ctx.kv.get<string>(`e:${id}`);
    if (!key) return null;
    return { key, members: (await ctx.kv.get<Group>(`g:${key}`)) ?? {} };
  }

  async function source(ctx: ModuleContext, id: string) {
    const e = await ctx.entry(id);
    if (!e) throw new AicmsError("not_found", `No entry ${id}`);
    if (!covered(e.model)) throw new AicmsError("invalid", `Model "${e.model}" isn't translated (i18n covers: ${opts.models?.join(", ")})`);
    if (!ctx.readable(e.model)) throw new AicmsError("forbidden", `You can't read ${e.model} entries`);
    return e;
  }

  async function link(ctx: ModuleContext, a: { id: string; locale: string }, b: { id: string; locale: string }) {
    const g = (await groupOf(ctx, a.id)) ?? { key: a.id, members: { [a.locale]: a.id } };
    if (g.members[b.locale] && g.members[b.locale] !== b.id) throw new AicmsError("conflict", `${a.id} already has a ${b.locale} translation: ${g.members[b.locale]}`);
    g.members[b.locale] = b.id;
    await ctx.kv.set(`g:${g.key}`, g.members);
    await ctx.kv.set(`e:${a.id}`, g.key);
    await ctx.kv.set(`e:${b.id}`, g.key);
    return g;
  }

  async function translations(ctx: ModuleContext, id: string) {
    const e = await source(ctx, id);
    const g = (await groupOf(ctx, id))?.members ?? { [e.locale]: id };
    const model = ctx.models().find((m) => m.name === e.model)!;
    const out: Record<string, { id: string; title: string; published: boolean } | null> = {};
    for (const locale of ctx.site.locales) {
      const member = g[locale];
      if (!member) {
        out[locale] = null;
        continue;
      }
      const t = await ctx.entry(member);
      out[locale] = t ? { id: member, title: displayTitle(model, t.data), published: t.version > 0 } : null;
    }
    return { id, model: e.model, locale: e.locale, translations: out, missing: Object.entries(out).filter(([, v]) => !v).map(([l]) => l) };
  }

  return defineModule({
    name: "i18n",
    description: "Translations: links entries across locales, lists what's missing, drafts translations.",
    provides: ["i18n"],
    uses: opts.models ?? ["*"],
    actions: {
      translations: action({
        description: "The translations of an entry: for each site locale, the linked entry or null if it's missing.",
        readOnly: true,
        input: z.strictObject({ id: z.string().min(1) }),
        run: ({ input, ctx }) => translations(ctx, input.id),
      }),
      missing: action({
        description: "Entries of a model in the default locale that have no translation yet, per locale.",
        readOnly: true,
        input: z.strictObject({ model: z.string().min(1), locale: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
        async run({ input, ctx }) {
          if (!covered(input.model) || !ctx.models().some((m) => m.name === input.model)) throw new AicmsError("not_found", `i18n doesn't cover "${input.model}"`);
          if (!ctx.readable(input.model)) throw new AicmsError("forbidden", `You can't read ${input.model} entries`);
          const model = ctx.models().find((m) => m.name === input.model)!;
          const targets = (input.locale ? [input.locale] : ctx.site.locales).filter((l) => l !== ctx.site.defaultLocale);
          const missing: Record<string, { id: string; title: string }[]> = Object.fromEntries(targets.map((l) => [l, []]));
          for (let offset = 0; ; offset += 200) {
            const page = await ctx.list(input.model, { locale: ctx.site.defaultLocale, limit: 200, offset });
            for (const e of page.items) {
              const g = (await groupOf(ctx, e.id))?.members ?? {};
              for (const l of targets) if (!g[l]) missing[l].push({ id: e.id, title: displayTitle(model, e) });
            }
            if (offset + 200 >= page.total) break;
          }
          const limit = input.limit ?? 50;
          return { model: input.model, missing: Object.fromEntries(Object.entries(missing).map(([l, items]) => [l, { count: items.length, items: items.slice(0, limit) }])) };
        },
      }),
      translate: action({
        description: "Draft a translation of an entry into another locale. Pass the translated fields in `fields` (block fields accept Markdown); everything else is copied from the source. It is linked to the source and goes through review like any draft.",
        scope: "i18n:translate",
        input: z.strictObject({
          id: z.string().min(1).describe("The entry to translate"),
          locale: z.string().min(1).describe("Target locale"),
          fields: z.record(z.string(), z.unknown()).optional().describe("Translated field values"),
        }),
        async run({ input, ctx }) {
          const e = await source(ctx, input.id);
          if (!ctx.site.locales.includes(input.locale)) throw new AicmsError("invalid", `Unknown locale "${input.locale}". Site locales: ${ctx.site.locales.join(", ")}`);
          if (input.locale === e.locale) throw new AicmsError("invalid", `${input.id} is already in ${e.locale}`);
          const existing = (await groupOf(ctx, input.id))?.members[input.locale];
          if (existing && (await ctx.entry(existing))) throw new AicmsError("conflict", `${input.id} already has a ${input.locale} translation: ${existing}. Draft changes to it instead.`);
          const model = ctx.models().find((m) => m.name === e.model)!;
          const unknown = Object.keys(input.fields ?? {}).filter((k) => !(k in model.fields));
          if (unknown.length) throw new AicmsError("invalid", `Model "${model.name}" has no field ${unknown.join(", ")}`);
          // Unique fields (slugs) are per locale, so the source's values are fine to keep unless translated.
          const data = { ...e.data, ...input.fields, locale: input.locale };
          const draft = await ctx.draft(model.name, data);
          await link(ctx, e, { id: draft.id, locale: input.locale });
          return {
            ...draft,
            translationOf: input.id,
            note: uniqueFields(model).some((f) => !(input.fields ?? {})[f]) ? `Kept ${uniqueFields(model).join(", ")} from the source; translate them too if they should differ.` : undefined,
          };
        },
      }),
      link: action({
        description: "Mark two existing entries of the same model as translations of each other.",
        scope: "i18n:translate",
        input: z.strictObject({ id: z.string().min(1), to: z.string().min(1) }),
        async run({ input, ctx }) {
          const a = await source(ctx, input.id);
          const b = await source(ctx, input.to);
          if (a.model !== b.model) throw new AicmsError("invalid", `${input.id} is a ${a.model}, ${input.to} is a ${b.model}`);
          if (a.locale === b.locale) throw new AicmsError("invalid", `Both entries are in ${a.locale}`);
          await link(ctx, a, b);
          return translations(ctx, input.id);
        },
      }),
    },
    on: {
      // A deleted entry leaves its group.
      "changeset.merged": async ({ payload, ctx }) => {
        for (const e of payload.entries ?? []) {
          if (e.op !== "delete") continue;
          const g = await groupOf(ctx, e.id);
          if (!g) continue;
          for (const [locale, id] of Object.entries(g.members)) if (id === e.id) delete g.members[locale];
          await ctx.kv.delete(`e:${e.id}`);
          if (Object.keys(g.members).length) await ctx.kv.set(`g:${g.key}`, g.members);
          else await ctx.kv.delete(`g:${g.key}`);
        }
      },
    },
  });
}
