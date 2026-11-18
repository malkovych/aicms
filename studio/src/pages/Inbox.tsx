import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { cms, errorMessage, humanize, isChangesetEvent, titleField, useApi, useLive, useModel, useSite } from "../api.tsx";
import { FieldDiff } from "../diff.tsx";
import { useT, type Key } from "../i18n.tsx";
import { Link, navigate } from "../router.tsx";
import { Avatar, Button, Empty, ErrorBox, Icon, item, list, Pill, Skeleton, TimeAgo, useToast } from "../ui.tsx";

type Status = "submitted" | "open" | "merged" | "rejected";

interface Change { field: string; before: unknown; after: unknown }
interface Item { op: "create" | "update" | "delete"; model: string; id: string; title?: string; changes: Change[] }
interface Changeset {
  id: string;
  actor: string;
  status: Status;
  note?: string;
  comment?: string;
  waitingBecause?: string;
  issues?: { entry: string; field?: string; message: string }[];
  items: Item[];
  updatedAt: string;
}

const TABS: Status[] = ["submitted", "open", "merged", "rejected"];
const OP_TONE = { create: "human", update: "core", delete: "gate" } as const;

export function Inbox({ selected }: { selected?: string }) {
  const { t } = useT();
  const [tab, setTab] = useState<Status>("submitted");
  const data = useApi(() => cms.call<{ changesets: Changeset[] }>("cms.review", { status: tab, limit: 50 }), [tab]);
  useLive(isChangesetEvent, data.reload);
  const rows = data.data?.changesets ?? [];
  const current = rows.find((c) => c.id === selected);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("inbox.title")}</h1>
          <p className="lead">{t("inbox.lead")}</p>
        </div>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((s) => (
          <button key={s} role="tab" aria-selected={tab === s} className={`tab ${tab === s ? "active" : ""}`} onClick={() => { setTab(s); navigate("/", true); }}>
            {tab === s && <motion.span layoutId="tab-pill" className="tab-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <span>{t(`inbox.${s}` as Key)}</span>
          </button>
        ))}
      </div>

      <div className={`split ${selected ? "has-detail" : ""}`}>
        <section className="split-list">
          {data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : !data.data ? <Skeleton /> : !rows.length ? (
            <Empty icon="inbox">{tab === "submitted" ? t("inbox.empty.submitted") : t("inbox.empty")}</Empty>
          ) : (
            <motion.ul className="cards" variants={list} initial="initial" animate="enter">
              <AnimatePresence initial={false}>
                {rows.map((cs) => <ChangesetCard key={cs.id} cs={cs} active={cs.id === selected} />)}
              </AnimatePresence>
            </motion.ul>
          )}
        </section>
        <section className="split-detail">
          <AnimatePresence mode="wait">
            {current ? (
              <Detail key={current.id} cs={current} onDone={(next) => { data.reload(); navigate(next ? `/inbox/${next}` : "/", true); }} next={rows[rows.indexOf(current) + 1]?.id ?? rows[rows.indexOf(current) - 1]?.id} />
            ) : selected && data.data ? (
              <SelectedElsewhere key="missing" id={selected} />
            ) : (
              <motion.div key="pick" className="pick" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <Icon name="arrow" size={20} />
                <span>{t("inbox.pick")}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </div>
    </div>
  );
}

/** A changeset linked from elsewhere that isn't in the current tab: load it by id. */
function SelectedElsewhere({ id }: { id: string }) {
  const one = useApi(() => cms.review(id) as Promise<Changeset>, [id]);
  if (one.error) return <ErrorBox error={one.error} />;
  if (!one.data) return <Skeleton />;
  return <Detail cs={one.data} onDone={() => { one.reload(); }} />;
}

function opSummary(items: Item[]) {
  const counts = { create: 0, update: 0, delete: 0 };
  for (const i of items) counts[i.op]++;
  return counts;
}

