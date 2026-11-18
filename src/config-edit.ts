// Small, careful edits to aicms.config.ts: add or remove a module and its import.
// A tokenizer skips strings, template literals and comments, so brackets inside
// them never confuse the edit. If the file doesn't look like defineConfig({ ... }),
// we refuse instead of guessing.

import { readFileSync, writeFileSync } from "node:fs";

/** Index of the bracket that closes the one at `open`, or -1. */
function closing(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 1; if (i <= 0) return -1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Top-level `key:` positions inside the object literal spanning [open, close]. */
function topLevelKey(src: string, open: number, close: number, key: string): number {
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { for (i++; i < close && src[i] !== c; i++) if (src[i] === "\\") i++; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && src.startsWith(key, i) && /[\s,{]/.test(src[i - 1]) && /^\s*:/.test(src.slice(i + key.length))) return i;
  }
  return -1;
}

function configObject(src: string): { open: number; close: number } {
  const call = src.search(/defineConfig\s*\(/);
  if (call < 0) throw new Error("aicms.config doesn't call defineConfig({ ... }); add the module by hand");
  const open = src.indexOf("{", call);
  const close = open < 0 ? -1 : closing(src, open);
  if (close < 0) throw new Error("Couldn't read the defineConfig({ ... }) object; add the module by hand");
  return { open, close };
}

function modulesArray(src: string): { open: number; close: number } | null {
  const obj = configObject(src);
  const key = topLevelKey(src, obj.open, obj.close, "modules");
  if (key < 0) return null;
  const open = src.indexOf("[", key);
  const close = open < 0 ? -1 : closing(src, open);
  if (close < 0 || open > obj.close) throw new Error("`modules` isn't an array literal; add the module by hand");
  return { open, close };
}

/** Entries of the modules array as source text, e.g. ["seo()", "editorial"]. */
export function listModuleCalls(src: string): string[] {
  const arr = modulesArray(src);
  if (!arr) return [];
  const out: string[] = [];
  let start = arr.open + 1;
  for (let i = arr.open + 1; i < arr.close; i++) {
    const c = src[i];
    if ("([{".includes(c)) { i = closing(src, i); continue; }
    if (c === '"' || c === "'" || c === "`") { for (i++; src[i] !== c; i++) if (src[i] === "\\") i++; continue; }
    if (c === ",") { out.push(src.slice(start, i).trim()); start = i + 1; }
  }
  out.push(src.slice(start, arr.close).trim());
  return out.filter(Boolean);
}

function addImport(src: string, name: string, from: string, isDefault: boolean): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const named = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`);
  const m = named.exec(src);
  if (!isDefault && m) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (names.includes(name)) return src;
    return src.replace(named, `import { ${[...names, name].join(", ")} } from "${from}"`);
  }
  const line = isDefault ? `import ${name} from "${from}"` : `import { ${name} } from "${from}"`;
  const imports = [...src.matchAll(/^import\b[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$/gm)];
  if (!imports.length) return `${line}\n${src}`;
  const last = imports[imports.length - 1];
  const at = last.index! + last[0].length;
  return src.slice(0, at) + "\n" + line + src.slice(at);
}

export interface ModuleRef {
  /** Identifier used in the config, e.g. "seo". */
  name: string;
  /** Import source, e.g. "aicms/modules" or "./modules/blog/module.ts". */
  from: string;
  /** Default import (local and npm modules) or named (official modules). */
  isDefault: boolean;
  /** What goes into the array, e.g. "seo()" or "blog". */
  call: string;
}

/** Add a module to aicms.config: the import and an entry in `modules`. Returns the new source. */
export function addModuleSource(src: string, ref: ModuleRef): string {
  if (listModuleCalls(src).some((c) => c === ref.call || c.startsWith(`${ref.name}(`) || c === ref.name)) throw new Error(`"${ref.name}" is already in modules`);
  let out = addImport(src, ref.name, ref.from, ref.isDefault);
  const arr = modulesArray(out);
  if (arr) {
    const inner = out.slice(arr.open + 1, arr.close);
    const trimmed = inner.replace(/\s+$/, "");
    const multiline = inner.includes("\n");
    if (!trimmed.trim()) out = out.slice(0, arr.open + 1) + ref.call + out.slice(arr.close);
    else {
      const trailing = trimmed.endsWith(",");
      const indent = multiline ? (/\n([ \t]*)\S[^\n]*\s*$/.exec(trimmed)?.[1] ?? "    ") : "";
      const insertAt = arr.open + 1 + trimmed.length;
      const piece = multiline ? `${trailing ? "" : ","}\n${indent}${ref.call}${trailing ? "," : ""}` : `${trailing ? "" : ","} ${ref.call}`;
      out = out.slice(0, insertAt) + piece + out.slice(insertAt);
    }
  } else {
    const obj = configObject(out);
    const indent = /\n([ \t]+)\S/.exec(out.slice(obj.open, obj.close))?.[1] ?? "  ";
    out = out.slice(0, obj.open + 1) + `\n${indent}modules: [${ref.call}],` + out.slice(obj.open + 1);
  }
  return out;
}

/** Remove a module (by identifier) from `modules` and drop its import if nothing else uses it. */
export function removeModuleSource(src: string, name: string): string {
  const arr = modulesArray(src);
  const calls = listModuleCalls(src);
  const target = calls.find((c) => c === name || c.startsWith(`${name}(`));
  if (!arr || !target) throw new Error(`"${name}" isn't in modules`);
  const rest = calls.filter((c) => c !== target);
  const inner = src.slice(arr.open + 1, arr.close);
  const multiline = inner.includes("\n");
  const indent = /\n([ \t]*)\S/.exec(inner)?.[1] ?? "    ";
  const closeIndent = /\n([ \t]*)$/.exec(inner)?.[1] ?? "  ";
  const body = !rest.length ? "" : multiline ? `\n${rest.map((c) => indent + c).join(",\n")},\n${closeIndent}` : rest.join(", ");
  let out = src.slice(0, arr.open + 1) + body + src.slice(arr.close);
  // Drop the import if the identifier is no longer referenced as code (strings, comments,
  // object keys like `seo: { ... }` and the import itself don't count).
  const code = out
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
    .replace(/^import\b[^\n]*$/gm, "")
    .replace(new RegExp(`\\b${name}\\s*:`, "g"), "");
  if (!new RegExp(`\\b${name}\\b`).test(code)) {
    out = out.replace(new RegExp(`^import\\s+${name}\\s+from\\s*["'][^"']+["'];?[ \\t]*\\n?`, "m"), "");
    out = out.replace(/import\s*\{([^}]*)\}\s*from\s*(["'][^"']+["']);?/g, (whole, names: string, from: string) => {
      const list = names.split(",").map((s) => s.trim()).filter(Boolean);
      if (!list.includes(name)) return whole;
      const left = list.filter((n) => n !== name);
      return left.length ? `import { ${left.join(", ")} } from ${from}` : "";
    });
    out = out.replace(/^\n(?=import)|\n{3,}/gm, "\n\n");
  }
  return out;
}

export function addModuleToFile(file: string, ref: ModuleRef) {
  writeFileSync(file, addModuleSource(readFileSync(file, "utf8"), ref));
}

export function removeModuleFromFile(file: string, name: string) {
  writeFileSync(file, removeModuleSource(readFileSync(file, "utf8"), name));
}
