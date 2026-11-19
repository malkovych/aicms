import { action, createCMS, defineModel, defineModule, field, PostgresStore, pgliteDriver, sqlite, type SqlDriver } from "../src/index.ts";

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

/**
 * AICMS_TEST_DB=pglite runs every test against Postgres (PGlite, in-process).
 * One database per test process; each test starts from an empty schema.
 */
let shared: Promise<SqlDriver> | undefined;
async function testStore() {
  if (process.env.AICMS_TEST_DB !== "pglite") return undefined;
  shared ??= import("@electric-sql/pglite").then(({ PGlite }) => pgliteDriver(new PGlite()));
  const driver = await shared;
  await driver.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  return new PostgresStore({ ...driver, close: async () => {} });
}

export async function makeCms(extra: Partial<Parameters<typeof createCMS>[0]> = {}, opts: Parameters<typeof createCMS>[1] = {}) {
  const store = opts.store ?? (await testStore());
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
  }, { ...opts, ...(store ? { store } : {}) });
}