function ChangesetCard({ cs, active }: { cs: Changeset; active: boolean }) {
  const { t } = useT();
  const counts = opSummary(cs.items);
  return (
    <motion.li layout variants={item} initial="initial" animate="enter" exit="exit">
      <Link to={`/inbox/${cs.id}`} className={`card ${active ? "active" : ""}`}>
        <Avatar name={cs.actor} size={36} />
        <div className="card-body">
          <div className="card-top">
            <strong>{cs.actor}</strong>
            <span className="muted small"><TimeAgo at={cs.updatedAt} /></span>
          </div>
          <div className="card-title">{cs.note || cs.items.map((i) => i.title || i.id).slice(0, 3).join(" · ")}</div>
          <div className="card-ops">
            {(["create", "update", "delete"] as const).map((op) => counts[op] ? <Pill key={op} tone={OP_TONE[op]}>{t(`op.${op}`)} · {counts[op]}</Pill> : null)}
            {!!cs.issues?.length && <Pill tone="gate"><Icon name="alert" size={12} /> {cs.issues.length}</Pill>}
          </div>
        </div>
      </Link>
    </motion.li>
  );
}

function Detail({ cs, onDone, next }: { cs: Changeset; onDone(next?: string): void; next?: string }) {
  const { t } = useT();
  const toast = useToast();
  const { reload: reloadSite } = useSite();
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const [final, setFinal] = useState(false);
  const pending = cs.status === "submitted" || cs.status === "open";

  const run = async (what: string, fn: () => Promise<string>, goNext = true) => {
    setBusy(what);
    try {
      toast(await fn(), "human");
      reloadSite();
      onDone(goNext ? next : undefined);
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(null);
    }
  };

  const approve = () => run("merge", async () => {
    const r = await cms.merge(cs.id);
    return t("inbox.published", { n: r.entries.length });
  });
  const reject = () => run("reject", async () => {
    await cms.reject(cs.id, comment.trim(), { final });
    return final ? t("inbox.closed") : t("inbox.sentBack", { actor: cs.actor });
  });
  const revert = () => run("revert", async () => {
    await cms.revert(cs.id);
    await cms.submit(`Revert ${cs.id}`);
    return t("inbox.reverted");
  }, false);

  return (
    <motion.article className="detail plate" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
      <header className="detail-head">
        <button className="icon-btn back-btn" onClick={() => navigate("/")} aria-label="Back"><Icon name="back" /></button>
        <Avatar name={cs.actor} size={44} />
        <div className="detail-who">
          <h2>{cs.actor}</h2>
          <div className="muted small"><span className="mono">{cs.id}</span> · <TimeAgo at={cs.updatedAt} /> · {t("inbox.items", { n: cs.items.length })}</div>
        </div>
        <Pill tone={cs.status === "merged" ? "human" : cs.status === "rejected" ? "gate" : cs.status === "submitted" ? "mod" : "adapt"}>{t(`inbox.${cs.status}` as Key)}</Pill>
      </header>

      {(cs.note || cs.waitingBecause || cs.comment) && (
        <dl className="facts">
          {cs.note && <><dt>{t("inbox.note")}</dt><dd>{cs.note}</dd></>}
          {cs.waitingBecause && <><dt>{t("inbox.why")}</dt><dd>{cs.waitingBecause}</dd></>}
          {cs.comment && <><dt>{t("inbox.comment.label")}</dt><dd>{cs.comment}</dd></>}
        </dl>
      )}

      {!!cs.issues?.length && (
        <div className="notice notice-gate">
          <Icon name="alert" />
          <div>
            <strong>{t("inbox.issues")}</strong>
            <ul>{cs.issues.map((i, n) => <li key={n}><span className="mono">{i.entry}{i.field ? `.${i.field}` : ""}</span> — {i.message}</li>)}</ul>
          </div>
        </div>
      )}

      <motion.div className="items" variants={list} initial="initial" animate="enter">
        {cs.items.map((it) => (
          <motion.section key={it.id} className={`change change-${it.op}`} variants={item}>
            <header className="change-head">
              <Pill tone={OP_TONE[it.op]}>{t(`op.${it.op}`)}</Pill>
              <span className="muted">{it.model}</span>
              {it.op !== "create" || cs.status === "merged" ? (
                <Link to={`/content/${it.model}/${it.id}`} className="change-title">{it.title || it.id}</Link>
              ) : <span className="change-title">{it.title || it.id}</span>}
            </header>
            {it.op === "delete" ? (
              <p className="muted">{t("inbox.willDelete")}</p>
            ) : (
              <ItemFields item={it} />
            )}
          </motion.section>
        ))}
      </motion.div>

      {pending && (
        <footer className="decide">
          <AnimatePresence initial={false} mode="wait">
            {asking ? (
              <motion.div key="ask" className="ask" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                <textarea className="input" rows={3} autoFocus value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("inbox.comment")} />
                <label className="check"><input type="checkbox" checked={final} onChange={(e) => setFinal(e.target.checked)} /> {t("inbox.closeInstead")}</label>
                <div className="row">
                  <Button tone="danger" icon={final ? "x" : "undo"} busy={busy === "reject"} disabled={!comment.trim()} onClick={reject}>{final ? t("close") : t("inbox.send")}</Button>
                  <Button tone="quiet" onClick={() => setAsking(false)}>{t("cancel")}</Button>
                </div>
              </motion.div>
            ) : (
              <motion.div key="buttons" className="row" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <Button tone="approve" icon="check" busy={busy === "merge"} disabled={!!cs.issues?.length} onClick={approve}>{t("inbox.approve")}</Button>
                <Button icon="undo" onClick={() => setAsking(true)}>{t("inbox.request")}</Button>
              </motion.div>
            )}
          </AnimatePresence>
        </footer>
      )}
      {cs.status === "merged" && (
        <footer className="decide">
          <Button icon="undo" busy={busy === "revert"} onClick={revert}>{t("inbox.revert")}</Button>
        </footer>
      )}
    </motion.article>
  );
}

