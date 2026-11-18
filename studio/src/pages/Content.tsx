import { blocksToHtml } from "@aicms/client";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { markdownToBlocks } from "../../../src/schema/markdown.ts";
import { AicmsClientError, cms, errorMessage, humanize, titleField, useApi, useLive, useModel, useModules, useSite, type FieldInfo, type ModelInfo } from "../api.tsx";
import { MediaPicker, uploadFiles } from "./Media.tsx";
import { show } from "../diff.tsx";
import { useT } from "../i18n.tsx";
import { Link, navigate } from "../router.tsx";
import { Avatar, Button, Empty, ErrorBox, Icon, item, list, Modal, Pill, Skeleton, TimeAgo, useToast } from "../ui.tsx";

type Data = Record<string, unknown>;
interface EntryRow extends Data { id: string; locale: string; version: number; updatedAt: string }

const touchesModel = (model: string) => (e: { event: string; payload: any }) => e.event === "changeset.merged" && (e.payload?.entries ?? []).some((x: { model: string }) => x.model === model);

// ---------- list ----------

export function ContentList({ model }: { model: string }) {
  const { t } = useT();
  const { site } = useSite();
  const info = useModel(model);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const title = titleField(info.data);
  const slug = info.data?.fields.find((f) => f.kind === "slug")?.name;

  // Full entries, so the list doesn't wait for the model description first.
  const rows = useApi(() => cms.model(model).list({ limit }), [model, limit]);
  const hits = useApi(() => (query.trim().length >= 2 ? cms.search(query.trim(), { model, limit: 30 }) : Promise.resolve(null)), [query, model]);
  useLive(touchesModel(model), rows.reload);

  const meta = site.models.find((m) => m.name === model);
  if (info.error) return <div className="page"><ErrorBox error={info.error} onRetry={info.reload} /></div>;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{meta?.label ?? humanize(model)}</h1>
          <p className="lead">{info.data?.description ?? t("content.total", { n: rows.data?.total ?? meta?.entries ?? 0 })}</p>
        </div>
        <Button tone="primary" icon="plus" onClick={() => navigate(`/content/${model}/new`)}>{t("content.new")}</Button>
      </header>

      <label className="search">
        <Icon name="search" />
        <input className="input" type="search" placeholder={t("content.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>

      {hits.data ? (
        hits.data.hits.length ? (
          <motion.ul className="rows" variants={list} initial="initial" animate="enter">
            {hits.data.hits.map((h) => (
              <motion.li key={h.id} variants={item}>
                <Link to={`/content/${model}/${h.id}`} className="row-link">
                  <span className="row-title">{h.title || <span className="muted">{t("content.untitled")}</span>}</span>
                  <span className="muted small snippet">{h.snippet}</span>
                </Link>
              </motion.li>
            ))}
          </motion.ul>
        ) : <Empty icon="search">{t("content.noMatch")}</Empty>
      ) : rows.error ? <ErrorBox error={rows.error} onRetry={rows.reload} /> : !rows.data ? <Skeleton rows={6} /> : !rows.data.items.length ? (
        <Empty icon="content">{t("content.empty")}</Empty>
      ) : (
        <>
          <motion.ul className="rows" variants={list} initial="initial" animate="enter">
            {(rows.data.items as EntryRow[]).map((e) => (
              <motion.li key={e.id} variants={item} layout>
                <Link to={`/content/${model}/${e.id}`} className="row-link">
                  <span className="row-title">{(title && (e[title] as string)) || <span className="muted">{t("content.untitled")}</span>}</span>
                  {slug && e[slug] ? <span className="mono muted small">/{String(e[slug])}</span> : <span />}
                  {site.locales.length > 1 ? <Pill>{e.locale}</Pill> : <span />}
                  <span className="muted small nowrap">v{e.version} · <TimeAgo at={e.updatedAt} /></span>
                </Link>
              </motion.li>
            ))}
          </motion.ul>
          {rows.data.total > rows.data.items.length && (
            <div className="more"><Button busy={rows.loading} onClick={() => setLimit((l) => l + 50)}>{t("content.more")}</Button></div>
          )}
        </>
      )}
    </div>
  );
}

// ---------- form values ----------

const emptyValue = (f: FieldInfo): unknown => {
  switch (f.kind) {
    case "boolean": return false;
    case "list": return [];
    case "ref": return f.many ? [] : "";
    case "media": return { url: "", alt: "" };
    case "object": return Object.fromEntries((f.fields ?? []).map((s) => [s.name, emptyValue(s)]));
    case "json": return "";
    default: return "";
  }
};

function toForm(f: FieldInfo, v: unknown): unknown {
  if (v === undefined || v === null) return emptyValue(f);
  if (f.kind === "number") return String(v);
  if (f.kind === "json") return JSON.stringify(v, null, 2);
  if (f.kind === "media") return { url: (v as Data).url ?? "", alt: (v as Data).alt ?? "" };
  if (f.kind === "object") return Object.fromEntries((f.fields ?? []).map((s) => [s.name, toForm(s, (v as Data)[s.name])]));
  return v;
}

/** Form value → what the API stores; null means empty. Throws on bad JSON. */
function fromForm(f: FieldInfo, v: unknown): unknown {
  switch (f.kind) {
    case "number": return v === "" || v === undefined ? null : Number(v);
    case "boolean": return !!v;
    case "list": return (v as string[]).length ? v : null;
    case "ref": return f.many ? ((v as string[]).length ? v : null) : v || null;
    case "media": {
      const m = v as { url: string; alt: string };
      return m.url.trim() ? { url: m.url.trim(), ...(m.alt.trim() ? { alt: m.alt.trim() } : {}) } : null;
    }
    case "json": return String(v).trim() ? JSON.parse(String(v)) : null;
    case "object": {
      const out: Data = {};
      for (const s of f.fields ?? []) {
        const x = fromForm(s, (v as Data)[s.name]);
        if (x !== null) out[s.name] = x;
      }
      return Object.keys(out).length ? out : null;
    }
    default: return typeof v === "string" && !v.trim() ? null : v;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------- editor ----------

export function EntryEditor({ model, id }: { model: string; id?: string }) {
  const { t } = useT();
  const toast = useToast();
  const { site, reload: reloadSite } = useSite();
  const info = useModel(model);
  const entry = useApi(() => (id ? (cms.model(model).get({ id, format: "markdown" }) as Promise<EntryRow>) : Promise.resolve(null)), [model, id]);
  const history = useApi(() => (id ? cms.history(id) : Promise.resolve(null)), [model, id]);
  const [values, setValues] = useState<Data>({});
  const [locale, setLocale] = useState(site.locales[0]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"publish" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);

  const fields = useMemo(() => info.data?.fields ?? [], [info.data]);
  const original = useMemo(() => {
    const src = entry.data ?? {};
    return Object.fromEntries(fields.map((f) => [f.name, toForm(f, (src as Data)[f.name])]));
  }, [entry.data, fields]);
  useEffect(() => setValues(original), [original]);
  useLive((e) => !!id && e.event === "changeset.merged" && (e.payload?.entries ?? []).some((x: { id: string }) => x.id === id), () => {
    entry.reload();
    history.reload();
  });

  const dirty = fields.some((f) => !same(values[f.name], original[f.name]));
  const titleKey = titleField(info.data);
  const heading = (titleKey && (values[titleKey] as string)) || (id ? t("content.untitled") : t("entry.new", { model: info.data?.label ?? model }));

  const publish = async () => {
    setErrors({});
    const patch: Data = {};
    try {
      for (const f of fields) {
        if (id && same(values[f.name], original[f.name])) continue;
        const v = fromForm(f, values[f.name]);
        if (!id && v === null) continue;
        patch[f.name] = v;
      }
    } catch {
      setErrors({ _: t("field.json") });
      return;
    }
    setBusy("publish");
    try {
      const draft = await cms.model(model).draft({ ...(id ? { id } : { locale }), ...patch });
      const res = await cms.submit();
      if (res.status === "needs_changes") {
        // Keep the owner's changeset clean: drop the broken draft, show the issues in the form.
        await cms.discard(draft.id).catch(() => {});
        setErrors(Object.fromEntries((res.issues ?? []).map((i) => [i.field?.split(".")[0] ?? "_", i.message])));
        return;
      }
      toast(id ? t("entry.published") : t("entry.created"));
      reloadSite();
      if (id) {
        entry.reload();
        history.reload();
      } else navigate(`/content/${model}/${draft.id}`, true);
    } catch (e) {
      const issues = e instanceof AicmsClientError ? ((e.details as { issues?: { field?: string; message: string }[] })?.issues ?? []) : [];
      if (issues.length) setErrors(Object.fromEntries(issues.map((i) => [i.field?.split(".")[0] ?? "_", i.message])));
      else toast(errorMessage(e), "gate");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!id) return;
    setBusy("delete");
    try {
      await cms.model(model).delete(id);
      await cms.submit();
      toast(t("entry.deleted"), "human", { label: t("entry.history"), run: () => navigate(`/content/${model}/${id}`) });
      reloadSite();
      navigate(`/content/${model}`);
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  if (info.error) return <div className="page"><ErrorBox error={info.error} onRetry={info.reload} /></div>;
  if (!info.data || (id && entry.loading && !entry.data && !entry.error)) return <div className="page"><Skeleton rows={8} /></div>;
  const missing = !!id && !!entry.error;

  return (
    <div className="page">
      <Link to={`/content/${model}`} className="back"><Icon name="back" size={16} /> {t("entry.back", { model: site.models.find((m) => m.name === model)?.label ?? model })}</Link>
      <header className="page-head">
        <div className="min0">
          <h1 className="entry-title">{heading}</h1>
          {id && <p className="lead mono small">{id}</p>}
        </div>
        {!missing && (
          <div className="row">
            <AnimatePresence>{dirty && <motion.span className="dirty" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>{t("entry.dirty")}</motion.span>}</AnimatePresence>
            <Button tone="primary" icon="check" busy={busy === "publish"} disabled={!dirty && !!id} onClick={publish}>{busy === "publish" ? t("entry.publishing") : t("entry.publish")}</Button>
          </div>
        )}
      </header>

      <div className="editor">
        <div className="editor-main">
          {missing ? (
            <div className="notice notice-mod"><Icon name="history" /><div>{t("entry.missing")}</div></div>
          ) : (
            <motion.div className="plate form" variants={list} initial="initial" animate="enter">
              {errors._ && <div className="notice notice-gate"><Icon name="alert" /><div>{errors._}</div></div>}
              {fields.map((f) => (
                <motion.div key={f.name} variants={item}>
                  <FieldInput f={f} value={values[f.name]} error={errors[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
                </motion.div>
              ))}
            </motion.div>
          )}
        </div>

        <aside className="editor-side">
          <section className="plate side-card">
            <h3>{t("entry.details")}</h3>
            <dl className="meta">
              {!id && site.locales.length > 1 && (
                <>
                  <dt>{t("entry.locale")}</dt>
                  <dd><select className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>{site.locales.map((l) => <option key={l}>{l}</option>)}</select></dd>
                </>
              )}
              {entry.data && (
                <>
                  <dt>{t("entry.locale")}</dt><dd><Pill>{entry.data.locale}</Pill></dd>
                  <dt>{t("entry.updated")}</dt><dd><TimeAgo at={entry.data.updatedAt} /> · v{entry.data.version}</dd>
                </>
              )}
            </dl>
            {id && !missing && <Button tone="quiet" icon="trash" className="danger-text" onClick={() => setConfirmDelete(true)}>{t("entry.delete")}</Button>}
          </section>

          {id && !missing && <SeoPanel model={model} id={id} version={entry.data?.version} />}
          {id && !missing && entry.data && <TranslationsPanel model={model} id={id} version={entry.data.version} />}

          {id && (
            <section className="plate side-card">
              <h3><Icon name="history" size={16} /> {t("entry.history")}</h3>
              {history.data ? (
                <ol className="history">
                  {history.data.versions.map((v: { version: number; at: string; actor: string; deleted?: boolean; changed?: string[] }) => (
                    <li key={v.version}>
                      <button className="history-row" onClick={() => !v.deleted && setViewing(v.version)} disabled={v.deleted}>
                        <Avatar name={v.actor} size={24} />
                        <span className="history-main">
                          <span><strong>v{v.version}</strong> · {v.actor} {v.version === history.data.current && <Pill tone="core">{t("entry.current")}</Pill>}{v.deleted && <Pill tone="gate">{t("entry.removed")}</Pill>}</span>
                          <span className="muted small"><TimeAgo at={v.at} />{v.changed?.length ? ` · ${v.changed.map(humanize).join(", ")}` : ""}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : history.error ? <p className="muted small">{errorMessage(history.error)}</p> : <Skeleton rows={3} />}
            </section>
          )}
        </aside>
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t("entry.delete")}>
        <p>{t("entry.deleteAsk")}</p>
        <div className="row end">
          <Button tone="quiet" onClick={() => setConfirmDelete(false)}>{t("cancel")}</Button>
          <Button tone="danger" icon="trash" busy={busy === "delete"} onClick={remove}>{t("entry.delete")}</Button>
        </div>
      </Modal>

      {id && viewing !== null && info.data && (
        <VersionModal
          id={id}
          version={viewing}
          info={info.data}
          current={history.data?.current}
          onClose={() => setViewing(null)}
          onRestored={() => {
            setViewing(null);
            entry.reload();
            history.reload();
            reloadSite();
          }}
        />
      )}
    </div>
  );
}

function VersionModal({ id, version, info, current, onClose, onRestored }: { id: string; version: number; info: ModelInfo; current?: number | null; onClose(): void; onRestored(): void }) {
  const { t } = useT();
  const toast = useToast();
  const data = useApi(() => cms.call("cms.history", { id, version, format: "markdown" }), [id, version]);
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try {
      await cms.restore(id, version);
      await cms.submit(`Restore ${id} to v${version}`);
      toast(t("entry.restored", { n: version }));
      onRestored();
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("entry.version", { n: version })} wide>
      {data.error ? <ErrorBox error={data.error} /> : !data.data ? <Skeleton rows={5} /> : (
        <>
          <p className="muted small">{data.data.actor} · <TimeAgo at={data.data.at} /></p>
          <dl className="version-data">
            {info.fields.map((f) => {
              const v = data.data.data?.[f.name];
              if (v === undefined || v === null || v === "") return null;
              return <div key={f.name}><dt>{f.label ?? humanize(f.name)}</dt><dd><pre>{show(v)}</pre></dd></div>;
            })}
          </dl>
          {version !== current && (
            <div className="row end">
              <Button tone="primary" icon="undo" busy={busy} onClick={restore}>{t("entry.restore")}</Button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------- field inputs ----------

function FieldInput({ f, value, onChange, error, nested }: { f: FieldInfo; value: unknown; onChange(v: unknown): void; error?: string; nested?: boolean }) {
  const { t } = useT();
  const label = f.label ?? humanize(f.name);
  const text = typeof value === "string" ? value : "";
  const hintId = `hint-${f.name}`;
  let control: React.ReactNode;

  switch (f.kind) {
    case "boolean":
      control = (
        <button type="button" role="switch" aria-checked={!!value} className={`switch ${value ? "on" : ""}`} onClick={() => onChange(!value)}>
          <motion.span className="knob" layout transition={{ type: "spring", stiffness: 600, damping: 34 }} />
        </button>
      );
      break;
    case "enum":
      control = (f.values?.length ?? 0) <= 4 ? (
        <div className="segmented" role="radiogroup">
          {!f.required && <button type="button" role="radio" aria-checked={!value} className={!value ? "on" : ""} onClick={() => onChange("")}>{t("field.none")}</button>}
          {f.values!.map((v) => <button type="button" role="radio" key={v} aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{v}</button>)}
        </div>
      ) : (
        <select className="input" value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("field.pick")}</option>
          {f.values!.map((v) => <option key={v}>{v}</option>)}
        </select>
      );
      break;
    case "number":
      control = <input className="input" type="number" min={f.min} max={f.max} value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "date":
      control = text.includes("T")
        ? <input className="input" type="datetime-local" value={text.slice(0, 16)} onChange={(e) => onChange(e.target.value)} />
        : <input className="input" type="date" value={text.slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "blocks":
      control = <BlocksInput value={text} onChange={onChange} allowed={f.blocks} />;
      break;
    case "media":
      control = <MediaInput value={value as { url: string; alt: string }} onChange={onChange} />;
      break;
    case "list":
      control = <ListInput value={(value as string[]) ?? []} onChange={onChange} />;
      break;
    case "ref":
      control = <RefInput f={f} value={value} onChange={onChange} />;
      break;
    case "json":
      control = <textarea className="input mono" rows={6} value={text} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
      break;
    case "object":
      control = (
        <div className="object-fields">
          {(f.fields ?? []).map((s) => (
            <FieldInput key={s.name} f={s} nested value={(value as Data)?.[s.name]} onChange={(v) => onChange({ ...(value as Data), [s.name]: v })} />
          ))}
        </div>
      );
      break;
    default: {
      const long = f.kind === "text" && (f.multiline || (f.max ?? 1000) > 160);
      const placeholder = f.kind === "slug" && f.filledFrom ? t("field.auto", { field: humanize(f.filledFrom) }) : undefined;
      control = long
        ? <textarea className="input" rows={3} value={text} maxLength={f.max} onChange={(e) => onChange(e.target.value)} aria-describedby={hintId} />
        : <input className={`input ${f.kind === "slug" ? "mono" : ""}`} value={text} maxLength={f.max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-describedby={hintId} />;
    }
  }

  return (
    <div className={`field ${nested ? "field-nested" : ""} ${error ? "has-error" : ""}`}>
      <div className="field-label">
        <label>{label}</label>
        {f.required && <span className="req">{t("field.required")}</span>}
        {f.max && (f.kind === "text" || f.kind === "slug") ? <span className={`counter ${text.length > f.max ? "over" : ""}`}>{text.length}/{f.max}</span> : null}
      </div>
      {control}
      {(f.description || error) && <div id={hintId} className={error ? "field-error" : "field-hint"}>{error ?? f.description}</div>}
    </div>
  );
}

function BlocksInput({ value, onChange, allowed }: { value: string; onChange(v: string): void; allowed?: string[] }) {
  const { t } = useT();
  const [mode, setMode] = useState<"write" | "preview">("write");
  const html = useMemo(() => (mode === "preview" ? blocksToHtml(markdownToBlocks(value)) : ""), [mode, value]);
  return (
    <div className="blocks-input">
      <div className="blocks-bar">
        <div className="segmented small">
          <button type="button" className={mode === "write" ? "on" : ""} onClick={() => setMode("write")}>{t("field.write")}</button>
          <button type="button" className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>{t("field.preview")}</button>
        </div>
        {allowed && <span className="muted small mono">{allowed.join(" · ")}</span>}
      </div>
      {mode === "write"
        ? <textarea className="input mono blocks-text" rows={12} value={value} onChange={(e) => onChange(e.target.value)} spellCheck />
        : <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}

function MediaInput({ value, onChange }: { value: { url: string; alt: string }; onChange(v: unknown): void }) {
  const { t } = useT();
  const toast = useToast();
  const { has } = useModules();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const v = value ?? { url: "", alt: "" };
  const library = has("media");
  const upload = async (files: File[]) => {
    setBusy(true);
    try {
      const [row] = await uploadFiles(files.slice(0, 1));
      onChange({ url: row.url, alt: v.alt || row.alt || "" });
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="media-input">
      {v.url ? <img src={v.url} alt={v.alt} className="media-thumb" /> : <span className="media-thumb media-thumb-empty"><Icon name="media" size={22} /></span>}
      <div className="media-fields">
        <input className="input" placeholder={t("field.url")} value={v.url} onChange={(e) => onChange({ ...v, url: e.target.value })} />
        <input className="input" placeholder={t("field.alt")} value={v.alt} onChange={(e) => onChange({ ...v, alt: e.target.value })} />
        {library && (
          <div className="row">
            <Button icon="media" onClick={() => setPicking(true)}>{t("media.pick")}</Button>
            <Button tone="quiet" icon="upload" busy={busy} onClick={() => file.current?.click()}>{t("media.upload")}</Button>
            <input ref={file} type="file" hidden accept="image/*,.svg" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) upload(f); }} />
          </div>
        )}
      </div>
      {library && <MediaPicker open={picking} onClose={() => setPicking(false)} onPick={(m) => { onChange({ url: m.url, alt: v.alt || m.alt || "" }); setPicking(false); }} />}
    </div>
  );
}

function ListInput({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean).filter((s) => !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setDraft("");
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="chips-input input">
      <AnimatePresence initial={false}>
        {value.map((v) => (
          <motion.span key={v} className="chip" layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
            {v}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`}><Icon name="x" size={12} /></button>
          </motion.span>
        ))}
      </AnimatePresence>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={key} onBlur={add} placeholder={value.length ? "" : t("field.add")} />
    </div>
  );
}

function RefInput({ f, value, onChange }: { f: FieldInfo; value: unknown; onChange(v: unknown): void }) {
  const { t } = useT();
  const target = useModel(f.model);
  const key = titleField(target.data);
  const options = useApi(async () => (target.data ? cms.model(f.model!).list({ limit: 100, ...(key ? { fields: [key] } : {}) }) : undefined), [f.model, target.data]);
  const items = (options.data?.items ?? []) as EntryRow[];
  const name = (id: string) => {
    const e = items.find((x) => x.id === id);
    return (e && key && (e[key] as string)) || id;
  };
  if (!f.many) {
    return (
      <select className="input" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("field.none")}</option>
        {items.map((e) => <option key={e.id} value={e.id}>{name(e.id)}</option>)}
      </select>
    );
  }
  const selected = (value as string[]) ?? [];
  return (
    <div className="chips-input input">
      <AnimatePresence initial={false}>
        {selected.map((id) => (
          <motion.span key={id} className="chip" layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
            {name(id)}
            <button type="button" onClick={() => onChange(selected.filter((x) => x !== id))} aria-label={`Remove ${name(id)}`}><Icon name="x" size={12} /></button>
          </motion.span>
        ))}
      </AnimatePresence>
      <select className="chips-select" value="" onChange={(e) => e.target.value && onChange([...selected, e.target.value])}>
        <option value="">{t("field.pick")}</option>
        {items.filter((e) => !selected.includes(e.id)).map((e) => <option key={e.id} value={e.id}>{name(e.id)}</option>)}
      </select>
    </div>
  );
}

// ---------- module panels ----------

interface Audit {
  score: number;
  issues: { level: "error" | "warning" | "tip"; field?: string; message: string }[];
  stats: { words: number };
}

/** SEO score and fixes for this entry, when the seo module is installed and covers the model. */
function SeoPanel({ model, id, version }: { model: string; id: string; version?: number }) {
  const { t } = useT();
  const { has } = useModules();
  const on = has("seo");
  const audit = useApi(() => (on ? cms.call<Audit>("seo.audit", { model, id }) : Promise.resolve(undefined)), [on, model, id, version]);
  if (!on || audit.error || (!audit.data && !audit.loading)) return null;
  const score = audit.data?.score ?? 0;
  const tone = score >= 80 ? "human" : score >= 50 ? "mod" : "gate";
  return (
    <section className="plate side-card">
      <h3><Icon name="search" size={16} /> {t("seo.title")}</h3>
      {!audit.data ? <Skeleton rows={2} /> : (
        <>
          <div className="seo-score">
            <span className={`seo-num tone-${tone}`}>{score}</span>
            <div className="meter grow" aria-label={`${score}/100`}>
              <motion.span className={`meter-${tone}`} initial={{ width: 0 }} animate={{ width: `${score}%` }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} />
            </div>
          </div>
          {audit.data.issues.length ? (
            <ul className="seo-issues">
              {audit.data.issues.map((i, n) => (
                <li key={n}><span className={`dot dot-${i.level}`} aria-hidden="true" /><span>{i.message}</span></li>
              ))}
            </ul>
          ) : <p className="muted small">{t("seo.ok")}</p>}
          <div className="row">
            <span className="muted small">{t("seo.words", { n: audit.data.stats.words })}</span>
            <Button tone="quiet" icon="history" busy={audit.loading} onClick={audit.reload}>{t("seo.check")}</Button>
          </div>
        </>
      )}
    </section>
  );
}

interface Translations {
  locale: string;
  translations: Record<string, { id: string; title: string; published: boolean } | null>;
  missing: string[];
}

/** Linked versions of this entry in other locales, when the i18n module is installed. */
function TranslationsPanel({ model, id, version }: { model: string; id: string; version: number }) {
  const { t } = useT();
  const toast = useToast();
  const { has } = useModules();
  const { site, reload: reloadSite } = useSite();
  const on = has("i18n") && site.locales.length > 1;
  const data = useApi(() => (on ? cms.call<Translations>("i18n.translations", { id }) : Promise.resolve(undefined)), [on, id, version]);
  const [busy, setBusy] = useState<string | null>(null);
  if (!on || data.error || !data.data) return null;
  const create = async (locale: string) => {
    setBusy(locale);
    try {
      const d = await cms.call<{ id: string }>("i18n.translate", { id, locale });
      await cms.submit(`Translation of ${id} into ${locale}`);
      toast(t("tr.created", { locale }));
      reloadSite();
      navigate(`/content/${model}/${d.id}`);
    } catch (e) {
      toast(errorMessage(e), "gate");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="plate side-card">
      <h3><Icon name="globe" size={16} /> {t("tr.title")}</h3>
      <ul className="tr-list">
        {site.locales.map((locale) => {
          const e = data.data!.translations[locale];
          return (
            <li key={locale}>
              <Pill tone={e ? "core" : "adapt"}>{locale}</Pill>
              {e ? (
                e.id === id ? <span className="muted small">{t("tr.this")}</span> : <Link to={`/content/${model}/${e.id}`} className="tr-link">{e.title || e.id}</Link>
              ) : (
                <Button tone="quiet" icon="plus" busy={busy === locale} onClick={() => create(locale)}>{t("tr.create", { locale })}</Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
