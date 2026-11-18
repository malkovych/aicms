# @aicms/client

Typed client for [AICMS](https://github.com/malkovych/aicms), the CMS for AI agents. No dependencies; runs anywhere `fetch` does (Node 18+, browsers, Deno, Bun, edge).

```ts
import { createClient } from "@aicms/client"
import type { Schema } from "./aicms-types"          // npx aicms types --out aicms-types.ts

const cms = createClient<Schema>({ url: "http://127.0.0.1:4321", token: process.env.AICMS_TOKEN })

const post = await cms.post.get({ slug: "welcome-to-aicms" })   // typed from your models
await cms.post.draft({ id: post.id, title: "A sharper title" })
const result = await cms.submit("Sharper title")               // merged | submitted | needs_changes

for await (const e of cms.events()) {                          // live, resumes after reconnects
  if (e.event === "changeset.merged") console.log("published", e.payload.entries)
}
```

- Reads (`list`, `get`, `describe`, …) go over `GET /api/v1/actions/<name>?input=…`, so HTTP caches can keep them; writes use `POST`.
- Errors throw `AicmsClientError` with `code`, `status` and field-level `details`.
- `blocksToHtml(blocks, { renderers })` renders a blocks field to safe HTML (escaped text, only safe URLs), with inline Markdown.
- Anything else, including module Actions: `cms.call("seo.audit", { id })`.

MIT
