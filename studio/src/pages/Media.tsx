import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { cms, errorMessage, useApi } from "../api.tsx";
import { useT } from "../i18n.tsx";
import { Button, Empty, ErrorBox, Icon, item, list, Modal, Pill, Skeleton, useToast } from "../ui.tsx";

export interface MediaRow {
  id: string;
  url: string;
  filename: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  alt?: string;
  createdAt: string;
}

const isImage = (m: MediaRow) => m.mime.startsWith("image/");
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Upload files through the media module's raw-body route (the session cookie authenticates it). */
export async function uploadFiles(files: File[]): Promise<MediaRow[]> {
  const out: MediaRow[] = [];
  for (const file of files) {
    const res = await fetch("/media/upload", { method: "POST", credentials: "same-origin", headers: { "x-filename": encodeURIComponent(file.name) }, body: file });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    out.push(body as MediaRow);
  }
  return out;
}

function useDropzone(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      depth.current++;
      setOver(true);
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    },
    onDragOver: (e: DragEvent) => e.dataTransfer.types.includes("Files") && e.preventDefault(),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = [...e.dataTransfer.files];
      if (files.length) onFiles(files);
    },
  };
  return { over, props };
}

function Thumb({ m }: { m: MediaRow }) {
  return isImage(m) ? <img src={m.url} alt={m.alt ?? ""} loading="lazy" /> : <span className="thumb-file"><Icon name="file" size={28} /><span className="mono small">{m.filename.split(".").pop()}</span></span>;
}

export function Media() {
  const { t } = useT();
  const toast = useToast();
  const [filter, setFilter] = useState<"all" | "alt">("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(48);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<MediaRow | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const data = useApi(() => cms.call<{ items: MediaRow[]; total: number }>("media.list", { limit, ...(filter === "alt" ? { missingAlt: true } : {}), ...(query.trim() ? { query: query.trim() } : {}) }), [filter, query, limit]);

  const upload = useCallback(async (files: File[]) => {
    setBusy(true);
    try {
      const rows = await uploadFiles(files);
      toast(t("media.uploaded", { name: rows.map((r) => r.filename).join(", ") }));
      data.reload();
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(false);
    }
  }, [data, t, toast]);
  const drop = useDropzone(upload);

  const saveAlt = async (m: MediaRow, alt: string) => {
    if ((m.alt ?? "") === alt.trim()) return;
    try {
      await cms.call("media.update", { id: m.id, alt });
      toast(t("media.saved"));
      data.reload();
    } catch (e) {
      toast(errorMessage(e), "gate");
    }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      await cms.call("media.delete", { id: removing.id });
      toast(t("media.deleted"));
      data.reload();
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="page" {...drop.props}>
      <header className="page-head">
        <div>
          <h1>{t("media.title")}</h1>
          <p className="lead">{t("media.lead")}</p>
        </div>
        <Button tone="primary" icon="upload" busy={busy} onClick={() => input.current?.click()}>{t("media.upload")}</Button>
        <input ref={input} type="file" multiple hidden accept="image/*,application/pdf,.svg" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) upload(f); }} />
      </header>

      <div className="toolbar">
        <div className="segmented">
          <button type="button" className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>{t("media.all")}</button>
          <button type="button" className={filter === "alt" ? "on" : ""} onClick={() => setFilter("alt")}>{t("media.missingAlt")}</button>
        </div>
        <label className="search grow">
          <Icon name="search" />
          <input className="input" type="search" placeholder={t("media.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      {data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : !data.data ? <Skeleton rows={4} /> : !data.data.items.length ? (
        <Empty icon="media">{t("media.empty")}</Empty>
      ) : (
        <>
          <motion.ul className="media-grid" variants={list} initial="initial" animate="enter">
            <AnimatePresence initial={false}>
              {data.data.items.map((m) => (
                <motion.li key={m.id} className="plate media-tile" variants={item} exit="exit" layout>
                  <div className="media-preview"><Thumb m={m} /></div>
                  <div className="media-meta">
                    <span className="media-name" title={m.filename}>{m.filename}</span>
                    <span className="muted small">{m.width && m.height ? `${m.width}×${m.height} · ` : ""}{kb(m.size)}</span>
                  </div>
                  {isImage(m) && <AltInput m={m} onSave={(alt) => saveAlt(m, alt)} />}
                  <div className="media-actions">
                    <button className="icon-btn" title={t("media.copy")} aria-label={t("media.copy")} onClick={async () => { await navigator.clipboard.writeText(new URL(m.url, location.origin).href).catch(() => {}); toast(t("media.copied")); }}><Icon name="link" size={16} /></button>
                    <button className="icon-btn danger-text" title={t("media.delete")} aria-label={t("media.delete")} onClick={() => setRemoving(m)}><Icon name="trash" size={16} /></button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
          {data.data.total > data.data.items.length && <div className="more"><Button onClick={() => setLimit((l) => l + 48)}>{t("media.more")}</Button></div>}
        </>
      )}

      <AnimatePresence>
        {drop.over && (
          <motion.div className="drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Icon name="upload" size={28} />
            <span>{t("media.drop")}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal open={!!removing} onClose={() => setRemoving(null)} title={t("media.delete")}>
        <p>{t("media.deleteAsk")}</p>
        <div className="row end">
          <Button tone="quiet" onClick={() => setRemoving(null)}>{t("cancel")}</Button>
          <Button tone="danger" icon="trash" onClick={remove}>{t("media.delete")}</Button>
        </div>
      </Modal>
    </div>
  );
}

function AltInput({ m, onSave }: { m: MediaRow; onSave(alt: string): void }) {
  const { t } = useT();
  const [value, setValue] = useState(m.alt ?? "");
  useEffect(() => setValue(m.alt ?? ""), [m.alt]);
  return (
    <div className="alt-input">
      {!m.alt && <Pill tone="mod">{t("media.missingAlt")}</Pill>}
      <input className="input" value={value} placeholder={t("media.alt")} onChange={(e) => setValue(e.target.value)} onBlur={() => onSave(value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </div>
  );
}

/** A library picker for media fields: choose an existing file or upload one. */
export function MediaPicker({ open, onClose, onPick }: { open: boolean; onClose(): void; onPick(m: MediaRow): void }) {
  const { t } = useT();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const data = useApi(() => (open ? cms.call<{ items: MediaRow[]; total: number }>("media.list", { limit: 60, ...(query.trim() ? { query: query.trim() } : {}) }) : Promise.resolve(undefined)), [open, query]);
  const upload = async (files: File[]) => {
    try {
      const [row] = await uploadFiles(files.slice(0, 1));
      onPick(row);
    } catch (e) {
      toast(errorMessage(e), "gate");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("media.choose")} wide>
      <div className="toolbar">
        <label className="search grow">
          <Icon name="search" />
          <input className="input" type="search" placeholder={t("media.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Button icon="upload" onClick={() => input.current?.click()}>{t("media.upload")}</Button>
        <input ref={input} type="file" hidden accept="image/*,.svg" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) upload(f); }} />
      </div>
      {!data.data ? <Skeleton rows={2} /> : !data.data.items.length ? <Empty icon="media">{t("media.empty")}</Empty> : (
        <ul className="picker-grid">
          {data.data.items.filter(isImage).map((m) => (
            <li key={m.id}>
              <button type="button" className="picker-tile" onClick={() => onPick(m)} title={m.alt || m.filename}>
                <Thumb m={m} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
