# AICMS

**The CMS for AI agents.** Describe a model once and get REST, MCP tools, an admin and types. Agents draft, people decide.

[Website](https://malkovych.github.io/aicms/) · [Architecture](ARCHITECTURE.md) · [Українською](README.uk.md)

> Status: phase 4 works. People hand agents work as briefs; every change passes content checks before a person sees it; approved changes can wait for their publish time; Studio has a ⌘K palette. Underneath: the kernel, Studio, modules and adapters from phases 0–2, and from phase 3 Postgres and Cloudflare Workers, live presence, a module registry, A2A and commerce.

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
npm create aicms@latest my-site
cd my-site
npm run dev        # Studio, REST, MCP and events on :4321
```

`create-aicms` installs `aicms` and writes `aicms.config.ts`, two example models, `.mcp.json` and `AGENTS.md`. `dev` prints a one-time Studio sign-in link. Open it, and Studio keeps you signed in for 30 days. `npx aicms login` makes a new link at any time.

Coding agents that read `.mcp.json` (Claude Code, Cursor) get the site's tools as the `writer` agent when you open the folder, over stdio, with no token. Any other agent runs the same server with `npx aicms mcp --agent writer`. To connect over HTTP, issue a token:

```bash
npx aicms agent create writer      # prints a token once
claude mcp add --transport http aicms http://localhost:4321/mcp --header "Authorization: Bearer <token>"
```

Whatever the agent submits appears in Studio's Inbox with a before/after diff. You can also review from the terminal:

```bash
npx aicms changes
npx aicms merge <changeset-id>
npx aicms reject <changeset-id> --comment "Shorter title, please"
npx aicms revert <changeset-id>        # undo something already published
```

From source instead: `git clone https://github.com/malkovych/aicms && cd aicms && npm install && npm run build`, then `node ../../dist/cli.js dev` in `examples/blog`.

## Briefs, checks and schedules

People hand agents work as **briefs**: "Write a post about the spring menu, publish Friday at 9:00". An agent finds its briefs with `cms_briefs`, asks a person when it's stuck (`cms_brief_update` with a question), and answers with changes: `cms_submit({ brief })`. Merging closes the brief; a rejection comes back as a note.

Every change passes **checks** before a person sees it: schema, conflicts, and the checks modules bring. `lint` stops a draft that still says "[insert price]" and flags "delve"; `seo` flags a missing description. Errors go back to the agent, warnings go to the reviewer, and a warning sends even an `auto` agent's change to a person. `cms_check` runs them before submitting.

Approve now or **schedule** it: "Schedule for Fri 09:00" in the Inbox when the agent asked for a time, or `cms_merge({ id, at })`. `aicms dev` publishes on time; on Cloudflare a cron trigger does.

```ts
agents: {
  writer:  { scopes: ["post:draft", "tag:draft"], review: "human" },
  tidy:    { scopes: ["tag:draft"], review: { auto: ["tag:update.name"] } },   // renames publish themselves, nothing else does
  planner: { scopes: ["post:read", "briefs:write"] },                          // writes briefs for the others
},
```

```bash
aicms brief "Write about the spring menu" --agent writer --at 2026-12-04T09:00
aicms briefs
aicms merge <changeset-id> --at 2026-12-04T09:00
```

## Modules

```bash
aicms add lint         # content checks: placeholders block, filler phrases and missing alt text warn
aicms add seo          # scores entries, sitemap.xml and robots.txt
aicms add search       # ranked full-text search in any language
aicms add media        # media library with uploads, image sizes and alt text
aicms add i18n         # translations across locales
aicms add git-sync     # content as Markdown files; edits come back for review
aicms add commerce     # products, orders, checkout (pulls in manual-payments; or add stripe)
aicms search reviews   # find modules in the registry
aicms modules          # what is installed and what each module may do
```

A module is one file: what it provides and requires, its models, Actions, hooks and routes. `aicms module new reviews` scaffolds one. Before anything is installed you see its permissions; an agent can propose a module (`cms_propose_module`), and a person installs it from the Inbox.

## Where it runs

```ts
db: sqlite(".aicms/data.db")             // default, built into Node
db: postgres({ url: process.env.DATABASE_URL })   // npm install pg
db: d1("DB")                             // Cloudflare Workers, see examples/edge
```

On Cloudflare, one Worker serves everything: `export default createWorker(config)` from `aicms/edge`, with media in R2 and Studio from Workers Assets. See [examples/edge](examples/edge).

## Studio

Studio is the admin for people, served at `/studio/`:

- **Inbox:** agents' changesets with a word-level diff and check warnings. Approve, schedule, request changes (the comment goes back to the agent) or close. Undo a published changeset in one click.
- **Briefs:** write work for agents, follow it, answer their questions.
- **Content:** forms generated from your models, a Markdown editor with preview, and every entry's history with one-click restore.
- **Agents:** scopes, review mode, budget use and pending work; issue or revoke tokens.
- **Media** and **Modules:** the media library, module manifests and one-click install; SEO and translation panels beside each entry.
- **Activity:** every action by people and agents, live.
- **Presence:** who else is on an entry, people and agents, and a warning when someone's draft would conflict.
- **⌘K:** jump to any page or entry, start a new entry or brief.

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
| [`@aicms/nuxt`](packages/nuxt) | Nuxt module: `useAicms`, `useAicmsData`, a webhook that clears Nitro's page cache |
| [`@aicms/sveltekit`](packages/sveltekit) | Load helpers with `depends`, cache headers, live updates on publish |
| [`@aicms/astro`](packages/astro) | Content Layer loader with pre-rendered blocks |
| [`aicms` (Python)](sdk/python) | Python client, standard library only |

## What's in the repository

| Piece | Where |
|---|---|
| Field builders, models, Markdown ↔ blocks, slugs | `src/schema/` |
| Action Bus, policies, changesets, checks, schedules, briefs, rollback, module SDK, live feed | `src/kernel/` |
| Official modules: seo, search, media, i18n, git-sync, lint, commerce, payments | `src/modules/` |
| Stores: SQLite (node:sqlite or D1) and Postgres | `src/store/` |
| REST, OpenAPI, GraphQL, A2A, discovery, MCP, SSE, module routes, Studio | `src/gates/` |
| Cloudflare Workers entry, module registry | `src/edge.ts`, `src/registry.ts` |
| CLI, `aicms types`, config edits for `aicms add` | `src/cli.ts`, `src/typegen.ts`, `src/config-edit.ts` |
| Studio (React + Framer Motion, shipped prebuilt in `dist/studio`) | `studio/` |
| TypeScript client and framework adapters | `packages/` |
| Python client | `sdk/python/` |
| `create-aicms`, release scripts and the package smoke test | `packages/create-aicms/`, `scripts/` |

## Development

```bash
npm test             # kernel, gates, SDK and adapters (node:test, no build step)
npm run test:pg      # the same suite on Postgres (PGlite, in-process)
npm run test:python  # Python client
npm run typecheck
npm run build        # dist/ for the CLI, the packages and Studio
npm run test:package # pack the packages, scaffold a site from the tarballs, drive it
npm run studio       # Studio dev server on :5173, proxied to a running `aicms dev`
```

Releases: `node scripts/version.mjs 0.6.0` sets the version everywhere; pushing the tag `v0.6.0` publishes to npm and PyPI from GitHub Actions.

## License

[MIT](LICENSE). AICMS is free for any use, including commercial: build sites, products and services on it without asking or paying. If the project ever needs funding, it will come from donations, never from a paid edition.
