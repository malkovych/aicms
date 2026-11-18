# AICMS

**The CMS for AI agents.** Describe a model once and get REST, MCP tools, an admin and types. Agents draft, people decide.

[Website](https://malkovych.github.io/aicms/) · [Architecture](ARCHITECTURE.md) · [Українською](README.uk.md)

> Status: phase 1 works. On top of the kernel (schemas, Action Bus, changesets, SQLite, REST, MCP, CLI) there is now Studio with an Inbox for reviewing agents' changes, rollback, live events, TypeScript and Python SDKs, and adapters for Next.js and Astro. Modules and the ecosystem come next.

## Why

WordPress was built for people clicking through an admin. Agents need explicit schemas, typed tools, permission boundaries and a safe way to propose changes. AICMS is built around those needs:

- **One schema, every interface.** A model in `models/post.ts` becomes REST endpoints, MCP tools, validation, OpenAPI, `llms.txt`, Studio forms and TypeScript types.
- **Agents never write to production directly.** Their changes go into a changeset, pass checks and wait for review. Every action is logged, and any change can be rolled back.
- **Field-level permissions.** An agent with `post:update.seo` only sees the `seo` field in its tool schema.
- **Markdown in, blocks out.** Agents write Markdown; AICMS stores structured blocks.
- **Modules like Lego.** A module is one folder with one manifest that declares what it provides and requires.

## A whole site in two files

```ts
// models/post.ts
import { defineModel, field } from "aicms"

export default defineModel({
  name: "post",
  fields: {
    title: field.text({ required: true }),
    slug:  field.slug({ from: "title" }),
    body:  field.blocks(["paragraph", "heading", "image", "quote", "cta"]),
  },
  agent: { guide: "Short sentences, friendly expert tone", can: ["create", "update"] },
})
```

```ts
// aicms.config.ts
import { defineConfig, sqlite } from "aicms"

export default defineConfig({
  db: sqlite(".aicms/data.db"),
  public: ["post:read"],
  agents: { writer: { scopes: ["post:draft"], review: "human" } },
})
```

## Quick start

Requires Node.js 22.13 or newer (AICMS uses the built-in `node:sqlite`).

```bash
git clone https://github.com/malkovych/aicms && cd aicms
npm install && npm run build
cd examples/blog
node ../../dist/cli.js agent create writer   # prints a token once
node ../../dist/cli.js dev                   # Studio, REST, MCP and events on :4321
```

`dev` prints a one-time Studio sign-in link. Open it, and Studio keeps you signed in for 30 days. `aicms login` makes a new link at any time.

Connect an MCP client (Claude Code, for example) with the token:

```bash
claude mcp add --transport http aicms http://localhost:4321/mcp --header "Authorization: Bearer <token>"
```

Or run it over stdio without a server:

```bash
node ../../dist/cli.js mcp --agent writer
```

Whatever the agent submits appears in Studio's Inbox with a before/after diff. You can also review from the terminal:

```bash
node ../../dist/cli.js changes
node ../../dist/cli.js merge <changeset-id>
node ../../dist/cli.js reject <changeset-id> --comment "Shorter title, please"
node ../../dist/cli.js revert <changeset-id>        # undo something already published
```

## Studio

Studio is the admin for people, served at `/studio/`:

- **Inbox:** agents' changesets with a word-level diff. Approve, request changes (the comment goes back to the agent) or close. Undo a published changeset in one click.
- **Content:** forms generated from your models, a Markdown editor with preview, and every entry's history with one-click restore.
- **Agents:** scopes, review mode, budget use and pending work; issue or revoke tokens.
- **Activity:** every action by people and agents, live.

English and Ukrainian, light and dark themes, works on a phone.

## Clients and frameworks

```ts
// any JavaScript runtime
import { createClient } from "@aicms/client"
import type { Schema } from "./aicms-types"            // npx aicms types --out aicms-types.ts

const cms = createClient<Schema>({ url: "http://localhost:4321", token })
const post = await cms.post.get({ slug: "welcome-to-aicms" })   // typed
for await (const e of cms.events()) console.log(e.event)       // live
```

```python
# Python, standard library only
from aicms import Client
cms = Client("http://localhost:4321", token="aicms_...")
cms.post.draft(title="Hello from Python", body="Markdown **works**")
cms.submit(note="First post")
```

| Package | What it is |
|---|---|
| [`@aicms/client`](packages/client) | Typed client, live events and safe `blocksToHtml`, no dependencies |
| [`@aicms/next`](packages/next) | Reads cached with per-model tags, revalidation from webhooks, `<Blocks />` |
| [`@aicms/astro`](packages/astro) | Content Layer loader with pre-rendered blocks |
| [`aicms` (Python)](sdk/python) | Python client, standard library only |

## What's in the repository

| Piece | Where |
|---|---|
| Field builders, models, Markdown ↔ blocks, slugs | `src/schema/` |
| Action Bus, policies, changesets, rollback, modules, live feed | `src/kernel/` |
| SQLite store: entries, versions, changesets, events, media, tokens | `src/store/` |
| REST, OpenAPI, discovery, MCP, SSE, Studio serving | `src/gates/` |
| CLI and `aicms types` | `src/cli.ts`, `src/typegen.ts` |
| Studio (React + Framer Motion, shipped prebuilt in `dist/studio`) | `studio/` |
| TypeScript client and framework adapters | `packages/` |
| Python client | `sdk/python/` |

## Development

```bash
npm test             # kernel, gates, SDK and adapters (node:test, no build step)
npm run test:python  # Python client
npm run typecheck
npm run build        # dist/ for the CLI, the packages and Studio
npm run studio       # Studio dev server on :5173, proxied to a running `aicms dev`
```

## License

[MIT](LICENSE). AICMS is free for any use, including commercial: build sites, products and services on it without asking or paying. If the project ever needs funding, it will come from donations, never from a paid edition.
