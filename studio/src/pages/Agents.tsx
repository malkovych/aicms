import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { cms, errorMessage, isChangesetEvent, useApi, useLive, useSite } from "../api.tsx";
import { useT } from "../i18n.tsx";
import { Link } from "../router.tsx";
import { Avatar, Button, CopyButton, Empty, ErrorBox, item, list, Modal, Pill, Skeleton, TimeAgo, useToast } from "../ui.tsx";

interface Agent {
  name: string;
  description?: string;
  scopes: string[];
  review: "human" | "auto" | { auto: string[] };
  budget?: { actionsPerHour?: number; maxChangesetItems?: number };
  tokens: number;
  lastSeen: string | null;
  actionsLastHour: number;
  waiting: number;
  drafting: number;
}

const SAMPLE = `agents: {
  writer: { scopes: ["post:draft"], review: "human" },
}`;

export function Agents() {
  const { t } = useT();
  const toast = useToast();
  const { site } = useSite();
  const data = useApi(() => cms.call<{ agents: Agent[] }>("cms.agents"), []);
  // Agents' own actions and review decisions change these numbers; our own page loads don't.
  useLive((e) => isChangesetEvent(e) || (e.event === "action" && e.payload.actor !== site.you.name), data.reload, 2000);
  const [issued, setIssued] = useState<{ agent: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const issue = async (agent: string) => {
    setBusy(`token:${agent}`);
    try {
      const r = await cms.call<{ token: string }>("cms.token", { agent });
      setIssued({ agent, token: r.token });
      data.reload();
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(null);
    }
  };
  const revoke = async () => {
    if (!revoking) return;
    setBusy(`revoke:${revoking}`);
    try {
      await cms.call("cms.revoke", { agent: revoking });
      toast(t("agents.revoked", { name: revoking }));
      data.reload();
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(null);
      setRevoking(null);
    }
  };

  const mcp = issued ? `claude mcp add --transport http aicms ${location.origin}/mcp --header "Authorization: Bearer ${issued.token}"` : "";

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("agents.title")}</h1>
          <p className="lead">{t("agents.lead")}</p>
        </div>
      </header>

      {data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : !data.data ? <Skeleton rows={4} /> : !data.data.agents.length ? (
        <Empty icon="agents">
          <p>{t("agents.empty")}</p>
          <pre className="code-block"><code>{SAMPLE}</code></pre>
        </Empty>
      ) : (
        <motion.div className="agent-grid" variants={list} initial="initial" animate="enter">
          {data.data.agents.map((a) => (
            <motion.article key={a.name} className="plate agent" variants={item} layout>
              <header className="agent-head">
                <Avatar name={a.name} size={44} />
                <div className="min0">
                  <h2>{a.name}</h2>
                  {a.description && <p className="muted small">{a.description}</p>}
                </div>
                <Pill tone={a.review === "human" ? "human" : typeof a.review === "object" ? "adapt" : "mod"}>{a.review === "human" ? t("agents.human") : typeof a.review === "object" ? t("agents.autoFor", { scopes: a.review.auto.join(", ") }) : t("agents.auto")}</Pill>
              </header>
              <div className="chips">
                {a.scopes.map((s) => <span key={s} className="chip mono">{s}</span>)}
              </div>
              <dl className="stats">
                <div><dt>{t("agents.seen")}</dt><dd>{a.lastSeen ? <TimeAgo at={a.lastSeen} /> : <span className="muted">{t("agents.never")}</span>}</dd></div>
                <div><dt>{t("agents.hour")}</dt><dd>{a.actionsLastHour}{a.budget?.actionsPerHour ? <span className="muted"> / {a.budget.actionsPerHour}</span> : null}</dd></div>
                <div><dt>{t("agents.waiting")}</dt><dd>{a.waiting ? <Link to="/">{a.waiting}</Link> : 0}</dd></div>
                <div><dt>{t("agents.drafting")}</dt><dd>{a.drafting}</dd></div>
                <div><dt>{t("agents.tokens")}</dt><dd>{a.tokens}</dd></div>
              </dl>
              {a.budget?.actionsPerHour ? (
                <div className="meter" aria-label={t("agents.budget")}>
                  <motion.span initial={{ width: 0 }} animate={{ width: `${Math.min(100, (a.actionsLastHour / a.budget.actionsPerHour) * 100)}%` }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} />
                </div>
              ) : null}
              <footer className="row">
                <Button icon="key" busy={busy === `token:${a.name}`} onClick={() => issue(a.name)}>{t("agents.token")}</Button>
                <Button tone="quiet" className="danger-text" disabled={!a.tokens && !a.waiting && !a.drafting} onClick={() => setRevoking(a.name)}>{t("agents.revoke")}</Button>
              </footer>
            </motion.article>
          ))}
        </motion.div>
      )}

      <Modal open={!!issued} onClose={() => setIssued(null)} title={issued ? t("agents.tokenFor", { name: issued.agent }) : ""} wide>
        <AnimatePresence>
          {issued && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <p className="notice notice-mod small">{t("agents.once")}</p>
              <div className="token-row">
                <code className="token mono">{issued.token}</code>
                <CopyButton text={issued.token} />
              </div>
              <h3 className="sub">{t("agents.connect")}</h3>
              <div className="token-row">
                <pre className="code-block grow"><code>{mcp}</code></pre>
                <CopyButton text={mcp} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Modal>

      <Modal open={!!revoking} onClose={() => setRevoking(null)} title={t("agents.revoke")}>
        <p>{revoking && t("agents.revokeAsk", { name: revoking })}</p>
        <div className="row end">
          <Button tone="quiet" onClick={() => setRevoking(null)}>{t("cancel")}</Button>
          <Button tone="danger" busy={busy === `revoke:${revoking}`} onClick={revoke}>{t("agents.revoke")}</Button>
        </div>
      </Modal>
    </div>
  );
}
