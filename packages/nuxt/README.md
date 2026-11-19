# @aicms/nuxt

A Nuxt module for [AICMS](https://github.com/malkovych/aicms): an auto-imported client, SSR-friendly data fetching, and a webhook that clears Nitro's page cache when content is published.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@aicms/nuxt"],
  aicms: { url: "https://cms.example.com" },        // or NUXT_PUBLIC_AICMS_URL
  routeRules: { "/blog/**": { swr: 3600 } },         // cached until AICMS says otherwise
})
```

```vue
<!-- pages/blog/[slug].vue -->
<script setup lang="ts">
import type { Schema } from "~/aicms-types"          // npx aicms types --out aicms-types.ts
const route = useRoute()
const { data: post } = await useAicmsData("post-" + route.params.slug, (cms) =>
  useAicms<Schema>().post.get({ slug: String(route.params.slug) }))
</script>

<template>
  <article v-if="post">
    <h1>{{ post.title }}</h1>
    <div v-html="blocksToHtml(post.body)" />
  </article>
</template>
```

Point an AICMS webhook at your site so published changes show up right away:

```ts
// aicms.config.ts
webhooks: [{ url: "https://your-site.com/api/_aicms/webhook", events: ["changeset.merged"], secret: process.env.AICMS_WEBHOOK_SECRET }]
```

and set the same secret as `NUXT_AICMS_WEBHOOK_SECRET`. The handler checks the signature, clears Nitro's cached routes and handlers, and calls the `aicms:merged` Nitro hook with the payload. A token for non-public models goes in `NUXT_AICMS_TOKEN`; it is only used on the server.

MIT
