import { createError, defineEventHandler, getHeader, readRawBody, useNitroApp, useRuntimeConfig, useStorage } from "#imports";

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * AICMS webhook: verifies the signature, clears Nitro's cached pages and handlers
 * (routeRules with swr/isr, cachedEventHandler) and calls the "aicms:merged" hook.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const body = (await readRawBody(event)) ?? "";
  const secret = config.aicms?.webhookSecret;
  if (secret && !same(getHeader(event, "x-aicms-signature") ?? "", `sha256=${await hmacHex(secret, body)}`)) {
    throw createError({ statusCode: 401, statusMessage: "Bad signature" });
  }
  let parsed: { event?: string; payload?: { entries?: { model: string }[] } };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Expected JSON" });
  }
  if (parsed.event !== "changeset.merged") return { cleared: 0 };
  const storage = useStorage("cache");
  const keys = (await storage.getKeys("nitro")).filter((k) => k.startsWith("nitro:routes:") || k.startsWith("nitro:handlers:") || k.startsWith("nitro:functions:"));
  await Promise.all(keys.map((k) => storage.removeItem(k)));
  await useNitroApp().hooks.callHook("aicms:merged", parsed.payload);
  return { cleared: keys.length, models: [...new Set((parsed.payload?.entries ?? []).map((e) => e.model))] };
});
