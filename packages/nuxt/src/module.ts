// @aicms/nuxt — a Nuxt module.
//
//   // nuxt.config.ts
//   export default defineNuxtConfig({ modules: ["@aicms/nuxt"], aicms: { url: "https://cms.example.com" } })
//   // any page
//   const { data: post } = await useAicmsData("post", (cms) => cms.post.get({ slug: route.params.slug }))

import { addImports, addPlugin, addServerHandler, createResolver, defineNuxtModule } from "@nuxt/kit";

export interface ModuleOptions {
  /** The AICMS origin, e.g. "https://cms.example.com". Also read from NUXT_PUBLIC_AICMS_URL. */
  url?: string;
  /** A token for server-side reads of models that aren't public. Never sent to the browser. NUXT_AICMS_TOKEN. */
  token?: string;
  /** The `secret` of the AICMS webhook pointing at `webhookRoute`. NUXT_AICMS_WEBHOOK_SECRET. */
  webhookSecret?: string;
  /** Where AICMS webhooks land; false to leave it out. Default "/api/_aicms/webhook". */
  webhookRoute?: string | false;
}

export default defineNuxtModule<ModuleOptions>({
  meta: { name: "@aicms/nuxt", configKey: "aicms", compatibility: { nuxt: ">=3.15.0" } },
  defaults: { url: "", token: "", webhookSecret: "", webhookRoute: "/api/_aicms/webhook" },
  setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url);
    const config = nuxt.options.runtimeConfig as Record<string, any>;
    // Private values stay on the server; only the URL is public.
    config.aicms = { ...(config.aicms ?? {}), token: options.token ?? "", webhookSecret: options.webhookSecret ?? "" };
    config.public.aicms = { ...(config.public.aicms ?? {}), url: options.url ?? "" };

    addPlugin(resolve("./runtime/plugin"));
    addImports([
      { name: "useAicms", from: resolve("./runtime/composables") },
      { name: "useAicmsData", from: resolve("./runtime/composables") },
      { name: "blocksToHtml", from: "@aicms/client" },
    ]);
    if (options.webhookRoute) addServerHandler({ route: options.webhookRoute, method: "post", handler: resolve("./runtime/server/webhook") });
    nuxt.options.build.transpile.push("@aicms/client");
  },
});
