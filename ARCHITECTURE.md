# AICMS — architecture

> A CMS where AI agents are first-class users and people are the editors and owners.
> Describe a model once and get REST, MCP tools, an admin and types.

Status: v0.1 · phase 0 works (schemas, Action Bus, changesets, SQLite, REST, MCP, CLI) · [Українською](ARCHITECTURE.uk.md)

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
- Produces JSON Schema for every model and every Action, OpenAPI, the agent manifest and `llms.txt`. TypeScript types are inferred straight from the model definition, so there is no codegen step.
- Validation uses Zod 4 (a Standard Schema implementation), so the same schema works on the server and in the browser.

### 4.2 Action Bus
- A registry of every Action: kernel Actions (`cms.describe`, `cms.submit`…), the four generated per model (`post.list`, `post.get`, `post.draft`, `post.delete`) and module Actions.
- Every call runs through one pipeline:
  `validate input → policy check → budget → run → event log → emit event`.
- Every gate (MCP, REST, CLI, Studio) is a thin wrapper over this pipeline, so behaviour is identical for people and agents.

### 4.3 Policy
- **Scopes:** `post:read`, `post:draft` (create + update), `post:update.seo` (one field), `post:delete`, `post:*`, `changesets:review`, `*`. Module Actions declare their own scopes, e.g. `reviews:write`.
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

### 6.2 Capabilities instead of package dependencies

A module asks for a capability, not a package:

| `requires` | Who can provide it |
|---|---|
| `payments` | `stripe`, `paddle`, `liqpay`, `monobank` |
| `shipping` | `dhl`, `ups`, `nova-poshta` |
| `search` | `search-sqlite`, `search-pg`, `meilisearch` |
| `ai.image` | `openai-images`, `flux`, `local-sd` |

So modules can be swapped without rewriting the rest.

### 6.3 Official modules (first wave)
`seo` · `i18n` · `media` (AI alt text, cropping, AVIF/WebP) · `search` (full-text + vector) · `git-sync` · `forms` · `commerce` · `reviews` · `redirects` · `analytics` · `workflows` (multi-step agent processes).

### 6.4 Agents proposing modules
An agent may propose installing a module. The proposal arrives in Inbox as a changeset of a special kind, listing the scopes and models the module asks for. A person installs it; agents never install code themselves. (Phase 2.)

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
| **GraphQL** | frontends with complex queries | `/graphql` | 2 |
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
5. **Review.** Automatic, or a person in Studio Inbox (until Studio ships: `aicms changes`, `aicms merge`, `aicms reject`). A rejection comment goes back to the agent through `cms_changes`.
6. **Publish.** Merge writes new entry versions, logs the event and fires webhooks.
7. **Roll back.** Any version can be restored. (Phase 1.)

## 8. Studio: for people

Five sections in the menu: **Content · Media · Inbox · Agents · Modules** (+ Settings).

- **Content.** Lists and forms generated from schemas. A block editor, live preview next to the frontend.
- **Inbox.** Changesets from agents: a before/after diff, checks, and Approve / Reject / Comment.
- **Agents.** Who is connected, their scopes, budgets, live activity, revoking access.
- **Modules.** Install and remove, the module's permissions.
- **⌘K.** Accepts commands and plain language: “find posts without a cover” → `post.list` with a filter.
- **Presence.** See which person or agent is editing an entry right now (Yjs).

## 9. Frameworks

| Adapter | What you get |
|---|---|
| `@aicms/next` | Server Components, `revalidateTag` from webhooks, Draft Mode preview |
| `@aicms/nuxt` | composables, Nitro revalidation, preview |
| `@aicms/sveltekit` | load helpers, preview |
| `@aicms/astro` | Content Layer loader, SSG + SSR |
| `@aicms/react-router` | loaders for React Router 7 / Remix |
| `@aicms/angular` | services and resolvers |
| `@aicms/expo` | mobile client with an offline cache |

Common to all: a client typed from your schemas, a `<Blocks />` component, an image component, a visual-editing overlay.

```tsx
// app/blog/[slug]/page.tsx (Next.js)
import { cms, Blocks } from "@aicms/next"

export default async function Post({ params }) {
  const post = await cms.post.get({ slug: params.slug })   // type inferred from models/post.ts
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
| **1. Human in the loop** | Studio MVP and Inbox, rollback, SSE events, TypeScript and Python SDKs, Next.js and Astro adapters | the first real site |
| **2. Lego** | module SDK, `aicms add`, official modules (seo, i18n, media, search, git-sync), agents propose modules via Inbox, GraphQL, Nuxt and SvelteKit | the ecosystem starts growing |
| **3. Scale** | Postgres and edge, real-time presence, module registry, A2A, commerce | production for shops and media |

## 13. Decisions

| Question | Decision |
|---|---|
| Content in the database or in git? | The database is the source of truth: changesets, field-level permissions, concurrent agents and transactions all need it. The `git-sync` module mirrors published content to Markdown + frontmatter files and turns pull requests into changesets, so developers and coding agents can still work through git. |
| Can an agent propose installing a module? | Yes, through Inbox, with the requested permissions shown. A person installs it. |
| Python SDK | Phase 1, together with the TypeScript SDK. |
| License | MIT for everything: kernel, SDKs, adapters and official modules. Free for any use, including commercial. If funding is ever needed, it comes from donations, not a paid edition. |
