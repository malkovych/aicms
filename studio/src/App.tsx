import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cms, isBriefEvent, isChangesetEvent, LiveProvider, ModulesProvider, SiteProvider, useApi, useLive, useLiveStatus, useModules, useSite, type SiteInfo } from "./api.tsx";
import { useT } from "./i18n.tsx";
import { CommandPalette, isMac, usePaletteHotkey, type Command } from "./palette.tsx";
import { Activity } from "./pages/Activity.tsx";
import { Agents } from "./pages/Agents.tsx";
import { Briefs } from "./pages/Briefs.tsx";
import { ContentList, EntryEditor } from "./pages/Content.tsx";
import { Inbox } from "./pages/Inbox.tsx";
import { Media } from "./pages/Media.tsx";
import { Modules } from "./pages/Modules.tsx";
import { Link, match, navigate, usePath } from "./router.tsx";
import { ErrorBox, Icon, page, Skeleton } from "./ui.tsx";

export function App() {
  const site = useApi(() => cms.describe() as Promise<SiteInfo>, []);
  if (site.error && !site.data) return <Centered><ErrorBox error={site.error} onRetry={site.reload} /></Centered>;
  if (!site.data) return <Centered><Skeleton rows={3} /></Centered>;
  if (site.data.you.name === "public") return <SignIn />;
  return (
    <SiteProvider site={site.data} reload={site.reload}>
      <LiveProvider>
        <ModulesProvider>
          <Shell />
        </ModulesProvider>
      </LiveProvider>
    </SiteProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered"><div style={{ width: "min(520px, 100%)" }}>{children}</div></div>;
}

function Wordmark() {
  return (
    <span className="wordmark">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <rect x="2" y="10" width="28" height="19" rx="5" fill="var(--core)" />
        <rect x="7" y="5" width="7" height="7" rx="2" fill="var(--core)" />
        <rect x="18" y="5" width="7" height="7" rx="2" fill="var(--core)" />
      </svg>
      <span className="wordmark-text">AICMS</span>
    </span>
  );
}

function SignIn() {
  const { t } = useT();
  return (
    <div className="centered">
      <motion.main className="plate signin" variants={page} initial="initial" animate="enter">
        <Wordmark />
        <h1>{t("signin.title")}</h1>
        <p>{t("signin.body")}</p>
        <pre className="code-block"><code>npx aicms login</code></pre>
        <p className="muted small">{t("signin.hint")}</p>
      </motion.main>
    </div>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("aicms.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, () => setTheme((x) => (x === "dark" ? "light" : "dark"))] as const;
}

function Shell() {
  const path = usePath();
  const { t, toggle, lang } = useT();
  const { site, reload } = useSite();
  const live = useLiveStatus();
  const mods = useModules();
  const [theme, flipTheme] = useTheme();
  const waiting = useApi(() => cms.review() as Promise<{ changesets: unknown[] }>, []);
  // Briefs with a question for a person.
  const asking = useApi(() => cms.briefs({ status: ["blocked"] }), []);
  useLive(isChangesetEvent, (e) => {
    waiting.reload();
    reload();
    if (e.payload?.modules?.length) mods.reload();
  }, 600);
  useLive(isBriefEvent, asking.reload, 600);
  const [palette, setPalette] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  usePaletteHotkey(openPalette);

  const section = path.split("/")[1] || "inbox";
  const nav = [
    { to: "/", key: "inbox", icon: "inbox", label: t("nav.inbox"), badge: waiting.data?.changesets.length },
    { to: "/briefs", key: "briefs", icon: "brief", label: t("nav.briefs"), badge: asking.data?.total },
    { to: site.models[0] ? `/content/${site.models[0].name}` : "/content", key: "content", icon: "content", label: t("nav.content") },
    ...(mods.has("media") ? [{ to: "/media", key: "media", icon: "media", label: t("nav.media") }] : []),
    { to: "/agents", key: "agents", icon: "agents", label: t("nav.agents") },
    { to: "/modules", key: "modules", icon: "modules", label: t("nav.modules") },
    { to: "/activity", key: "activity", icon: "activity", label: t("nav.activity") },
  ];

  const commands = useMemo<Command[]>(() => [
    ...nav.map((n) => ({ id: `go:${n.key}`, group: "pages" as const, label: n.label, icon: n.icon, run: () => navigate(n.to) })),
    ...site.models.map((m) => ({ id: `go:model:${m.name}`, group: "pages" as const, label: m.label ?? m.name, hint: t("nav.content"), icon: "content", run: () => navigate(`/content/${m.name}`) })),
    ...site.models.map((m) => ({ id: `new:${m.name}`, group: "actions" as const, label: t("cmdk.new", { model: m.label ?? m.name }), icon: "plus", run: () => navigate(`/content/${m.name}/new`) })),
    { id: "new:brief", group: "actions", label: t("cmdk.newBrief"), icon: "brief", run: () => navigate("/briefs/new") },
    { id: "theme", group: "actions", label: t("cmdk.theme"), icon: theme === "dark" ? "sun" : "moon", run: flipTheme },
    { id: "lang", group: "actions", label: t("cmdk.lang"), icon: "globe", run: toggle },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [lang, theme, site.models, mods.modules]);
  const modelLabels = useMemo(() => Object.fromEntries(site.models.map((m) => [m.name, m.label ?? m.name])), [site.models]);

  let view: React.ReactNode;
  let params: Record<string, string> | null;
  if ((params = match("/content/:model/new", path))) view = <EntryEditor model={params.model} />;
  else if ((params = match("/content/:model/:id", path))) view = <EntryEditor model={params.model} id={params.id} />;
  else if ((params = match("/content/:model", path))) view = <ContentList model={params.model} />;
  else if (path === "/agents") view = <Agents />;
  else if (path === "/activity") view = <Activity />;
  else if (path === "/modules") view = <Modules />;
  else if (path === "/media") view = <Media />;
  else if (path === "/briefs/new") view = <Briefs creating />;
  else if ((params = match("/briefs/:id", path))) view = <Briefs selected={params.id} />;
  else if (path === "/briefs") view = <Briefs />;
  else if ((params = match("/inbox/:id", path))) view = <Inbox selected={params.id} />;
  else view = <Inbox />;

  const signOut = async () => {
    await fetch("/studio/logout", { method: "POST", credentials: "same-origin" });
    location.href = "/studio/";
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Wordmark />
          <span className="site-name" title={site.site}>{site.site}</span>
        </div>
        <button className="nav-search" onClick={openPalette} aria-label={t("cmdk.open")} title={`${t("cmdk.open")} (${isMac ? "⌘" : "Ctrl+"}K)`}>
          <Icon name="search" size={16} />
          <span className="nav-search-label">{t("cmdk.open")}</span>
          <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <nav className="nav">
          {nav.map((n) => {
            const active = section === n.key || (n.key === "inbox" && section === "inbox");
            return (
              <div key={n.key}>
                <Link to={n.to} className={`nav-item nav-${n.key} ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
                  {active && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                  <Icon name={n.icon} />
                  <span className="nav-label">{n.label}</span>
                  {!!n.badge && <motion.span key={n.badge} className="badge" initial={{ scale: 0.6 }} animate={{ scale: 1 }}>{n.badge}</motion.span>}
                </Link>
                {n.key === "content" && section === "content" && (
                  <div className="nav-sub">
                    {site.models.map((m) => (
                      <Link key={m.name} to={`/content/${m.name}`} className={`nav-subitem ${path.startsWith(`/content/${m.name}`) ? "active" : ""}`}>
                        <span>{m.label ?? m.name}</span>
                        <span className="count">{m.entries}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <span className={`live ${live ? "on" : ""}`} title={live ? t("live.on") : t("live.off")}><span className="dot" /><span className="live-text">{live ? t("live.on") : t("live.off")}</span></span>
          <div className="foot-actions">
            <button className="icon-btn" onClick={flipTheme} title={theme === "dark" ? t("theme.light") : t("theme.dark")} aria-label={theme === "dark" ? t("theme.light") : t("theme.dark")}>
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            <button className="icon-btn lang-btn" onClick={toggle} title={t("lang")} aria-label={t("lang")}>{lang === "en" ? "UK" : "EN"}</button>
            <button className="icon-btn" onClick={signOut} title={t("signout")} aria-label={t("signout")}><Icon name="logout" /></button>
          </div>
        </div>
      </aside>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} models={modelLabels} />
      <main className="main">
        <AnimatePresence mode="wait">
          <motion.div key={section + (section === "content" ? path.split("/").slice(2, 4).join("/") : "")} variants={page} initial="initial" animate="enter" exit="exit">
            {view}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
