// Blocks to HTML without dependencies. Inline Markdown inside block text
// (bold, italic, code, links) is supported; everything is escaped, and only
// http(s), mailto, tel, relative and #anchor URLs survive.

export interface Block {
  type: string;
  [key: string]: unknown;
}

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong" | "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|\n/g;

/** Inline Markdown → a small token tree. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  // A fresh regex per call: nested calls (bold inside a link…) must not share lastIndex.
  const re = new RegExp(INLINE.source, "g");
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[0] === "\n") out.push({ t: "br" });
    else if (m[2] !== undefined) out.push({ t: "code", v: m[2].trim() });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: "strong", c: parseInline(m[3] ?? m[4]) });
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ t: "em", c: parseInline(m[5] ?? m[6]) });
    else {
      const href = safeUrl(m[8]);
      const c = parseInline(m[7]);
      out.push(href ? { t: "link", href, c } : { t: "text", v: m[7] });
    }
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** The URL if it is safe to put in href/src, else undefined. */
export function safeUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const u = url.trim();
  if (!u) return undefined;
  if (/^(https?:|mailto:|tel:)/i.test(u) || /^[/#?.]/.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return undefined; // javascript:, data:, vbscript:…
  return u; // relative path such as "post/hello"
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export function inlineToHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text": return escapeHtml(n.v);
        case "br": return "<br>";
        case "code": return `<code>${escapeHtml(n.v)}</code>`;
        case "strong": return `<strong>${inlineToHtml(n.c)}</strong>`;
        case "em": return `<em>${inlineToHtml(n.c)}</em>`;
        case "link": return `<a href="${escapeHtml(n.href)}">${inlineToHtml(n.c)}</a>`;
      }
    })
    .join("");
}

const text = (b: Block, key = "text") => inlineToHtml(parseInline(String(b[key] ?? "")));

export type BlockRenderer = (block: Block, helpers: { inline: (s: unknown) => string; escape: (s: unknown) => string }) => string;

export interface HtmlOptions {
  /** Your own HTML for any block type, e.g. `{ cta: (b) => ... }`. Returned strings are used as is. */
  renderers?: Record<string, BlockRenderer>;
}

/** Render blocks to an HTML string, e.g. for Astro's set:html or a server template. */
export function blocksToHtml(blocks: readonly Block[] | null | undefined, opts: HtmlOptions = {}): string {
  if (!Array.isArray(blocks)) return "";
  const helpers = { inline: (s: unknown) => inlineToHtml(parseInline(String(s ?? ""))), escape: escapeHtml };
  return blocks
    .map((b) => {
      const custom = opts.renderers?.[b.type];
      if (custom) return custom(b, helpers);
      switch (b.type) {
        case "heading": {
          const level = Math.min(6, Math.max(1, Number(b.level) || 2));
          return `<h${level}>${text(b)}</h${level}>`;
        }
        case "paragraph": return `<p>${text(b)}</p>`;
        case "image": {
          const src = safeUrl(b.url);
          if (!src) return "";
          const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(b.alt)}" loading="lazy">`;
          return b.caption ? `<figure>${img}<figcaption>${text(b, "caption")}</figcaption></figure>` : img;
        }
        case "quote": return `<blockquote><p>${text(b)}</p></blockquote>`;
        case "list": {
          const tag = b.ordered ? "ol" : "ul";
          const items = Array.isArray(b.items) ? b.items : [];
          return `<${tag}>${items.map((i: unknown) => `<li>${helpers.inline(i)}</li>`).join("")}</${tag}>`;
        }
        case "code": {
          const lang = typeof b.lang === "string" && /^[\w+-]+$/.test(b.lang) ? ` class="language-${b.lang}"` : "";
          return `<pre><code${lang}>${escapeHtml(b.code)}</code></pre>`;
        }
        case "divider": return "<hr>";
        default: return directiveHtml(b);
      }
    })
    .join("\n");
}

/** Blocks without a renderer become `<aside data-block="cta" data-...>` with their text and link. */
function directiveHtml(b: Block): string {
  const { type, text: body, href, label, ...rest } = b;
  const attrs = Object.entries(rest)
    .filter(([k, v]) => /^[a-zA-Z][\w-]*$/.test(k) && v != null && typeof v !== "object")
    .map(([k, v]) => ` data-${k.toLowerCase()}="${escapeHtml(v)}"`)
    .join("");
  const link = safeUrl(href);
  const inner = (body ? `<p>${inlineToHtml(parseInline(String(body)))}</p>` : "") + (link ? `<a href="${escapeHtml(link)}">${escapeHtml(label ?? link)}</a>` : label ? escapeHtml(label) : "");
  return `<aside data-block="${escapeHtml(type)}"${attrs}>${inner}</aside>`;
}
