import { defineModel, field } from "aicms"

export default defineModel({
  name: "post",
  label: "Posts",
  fields: {
    title: field.text({ required: true, max: 120 }),
    slug: field.slug({ from: "title" }),
    excerpt: field.text({ max: 280 }),
    cover: field.media(),
    body: field.blocks(["heading", "paragraph", "image", "list", "quote", "cta"]),
    publishedAt: field.date({ indexed: true }),
  },
  agent: { guide: "Short sentences, friendly expert tone.", can: ["create", "update"] },
})
