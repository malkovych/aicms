import { defineConfig, sqlite } from "aicms"
import { i18n, media, search, seo } from "aicms/modules"
import editorial from "./modules/editorial/module.ts"

export default defineConfig({
  name: "Demo blog",
  db: sqlite(".aicms/data.db"),
  locales: ["en", "uk"],
  // Requests without a token may read posts and tags.
  public: ["post:read", "tag:read"],
  modules: [editorial, seo({ siteUrl: "https://blog.example.com" }), search(), media(), i18n()],
  agents: {
    // Writes posts and tags; a person approves every changeset.
    writer: {
      scopes: ["post:draft", "tag:draft", "editorial:check", "seo:audit", "media:upload", "media:read"],
      review: "human",
      budget: { actionsPerHour: 300 },
    },
    // Only touches SEO fields and alt text; merged automatically when checks pass.
    seo: { scopes: ["post:update.seo", "tag:read", "seo:audit", "media:read", "media:update"], review: "auto" },
    // Drafts Ukrainian versions of posts for a person to approve.
    translator: { scopes: ["post:read", "tag:read", "i18n:translate"], review: "human" },
    // Reviews and publishes other agents' work.
    editor: { scopes: ["post:read", "tag:read", "changesets:review"] },
  },
})
