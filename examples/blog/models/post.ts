import { defineModel, field } from "aicms"

export default defineModel({
  name: "post",
  label: "Posts",
  description: "Blog articles",
  fields: {
    title: field.text({ required: true, max: 120 }),
    slug: field.slug({ from: "title" }),
    excerpt: field.text({ max: 280, description: "One or two sentences for cards and previews" }),
    cover: field.media(),
    body: field.blocks(["heading", "paragraph", "image", "list", "quote", "code", "cta", "callout"]),
    tags: field.ref("tag", { many: true }),
    seo: field.object({
      title: field.text({ max: 60 }),
      description: field.text({ max: 160 }),
    }),
    publishedAt: field.date({ indexed: true }),
  },
  agent: {
    guide: "Short sentences, friendly expert tone. One idea per paragraph. No clichés.",
    examples: ["slug:welcome-to-aicms"],
    // Agents may write posts, but publishing stays with a person.
    can: ["create", "update"],
  },
})
