// @aicms/sveltekit — AICMS in SvelteKit load functions.
//
//   // src/lib/cms.ts
//   export const cms = createAicms<Schema>({ url: PUBLIC_AICMS_URL })
//   // src/routes/blog/[slug]/+page.ts
//   export const load = async (event) => ({ post: await cms(event).post.get({ slug: event.params.slug }) })

import { createClient, type AnySchema, type Client, type ClientOptions } from "@aicms/client";

export * from "@aicms/client";

/** The parts of a SvelteKit load event this package uses. */
export interface LoadEventLike {
  fetch: typeof fetch;
  depends?: (...deps: `${string}:${string}`[]) => void;
  setHeaders?: (headers: Record<string, string>) => void;
}

export interface AicmsKitOptions extends Omit<ClientOptions, "fetch" | "init"> {
  /** Let CDNs cache pages built from AICMS reads for this many seconds (sets cache-control once per request). */
  maxAge?: number;
  /** Serve a stale page this long while it is refreshed. Default: 10 × maxAge. */
  staleWhileRevalidate?: number;
}

/** Dependency keys for an Action: every read depends on `aicms:all` and `aicms:<model>`. */
export function dependsFor(action: string): `${string}:${string}`[] {
  const model = action.split(".")[0];
  return ["aicms:all", ...(model && model !== "cms" ? [`aicms:${model}` as const] : [])];
}

/**
 * Bind the client to a load event: requests go through SvelteKit's fetch (deduplicated,
 * replayed during hydration) and register dependencies, so `invalidate("aicms:post")` reruns the load.
 */
export function createAicms<S extends AnySchema = AnySchema>(opts: AicmsKitOptions) {
  const { maxAge, staleWhileRevalidate, ...rest } = opts;
  return (event: LoadEventLike): Client<S> => {
    let cached = false;
    return createClient<S>({
      ...rest,
      fetch: event.fetch,
      init: ({ action, method }) => {
        if (method !== "GET") return undefined;
        event.depends?.(...dependsFor(action));
        if (maxAge && event.setHeaders && !cached) {
          cached = true;
          try {
            event.setHeaders({ "cache-control": `public, max-age=0, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate ?? maxAge * 10}` });
          } catch {
            // Another load function already set it for this request.
          }
        }
        return undefined;
      },
    });
  };
}

export interface LiveOptions {
  /** The AICMS origin. */
  url: string;
  /** `invalidate` from "$app/navigation". */
  invalidate: (dep: string) => unknown;
  /** Only react to these models. Default: all. */
  models?: string[];
  /** For tests or non-browser runtimes. */
  EventSource?: typeof EventSource;
}

/**
 * In the browser: rerun the loads that read a model as soon as a change to it is published.
 * Call it in onMount of your root layout; it returns a function that stops listening.
 */
export function liveUpdates(opts: LiveOptions): () => void {
  const ES = opts.EventSource ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
  if (!ES) return () => {};
  const source = new ES(`${opts.url.replace(/\/+$/, "")}/api/v1/events`);
  source.addEventListener("changeset.merged", (msg) => {
    try {
      const e = JSON.parse((msg as MessageEvent).data);
      const models = new Set<string>((e.payload?.entries ?? []).map((x: { model: string }) => x.model));
      for (const m of models) if (!opts.models || opts.models.includes(m)) opts.invalidate(`aicms:${m}`);
    } catch {
      /* not one of ours */
    }
  });
  return () => source.close();
}
