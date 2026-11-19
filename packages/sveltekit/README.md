# @aicms/sveltekit

[AICMS](https://github.com/malkovych/aicms) in SvelteKit: load helpers that use SvelteKit's `fetch` and track dependencies, optional CDN cache headers, and live updates when content is published.

```ts
// src/lib/cms.ts
import { createAicms } from "@aicms/sveltekit"
import { PUBLIC_AICMS_URL } from "$env/static/public"
import type { Schema } from "./aicms-types"          // npx aicms types --out src/lib/aicms-types.ts
export const cms = createAicms<Schema>({ url: PUBLIC_AICMS_URL, maxAge: 60 })
```

```ts
// src/routes/blog/[slug]/+page.ts
import { cms } from "$lib/cms"
export const load = async (event) => ({ post: await cms(event).post.get({ slug: event.params.slug }) })
```

```svelte
<!-- src/routes/blog/[slug]/+page.svelte -->
<script>
  import { blocksToHtml } from "@aicms/sveltekit"
  let { data } = $props()
</script>
<h1>{data.post.title}</h1>
{@html blocksToHtml(data.post.body)}
```

```svelte
<!-- src/routes/+layout.svelte: refresh pages the moment an agent's change is approved -->
<script>
  import { onMount } from "svelte"
  import { invalidate } from "$app/navigation"
  import { liveUpdates } from "@aicms/sveltekit"
  import { PUBLIC_AICMS_URL } from "$env/static/public"
  let { children } = $props()
  onMount(() => liveUpdates({ url: PUBLIC_AICMS_URL, invalidate }))
</script>
{@render children()}
```

Every read depends on `aicms:all` and `aicms:<model>`, so `invalidate("aicms:post")` reruns exactly the loads that read posts. `blocksToHtml` escapes text and keeps only safe URLs; pass `renderers` for blocks such as `cta`.

MIT
