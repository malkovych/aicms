# AICMS — architecture

> A CMS where AI agents are first-class users and people are the editors and owners.
> Describe a model once and get REST, MCP tools, an admin and types.

Status: v0.3 · phase 2 works: module SDK, `aicms add`, official modules (seo, search, media, i18n, git-sync), module proposals in Inbox, GraphQL, Nuxt and SvelteKit, on top of phases 0 and 1 · [Українською](ARCHITECTURE.uk.md)

---

## 1. Why

WordPress grew out of a 2003 blog engine: thousands of core files, `wp_posts` + `wp_postmeta` instead of schemas, global hooks with priorities, a REST API bolted on later, and an admin that agents have to scrape. Agents need something else:

- **explicit schemas**, so they know what they may write;
- **typed tools** instead of HTML forms;
- **permission boundaries**, so an agent can't do more than intended;
- **drafts and rollback**, so an agent's mistake breaks nothing.

AICMS is built around those four needs. People get the same system through Studio, which makes it simpler for them too.

## 2. Principles

1. **One schema, everything else generated.** A model is described once in TypeScript. Tables, validation, REST, MCP tools, Studio forms, frontend types and agent docs all come from it.
2. **Every operation is an Action.** Creating an entry, generating alt text, running an SEO audit: one shape with an input/output schema, scopes and hooks. Gates (MCP, REST, SDK, Studio) only call Actions.
3. **Agents never write to production directly.** An agent's changes go into a changeset, pass checks and review, and only then get published. Every event is logged, so anything can be rolled back.
4. **A module is one folder with one manifest.** It declares what it provides (`provides`) and what it needs (`requires`). No global hook soup.
5. **As few files as possible.** A project is `aicms.config.ts`, a `models/` folder and, if needed, `modules/`. Everything generated lives in `.aicms/` and is never committed.
6. **Headless, with first-class adapters.** Next.js, Nuxt, SvelteKit, Astro, React Router, Angular, Expo: a typed client, live preview, cache revalidation.
7. **Web standards.** The kernel speaks `Request/Response`, so it runs on Node, Bun, Deno and Cloudflare Workers.

## 3. Vocabulary: seven concepts

| Concept | What it is | Example |
|---|---|---|
| **Model** | A content type's schema plus instructions for agents | `post`, `product`, `review` |
| **Entry** | One record of a model, with its version history | “How to choose SPF for winter” |
| **Block** | A brick inside rich content | `paragraph`, `image`, `cta` |
| **Action** | Any operation with a typed input, output and scopes | `post.draft`, `seo.audit` |
| **Module** | A package of models, blocks, Actions, hooks and Studio panels | `seo`, `commerce`, `reviews` |
| **Agent** | An agent identity with scopes, a budget and a review mode | `writer`, `seo`, `moderator` |
| **Changeset** | A set of proposed changes waiting for checks and review | “writer: 3 new posts” |

There is nothing else to learn.

## 4. Layers

```
┌──────────────────────────────────────────────────────────────┐
│  Agents (Claude, GPT, Gemini, your own)     People (Studio)   │
└───────────────┬──────────────────────────────────┬───────────┘
                │                                  │
┌───────────────▼──────────────────────────────────▼───────────┐
│  GATES   MCP · REST + OpenAPI · GraphQL · SDK · Events · A2A   │
│          (all generated from the Action registry)              │
└───────────────┬──────────────────────────────────────────────┘
                │ calls an Action
┌───────────────▼──────────────────────────────────────────────┐
│  KERNEL                                                        │
│   Schema Engine → Action Bus → Policy (scopes, budgets, review) │
│   Content Store (entries, versions, changesets, event log)      │
│   Module Loader (provides / requires, isolation)                │
└───────┬───────────────────────────────┬──────────────────────┘
        │                               │
┌───────▼─────────┐            ┌────────▼───────────────────────┐
│  MODULES        │            │  ADAPTERS                        │
│  seo, i18n,     │            │  DB: SQLite · Postgres · libSQL  │
│  media, search, │            │  Media: local · S3 · R2          │
│  commerce, …    │            │  Vector: sqlite-vec · pgvector   │
└─────────────────┘            └────────────────────────────────┘
```

