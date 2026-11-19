// AICMS on Cloudflare Workers: D1 for data, R2 for media, Workers Assets for Studio.
//
//   // worker.ts
//   import { createWorker } from "aicms/edge"
//   import config from "./aicms.config"
//   export default createWorker(config)

import type { Config } from "./config.ts";
import { createCMS, type Kernel } from "./kernel/cms.ts";
import { createApp } from "./gates/rest.ts";
import { assetsSource } from "./gates/studio.ts";

export { d1 } from "./store/d1.ts";

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerOptions {
  /** Assets binding with dist/studio as its directory; false to serve no Studio. Default "ASSETS". */
  assets?: string | false;
  /** Env var holding the owner token (24+ characters). Default "AICMS_OWNER_TOKEN". */
  ownerToken?: string;
}

/**
 * A Worker that serves every AICMS gate: Studio, REST, GraphQL, MCP, A2A, events.
 * The kernel is created once per isolate; live events and presence are per isolate too.
 */
export function createWorker(config: Config, opts: WorkerOptions = {}) {
  let ready: Promise<{ kernel: Kernel; app: ReturnType<typeof createApp> }> | undefined;
  let current: ExecutionContextLike | undefined;
  return {
    async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContextLike): Promise<Response> {
      current = ctx;
      ready ??= (async () => {
        const token = env[opts.ownerToken ?? "AICMS_OWNER_TOKEN"];
        const kernel = await createCMS(config, {
          bindings: env,
          cwd: "/",
          ownerToken: typeof token === "string" && token ? token : undefined,
          waitUntil: (p) => current?.waitUntil(p),
        });
        const binding = opts.assets === false ? undefined : (env[opts.assets ?? "ASSETS"] as { fetch(r: Request): Promise<Response> } | undefined);
        return { kernel, app: createApp(kernel, { studio: binding ? assetsSource(binding) : false }) };
      })().catch((e) => {
        ready = undefined; // try again on the next request
        throw e;
      });
      const { app } = await ready;
      return app.fetch(request, env, ctx as Parameters<typeof app.fetch>[2]);
    },
  };
}