/** Entry titles for reference ids, fetched once per id. */
const titles = new Map<string, Promise<string>>();
function useTitles(model: string | undefined, ids: string[]) {
  const target = useModel(model);
  const [names, setNames] = useState<Record<string, string>>({});
  const key = ids.join(",");
  useEffect(() => {
    if (!model || !target.data || !ids.length) return;
    const field = titleField(target.data);
    let live = true;
    Promise.all(
      ids.map((id) => {
        if (!titles.has(id)) titles.set(id, cms.model(model).get({ id, drafts: true }).then((e) => (field && (e[field] as string)) || id, () => id));
        return titles.get(id)!.then((name) => [id, name] as const);
      }),
    ).then((pairs) => live && setNames(Object.fromEntries(pairs)));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, target.data, key]);
  return (id: string) => names[id] ?? id;
}

const asIds = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

function RefDiff({ model, before, after, created }: { model?: string; before: unknown; after: unknown; created: boolean }) {
  const label = useTitles(model, [...new Set([...asIds(before), ...asIds(after)])]);
  return <FieldDiff before={before} after={after} created={created} label={label} list />;
}

function ItemFields({ item: it }: { item: Item }) {
  const info = useModel(it.model);
  const byName = new Map((info.data?.fields ?? []).map((f) => [f.name, f]));
  return (
    <div className="fields">
      {it.changes.map((c) => {
        const f = byName.get(c.field);
        return (
          <div key={c.field} className="field-change">
            <div className="field-name">{f?.label ?? humanize(c.field)}</div>
            {f?.kind === "ref" ? (
              <RefDiff model={f.model} before={c.before} after={c.after} created={it.op === "create"} />
            ) : f?.kind === "object" && f.fields ? (
              <div className="subfields">
                {f.fields.map((sub) => {
                  const b = (c.before as Record<string, unknown> | null)?.[sub.name];
                  const a = (c.after as Record<string, unknown> | null)?.[sub.name];
                  if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return null;
                  return (
                    <div key={sub.name} className="subfield">
                      <span className="muted small">{sub.label ?? humanize(sub.name)}</span>
                      <FieldDiff before={b} after={a} created={it.op === "create"} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <FieldDiff before={c.before} after={c.after} created={it.op === "create"} list={f?.kind === "list"} />
            )}
          </div>
        );
      })}
    </div>
  );
}
