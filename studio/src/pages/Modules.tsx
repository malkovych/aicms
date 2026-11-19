import { motion } from "framer-motion";
import { useState } from "react";
import { cms, errorMessage, useModules, useSite, type ModuleManifest } from "../api.tsx";
import { useT } from "../i18n.tsx";
import { Button, Empty, Icon, item, list, Pill, Skeleton, useToast } from "../ui.tsx";

/** What a module may do, shown before installing it and in the Inbox. */
export function ManifestView({ m }: { m: ModuleManifest }) {
  const { t } = useT();
  const rows: [string, React.ReactNode][] = [];
  if (m.provides.length) rows.push([t("modules.provides"), m.provides.map((p) => <Pill key={p} tone="mod">{p}</Pill>)]);
  if (m.requires.length) rows.push([t("modules.requires"), m.requires.map((p) => <Pill key={p} tone="gate">{p}</Pill>)]);
  if (m.uses.length) rows.push([t("modules.uses"), m.uses.map((u) => <span key={u} className="chip">{u === "*" ? t("modules.allModels") : u}</span>)]);
  if (m.models.length) rows.push([t("modules.models"), m.models.map((x) => <span key={x.name} className="chip mono">{x.name}</span>)]);
  if (m.routes.length) rows.push([t("modules.routes"), m.routes.map((r) => <span key={r} className="chip mono">{r}</span>)]);
  if (m.hooks.length) rows.push([t("modules.hooks"), m.hooks.map((h) => <span key={h} className="chip mono">{h}</span>)]);
  if (m.scopes.length) rows.push([t("modules.scopes"), m.scopes.map((s) => <span key={s} className="chip mono">{s}</span>)]);
  return (
    <div className="manifest">
      <dl className="manifest-rows">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="chips">{value}</dd>
          </div>
        ))}
      </dl>
      {!!m.actions.length && (
        <details className="manifest-actions">
          <summary>{t("modules.actions")} · {m.actions.length}</summary>
          <ul>
            {m.actions.map((a) => (
              <li key={a.name}>
                <span className="mono">{a.name}</span>
                <span className="muted small">{a.description}</span>
                <span className="muted small mono">{a.scope.includes(":") ? a.scope : t("modules.anyone")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function Modules() {
  const { t } = useT();
  const toast = useToast();
  const { modules, reload } = useModules();
  const { reload: reloadSite } = useSite();
  const [busy, setBusy] = useState<string | null>(null);

  const install = async (name: string) => {
    setBusy(name);
    try {
      const r = await cms.call<{ module: string; note?: string }>("cms.install_module", { module: name });
      toast(r.note ? `${t("modules.installedToast", { name: r.module })}. ${r.note}` : t("modules.installedToast", { name: r.module }));
      reload();
      reloadSite();
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("modules.title")}</h1>
          <p className="lead">{t("modules.lead")}</p>
        </div>
      </header>

      {!modules ? <Skeleton rows={4} /> : (
        <>
          <h2 className="section-title">{t("modules.installed")} <span className="muted">{modules.installed.length}</span></h2>
          {!modules.installed.length ? <Empty icon="modules">{t("modules.none")}</Empty> : (
            <motion.div className="module-grid" variants={list} initial="initial" animate="enter">
              {modules.installed.map((m) => (
                <motion.article key={m.name} className="plate module" variants={item} layout>
                  <header className="module-head">
                    <span className="module-brick brick-mod" aria-hidden="true"><Icon name="modules" size={18} /></span>
                    <div className="min0">
                      <h3>{m.name}{m.version && <span className="muted small"> v{m.version}</span>}</h3>
                      {m.description && <p className="muted small">{m.description}</p>}
                    </div>
                  </header>
                  <ManifestView m={m} />
                </motion.article>
              ))}
            </motion.div>
          )}

          <h2 className="section-title">{t("modules.available")} <span className="muted">{modules.available.length}</span></h2>
          {!modules.available.length ? <Empty icon="check">{t("modules.allInstalled")}</Empty> : (
            <>
              {modules.youCan !== "install" && <p className="muted small">{t("modules.proposeOnly")}</p>}
              <motion.div className="module-grid" variants={list} initial="initial" animate="enter">
                {modules.available.map((m) => (
                  <motion.article key={m.name} className="plate module module-available" variants={item} layout>
                    <header className="module-head">
                      <span className="module-brick" aria-hidden="true"><Icon name="plus" size={18} /></span>
                      <div className="min0">
                        <h3>{m.title ?? m.name}</h3>
                        <p className="muted small">{m.summary}</p>
                      </div>
                    </header>
                    <ManifestView m={m} />
                    <footer className="row module-foot">
                      {modules.youCan === "install" && <Button tone="primary" icon="plus" busy={busy === m.name} onClick={() => install(m.name)}>{t("modules.install")}</Button>}
                      <code className="muted small mono">aicms add {m.name}</code>
                    </footer>
                  </motion.article>
                ))}
              </motion.div>
            </>
          )}

          {!!modules.community?.length && (
            <>
              <h2 className="section-title">{t("modules.community")} <span className="muted">{modules.community.length}</span></h2>
              <p className="muted small">{t("modules.communityNote")}</p>
              <motion.div className="module-grid" variants={list} initial="initial" animate="enter">
                {modules.community.map((c) => (
                  <motion.article key={c.name} className="plate module module-available" variants={item} layout>
                    <header className="module-head">
                      <span className="module-brick" aria-hidden="true"><Icon name="modules" size={18} /></span>
                      <div className="min0">
                        <h3>{c.title}</h3>
                        <p className="muted small">{c.summary}</p>
                        <p className="muted small">{t("modules.by", { author: c.author })} · {c.license} · <span className="mono">{c.package}</span></p>
                      </div>
                    </header>
                    <ManifestView m={{ ...c, models: [], actions: [] }} />
                    <footer className="row module-foot">
                      <code className="muted small mono">{c.install}</code>
                    </footer>
                  </motion.article>
                ))}
              </motion.div>
            </>
          )}
        </>
      )}
    </div>
  );
}