### 4.1 Schema Engine
- Reads models from `models/*.ts` and from modules.
- Produces JSON Schema for every model and every Action, OpenAPI, the agent manifest and `llms.txt`. TypeScript types: inside the CMS project they are inferred straight from the model (`InferModel<typeof post>`); a frontend in another repository gets them from `aicms types`, which `@aicms/client` takes as a type parameter.
- Validation uses Zod 4 (a Standard Schema implementation), so the same schema works on the server and in the browser.

### 4.2 Action Bus
- A registry of every Action: kernel Actions (`cms.describe`, `cms.submit`…), the four generated per model (`post.list`, `post.get`, `post.draft`, `post.delete`) and module Actions.
- Every call runs through one pipeline:
  `validate input → policy check → budget → run → event log → emit event`.
- Every gate (MCP, REST, CLI, Studio) is a thin wrapper over this pipeline, so behaviour is identical for people and agents.

### 4.3 Policy
- **Scopes:** `post:read`, `post:draft` (create + update), `post:update.seo` (one field), `post:delete`, `post:*`, `changesets:review`, `agents:manage`, `events:read`, `*`. Module Actions declare their own scopes, e.g. `reviews:write`.
- **Field-level tool schemas:** a draft tool only lists the fields the agent may write. With `post:update.seo` the agent's `post_draft` tool contains `id` and `seo` and nothing else.
- **Review mode** per agent: `human` (a person approves) or `auto` (merged when every check is green and no model requires a person). The default is `human`.
- **The model has the last word:** if a model's `agent.can` doesn't include `publish`, any agent changeset that touches it waits for a person, whatever the agent's review mode.
- **Budgets:** `actionsPerHour` and `maxChangesetItems`.
- **Kill switch:** `aicms agent revoke <name>` revokes the agent's tokens and rejects all its unmerged changesets.

### 4.4 Content Store
Six core tables, however many models you have:

| Table | Purpose |
|---|---|
| `entries` | current state: `id, model, locale, data (JSON), version` |
| `versions` | immutable history of every entry |
| `changesets` | branches of changes from agents and people |
| `events` | log of every Action: who, what, when, through which gate |
| `media` | files, metadata, alt text |
| `tokens` | agent tokens, stored only as SHA-256 hashes |

Fields marked `indexed: true` or `unique: true` get expression indexes (`json_extract(data, '$.slug')`), which SQLite and Postgres both support. Modules may add their own index tables (the search module adds embeddings).

### 4.5 Module Loader
- Modules are listed in `aicms.config.ts`.
- The `requires → provides` graph is checked at startup and on `aicms add`.
- A module only sees its own models and the ones it lists in `uses`. A module's permissions are shown on install, like a phone app's.

## 5. Project structure

```
my-site/
├── aicms.config.ts      # DB, locales, modules, agents
├── models/
│   ├── post.ts
│   └── tag.ts
├── modules/             # optional: your own modules
│   └── reviews/
│       └── module.ts
└── .aicms/              # generated: database, cache (in .gitignore)
```

### 5.1 Config

```ts
// aicms.config.ts
import { defineConfig, sqlite } from "aicms"

export default defineConfig({
  db: sqlite(".aicms/data.db"),            // postgres() comes in phase 3
  locales: ["en", "uk"],
  public: ["post:read", "tag:read"],       // what anonymous requests may do
  agents: {
    writer:    { scopes: ["post:draft", "tag:draft"], review: "human" },
    seo:       { scopes: ["post:update.seo"],         review: "auto"  },
    moderator: { scopes: ["reviews:write"], budget: { actionsPerHour: 500 } },
  },
  webhooks: [{ url: "https://my-site.com/api/revalidate", events: ["changeset.merged"] }],
})
```

