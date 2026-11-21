import { typeLabel } from "../schema/fields.ts";
import type { Kernel } from "../kernel/cms.ts";
import { modelPermissions, type Actor } from "../kernel/policy.ts";

export const VERSION = "0.4.0";

/** /llms.txt: a plain description of the site for any agent, no token needed. */
export function llmsTxt(k: Kernel, actor: Actor, origin: string): string {
  const lines = [
    `# ${k.config.name}`,
    "",
    `> A content site running AICMS ${VERSION}. Agents read and propose changes through MCP or REST; people review before anything is published.`,
    "",
    "## Connect",
    `- MCP (Streamable HTTP): ${origin}/mcp, header \`Authorization: Bearer <token>\``,
    `- REST: ${origin}/api/v1 · OpenAPI: ${origin}/openapi.json`,
    `- Live events (SSE): ${origin}/api/v1/events · GraphQL: ${origin}/graphql`,
    `- A2A: Agent Card ${origin}/.well-known/agent-card.json, JSON-RPC ${origin}/a2a`,
    "- Tokens are issued by the site owner: `aicms agent create <name>`",
    "- Start with the `cms_describe` tool; it lists models, guides and your permissions.",
    "",
    "## Models",
  ];
  const models = [...k.models.values()];
  for (const m of models) {
    const p = modelPermissions(actor, m);
    lines.push("", `### ${m.name}${m.label ? ` — ${m.label}` : ""}${p.read ? "" : " (needs a token)"}`);
    if (m.description) lines.push(m.description);
    if (m.agent?.guide) lines.push(`Guide: ${m.agent.guide}`);
    lines.push(
      ...Object.entries(m.fields).map(([key, f]) => `- ${key}${f.options.required ? "*" : ""}: ${typeLabel(f)}${f.options.description ? ` — ${f.options.description}` : ""}`),
    );
  }
  lines.push(
    "",
    "## Publishing",
    "Agents write drafts into a changeset (`<model>_draft`) and send it with `cms_submit`. Checks run on submit (`cms_check` runs them earlier): errors must be fixed, warnings go to the reviewer. A person or the agent's review policy decides whether it is merged, now or at a scheduled time. `cms_changes` shows decisions and comments.",
    "People hand agents work as briefs: `cms_briefs` lists yours, `cms_brief_update` reports progress or asks a question, and `cms_submit({ brief })` answers one.",
    "",
  );
  return lines.join("\n");
}

/** /.well-known/aicms.json: machine-readable entry points. */
export function manifest(k: Kernel, origin: string) {
  return {
    name: k.config.name,
    software: { name: "aicms", version: VERSION },
    endpoints: {
      mcp: `${origin}/mcp`,
      rest: `${origin}/api/v1`,
      openapi: `${origin}/openapi.json`,
      llms: `${origin}/llms.txt`,
      events: `${origin}/api/v1/events`,
      graphql: `${origin}/graphql`,
      a2a: `${origin}/.well-known/agent-card.json`,
      studio: `${origin}/studio/`,
    },
    auth: { type: "bearer", issuedBy: "site owner via `aicms agent create <name>`" },
    locales: k.config.locales,
    models: [...k.models.values()].map((m) => ({ name: m.name, label: m.label })),
    modules: k.modules.map((m) => ({ name: m.name, provides: m.provides ?? [] })),
  };
}
