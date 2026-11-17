import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Kernel } from "../kernel/cms.ts";
import { isAicmsError } from "../kernel/errors.ts";
import type { Actor } from "../kernel/policy.ts";
import { VERSION } from "./discovery.ts";

const INSTRUCTIONS = `This is an AICMS content site.
Start with cms_describe: it lists the models you can work with, their writing guides and your permissions.
Read with <model>_list and <model>_get. Write with <model>_draft; block fields accept Markdown.
Your edits are drafts in a changeset. Call cms_submit when you're done; nothing is public until it is merged.
cms_changes shows review decisions and reviewer comments.`;

/** An MCP server whose tool list is exactly what this actor may call. */
export function createMcpServer(k: Kernel, actor: Actor): Server {
  const server = new Server({ name: "aicms", title: k.config.name, version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: k.tools(actor).map((t) => ({
      name: t.tool,
      title: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object"; [key: string]: unknown },
      annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = k.tools(actor).find((t) => t.tool === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool "${req.params.name}". Call cms_describe to see what you can use.` }] };
    }
    try {
      const out = await k.call(tool.name, req.params.arguments ?? {}, { actor, gate: "mcp" });
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      const body = isAicmsError(e) ? { error: e.toJSON() } : { error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
      if (!isAicmsError(e)) console.error("[aicms] tool failed:", e);
      return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
    }
  });

  return server;
}

/** Stateless Streamable HTTP: a fresh server per request, JSON responses, no sessions. */
export async function handleMcpRequest(k: Kernel, actor: Actor, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createMcpServer(k, actor);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // The JSON response is complete at this point; release the per-request server.
    void server.close().catch(() => {});
  }
}

export async function serveStdio(k: Kernel, actor: Actor): Promise<void> {
  const server = createMcpServer(k, actor);
  await server.connect(new StdioServerTransport());
}