Models are loaded from `models/` automatically; pass `models: [...]` to list them explicitly.

### 5.2 Model

```ts
// models/post.ts
import { defineModel, field } from "aicms"

export default defineModel({
  name: "post",
  label: "Posts",
  fields: {
    title:       field.text({ required: true, max: 120 }),
    slug:        field.slug({ from: "title" }),          // unique and indexed by default
    cover:       field.media(),
    body:        field.blocks(["paragraph", "heading", "image", "quote", "cta"]),
    tags:        field.ref("tag", { many: true }),
    publishedAt: field.date({ indexed: true }),
  },
  agent: {
    guide: "Short sentences, friendly expert tone. No clichés.",
    can: ["create", "update"],              // publishing stays with a person
  },
})
```

The `agent` block is the key difference from classic CMSs: instructions for agents live next to the schema. Agents receive them together with their tool list.

## 6. Modules: like Lego

### 6.1 Anatomy

```ts
// modules/reviews/module.ts
import { defineModule, defineModel, field, action } from "aicms"

export default defineModule({
  name: "reviews",
  provides: ["reviews"],
  requires: ["commerce"],                // any implementation of commerce
  uses: ["product"],                     // other models this module may touch

  models: [
    defineModel({
      name: "review",
      fields: {
        product: field.ref("product"),
        rating:  field.number({ min: 1, max: 5, required: true }),
        text:    field.text(),
        status:  field.enum(["pending", "published", "rejected"]),
      },
    }),
  ],

  actions: {
    moderate: action({
      description: "Approve or reject a review",
      scope: "reviews:write",
      input: { id: field.id({ required: true }), ok: field.boolean({ required: true }) },
      run: ({ input, ctx }) =>
        ctx.draft("review", { id: input.id, status: input.ok ? "published" : "rejected" }),
    }),
  },

  on: {
    "changeset.merged": ({ payload, ctx }) => { /* notify, reindex, … */ },
  },
})
```

Inside `run`, `ctx` writes through the caller's changeset, so a module Action can never bypass review. Its reads include the caller's own drafts, so a module can check work before it is submitted.

A module may also have:

| Part | What it does | Example |
|---|---|---|
| options | modules are usually factories: `seo({ siteUrl })` | `aicms.config.ts` |
| `setup(ctx)` | runs once at start or install | build an index |
| `services` | the implementation of a capability in `provides` | `search` answers `cms.search` |
| `routes` | HTTP routes, `"GET /sitemap.xml"`, with `:params` | `/media/:id/:name` |
| `ctx.kv` | small JSON values that belong to the module | translation groups |
| `ctx.pending(id)` | someone's unpublished draft of an entry | "already waiting for review" |

Everything a module asks for is listed in its manifest (`cms_modules`, `aicms modules`, Studio): models it adds and uses, Actions with their scopes, routes and hooks. Modules can be installed into a running server; their tools, routes and GraphQL types appear at once.

```bash
aicms add seo                 # an official module
aicms add ./modules/reviews   # a local folder
aicms add @someone/aicms-x    # an npm package (npm install + config)
aicms module new reviews      # scaffold modules/reviews/module.ts
aicms remove seo              # its data stays in the database
```

`aicms add` writes the import and the entry in `modules`, pulls in official modules that provide what the new one requires, checks that the project still starts, and puts the file back if it doesn't.

### 6.2 Capabilities instead of package dependencies

A module asks for a capability, not a package:

| `requires` | Who can provide it |
|---|---|
| `payments` | `stripe`, `paddle`, `adyen` |
| `shipping` | `dhl`, `ups`, `fedex` |
| `search` | `search-sqlite`, `search-pg`, `meilisearch` |
| `ai.image` | `openai-images`, `flux`, `local-sd` |

So modules can be swapped without rewriting the rest.

### 6.3 Official modules

