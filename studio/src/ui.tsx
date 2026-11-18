import { AnimatePresence, motion, type Variants } from "framer-motion";
import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useT } from "./i18n.tsx";

// ---------- motion ----------

export const page: Variants = {
  initial: { opacity: 0, y: 10 },
  enter: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16 } },
};

export const list: Variants = {
  enter: { transition: { staggerChildren: 0.035 } },
};

export const item: Variants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, x: 24, transition: { duration: 0.18 } },
};

export const pop: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  enter: { opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 32 } },
  exit: { opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.14 } },
};

// ---------- icons (24px grid, stroked) ----------

const PATHS: Record<string, string> = {
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z",
  content: "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M9 13h6M9 17h4",
  agents: "M12 3v3M8 21h8M7 9h10a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3zM9.5 13.5h.01M14.5 13.5h.01",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  back: "M15 18l-6-6 6-6",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  copy: "M9 9h10v10H9zM5 15V5h10",
  key: "M15 7a4 4 0 1 1-3.8 5.2L4 19v2h3v-2h2v-2h2l1.2-1.2A4 4 0 0 1 15 7zM16 8h.01",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  logout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  alert: "M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  arrow: "M5 12h14M13 6l6 6-6 6",
  modules: "M4 11h16v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM7 11V7.5h4V11M13 11V7.5h4V11",
  media: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5h.01",
  upload: "M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  file: "M7 3h7l5 5v13H7zM14 3v5h5",
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

// ---------- basics ----------

type Tone = "primary" | "approve" | "danger" | "ghost" | "quiet";

export function Button({ tone = "ghost", icon, busy, children, className, disabled, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; icon?: string; busy?: boolean }) {
  return (
    <motion.button whileTap={{ scale: 0.97 }} type={type} className={`btn btn-${tone} ${className ?? ""}`} disabled={busy || disabled} aria-busy={busy || undefined} {...(rest as object)}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children && <span>{children}</span>}
    </motion.button>
  );
}

const BRICKS = ["core", "gate", "mod", "human", "adapt"];
export function brickOf(name: string) {
  if (name === "owner") return "core";
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BRICKS[h % BRICKS.length];
}

/** A brick with the actor's initial: people and agents get stable colours. */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const label = name.startsWith("module:") ? name.slice(7) : name;
  return (
    <span className={`avatar brick-${brickOf(name)}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Pill({ tone = "adapt", children }: { tone?: string; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function TimeAgo({ at }: { at: string | null | undefined }) {
  const { t, lang } = useT();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!at) return null;
  const s = (Date.now() - new Date(at).getTime()) / 1000;
  const text = s < 45 ? t("now") : s < 3600 ? t("min", { n: Math.round(s / 60) }) : s < 86400 ? t("hour", { n: Math.round(s / 3600) }) : s < 7 * 86400 ? t("day", { n: Math.round(s / 86400) }) : new Date(at).toLocaleDateString(lang === "uk" ? "uk-UA" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
  return <time dateTime={at} title={new Date(at).toLocaleString()}>{text}</time>;
}

export function Empty({ icon = "inbox", children }: { icon?: string; children: ReactNode }) {
  return (
    <motion.div className="empty" variants={item} initial="initial" animate="enter">
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <div>{children}</div>
    </motion.div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div className="notice notice-gate" role="alert">
      <Icon name="alert" />
      <div>
        <strong>{t("error")}</strong>
        <div>{error instanceof Error ? error.message : String(error)}</div>
      </div>
      {onRetry && <Button onClick={onRetry}>{t("retry")}</Button>}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton-row" style={{ animationDelay: `${i * 90}ms` }} />)}
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <Button
      icon={done ? "check" : "copy"}
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? t("copied") : t("copy")}
    </Button>
  );
}

// ---------- modal ----------

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose(): void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div className={`modal plate ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" variants={pop} initial="initial" animate="enter" exit="exit">
            <header className="modal-head">
              <h2>{title}</h2>
              <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
            </header>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- toasts ----------

interface Toast {
  id: number;
  text: string;
  tone: "human" | "gate" | "core";
  action?: { label: string; run(): void };
}
const ToastContext = createContext<(text: string, tone?: Toast["tone"], action?: Toast["action"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "human", action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { id, text, tone, action }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((x) => (
            <motion.div key={x.id} layout className={`toast toast-${x.tone}`} initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 40 }} transition={{ type: "spring", stiffness: 480, damping: 34 }}>
              <Icon name={x.tone === "gate" ? "alert" : "check"} size={16} />
              <span>{x.text}</span>
              {x.action && <button className="toast-action" onClick={x.action.run}>{x.action.label}</button>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
