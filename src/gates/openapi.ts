import type { Kernel } from "../kernel/cms.ts";
import type { Actor } from "../kernel/policy.ts";
import { VERSION } from "./discovery.ts";

/**
 * One operation per Action the caller can see: POST /api/v1/actions/<name>.
 * operationId is the MCP tool name, so function-calling setups and MCP agree.
 */
export function openapi(k: Kernel, actor: Actor, origin: string) {
  const paths: Record<string, unknown> = {};
  for (const t of k.tools(actor)) {
    paths[`/api/v1/actions/${t.name}`] = {
      post: {
        operationId: t.tool,
        summary: t.name,
        description: t.description,
        tags: [t.name.split(".")[0]],
        requestBody: { required: true, content: { "application/json": { schema: t.inputSchema } } },
        responses: {
          "200": { description: "Result of the action", content: { "application/json": { schema: { type: "object" } } } },
          "401": { $ref: "#/components/responses/Error" },
          "403": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "422": { $ref: "#/components/responses/Error" },
          "429": { $ref: "#/components/responses/Error" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `${k.config.name} — AICMS API`,
      version: VERSION,
      description: "Every operation is an AICMS Action. Writes land in your changeset; call cms.submit to send them for review.",
    },
    servers: [{ url: origin }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      responses: {
        Error: {
          description: "Error",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "object",
                    properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
                    required: ["code", "message"],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
