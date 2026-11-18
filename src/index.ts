// Public API. A site needs only defineConfig, defineModel and field;
// modules add defineModule and action.

export { defineConfig, type Config, type AgentConfig, type WebhookConfig } from "./config.ts";
export { defineModel, type Model, type InferModel, type ModelAgentOptions, type ModelOp } from "./schema/model.ts";
export { field, type Field, type InferFields, type MediaValue } from "./schema/fields.ts";
export { slugify } from "./schema/slug.ts";
export { markdownToBlocks, blocksToMarkdown, type Block } from "./schema/markdown.ts";
export { action, type ActionDef, type Gate } from "./kernel/action.ts";
export { defineModule, type ModuleDef, type ModuleContext, type EventHandler } from "./kernel/modules.ts";
export { createCMS, type Kernel, type ToolInfo, type CreateOptions, type FeedEvent, type Feed } from "./kernel/cms.ts";
export { AicmsError, type ErrorCode } from "./kernel/errors.ts";
export { allows, type Actor, type ReviewMode, type Budget } from "./kernel/policy.ts";
export { sqlite, SqliteStore } from "./store/sqlite.ts";
export type { Store, EntryRow, ChangesetRow, ChangesetItem, CheckIssue } from "./store/types.ts";
export { createApp, type AppOptions } from "./gates/rest.ts";
export { generateTypes } from "./typegen.ts";
export { createMcpServer, handleMcpRequest, serveStdio } from "./gates/mcp.ts";
export { VERSION } from "./gates/discovery.ts";
