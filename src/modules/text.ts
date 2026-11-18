import { blocksToMarkdown, type Block } from "../schema/markdown.ts";
import { displayTitle, type Model } from "../schema/model.ts";

/** Lowercase words without diacritics, so "Зима" finds "зима" and "café" finds "cafe". */
export function tokenize(text: string): string[] {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** All readable text of an entry: text fields, lists, blocks (as Markdown) and nested objects. */
export function entryText(model: Model, data: Record<string, unknown>): { title: string; body: string } {
  const parts: string[] = [];
  const walk = (value: unknown, kind?: string) => {
    if (value == null) return;
    if (kind === "blocks" && Array.isArray(value)) parts.push(blocksToMarkdown(value as Block[]));
    else if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v));
    else if (typeof value === "object") Object.values(value as Record<string, unknown>).forEach((v) => walk(v));
  };
  for (const [key, f] of Object.entries(model.fields)) {
    if (["text", "blocks", "list", "object"].includes(f.kind)) walk(data[key], f.kind);
  }
  return { title: displayTitle(model, data), body: parts.join("\n\n") };
}

/** A short excerpt around the first query word found in `text`. */
export function snippet(text: string, words: string[], size = 160): string {
  const flat = text.replace(/[#>*_`\[\]]+/g, " ").replace(/\s+/g, " ").trim();
  const folded = flat.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase();
  let at = -1;
  for (const w of words) {
    at = folded.indexOf(w);
    if (at >= 0) break;
  }
  if (at < 0) return flat.slice(0, size) + (flat.length > size ? "…" : "");
  const start = Math.max(0, at - Math.floor(size / 3));
  return (start ? "…" : "") + flat.slice(start, start + size) + (start + size < flat.length ? "…" : "");
}
