import { createElement, Fragment, type ReactNode } from "react";
import { parseInline, safeUrl, type Block, type Inline } from "@aicms/client";

export type BlockComponent = (props: { block: Block; inline: (text: unknown) => ReactNode }) => ReactNode;

export interface BlocksProps {
  value: readonly Block[] | null | undefined;
  /** Your own component for any block type, e.g. `{ cta: ({ block }) => <Button href={block.href} /> }`. */
  components?: Record<string, BlockComponent>;
}

function inlineNodes(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text": return n.v;
      case "br": return createElement("br", { key: i });
      case "code": return createElement("code", { key: i }, n.v);
      case "strong": return createElement("strong", { key: i }, ...inlineNodes(n.c));
      case "em": return createElement("em", { key: i }, ...inlineNodes(n.c));
      case "link": return createElement("a", { key: i, href: n.href }, ...inlineNodes(n.c));
    }
  });
}

const inline = (text: unknown): ReactNode => createElement(Fragment, null, ...inlineNodes(parseInline(String(text ?? ""))));

function renderBlock(b: Block, key: number, components: BlocksProps["components"]): ReactNode {
  const custom = components?.[b.type];
  if (custom) return createElement(Fragment, { key }, custom({ block: b, inline }));
  switch (b.type) {
    case "heading":
      return createElement(`h${Math.min(6, Math.max(1, Number(b.level) || 2))}`, { key }, inline(b.text));
    case "paragraph":
      return createElement("p", { key }, inline(b.text));
    case "image": {
      const src = safeUrl(b.url);
      if (!src) return null;
      const img = createElement("img", { src, alt: String(b.alt ?? ""), loading: "lazy" });
      return b.caption ? createElement("figure", { key }, img, createElement("figcaption", null, inline(b.caption))) : createElement(Fragment, { key }, img);
    }
    case "quote":
      return createElement("blockquote", { key }, createElement("p", null, inline(b.text)));
    case "list":
      return createElement(b.ordered ? "ol" : "ul", { key }, ...(Array.isArray(b.items) ? b.items : []).map((it, i) => createElement("li", { key: i }, inline(it))));
    case "code":
      return createElement("pre", { key }, createElement("code", typeof b.lang === "string" ? { className: `language-${b.lang}` } : null, String(b.code ?? "")));
    case "divider":
      return createElement("hr", { key });
    default: {
      const href = safeUrl(b.href);
      const data = Object.fromEntries(
        Object.entries(b)
          .filter(([k, v]) => !["type", "text", "href", "label"].includes(k) && /^[a-zA-Z][\w-]*$/.test(k) && v != null && typeof v !== "object")
          .map(([k, v]) => [`data-${k.toLowerCase()}`, String(v)]),
      );
      return createElement(
        "aside",
        { key, "data-block": b.type, ...data },
        b.text ? createElement("p", null, inline(b.text)) : null,
        href ? createElement("a", { href }, String(b.label ?? href)) : b.label ? String(b.label) : null,
      );
    }
  }
}

/** Render a blocks field. Works in Server Components (no hooks, no client JS). */
export function Blocks({ value, components }: BlocksProps): ReactNode {
  if (!Array.isArray(value)) return null;
  return createElement(Fragment, null, ...value.map((b, i) => renderBlock(b, i, components)));
}
