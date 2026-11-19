import { createClient } from "@aicms/client";
import { defineNuxtPlugin, useRuntimeConfig } from "#imports";

/** Provides `$aicms`: on the server it may carry the private token; in the browser it reads only public data. */
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const token = import.meta.server ? config.aicms?.token || undefined : undefined;
  const aicms = createClient({ url: config.public.aicms?.url ?? "", token });
  return { provide: { aicms } };
});
