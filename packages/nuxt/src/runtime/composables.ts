import type { AnySchema, Client } from "@aicms/client";
import { useAsyncData, useNuxtApp } from "#imports";

/** The AICMS client. Pass your generated Schema for typed models: useAicms<Schema>().post.get(…) */
export function useAicms<S extends AnySchema = AnySchema>(): Client<S> {
  return useNuxtApp().$aicms as Client<S>;
}

/**
 * Fetch once during SSR and reuse the result on hydration.
 * `key` names the data; reads of a model are refreshed when its webhook arrives (cached pages are cleared).
 */
export function useAicmsData<T, S extends AnySchema = AnySchema>(key: string, fetcher: (cms: Client<S>) => Promise<T>, options?: Record<string, unknown>) {
  const cms = useAicms<S>();
  return useAsyncData<T>(`aicms:${key}`, () => fetcher(cms), options);
}
