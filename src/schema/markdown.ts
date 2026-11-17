// Markdown in, blocks out. Agents read and write Markdown; the database keeps
// structured blocks. Anything Markdown has no syntax for is a directive:
//   :::cta{href="/spf" label="Pick a cream"}            (leaf block)
//   :::callout{tone="warning"}\nText\n:::               (block with text)

export interface Block {
  type: string;
  [key: string]: unknown;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const IMAGE = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/;
const FENCE = /^```\s*([\w+-]*)\s*$/;
const DIRECTIVE = /^:::([a-zA-Z][\w-]*)(?:\{(.*)\})?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const DIVIDER = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

export function parseAttributes(src: string): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  const re = /([a-zA-Z_][\w-]*)(?:=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const value = m[2] ?? m[3] ?? m[4];
    attrs[m[1]] = value === undefined ? true : value.replace(/\\"/g, '"');
  }
  return attrs;
}

export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", text: para.join("\n").trim() });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { flush(); continue; }

    const fence = trimmed.match(FENCE);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) code.push(lines[i++]);
      blocks.push({ type: "code", ...(fence[1] ? { lang: fence[1] } : {}), code: code.join("\n") });
      continue;
    }

    const directive = trimmed.match(DIRECTIVE);
    if (directive) {
      flush();
      const block: Block = { type: directive[1], ...parseAttributes(directive[2] ?? "") };
      // A directive owns the following lines until a closing ":::" — but only
      // if such a line exists; otherwise it is a leaf block.
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t === ":::") { close = j; break; }
        if (DIRECTIVE.test(t)) break;
      }
      if (close > i) {
        const text = lines.slice(i + 1, close).join("\n").trim();
        if (text) block.text = text;
        i = close;
      }
      blocks.push(block);
      continue;
    }

    const heading = trimmed.match(HEADING);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const image = trimmed.match(IMAGE);
    if (image) {
      flush();
      blocks.push({ type: "image", url: image[2], alt: image[1], ...(image[3] ? { caption: image[3] } : {}) });
      continue;
    }

    if (DIVIDER.test(trimmed) && !para.length) {
      blocks.push({ type: "divider" });
      continue;
    }

    if (trimmed.startsWith(">")) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      i--;
      blocks.push({ type: "quote", text: quote.join("\n").trim() });
      continue;
    }

    const bullet = line.match(BULLET);
    const ordered = line.match(ORDERED);
    if (bullet || ordered) {
      flush();
      const isOrdered = !!ordered && !bullet;
      const re = isOrdered ? ORDERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(m[1].trim());
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    para.push(trimmed);
  }
  flush();
  return blocks;
}

const serializeAttr = (value: unknown) => {
  if (value === true) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `="${text.replace(/"/g, '\\"')}"`;
};

export function blocksToMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "paragraph":
        out.push(String(b.text ?? ""));
        break;
      case "heading":
        out.push(`${"#".repeat(Math.min(6, Math.max(1, Number(b.level) || 2)))} ${b.text ?? ""}`);
        break;
      case "image":
        out.push(`![${b.alt ?? ""}](${b.url ?? ""}${b.caption ? ` "${b.caption}"` : ""})`);
        break;
      case "quote":
        out.push(String(b.text ?? "").split("\n").map((l) => `> ${l}`).join("\n"));
        break;
      case "list": {
        const items = Array.isArray(b.items) ? b.items : [];
        out.push(items.map((it, n) => (b.ordered ? `${n + 1}. ${it}` : `- ${it}`)).join("\n"));
        break;
      }
      case "code":
        out.push("```" + (b.lang ?? "") + "\n" + (b.code ?? "") + "\n```");
        break;
      case "divider":
        out.push("---");
        break;
      default: {
        const { type, text, ...rest } = b;
        const attrs = Object.entries(rest)
          .filter(([, v]) => v !== undefined && v !== null && v !== false)
          .map(([k, v]) => `${k}${serializeAttr(v)}`)
          .join(" ");
        const head = `:::${type}${attrs ? `{${attrs}}` : ""}`;
        out.push(text ? `${head}\n${text}\n:::` : head);
      }
    }
  }
  return out.join("\n\n");
}
