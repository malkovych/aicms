// Content lint: checks that run on every submitted change, like CI for content.
// Placeholders an agent left behind ("[insert statistic]", "TODO") stop the
// changeset; filler phrases, long sentences, empty headings, images without alt
// text and dead links go to the reviewer as warnings. Only the fields a change
// touches are checked, so fixing a typo doesn't drag up the whole entry.

import { defineModule, type CheckFinding, type CheckInput } from "../kernel/modules.ts";
import type { Block } from "../schema/markdown.ts";
import type { AnyField } from "../schema/fields.ts";

type Level = "error" | "warning";

export interface LintOptions {
  /** Phrases to avoid: words, phrases or regular expressions. Default: DEFAULT_AVOID. Extend with [...DEFAULT_AVOID, "synergy"]. */
  avoid?: (string | RegExp)[];
  /** Level for avoided phrases. Default "warning". */
  avoidLevel?: Level;
  /** Placeholder text left in a draft ("[insert …]", "TODO", "lorem ipsum"). Default "error"; false turns it off. */
  placeholders?: Level | false;
  /** Sentences longer than this many words get a warning. Default 40; 0 turns it off. */
  maxSentenceWords?: number;
  /** Images and media fields without alt text. Default "warning". */
  altText?: Level | false;
  /** Models to lint. Default: all. */
  models?: string[];
}

/** Filler that reads as machine-written. Matched as whole words, case-insensitively. */
export const DEFAULT_AVOID: string[] = [
  "delve",
  "delves",
  "delving",
  "in today's fast-paced world",
  "in today's digital age",
  "it's important to note",
  "it is important to note",
  "it's worth noting",
  "game-changer",
  "game changer",
  "unlock the power",
  "unleash the power",
  "a testament to",
  "rich tapestry",
  "navigate the complexities",
  "in the ever-evolving",
  "ever-changing landscape",
  "look no further",
];

const PLACEHOLDERS = [
  /\[(?:insert|add|your|link|source|citation|todo|tbd|placeholder)[^\]]*\]/i,
  /\{\{[^}]*\}\}/,
  /\b(?:TODO|TBD|FIXME|XXX)\b/,
  /\blorem ipsum\b/i,
  /\b(?:example\.com|example\.org)\b/i,
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (p: string | RegExp) => (p instanceof RegExp ? p : new RegExp(`(?<![\\p{L}\\p{N}])${escape(p).replace(/'/g, "['’]")}(?![\\p{L}\\p{N}])`, "iu"));

/** Readable text of one field, as [where, text] pairs: "paragraph 3", "heading 1", "seo.title"… */
function texts(key: string, field: AnyField, value: unknown): [string, string][] {
  if (value == null) return [];
  if (field.kind === "blocks" && Array.isArray(value)) {
    const out: [string, string][] = [];
    const count: Record<string, number> = {};
    for (const b of value as Block[]) {
      count[b.type] = (count[b.type] ?? 0) + 1;
      const where = `${key}: ${b.type} ${count[b.type]}`;
      for (const k of ["text", "title", "caption", "label"]) if (typeof b[k] === "string") out.push([where, b[k] as string]);
      if (Array.isArray(b.items)) for (const item of b.items) if (typeof item === "string") out.push([where, item]);
    }
    return out;
  }
  if (field.kind === "object" && typeof value === "object") {
    const sub = field.options.fields as Record<string, AnyField>;
    return Object.entries(sub).flatMap(([k, f]) => texts(`${key}.${k}`, f, (value as Record<string, unknown>)[k]));
  }
  if (field.kind === "list" && Array.isArray(value)) return value.filter((v) => typeof v === "string").map((v) => [key, v as string]);
  if (field.kind === "text" && typeof value === "string") return [[key, value]];
  return [];
}

const sentences = (text: string) => text.replace(/\]\([^)]*\)/g, "]").split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const words = (s: string) => s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function lintEntry(input: Pick<CheckInput, "model" | "data" | "op" | "changed">, opts: LintOptions = {}): CheckFinding[] {
  const out: CheckFinding[] = [];
  const avoid = (opts.avoid ?? DEFAULT_AVOID).map(phrase);
  const maxWords = opts.maxSentenceWords ?? 40;
  const alt = opts.altText ?? "warning";
  const placeholders = opts.placeholders ?? "error";
  const touched = (key: string) => input.op === "create" || input.changed.includes(key);

  for (const [key, field] of Object.entries(input.model.fields)) {
    if (!touched(key)) continue;
    const value = input.data[key];
    for (const [where, text] of texts(key, field, value)) {
      const top = where.split(":")[0];
      if (placeholders) {
        const hit = PLACEHOLDERS.map((re) => text.match(re)?.[0]).find(Boolean);
        if (hit) out.push({ level: placeholders, field: top, message: `${where}: placeholder "${short(hit, 40)}" left in the text` });
      }
      for (const re of avoid) {
        const hit = text.match(re)?.[0];
        if (hit) out.push({ level: opts.avoidLevel ?? "warning", field: top, message: `${where}: avoid "${hit}"` });
      }
      if (maxWords > 0) {
        const long = sentences(text).find((s) => words(s) > maxWords);
        if (long) out.push({ level: "warning", field: top, message: `${where}: a ${words(long)}-word sentence ("${short(long, 50)}"); split it` });
      }
      const dead = text.match(/\[[^\]]*\]\(\s*(#?|https?:\/\/(?:localhost|127\.0\.0\.1)[^)]*)\s*\)/);
      if (dead) out.push({ level: "warning", field: top, message: `${where}: link "${short(dead[0], 50)}" goes nowhere` });
    }
    if (field.kind === "blocks" && Array.isArray(value)) {
      (value as Block[]).forEach((b, i) => {
        if (b.type === "heading" && !String(b.text ?? "").trim()) out.push({ level: "warning", field: key, message: `${key}: block ${i + 1} is an empty heading` });
        if (alt && b.type === "image" && !String(b.alt ?? "").trim()) out.push({ level: alt, field: key, message: `${key}: image ${short(String(b.src ?? b.url ?? i + 1), 50)} has no alt text` });
      });
    }
    if (alt && field.kind === "media" && value && typeof value === "object" && (value as { url?: string }).url && !String((value as { alt?: string }).alt ?? "").trim()) {
      out.push({ level: alt, field: key, message: `${key} has no alt text` });
    }
  }
  return out;
}

/** Content lint for every change: placeholders block, filler and sloppiness warn. */
export function lint(opts: LintOptions = {}) {
  return defineModule({
    name: "lint",
    description: "Content checks on every change: placeholders left in drafts block; filler phrases, long sentences, empty headings, missing alt text and dead links go to the reviewer.",
    uses: opts.models ?? ["*"],
    checks: {
      text: (input) => lintEntry(input, opts),
    },
  });
}
