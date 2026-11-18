# @aicms/next

[AICMS](https://github.com/malkovych/aicms) in a Next.js App Router project: cached reads tagged per model, revalidation from AICMS webhooks, and a `<Blocks />` component for Server Components.

```ts
// lib/cms.ts
import { createAicms } from "@aicms/next"
import type { Schema } from "./aicms-types"   // npx aicms types --out lib/aicms-types.ts
export const cms = createAicms<Schema>({ url: process.env.AICMS_URL! })
```

```tsx
// app/blog/[slug]/page.tsx
import { Blocks } from "@aicms/next"
import { cms } from "@/lib/cms"

export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const post = await cms.post.get({ slug: (await params).slug })
  return <article><h1>{post.title}</h1><Blocks value={post.body} /></article>
}
```

```ts
// app/api/aicms/route.ts — point an AICMS webhook here
import { revalidateTag } from "next/cache"
import { createRevalidateHandler } from "@aicms/next"
export const POST = createRevalidateHandler({ secret: process.env.AICMS_WEBHOOK_SECRET, revalidateTag })
```

```ts
// aicms.config.ts
webhooks: [{ url: "https://your-site.com/api/aicms", events: ["changeset.merged"], secret: process.env.AICMS_WEBHOOK_SECRET }]
```

Every read is tagged `aicms` and `aicms:<model>` and stays cached until a merge touches that model (or pass `revalidate: 60` for time-based caching). Custom blocks: `<Blocks value={post.body} components={{ cta: ({ block }) => <Button href={block.href}>{block.label}</Button> }} />`.

MIT
