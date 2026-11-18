# @aicms/astro

Load [AICMS](https://github.com/malkovych/aicms) entries into Astro's Content Layer (Astro 5+), with block fields pre-rendered to HTML.

```ts
// src/content.config.ts
import { defineCollection } from "astro:content"
import { aicmsLoader } from "@aicms/astro"

export const collections = {
  posts: defineCollection({ loader: aicmsLoader({ url: import.meta.env.AICMS_URL, model: "post", render: "body" }) }),
}
```

```astro
---
import { getCollection, render } from "astro:content"
const posts = await getCollection("posts")
const { Content } = await render(posts[0])
---
<h1>{posts[0].data.title}</h1>
<Content />
```

Options: `token` (for models that aren't public), `locale`, `where` (exact-match filters), `render` (a blocks field to pre-render), `renderers` (HTML for directive blocks such as `cta`). For on-demand pages, use `@aicms/client` directly.

MIT
