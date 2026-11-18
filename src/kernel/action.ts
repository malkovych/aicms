import { z } from "zod";
import type { AnyField } from "../schema/fields.ts";
import type { Actor } from "./policy.ts";
import type { Kernel } from "./cms.ts";
import type { ModuleContext } from "./modules.ts";

export type Gate = "mcp" | "rest" | "graphql" | "cli" | "sdk" | "studio" | "internal";

export interface CallContext {
  actor: Actor;
  gate: Gate;
  kernel: Kernel;
}

/** An Action as declared by a module. */
export interface ActionDef<I = any, O = any> {
  readonly kind?: "action";
  description: string;
  /** Fields (like a model) or a Zod object. */
  input?: Record<string, AnyField> | z.ZodObject;
  /** Scope required to see and call the Action. Omit to allow any signed-in caller. */
  scope?: string;
  /** Also allow anonymous callers. */
  public?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  run(args: { input: I; ctx: ModuleContext }): O | Promise<O>;
}

export function action<I = any, O = any>(def: Omit<ActionDef<I, O>, "kind">): ActionDef<I, O> {
  return { kind: "action", ...def };
}

/** An Action in the kernel registry. Everything a gate exposes is one of these. */
export interface RegisteredAction {
  name: string;
  description: string;
  module?: string;
  readOnly?: boolean;
  destructive?: boolean;
  /** Is the Action listed for this actor at all? */
  visible(actor: Actor): boolean;
  /** Schema used to validate input. */
  schema(actor: Actor): z.ZodType;
  /** Schema advertised to this actor as a tool (may be narrower, e.g. only writable fields). */
  advertised?(actor: Actor): z.ZodType;
  run(input: any, ctx: CallContext): Promise<unknown>;
}

/** Turn a field map into a Zod object, honouring `required` and input schemas. */
export function fieldsToSchema(fields: Record<string, AnyField>): z.ZodObject {
  return z.strictObject(
    Object.fromEntries(
      Object.entries(fields).map(([k, f]) => {
        let s = f.input ?? f.schema;
        if (f.options.description) s = s.describe(f.options.description);
        return [k, f.options.required ? s : s.optional()];
      }),
    ),
  );
}

export function normalizeFields(fields: Record<string, AnyField>, input: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...input };
  for (const [k, f] of Object.entries(fields)) if (out[k] != null && f.normalize) out[k] = f.normalize(out[k]);
  return out;
}

/** MCP tool names may not contain dots in several LLM APIs. */
export const toolName = (action: string) => action.replace(/\./g, "_");