Shipped in phase 2 (`import { seo, search, media, i18n, gitSync } from "aicms/modules"`):

| Module | What it gives agents and people |
|---|---|
| `seo` | `seo_audit`: a 0–100 score with concrete fixes (title and description length, slug, word count, heading order, image alt text, internal links), working on drafts; `seo_report` for a whole model; `sitemap.xml` and `robots.txt` |
| `search` | ranked full-text search in any language (TF-IDF, title boost, prefix matching) on a portable index; `cms_search` uses it as soon as it is installed |
| `media` | a media library: uploads, imports from URLs (private networks blocked), image sizes, alt text an agent can fill in, inert SVG, files under `/media` |
| `i18n` | translation groups across locales, what's missing per locale, `i18n_translate` drafts a translation that goes through review |
| `git-sync` | published content mirrored to Markdown with frontmatter; edited files come back as a changeset (`aicms sync import`), so pull requests can feed the Inbox |

Next: `forms` · `commerce` · `reviews` · `redirects` · `analytics` · `workflows` (multi-step agent processes), vector search and AI image tools.

### 6.4 Agents proposing modules
An agent may propose installing a module. The proposal arrives in Inbox as a changeset of a special kind, listing the scopes and models the module asks for. A person with the `modules:install` scope installs it from the Inbox (`cms_propose_module`, then Approve); agents never install code themselves. A declined proposal is closed, not reopened.

## 7. Connecting agents

### 7.1 Gates

| Gate | For | Address | Phase |
|---|---|---|---|
| **MCP** | Claude, Cursor, ChatGPT, any MCP client | `POST /mcp` (Streamable HTTP) or `aicms mcp` (stdio) | 0 |
| **REST + OpenAPI** | function calling in any LLM, n8n, scripts | `/api/v1/*`, `/openapi.json` | 0 |
| **Discovery** | anyone | `/llms.txt`, `/.well-known/aicms.json` | 0 |
| **Webhooks** | frontends, automations | `webhooks` in config | 0 |
| **SDK** | your own agents | `@aicms/client` (TS), `aicms` (PyPI) | 1 |
| **SSE events** | agents that react to changes | `/api/v1/events` | 1 |
| **GraphQL** | frontends with complex queries; references resolve to entries | `/graphql` | 2 ✓ |
| **A2A** | agent-to-agent | `/.well-known/agent.json` | 3 |

### 7.2 Tools an agent sees

An agent only sees what its scopes allow. MCP tool names use underscores (`post_draft`) because several LLM APIs reject dots in tool names; the Action is still called `post.draft` in REST and code.

| Tool | Action | What it does |
|---|---|---|
| `cms_describe` | `cms.describe` | models, fields, guides, the agent's own scopes and review mode |
| `cms_search` | `cms.search` | full-text search across readable models |
| `<model>_list` | `<model>.list` | filter by indexed fields, select fields, paginate |
| `<model>_get` | `<model>.get` | one entry by `id` or by a unique field such as `slug`; `drafts: true` includes your unpublished changes |
| `<model>_draft` | `<model>.draft` | create or change an entry inside the agent's changeset |
| `<model>_delete` | `<model>.delete` | propose deleting an entry |
| `cms_submit` | `cms.submit` | run checks and send the changeset for review |
| `cms_changes` | `cms.changes` | the agent's changesets, check results and reviewer comments |
| `cms_review` / `cms_merge` / `cms_reject` | `cms.review` … | for reviewers with `changesets:review` |
| `cms_history` / `cms_restore` / `cms_revert` | `cms.history` … | an entry's versions; draft the restore of any version, or the undo of a merged changeset |
| `cms_discard` | `cms.discard` | drop drafts that weren't submitted |
| `cms_modules` / `cms_propose_module` | `cms.modules` … | installed modules with their permissions, official ones to propose; `cms_install_module` for admins (`modules:install`) |
| `cms_agents` / `cms_token` / `cms_revoke` / `cms_log` | `cms.agents` … | for admins (`agents:manage`, `events:read`): agents, tokens, the action log |
| `<module>_<action>` | `<module>.<action>` | module Actions |

