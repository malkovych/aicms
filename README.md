# AICMS

**The CMS for AI agents.** Describe a model once and get REST, MCP tools, an admin and types. Agents draft, people decide.

[Website](https://malkovych.github.io/aicms/) · [Architecture](ARCHITECTURE.md) · [Українською](README.uk.md)

> Status: phase 0. The kernel (schemas, Action Bus, changesets, SQLite, REST, MCP, CLI) is being built in this repository. Studio, SDKs and framework adapters come next.

## Why

WordPress was built for people clicking through an admin. Agents need explicit schemas, typed tools, permission boundaries and a safe way to propose changes. AICMS is built around those needs:

- **One schema, every interface.** A model in `models/post.ts` becomes REST endpoints, MCP tools, validation, OpenAPI and `llms.txt`.
- **Agents never write to production directly.** Their changes go into a changeset, pass checks and wait for review. Every action is logged.
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

## Quick start (phase 0)

Requires Node.js 22.13 or newer (AICMS uses the built-in `node:sqlite`).

```bash
git clone https://github.com/malkovych/aicms && cd aicms
npm install && npm run build
cd examples/blog
node ../../dist/cli.js agent create writer   # prints a token once
node ../../dist/cli.js dev                   # API on :4321/api/v1, MCP on :4321/mcp
```

Connect an MCP client (Claude Code, for example) with the token:

```bash
claude mcp add --transport http aicms http://localhost:4321/mcp --header "Authorization: Bearer <token>"
```

Or run it over stdio without a server:

```bash
node ../../dist/cli.js mcp --agent writer
```

Review what the agent proposed:

```bash
node ../../dist/cli.js changes
node ../../dist/cli.js merge <changeset-id>
node ../../dist/cli.js reject <changeset-id> --comment "Shorter title, please"
```

## What's in the kernel

| Piece | Where |
|---|---|
| Field builders, models, Markdown ↔ blocks, slugs | `src/schema/` |
| Action Bus, policies, changesets, modules | `src/kernel/` |
| SQLite store: entries, versions, changesets, events, media, tokens | `src/store/` |
| REST, OpenAPI, discovery, MCP | `src/gates/` |
| CLI | `src/cli.ts` |

## License

Not decided yet (MIT or AGPL with a commercial cloud). Until a license file is added, all rights are reserved.
