import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { isIP } from "node:net";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { action } from "../kernel/action.ts";
import { newId } from "../kernel/changesets.ts";
import { AicmsError } from "../kernel/errors.ts";
import { defineModule, type ModuleContext } from "../kernel/modules.ts";
import { allows } from "../kernel/policy.ts";
import { slugify } from "../schema/slug.ts";
import type { MediaRow } from "../store/types.ts";

export interface MediaOptions {
  /** Largest accepted file, in bytes. Default 10 MB. */
  maxBytes?: number;
  /** Prefix for stored URLs, e.g. "https://cms.example.com". Default: relative ("/media/…"). */
  baseUrl?: string;
  /** Let agents import files from http(s) URLs. Default true. */
  allowRemote?: boolean;
  /** Allow URL imports from private and loopback addresses (local development only). Default false. */
  allowPrivateNetworks?: boolean;
}

/** Loopback, private, link-local and other non-public ranges (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

const TYPES: [string, (b: Buffer) => boolean][] = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a"],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
  ["image/avif", (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && /avi[fs]/.test(b.subarray(8, 12).toString("latin1"))],
  ["application/pdf", (b) => b.subarray(0, 5).toString("latin1") === "%PDF-"],
  ["image/svg+xml", (b) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(b.subarray(0, 2048).toString("utf8"))],
];

/** The type from the file's own bytes; the name or a client header is never trusted. */
export function sniff(buf: Buffer): string | null {
  return TYPES.find(([, test]) => test(buf))?.[0] ?? null;
}

/** Width and height read from the image header (PNG, JPEG, GIF, WebP), without decoding it. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    if (sniff(buf) === "image/png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (sniff(buf) === "image/gif") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (sniff(buf) === "image/webp") {
      const chunk = buf.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (sniff(buf) === "image/jpeg") {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    /* truncated header */
  }
  return null;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "application/pdf": "pdf", "image/svg+xml": "svg" };

function safeName(name: string | undefined, mime: string): string {
  const raw = (name ?? "").split(/[\\/]/).pop() ?? "";
  const dot = raw.lastIndexOf(".");
  const base = slugify(dot > 0 ? raw.slice(0, dot) : raw, 60) || "file";
  return `${base}.${EXT[mime]}`;
}

