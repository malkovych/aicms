// The Nuxt and Nitro auto-imports these runtime files use. Real types come from the app at build time.
declare module "#imports" {
  export const defineNuxtPlugin: (setup: () => unknown) => unknown;
  export const useRuntimeConfig: () => Record<string, any>;
  export const useNuxtApp: () => Record<string, any>;
  export const useAsyncData: <T>(key: string, handler: () => Promise<T>, options?: Record<string, unknown>) => Promise<{ data: { value: T | null }; error: { value: unknown }; refresh: () => Promise<void>; status: { value: string } }>;
  export const useRequestFetch: () => typeof fetch;
  export const defineEventHandler: (handler: (event: any) => unknown) => unknown;
  export const readRawBody: (event: any) => Promise<string | undefined>;
  export const getHeader: (event: any, name: string) => string | undefined;
  export const createError: (input: { statusCode: number; statusMessage: string }) => Error;
  export const useStorage: (base?: string) => { getKeys(base?: string): Promise<string[]>; removeItem(key: string): Promise<void> };
  export const useNitroApp: () => { hooks: { callHook(name: string, ...args: unknown[]): Promise<void> } };
}

interface ImportMeta {
  /** True in server bundles (Nuxt build-time flag). */
  readonly server: boolean;
  readonly client: boolean;
}
