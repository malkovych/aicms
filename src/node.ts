// Node built-ins that exist only on servers. Loaded on first use so the kernel
// also starts where they are missing (Cloudflare Workers, other edges).

type Builtins = { "node:fs": typeof import("node:fs"); "node:os": typeof import("node:os"); "node:url": typeof import("node:url") };

export function builtin<K extends keyof Builtins>(name: K): Builtins[K] | undefined {
  const get = (globalThis as { process?: { getBuiltinModule?: (n: string) => unknown } }).process?.getBuiltinModule;
  try {
    return get?.(name) as Builtins[K] | undefined;
  } catch {
    return undefined;
  }
}
