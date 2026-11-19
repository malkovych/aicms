import { defineConfig } from "aicms"
import { d1 } from "aicms/edge"
import { media, search, seo } from "aicms/modules"
import post from "./models/post"

// On the edge, models are imported explicitly (there is no folder to scan).
export default defineConfig({
  name: "Edge blog",
  db: d1("DB"),
  models: [post],
  public: ["post:read"],
  modules: [seo({ siteUrl: "https://blog.example.com" }), search(), media({ storage: { r2: "MEDIA" } })],
  agents: {
    writer: { scopes: ["post:draft", "seo:audit", "media:upload", "media:read"], review: "human" },
  },
})