### 7.3 Markdown in, blocks in the database
Agents read and write Markdown comfortably; people need a visual editor. AICMS stores blocks, and a `blocks` field accepts either a block array or Markdown with directive blocks (`:::cta{href="/sale" label="Shop now"}`). Over MCP, block fields are returned as Markdown by default; REST returns blocks. Same data, each side gets its own interface.

### 7.4 Saving context
- `cms_describe` without arguments is brief; with `{ model }` it is detailed.
- Field selection: `post_get({ slug, fields: ["title", "slug"] })`.
- Compact responses without service noise.

### 7.5 The path of an agent's change
1. **Connect.** The agent arrives with a token and gets its tool list.
2. **Learn.** `cms_describe` returns schemas, guides and examples.
3. **Draft.** Changes are written into a changeset; production is untouched.
4. **Check.** `cms_submit` runs schema, uniqueness, reference and conflict checks. Failures come back to the agent with field-level messages.
5. **Review.** Automatic, or a person in Studio Inbox (or `aicms changes`, `aicms merge`, `aicms reject`). A rejection comment goes back to the agent through `cms_changes` and the `changeset.rejected` event.
6. **Publish.** Merge writes new entry versions, logs the event and fires webhooks.
7. **Roll back.** Any version of an entry can be restored (`cms_restore`, or History in Studio), and a merged changeset can be undone as a whole (`cms_revert`). Both are drafted and published like any other change, so they are checked, reviewed and logged too.

## 8. Studio: for people

Studio is served by the kernel at `/studio/`. You sign in with a one-time link from the terminal (`aicms login`; `aicms dev` prints one when it starts), which becomes a 30-day session cookie, so there is no password to leak. Studio calls the same Actions as agents through the same pipeline; its writes are logged with the gate `studio`.

Shipped in phase 1:

- **Inbox.** Changesets from agents with a word-level before/after diff, failed checks, and Approve / Request changes (the comment goes back to the agent) / Close. A merged changeset can be undone in one click.
- **Content.** Lists and forms generated from schemas: every field kind has an input, block fields get a Markdown editor with a live preview. Every entry has its history; any version can be opened and restored.
- **Agents.** Scopes, review mode, budget use, last activity and pending work. Issue a token (shown once, with the MCP command to connect) or revoke access.
- **Activity.** The action log of people and agents, live over SSE.
- English and Ukrainian, light and dark themes, phone-sized screens.

Added in phase 2: **Media** (a library with drag-and-drop upload and alt text), **Modules** (manifests and one-click install), module proposals in **Inbox**, a media picker in forms, and SEO and translation panels beside each entry.

Next: **⌘K** (commands and plain language: “find posts without a cover” → `post.list` with a filter), **presence** (who is editing an entry right now, Yjs), a block editor beside the frontend's live preview, and roles for people other than the owner.

## 9. Frameworks

| Adapter | What you get | Status |
|---|---|---|
| `@aicms/client` | typed client for any runtime with `fetch`, live events, `blocksToHtml` | phase 1 ✓ |
| `@aicms/next` | reads cached with per-model tags, `revalidateTag` from webhooks, `<Blocks />` for Server Components | phase 1 ✓ (Draft Mode preview next) |
| `@aicms/astro` | Content Layer loader with pre-rendered blocks | phase 1 ✓ |
| `aicms` (PyPI) | Python client, standard library only | phase 1 ✓ |
| `@aicms/nuxt` | a Nuxt module: `useAicms`, `useAicmsData`, a signed webhook that clears Nitro's page cache | phase 2 ✓ |
| `@aicms/sveltekit` | load helpers on SvelteKit's `fetch` with `depends`, cache headers, live `invalidate` on publish | phase 2 ✓ |
| `@aicms/react-router` | loaders for React Router 7 / Remix | later |
| `@aicms/angular` | services and resolvers | later |
| `@aicms/expo` | mobile client with an offline cache | later |

