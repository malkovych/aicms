import type { ReactNode } from "react";

type Part = { kind: "same" | "ins" | "del"; text: string };

/** Longest-common-subsequence diff over tokens. Returns null when the input is too big to diff nicely. */
function diffTokens(a: string[], b: string[]): Part[] | null {
  if (a.length * b.length > 400_000) return null;
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Part[] = [];
  const push = (kind: Part["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("same", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", a[i++]);
    else push("ins", b[j++]);
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return out;
}

const words = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
const lines = (s: string) => s.split(/(?<=\n)/);

export const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

export function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

const scalars = (v: unknown): string[] | null =>
  v === null || v === undefined ? [] : typeof v === "string" && v ? [v] : Array.isArray(v) && v.every((x) => typeof x !== "object") ? v.map(String) : null;

/**
 * Before → after for one field, word by word for short text and line by line for long text.
 * `label` turns ids into names (for references); lists are shown as chips.
 */
export function FieldDiff({ before, after, created, label, list }: { before: unknown; after: unknown; created?: boolean; label?: (v: string) => string; list?: boolean }) {
  const a = scalars(created ? null : before);
  const b = scalars(after);
  if ((list || Array.isArray(after) || Array.isArray(before)) && a && b) {
    const A = new Set(a);
    const B = new Set(b);
    return (
      <div className="chips">
        {[...new Set([...a, ...b])].map((x) => (
          <span key={x} className={`chip ${label ? "" : "mono"} ${!A.has(x) ? "chip-ins" : !B.has(x) ? "chip-del" : ""}`} title={x}>{label ? label(x) : x}</span>
        ))}
      </div>
    );
  }
  if (created || isEmpty(before)) return <div className="diff"><ins>{show(after)}</ins></div>;
  if (isEmpty(after)) return <div className="diff"><del>{show(before)}</del></div>;

  const A = show(before);
  const B = show(after);
  const long = A.length > 400 || B.length > 400 || A.includes("\n") || B.includes("\n");
  const parts = long ? diffTokens(lines(A), lines(B)) : diffTokens(words(A), words(B));
  if (!parts) {
    return (
      <div className="diff diff-split">
        <del>{A}</del>
        <ins>{B}</ins>
      </div>
    );
  }
  const nodes: ReactNode[] = parts.map((p, i) => (p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "ins" ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>));
  return <div className={`diff ${long ? "diff-lines" : ""}`}>{nodes}</div>;
}
