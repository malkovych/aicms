import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { cms } from "./api.tsx";
import { useT } from "./i18n.tsx";
import { navigate } from "./router.tsx";
import { Icon, pop } from "./ui.tsx";

export interface Command {
  id: string;
  group: "pages" | "actions" | "entries";
  label: string;
  hint?: string;
  icon: string;
  run(): void;
}

interface Hit { model: string; id: string; title: string; snippet?: string }

/** Open with ⌘K / Ctrl+K anywhere, or "/" outside text fields. */
export function usePaletteHotkey(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        open();
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function CommandPalette({ open, onClose, commands, models }: { open: boolean; onClose(): void; commands: Command[]; models: Record<string, string> }) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      restore.current = document.activeElement;
      setQuery("");
      setHits([]);
      setActive(0);
    } else if (restore.current instanceof HTMLElement) restore.current.focus();
  }, [open]);

  // Entries: full-text search as you type, debounced; stale answers are dropped.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) return setHits([]);
    let live = true;
    const timer = setTimeout(() => {
      cms.search(q, { limit: 8 }).then((r) => live && setHits(r.hits as Hit[]), () => live && setHits([]));
    }, 140);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, open]);

  const items = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const matched = q ? commands.filter((c) => `${c.label} ${c.hint ?? ""}`.toLocaleLowerCase().includes(q)) : commands;
    const entries: Command[] = hits.map((h) => ({
      id: `entry:${h.id}`,
      group: "entries",
      label: h.title || h.id,
      hint: models[h.model] ?? h.model,
      icon: "content",
      run: () => navigate(`/content/${h.model}/${h.id}`),
    }));
    return [...matched.filter((c) => c.group === "pages"), ...matched.filter((c) => c.group === "actions"), ...entries];
  }, [commands, hits, query, models]);

  useEffect(() => setActive((a) => Math.min(a, Math.max(0, items.length - 1))), [items.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="palette-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div className="palette plate" role="dialog" aria-modal="true" aria-label={t("cmdk.open")} variants={pop} initial="initial" animate="enter" exit="exit" onKeyDown={onKeyDown}>
            <div className="palette-search">
              <Icon name="search" />
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder={t("cmdk.placeholder")}
                aria-label={t("cmdk.placeholder")}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={items[active] ? `palette-${active}` : undefined}
              />
              <kbd>esc</kbd>
            </div>
            <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
              {!items.length && <div className="palette-empty muted">{t("cmdk.none")}</div>}
              {items.map((c, i) => {
                const heading = c.group !== lastGroup ? (lastGroup = c.group) : null;
                return (
                  <div key={c.id}>
                    {heading && <div className="palette-group">{t(`cmdk.${heading}` as "cmdk.pages")}</div>}
                    <button
                      id={`palette-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={i === active}
                      className={`palette-item ${i === active ? "active" : ""}`}
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={() => choose(c)}
                    >
                      {i === active && <motion.span layoutId="palette-pill" className="palette-pill" transition={{ type: "spring", stiffness: 600, damping: 40 }} />}
                      <Icon name={c.icon} size={16} />
                      <span className="palette-label">{c.label}</span>
                      {c.hint && <span className="palette-hint">{c.hint}</span>}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="palette-foot muted small">{t("cmdk.hint")}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
