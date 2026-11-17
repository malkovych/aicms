import { defineConfig, sqlite } from "aicms"
import editorial from "./modules/editorial/module.ts"

export default defineConfig({
  name: "Demo blog",
  db: sqlite(".aicms/data.db"),
  locales: ["en", "uk"],
  // Requests without a token may read posts and tags.
  public: ["post:read", "tag:read"],
  modules: [editorial],
  agents: {
    // Writes posts and tags; a person approves every changeset.
    writer: { scopes: ["post:draft", "tag:draft", "editorial:check"], review: "human", budget: { actionsPerHour: 300 } },
    // Only touches SEO fields; merged automatically when checks pass.
    seo: { scopes: ["post:update.seo", "tag:read"], review: "auto" },
    // Reviews and publishes other agents' work.
    editor: { scopes: ["post:read", "tag:read", "changesets:review"] },
  },
})