Common to all: a client typed from your schemas (`aicms types`), a `<Blocks />` component or `blocksToHtml`, and later an image component and a visual-editing overlay.

```tsx
// lib/cms.ts
import { createAicms } from "@aicms/next"
import type { Schema } from "./aicms-types"            // npx aicms types --out lib/aicms-types.ts
export const cms = createAicms<Schema>({ url: process.env.AICMS_URL! })

// app/blog/[slug]/page.tsx
import { Blocks } from "@aicms/next"
import { cms } from "@/lib/cms"

export default async function Post({ params }) {
  const post = await cms.post.get({ slug: (await params).slug })   // typed from models/post.ts
  return <Blocks value={post.body} />
}
```

Deployment modes:
- **Embedded:** AICMS mounts as a route handler inside Next.js / Nuxt / SvelteKit. One deploy.
- **Standalone:** `aicms start` or a Docker image.
- **Edge:** Cloudflare Workers + D1 + R2.

## 10. Kernel stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | types end to end, from schema to frontend |
| Database | `node:sqlite` | built into Node 22+, no native builds; Postgres later behind the same `Store` interface |
| HTTP | Hono | runs on any runtime, web standards |
| Validation | Zod 4 | one schema → JSON Schema for agents |
| MCP | official TypeScript SDK | Streamable HTTP (web-standard transport) + stdio |
| Config loading | jiti | loads `aicms.config.ts` and models without a build step |
| Studio | React + Framer Motion | fast UI, smooth transitions |
| Realtime | Yjs | co-editing between people and agents |

## 11. Compared with WordPress

| | WordPress | AICMS |
|---|---|---|
| Structure | thousands of core files, themes, plugins, `functions.php` | one package; a project = config + models |
| Data model | `wp_posts` + `wp_postmeta` (EAV) | typed models, six core tables |
| Extending | global hooks with priorities, plugin conflicts | modules with `provides / requires` and isolation |
| API | REST added later, partial | every Action → REST and MCP automatically |
| AI agents | plugins or scraping the admin | native MCP, scopes, changesets |
| Agent permissions | administrator role = everything | field-level scopes, budgets, review |
| History | revisions for posts only | an event log for everything |
| Frontend | PHP themes | any framework, typed SDK |

## 12. Roadmap

| Phase | Scope | Outcome |
|---|---|---|
| **0. Kernel** ✓ | Schema Engine, Action Bus, policies, changesets, event log, SQLite store, REST, MCP, discovery, webhooks, CLI | an agent drafts content over MCP, a person merges it |
| **1. Human in the loop** ✓ | Studio MVP and Inbox, rollback, SSE events, TypeScript and Python SDKs, Next.js and Astro adapters | the first real site |
| **2. Lego** ✓ | module SDK, `aicms add`, official modules (seo, i18n, media, search, git-sync), agents propose modules via Inbox, GraphQL, Nuxt and SvelteKit | the ecosystem starts growing |
| **3. Scale** | Postgres and edge, real-time presence, module registry, A2A, commerce | production for shops and media |

## 13. Decisions

| Question | Decision |
|---|---|
| Content in the database or in git? | The database is the source of truth: changesets, field-level permissions, concurrent agents and transactions all need it. The `git-sync` module mirrors published content to Markdown + frontmatter files and turns pull requests into changesets, so developers and coding agents can still work through git. |
| Can an agent propose installing a module? | Yes, through Inbox, with the requested permissions shown. A person installs it. |
| Python SDK | Shipped in phase 1 with the TypeScript SDK: `sdk/python`, standard library only. |
| License | MIT for everything: kernel, SDKs, adapters and official modules. Free for any use, including commercial. If funding is ever needed, it comes from donations, not a paid edition. |
