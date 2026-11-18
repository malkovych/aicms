// @aicms/next — AICMS in a Next.js App Router project.
//
//   // lib/cms.ts
//   export const cms = createAicms<Schema>({ url: process.env.AICMS_URL! })
//   // app/api/aicms/route.ts
//   export const POST = createRevalidateHandler({ secret: process.env.AICMS_WEBHOOK_SECRET, revalidateTag })

import { createClient, type AnySchema, type Client, type ClientOptions } from "@aicms/client";

export * from "@aicms/client";
export { Blocks, type BlocksProps, type BlockComponent } from "./blocks.ts";

export interface AicmsNextOptions extends Omit<ClientOptions, "init"> {
  /** Seconds before cached reads go stale. By default they stay cached until a webhook revalidates them. */
  revalidate?: number;
  /** Extra cache tags added to every read. */
  tags?: string[];
}

/** Cache tags for an Action: every read is tagged `aicms` and `aicms:<model>`. */
export function tagsFor(action: string): string[] {
  const model = action.split(".")[0];
  return ["aicms", ...(model && model !== "cms" ? [`aicms:${model}`] : [])];
}

/**
 * A client whose reads go through Next's data cache, tagged per model.
 * Writes (drafts, submit) are never cached.
 */
export function createAicms<S extends AnySchema = AnySchema>(opts: AicmsNextOptions): Client<S> {
  const { revalidate, tags = [], ...rest } = opts;
  return createClient<S>({
    ...rest,
    init: ({ action, method }) => {
      if (method !== "GET") return { cache: "no-store" };
      const next = { tags: [...tagsFor(action), ...tags], ...(revalidate !== undefined ? { revalidate } : {}) };
      return { next, ...(revalidate === undefined ? { cache: "force-cache" } : {}) } as RequestInit;
    },
  });
}

/** Tags to revalidate for an AICMS webhook event. */
export function tagsForEvent(event: string, payload: any): string[] {
  if (event !== "changeset.merged") return [];
  const models = new Set<string>((payload?.entries ?? []).map((e: { model: string }) => e.model));
  return [...models].map((m) => `aicms:${m}`);
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface RevalidateOptions {
  /** The `secret` of this webhook in aicms.config. Strongly recommended. */
  secret?: string;
  /** Pass `revalidateTag` from "next/cache". */
  revalidateTag: (tag: string, profile: "max") => void;
}

/**
 * A Route Handler for AICMS webhooks. Point a webhook at it:
 * `webhooks: [{ url: "https://site.com/api/aicms", events: ["changeset.merged"], secret }]`
 */
export function createRevalidateHandler(opts: RevalidateOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = await request.text();
    if (opts.secret) {
      const got = request.headers.get("x-aicms-signature") ?? "";
      if (!sameString(got, `sha256=${await hmacHex(opts.secret, body)}`)) return Response.json({ error: "bad signature" }, { status: 401 });
    }
    let parsed: { event?: string; payload?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return Response.json({ error: "expected JSON" }, { status: 400 });
    }
    const tags = tagsForEvent(parsed.event ?? "", parsed.payload);
    for (const tag of tags) opts.revalidateTag(tag, "max");
    return Response.json({ revalidated: tags });
  };
}
