import { action, defineModule, field } from "aicms"

// A tiny module: one read-only Action that checks a post against house rules,
// and a hook that reacts to merges. It may only touch the models it "uses".
export default defineModule({
  name: "editorial",
  description: "House-style checks for posts",
  provides: ["editorial"],
  uses: ["post"],

  actions: {
    check: action({
      description: "Check a post against the house rules before submitting: title length, excerpt, cover, body length, SEO fields.",
      scope: "editorial:check",
      readOnly: true,
      input: { id: field.id({ required: true }) },
      async run({ input, ctx }) {
        const post = await ctx.get("post", input.id)
        if (!post) return { ok: false, problems: [`No post ${input.id}`] }
        const body = Array.isArray(post.body) ? post.body : []
        const words = body
          .map((b: any) => [b.text, ...(Array.isArray(b.items) ? b.items : [])].filter(Boolean).join(" "))
          .join(" ")
          .split(/\s+/)
          .filter(Boolean).length
        const problems: string[] = []
        if (String(post.title ?? "").length > 70) problems.push("Title is longer than 70 characters")
        if (!post.excerpt) problems.push("Add an excerpt")
        if (!post.cover) problems.push("Add a cover image")
        if (words < 150) problems.push(`Body has ${words} words; aim for at least 150`)
        const seo = (post.seo ?? {}) as { title?: string; description?: string }
        if (!seo.description) problems.push("Add seo.description")
        return { ok: problems.length === 0, words, problems }
      },
    }),
  },

  on: {
    "changeset.merged": async ({ payload }) => {
      const posts = payload.entries.filter((e: any) => e.model === "post")
      if (posts.length) console.log(`[editorial] ${posts.length} post(s) published by ${payload.mergedBy}`)
    },
  },
})
