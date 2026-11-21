import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import type { Brief, BriefStatus } from "@aicms/client";
import { cms, errorMessage, isBriefEvent, useApi, useLive, useSite } from "../api.tsx";
import { useT, type Key } from "../i18n.tsx";
import { Link, navigate } from "../router.tsx";
import { Avatar, Button, Empty, ErrorBox, Icon, item, list, Modal, Pill, Skeleton, TimeAgo, toLocalInput, useToast, When } from "../ui.tsx";

type Row = Omit<Brief, "notes"> & { notes: number; lastNote?: { at: string; by: string; text: string } };
type Tab = "active" | "done" | "canceled";

const TAB_STATUS: Record<Tab, BriefStatus[]> = {
  active: ["open", "in_progress", "blocked", "in_review"],
  done: ["done"],
  canceled: ["canceled"],
};
const TONE: Record<BriefStatus, string> = { open: "adapt", in_progress: "core", blocked: "gate", in_review: "mod", done: "human", canceled: "adapt" };
// Questions first, then work in review, in progress, open.
const ORDER: BriefStatus[] = ["blocked", "in_review", "in_progress", "open", "done", "canceled"];

export function Briefs({ selected, creating }: { selected?: string; creating?: boolean }) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("active");
  const [writingState, setWriting] = useState(false);
  const writing = writingState || !!creating;
  const data = useApi(() => cms.call<{ briefs: Row[] }>("cms.briefs", { status: TAB_STATUS[tab], limit: 200 }), [tab]);
  useLive(isBriefEvent, data.reload);
  const rows = [...(data.data?.briefs ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("briefs.title")}</h1>
          <p className="lead">{t("briefs.lead")}</p>
        </div>
        <Button tone="primary" icon="plus" onClick={() => setWriting(true)}>{t("briefs.new")}</Button>
      </header>

      <div className="tabs" role="tablist">
        {(["active", "done", "canceled"] as Tab[]).map((s) => (
          <button key={s} role="tab" aria-selected={tab === s} className={`tab ${tab === s ? "active" : ""}`} onClick={() => { setTab(s); navigate("/briefs", true); }}>
            {tab === s && <motion.span layoutId="brief-tab-pill" className="tab-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <span>{t(`briefs.${s}` as Key)}</span>
          </button>
        ))}
      </div>

      <div className={`split ${selected ? "has-detail" : ""}`}>
        <section className="split-list">
          {data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : !data.data ? <Skeleton /> : !rows.length ? (
            <Empty icon="brief">{tab === "active" ? t("briefs.empty") : t("briefs.emptyTab")}</Empty>
          ) : (
            <motion.ul className="cards" variants={list} initial="initial" animate="enter">
              <AnimatePresence initial={false}>
                {rows.map((b) => <BriefCard key={b.id} b={b} active={b.id === selected} />)}
              </AnimatePresence>
            </motion.ul>
          )}
        </section>
        <section className="split-detail">
          <AnimatePresence mode="wait">
            {selected ? (
              <BriefDetail key={selected} id={selected} onChange={data.reload} />
            ) : (
              <motion.div key="pick" className="pick" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <Icon name="arrow" size={20} />
                <span>{t("briefs.pick")}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </div>

      <NewBrief open={writing} onClose={() => { setWriting(false); if (creating) navigate("/briefs", true); }} onCreated={(id) => { setWriting(false); setTab("active"); data.reload(); navigate(`/briefs/${id}`, !!creating); }} />
    </div>
  );
}

function BriefCard({ b, active }: { b: Row; active: boolean }) {
  const { t } = useT();
  const who = b.agent ?? b.claimedBy;
  return (
    <motion.li layout variants={item} initial="initial" animate="enter" exit="exit">
      <Link to={`/briefs/${b.id}`} className={`card ${active ? "active" : ""}`}>
        {who ? <Avatar name={who} size={36} /> : <span className="avatar avatar-any" style={{ width: 36, height: 36 }} aria-hidden="true"><Icon name="agents" size={18} /></span>}
        <div className="card-body">
          <div className="card-top">
            <strong>{who ?? t("briefs.anyAgent")}</strong>
            <span className="muted small"><TimeAgo at={b.updatedAt} /></span>
          </div>
          <div className="card-title">{b.title}</div>
          <div className="card-ops">
            <Pill tone={TONE[b.status]}>{b.status === "blocked" && <Icon name="alert" size={12} />} {t(`briefs.status.${b.status}` as Key)}</Pill>
            {b.due && <Pill tone="adapt"><Icon name="clock" size={12} /> {t("briefs.dueOn", { when: new Date(b.due).toLocaleDateString() })}</Pill>}
            {b.model && <Pill tone="adapt">{b.model}</Pill>}
            {!!b.notes && <Pill tone="adapt">✎ {b.notes}</Pill>}
          </div>
        </div>
      </Link>
    </motion.li>
  );
}

function BriefDetail({ id, onChange }: { id: string; onChange(): void }) {
  const { t } = useT();
  const toast = useToast();
  const one = useApi(() => cms.brief(id), [id]);
  useLive((e) => isBriefEvent(e) && e.payload?.id === id, one.reload, 300);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const save = async (what: string, input: Record<string, unknown>, done?: string) => {
    setBusy(what);
    try {
      await cms.call("cms.brief", { id, ...input });
      if (done) toast(done);
      one.reload();
      onChange();
      return true;
    } catch (e) {
      toast(errorMessage(e), "gate");
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (one.error) return <ErrorBox error={one.error} onRetry={one.reload} />;
  if (!one.data) return <Skeleton />;
  const b = one.data.brief;
  const who = b.agent ?? b.claimedBy;
  const closed = b.status === "done" || b.status === "canceled";

  return (
    <motion.article className="detail plate" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
      <header className="detail-head">
        <button className="icon-btn back-btn" onClick={() => navigate("/briefs")} aria-label="Back"><Icon name="back" /></button>
        <div className="detail-who">
          <h2>{b.title}</h2>
          <div className="muted small"><span className="mono">{b.id}</span> · {t("briefs.by", { who: b.createdBy })} · <TimeAgo at={b.createdAt} /></div>
        </div>
        <Pill tone={TONE[b.status]}>{t(`briefs.status.${b.status}` as Key)}</Pill>
      </header>

      {b.status === "blocked" && (
        <div className="notice notice-gate"><Icon name="alert" /><div>{t("briefs.blockedHint", { who: who ?? "" })}</div></div>
      )}

      <dl className="facts">
        <dt>{t("briefs.agent")}</dt>
        <dd>{who ? <span className="inline-who"><Avatar name={who} size={20} /> {who}</span> : t("briefs.anyAgent")}</dd>
        {b.model && <><dt>{t("briefs.model")}</dt><dd className="mono">{b.model}</dd></>}
        {b.entry && <><dt>{t("briefs.entry")}</dt><dd className="mono">{b.entry}</dd></>}
        {b.due && <><dt>{t("briefs.due")}</dt><dd>{new Date(b.due).toLocaleDateString()}</dd></>}
        {b.publishAt && <><dt>{t("briefs.publishAt")}</dt><dd><Icon name="clock" size={14} /> <When at={b.publishAt} /></dd></>}
        {!!b.changesets.length && (
          <><dt>{t("briefs.changes")}</dt><dd className="chips">{b.changesets.map((c) => <Link key={c} to={`/inbox/${c}`} className="chip mono">{c}</Link>)}</dd></>
        )}
      </dl>

      {b.details && <div className="brief-details">{b.details}</div>}

      <section className="notes">
        <h3>{t("briefs.notes")}</h3>
        {!b.notes.length ? <p className="muted small">{t("briefs.noNotes")}</p> : (
          <motion.ol className="note-list" variants={list} initial="initial" animate="enter">
            {b.notes.map((n, i) => (
              <motion.li key={`${n.at}-${i}`} className={`note ${n.by === b.createdBy || n.by === "owner" ? "note-person" : ""}`} variants={item}>
                <Avatar name={n.by} size={28} />
                <div className="note-body">
                  <div className="note-meta"><strong>{n.by}</strong> <span className="muted small"><TimeAgo at={n.at} /></span></div>
                  <div className="note-text">{n.text}</div>
                </div>
              </motion.li>
            ))}
          </motion.ol>
        )}
        {!closed && (
          <form className="note-compose" onSubmit={async (e) => { e.preventDefault(); if (note.trim() && (await save("note", { note: note.trim() }))) setNote(""); }}>
            <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("briefs.replyPh")} />
            <Button type="submit" tone="primary" icon="send" busy={busy === "note"} disabled={!note.trim()}>{t("briefs.send")}</Button>
          </form>
        )}
      </section>

      <footer className="decide">
        <div className="row">
          {closed ? (
            <Button icon="undo" busy={busy === "open"} onClick={() => save("open", { status: "open" }, t("briefs.saved"))}>{t("briefs.reopen")}</Button>
          ) : (
            <>
              <Button tone="approve" icon="check" busy={busy === "done"} onClick={() => save("done", { status: "done" }, t("briefs.saved"))}>{t("briefs.markDone")}</Button>
              <Button tone="quiet" icon="x" className="danger-text" busy={busy === "canceled"} onClick={() => save("canceled", { status: "canceled" }, t("briefs.saved"))}>{t("briefs.cancel")}</Button>
            </>
          )}
        </div>
      </footer>
    </motion.article>
  );
}

function NewBrief({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(id: string): void }) {
  const { t } = useT();
  const toast = useToast();
  const { site } = useSite();
  const agents = useApi(() => (open ? cms.call<{ agents: { name: string; description?: string }[] }>("cms.agents") : Promise.resolve(null)), [open]);
  const [f, setF] = useState({ title: "", details: "", agent: "", model: "", due: "", publishAt: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const create = async () => {
    setBusy(true);
    try {
      const r = await cms.call<{ brief: Brief }>("cms.brief", {
        title: f.title.trim(),
        ...(f.details.trim() ? { details: f.details.trim() } : {}),
        ...(f.agent ? { agent: f.agent } : {}),
        ...(f.model ? { model: f.model } : {}),
        ...(f.due ? { due: f.due } : {}),
        ...(f.publishAt ? { publishAt: new Date(f.publishAt).toISOString() } : {}),
      });
      toast(t("briefs.created", { agent: f.agent || t("briefs.anyAgent") }));
      setF({ title: "", details: "", agent: "", model: "", due: "", publishAt: "" });
      onCreated(r.brief.id);
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t("briefs.new")} wide>
      <form className="brief-form" onSubmit={(e) => { e.preventDefault(); if (f.title.trim()) void create(); }}>
        <label className="field">
          <span className="field-label">{t("briefs.titleLabel")}</span>
          <input className="input" autoFocus value={f.title} onChange={set("title")} placeholder={t("briefs.titlePh")} maxLength={200} />
        </label>
        <label className="field">
          <span className="field-label">{t("briefs.details")}</span>
          <textarea className="input" rows={5} value={f.details} onChange={set("details")} placeholder={t("briefs.detailsPh")} />
        </label>
        <div className="brief-grid">
          <label className="field">
            <span className="field-label">{t("briefs.agent")}</span>
            <select className="input" value={f.agent} onChange={set("agent")}>
              <option value="">{t("briefs.anyAgent")}</option>
              {(agents.data?.agents ?? []).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("briefs.model")}</span>
            <select className="input" value={f.model} onChange={set("model")}>
              <option value="">{t("briefs.anything")}</option>
              {site.models.map((m) => <option key={m.name} value={m.name}>{m.label ?? m.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("briefs.due")}</span>
            <input className="input" type="date" value={f.due} onChange={set("due")} />
          </label>
          <label className="field">
            <span className="field-label">{t("briefs.publishAt")}</span>
            <input className="input" type="datetime-local" value={f.publishAt} min={toLocalInput(new Date())} onChange={set("publishAt")} />
          </label>
        </div>
        <div className="row modal-foot">
          <Button tone="quiet" onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" tone="primary" icon="send" busy={busy} disabled={!f.title.trim()}>{t("briefs.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}
