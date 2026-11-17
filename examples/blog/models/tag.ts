import { defineModel, field } from "aicms"

export default defineModel({
  name: "tag",
  label: "Tags",
  fields: {
    name: field.text({ required: true, max: 40 }),
    slug: field.slug({ from: "name" }),
  },
  // Tags are low-risk: agents with review "auto" may publish them.
  agent: { can: ["create", "update", "publish"] },
})
