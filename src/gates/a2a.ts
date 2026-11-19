// A2A (Agent2Agent) gate: an Agent Card and a JSON-RPC endpoint, so other
// agents can discover this site and call its Actions as skills. A message
// carries a data part `{ action, input }`; the reply is a completed task with
// the result as a data artifact. Same pipeline, permissions and log as MCP/REST.

import { randomUUID } from "node:crypto";
import type { Kernel } from "../kernel/cms.ts";
import { isAicmsError } from "../kernel/errors.ts";
import type { Actor } from "../kernel/policy.ts";
import { toolName } from "../kernel/action.ts";
import { VERSION } from "./discovery.ts";

export const A2A_PROTOCOL = "0.3.0";

type Part = { kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> } | { kind: "file"; file: unknown };

interface Message {
  kind: "message";
  role: "user" | "agent";
  messageId: string;
  parts: Part[];
  contextId?: string;
  taskId?: string;
}

type TaskState = "completed" | "failed" | "input-required" | "canceled" | "rejected";

interface Task {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; message?: Message; timestamp: string };
  artifacts?: { artifactId: string; name: string; parts: Part[] }[];
  history: Message[];
  metadata?: Record<string, unknown>;
}

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupported: -32004,
} as const;

/** The Agent Card: who this agent is and what it can do: one skill per Action the caller may use. */
export function agentCard(k: Kernel, origin: string, actor: Actor) {
  return {
    protocolVersion: A2A_PROTOCOL,
    name: k.config.name,
    description: `A content site running AICMS. Agents read content and propose changes; people review them before anything is published. Send a data part { "action": "<skill id>", "input": { … } }.`,
    url: `${origin}/a2a`,
    preferredTransport: "JSONRPC",
    version: VERSION,
    provider: { organization: k.config.name, url: origin },
    documentationUrl: `${origin}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "An agent token issued by the site owner (aicms agent create <name>)" } },
    security: [{ bearer: [] }],
    skills: [...k.actions.values()].filter((a) => a.visible(actor)).map((a) => ({
      id: a.name,
      name: toolName(a.name),
      description: a.description,
      tags: [a.module ? `module:${a.module}` : a.name.split(".")[0], a.readOnly ? "read" : "write"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      examples: [JSON.stringify({ action: a.name, input: {} })],
    })),
  };
}

const now = () => new Date().toISOString();
const text = (t: string): Message => ({ kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "text", text: t }] });

/** JSON-RPC handler for one request. Tasks live in memory, visible only to the actor that created them. */
export function createA2A(k: Kernel) {
  const tasks = new Map<string, { owner: string; task: Task }>();
  const remember = (owner: string, task: Task) => {
    tasks.set(task.id, { owner, task });
    if (tasks.size > 1000) tasks.delete(tasks.keys().next().value!);
    return task;
  };

  async function send(actor: Actor, message: Message): Promise<Task> {
    const contextId = message.contextId ?? randomUUID();
    const base = { kind: "task" as const, id: randomUUID(), contextId, history: [message] };
    const data = message.parts.find((p): p is Extract<Part, { kind: "data" }> => p.kind === "data")?.data;
    const action = typeof data?.action === "string" ? data.action : typeof data?.skill === "string" ? data.skill : undefined;
    if (!action) {
      const skills = k.tools(actor).map((t) => t.name);
      return remember(actor.id, {
        ...base,
        status: {
          state: "input-required",
          timestamp: now(),
          message: text(`This agent runs structured skills and has no language model. Send a data part { "action": "<skill>", "input": { … } }. Skills you can use: ${skills.join(", ") || "none — you need a token"}. Start with cms.describe.`),
        },
      });
    }
    const name = k.actions.has(action) ? action : [...k.actions.keys()].find((n) => toolName(n) === action) ?? action;
    try {
      const result = await k.call(name, (data!.input as object) ?? {}, { actor, gate: "a2a" });
      return remember(actor.id, {
        ...base,
        status: { state: "completed", timestamp: now() },
        artifacts: [{ artifactId: randomUUID(), name: `${name} result`, parts: [{ kind: "data", data: (result && typeof result === "object" && !Array.isArray(result) ? result : { result }) as Record<string, unknown> }] }],
      });
    } catch (e) {
      const error = isAicmsError(e) ? e.toJSON() : { code: "internal", message: e instanceof Error ? e.message : String(e) };
      const state: TaskState = error.code === "unauthorized" || error.code === "forbidden" ? "rejected" : "failed";
      return remember(actor.id, {
        ...base,
        status: { state, timestamp: now(), message: { ...text(error.message), parts: [{ kind: "text", text: error.message }, { kind: "data", data: { error } }] } },
      });
    }
  }

  return async function handle(actor: Actor, body: unknown): Promise<unknown> {
    const req = body as { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
    const id = req && typeof req === "object" ? (req.id ?? null) : null;
    const fail = (code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") return fail(ERR.invalidRequest, "Expected a JSON-RPC 2.0 request");
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (req.method) {
      case "message/send": {
        const m = req.params?.message as Message | undefined;
        if (!m || !Array.isArray(m.parts) || !m.parts.length) return fail(ERR.invalidParams, "params.message with parts is required");
        return ok(await send(actor, { ...m, kind: "message", messageId: m.messageId ?? randomUUID() }));
      }
      case "tasks/get": {
        const t = tasks.get(String(req.params?.id ?? ""));
        if (!t || t.owner !== actor.id) return fail(ERR.taskNotFound, "Task not found");
        return ok(t.task);
      }
      case "tasks/cancel": {
        const t = tasks.get(String(req.params?.id ?? ""));
        if (!t || t.owner !== actor.id) return fail(ERR.taskNotFound, "Task not found");
        return fail(ERR.taskNotCancelable, `Task is already ${t.task.status.state}`);
      }
      case "message/stream":
      case "tasks/resubscribe":
      case "tasks/pushNotificationConfig/set":
      case "tasks/pushNotificationConfig/get":
        return fail(ERR.unsupported, `${req.method} is not supported; use message/send`);
      default:
        return fail(ERR.methodNotFound, `Unknown method ${req.method}`);
    }
  };
}