/** Media library: uploads (file, URL or base64), image sizes, alt text, served under /media. */
export function media(opts: MediaOptions = {}) {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const base = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const fileOf = (ctx: ModuleContext, row: Pick<MediaRow, "id" | "filename">) => join(ctx.dataDir, "files", row.id, row.filename);
  const tooBig = () => new AicmsError("invalid", `Files may be up to ${Math.round(maxBytes / 1024 / 1024)} MB`);

  async function store(ctx: ModuleContext, buf: Buffer, name: string | undefined, alt: string | undefined): Promise<MediaRow> {
    if (!buf.length) throw new AicmsError("invalid", "The file is empty");
    if (buf.length > maxBytes) throw tooBig();
    const mime = sniff(buf);
    if (!mime) throw new AicmsError("invalid", "Unsupported file. Upload PNG, JPEG, GIF, WebP, AVIF, SVG or PDF.");
    const id = newId("med");
    const filename = safeName(name, mime);
    const row: MediaRow = {
      id,
      url: `${base}/media/${id}/${filename}`,
      filename,
      mime,
      size: buf.length,
      ...(imageSize(buf) ?? {}),
      ...(alt?.trim() ? { alt: alt.trim() } : {}),
      createdAt: new Date().toISOString(),
      createdBy: ctx.actor.id,
    };
    await mkdir(join(ctx.dataDir, "files", id), { recursive: true });
    await writeFile(fileOf(ctx, row), buf);
    await ctx.media.create(row);
    return row;
  }

  async function download(url: string): Promise<{ buf: Buffer; name: string }> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new AicmsError("invalid", "Not a valid URL");
    }
    // Follow redirects by hand so every hop is checked against private networks (SSRF).
    let res: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:$/.test(u.protocol)) throw new AicmsError("invalid", "Only http(s) URLs can be imported");
      if (!opts.allowPrivateNetworks) {
        const host = u.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
        if (!addresses.length) throw new AicmsError("invalid", `Can't resolve ${u.hostname}`);
        if (addresses.some(isPrivateAddress)) throw new AicmsError("forbidden", `${u.hostname} points to a private network address`);
      }
      res = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      u = new URL(location, u);
      res = undefined;
    }
    if (!res) throw new AicmsError("invalid", "Too many redirects");
    if (!res.ok || !res.body) throw new AicmsError("invalid", `Couldn't download ${url}: HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw tooBig();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maxBytes) throw tooBig();
      chunks.push(Buffer.from(chunk));
    }
    return { buf: Buffer.concat(chunks), name: decodeURIComponent(u.pathname.split("/").pop() ?? "") };
  }

  return defineModule({
    name: "media",
    description: "Media library: upload files or import them from URLs, image sizes, alt text, served under /media.",
    provides: ["media"],
    actions: {
      upload: action({
        description: "Add a file to the media library from a URL or base64 data. Returns { id, url, width, height }; put the url in a media field or an image block.",
        scope: "media:upload",
        input: z.strictObject({
          url: z.string().url().optional().describe("Import from this http(s) URL"),
          data: z.string().optional().describe("Base64 file contents (instead of url)"),
          filename: z.string().max(200).optional(),
          alt: z.string().max(500).optional().describe("What the image shows, for people who can't see it"),
        }),
        async run({ input, ctx }) {
          if (!!input.url === !!input.data) throw new AicmsError("invalid", "Pass either url or data");
          if (input.url) {
            if (opts.allowRemote === false) throw new AicmsError("forbidden", "Importing from URLs is turned off");
            const { buf, name } = await download(input.url);
            return store(ctx, buf, input.filename ?? name, input.alt);
          }
          return store(ctx, Buffer.from(input.data!, "base64"), input.filename, input.alt);
        },
      }),
      list: action({
        description: "Files in the media library, newest first. missingAlt: true lists images that still need alt text.",
        scope: "media:read",
        readOnly: true,
        input: z.strictObject({
          query: z.string().optional(),
          missingAlt: z.boolean().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          offset: z.number().int().min(0).optional(),
        }),
        run: ({ input, ctx }) => ctx.media.list({ query: input.query, missingAlt: input.missingAlt, limit: input.limit ?? 30, offset: input.offset ?? 0 }),
      }),
      get: action({
        description: "One file's details.",
        scope: "media:read",
        readOnly: true,
        input: z.strictObject({ id: z.string().min(1) }),
        async run({ input, ctx }) {
          const row = await ctx.media.get(input.id);
          if (!row) throw new AicmsError("not_found", `No media ${input.id}`);
          return row;
        },
      }),
      update: action({
        description: "Set a file's alt text.",
        scope: "media:update",
        input: z.strictObject({ id: z.string().min(1), alt: z.string().max(500) }),
        async run({ input, ctx }) {
          const row = await ctx.media.update(input.id, { alt: input.alt.trim() });
          if (!row) throw new AicmsError("not_found", `No media ${input.id}`);
          return row;
        },
      }),
      delete: action({
        description: "Delete a file from the library. Entries that still use its URL will show a broken image.",
        scope: "media:delete",
        destructive: true,
        input: z.strictObject({ id: z.string().min(1) }),
        async run({ input, ctx }) {
          const row = await ctx.media.get(input.id);
          if (!row) throw new AicmsError("not_found", `No media ${input.id}`);
          await ctx.media.delete(input.id);
          await rm(join(ctx.dataDir, "files", row.id), { recursive: true, force: true });
          return { deleted: input.id };
        },
      }),
    },
    routes: {
      // Raw-body upload for Studio and scripts: POST /media/upload with x-filename (and optional x-alt).
      "POST /media/upload": async ({ request, ctx }) => {
        if (!allows(ctx.actor.scopes, "media:upload")) {
          return Response.json({ error: { code: ctx.actor.kind === "public" ? "unauthorized" : "forbidden", message: "Uploading needs the media:upload scope" } }, { status: ctx.actor.kind === "public" ? 401 : 403 });
        }
        if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return Response.json({ error: { code: "invalid", message: tooBig().message } }, { status: 413 });
        try {
          const buf = Buffer.from(await request.arrayBuffer());
          const decode = (h: string | null) => (h ? decodeURIComponent(h) : undefined);
          const row = await store(ctx, buf, decode(request.headers.get("x-filename")), decode(request.headers.get("x-alt")));
          return Response.json(row, { status: 201 });
        } catch (e) {
          const err = e instanceof AicmsError ? e : new AicmsError("invalid", String(e));
          return Response.json({ error: err.toJSON() }, { status: err.status });
        }
      },
      "GET /media/:id/:name": async ({ params, ctx }) => {
        const row = await ctx.media.get(params.id);
        if (!row || row.filename !== params.name) return new Response("Not found", { status: 404 });
        const path = fileOf(ctx, row);
        try {
          await stat(path);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        const headers: Record<string, string> = {
          "content-type": row.mime,
          "content-length": String(row.size),
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        };
        // An SVG can carry scripts: serve it inert.
        if (row.mime === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
        return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers });
      },
    },
  });
}
