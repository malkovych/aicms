import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { cms, useApi, useLiveEach } from "../api.tsx";
import { useT } from "../i18n.tsx";
import { Avatar, Button, Empty, ErrorBox, Pill, Skeleton, TimeAgo } from "../ui.tsx";

interface LogEvent {
  id?: number;
  at: string;
  actor: string;
  gate: string;
  action: string;
  ok: boolean;
  error?: string;
  ms: number;
  live?: boolean;
}

const GATE_TONE: Record<string, string> = { mcp: "gate", rest: "core", studio: "human", cli: "adapt", sdk: "core", internal: "adapt" };

export function Activity() {
  const { t } = useT();
  const [actor, setActor] = useState("");
  const [older, setOlder] = useState<LogEvent[]>([]);
  const [fresh, setFresh] = useState<LogEvent[]>([]);
  const first = useApi(() => cms.call<{ events: LogEvent[] }>("cms.log", { limit: 50, ...(actor ? { actor } : {}) }), [actor]);
  const agents = useApi(() => cms.call<{ agents: { name: string }[] }>("cms.agents"), []);
  useEffect(() => {
    setOlder([]);
    setFresh([]);
  }, [actor]);

  useLiveEach(
    (e) => e.event === "action" && (!actor || e.payload.actor === actor),
    (e) => setFresh((rows) => [{ ...(e.payload as LogEvent), at: e.at, live: true }, ...rows].slice(0, 200)),
  );

  const rows = [...fresh, ...(first.data?.events ?? []), ...older];
  const oldest = rows[rows.length - 1]?.id;
  const loadOlder = async () => {
    const r = await cms.call<{ events: LogEvent[] }>("cms.log", { limit: 50, before: oldest, ...(actor ? { actor } : {}) });
    setOlder((o) => [...o, ...r.events]);
  };

  const people = ["owner", ...(agents.data?.agents.map((a) => a.name) ?? [])];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("activity.title")}</h1>
          <p className="lead">{t("activity.lead")}</p>
        </div>
        <select className="input auto" value={actor} onChange={(e) => setActor(e.target.value)} aria-label={t("activity.everyone")}>
          <option value="">{t("activity.everyone")}</option>
          {people.map((p) => <option key={p}>{p}</option>)}
        </select>
      </header>

      {first.error ? <ErrorBox error={first.error} onRetry={first.reload} /> : !first.data ? <Skeleton rows={8} /> : !rows.length ? (
        <Empty icon="activity">{t("activity.empty")}</Empty>
      ) : (
        <div className="plate log">
          <ul>
            <AnimatePresence initial={false}>
              {rows.map((e, i) => (
                <motion.li
                  key={e.id ?? `live-${e.at}-${i}`}
                  className={`log-row ${e.ok ? "" : "failed"}`}
                  initial={e.live ? { opacity: 0, backgroundColor: "var(--core-tint)" } : false}
                  animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
                  transition={{ duration: 0.25, backgroundColor: { duration: 1.6 } }}
                  layout="position"
                >
                  <span className="log-time muted small"><TimeAgo at={e.at} /></span>
                  <span className="log-actor"><Avatar name={e.actor} size={22} /> {e.actor}</span>
                  <Pill tone={GATE_TONE[e.gate] ?? "adapt"}>{e.gate}</Pill>
                  <span className="log-action mono">{e.action}</span>
                  <span className={`log-status ${e.ok ? "ok" : "err"}`}>{e.ok ? `${e.ms} ms` : e.error}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {first.data.events.length === 50 && oldest && (
            <div className="more"><Button onClick={loadOlder}>{t("activity.older")}</Button></div>
          )}
        </div>
      )}
    </div>
  );
}

