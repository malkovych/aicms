import { action, createCMS, defineModel, defineModule, field, sqlite } from "../src/index.ts";

export const tag = defineModel({
  name: "tag",
  fields: { name: field.text({ required: true }), slug: field.slug({ from: "name" }) },
  agent: { can: ["create", "update", "publish"] },
});

export const post = defineModel({
  name: "post",
  label: "Posts",
  fields: {
    title: field.text({ required: true, max: 120 }),
    slug: field.slug({ from: "title" }),
    body: field.blocks(["heading", "paragraph", "image", "list", "quote", "cta"]),
    tags: field.ref("tag", { many: true }),
    seo: field.object({ title: field.text({ max: 60 }), description: field.text({ max: 160 }) }),
    publishedAt: field.date({ indexed: true }),
  },
  agent: { guide: "Short sentences.", can: ["create", "update"] },
});

export const stats = defineModule({
  name: "stats",
  provides: ["stats"],
  uses: ["post"],
  actions: {
    word_count: action({
      description: "Count words in a post body",
      scope: "post:read",
      readOnly: true,
      input: { id: field.id({ required: true }) },
      async run({ input, ctx }) {
        const p = await ctx.get("post", input.id);
        const text = ((p?.body as any[]) ?? []).map((b) => b.text ?? "").join(" ");
        return { words: text.split(/\s+/).filter(Boolean).length };
      },
    }),
  },
});

export async function makeCms(extra: Partial<Parameters<typeof createCMS>[0]> = {}) {
  return createCMS({
    name: "Test site",
    db: sqlite(":memory:"),
    locales: ["en", "uk"],
    models: [post, tag],
    modules: [stats],
    public: ["post:read", "tag:read"],
    agents: {
      writer: { scopes: ["post:draft", "tag:draft"], review: "human" },
      tagger: { scopes: ["tag:draft"], review: "auto" },
      seo: { scopes: ["post:update.seo"], review: "auto" },
      editor: { scopes: ["post:read", "changesets:review"] },
      tiny: { scopes: ["tag:draft"], review: "auto", budget: { actionsPerHour: 3 } },
    },
    ...extra,
  });
}
