import { createClient, AicmsClientError, type FeedEvent } from "@aicms/client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/** Same-origin client: the Studio session cookie authenticates every call. */
export const cms = createClient({ url: "", credentials: "same-origin" });
export { AicmsClientError };

export interface FieldInfo {
  name: string;
  kind: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  label?: string;
  description?: string;
  filledFrom?: string;
  min?: number;
  max?: number;
  multiline?: boolean;
  values?: string[];
  model?: string;
  many?: boolean;
  blocks?: string[];
  fields?: FieldInfo[];
  writable?: boolean;
}

export interface ModelInfo {
  name: string;
  label?: string;
  description?: string;
  fields: FieldInfo[];
  filterBy: string[];
  findBy: string[];
}

export interface SiteInfo {
  site: string;
  you: { name: string; scopes: string[] };
  locales: string[];
  models: { name: string; label?: string; entries: number }[];
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Load data, reload on demand; keeps the previous data while reloading. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => id === latest.current && setState({ data, loading: false }),
      (error) => id === latest.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// ---------- live events ----------

type Listener = (e: FeedEvent) => void;
const LiveContext = createContext<{ connected: boolean; subscribe(fn: Listener): () => void }>({ connected: false, subscribe: () => () => {} });
const EVENTS = ["action", "presence", "changeset.submitted", "changeset.merged", "changeset.rejected"];

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());
  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    const handle = (msg: MessageEvent) => {
      try {
        const e = JSON.parse(msg.data) as FeedEvent;
        for (const fn of listeners.current) fn(e);
      } catch {
        /* ignore */
      }
    };
    for (const name of EVENTS) source.addEventListener(name, handle);
    return () => source.close();
  }, []);
  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);
  return <LiveContext.Provider value={{ connected, subscribe }}>{children}</LiveContext.Provider>;
}

export const useLiveStatus = () => useContext(LiveContext).connected;

/** Call `fn` for matching live events, at most once per `wait` ms. */
export function useLive(match: (e: FeedEvent) => boolean, fn: (e: FeedEvent) => void, wait = 400) {
  const { subscribe } = useContext(LiveContext);
  const ref = useRef({ match, fn });
  ref.current = { match, fn };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: FeedEvent | undefined;
    const off = subscribe((e) => {
      if (!ref.current.match(e)) return;
      pending = e;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (pending) ref.current.fn(pending);
      }, wait);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe, wait]);
}

/** Call `fn` for every matching live event, unthrottled. */
export function useLiveEach(match: (e: FeedEvent) => boolean, fn: (e: FeedEvent) => void) {
  const { subscribe } = useContext(LiveContext);
  const ref = useRef({ match, fn });
  ref.current = { match, fn };
  useEffect(() => subscribe((e) => ref.current.match(e) && ref.current.fn(e)), [subscribe]);
}

export const isChangesetEvent = (e: FeedEvent) => e.event.startsWith("changeset.");

// ---------- site and model details ----------

const SiteContext = createContext<{ site: SiteInfo; reload(): void; model(name: string): Promise<ModelInfo> } | null>(null);

export function SiteProvider({ site, reload, children }: { site: SiteInfo; reload(): void; children: ReactNode }) {
  const cache = useRef(new Map<string, Promise<ModelInfo>>());
  const model = useCallback((name: string) => {
    let p = cache.current.get(name);
    if (!p) {
      p = cms.describe(name) as Promise<ModelInfo>;
      p.catch(() => cache.current.delete(name));
      cache.current.set(name, p);
    }
    return p;
  }, []);
  return <SiteContext.Provider value={{ site, reload, model }}>{children}</SiteContext.Provider>;
}

export function useSite() {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error("useSite outside SiteProvider");
  return ctx;
}

export function useModel(name: string | undefined) {
  const { model } = useSite();
  return useApi(() => (name ? model(name) : Promise.resolve(undefined)), [name]);
}

/** The field people read as an entry's name. */
export function titleField(m: ModelInfo | undefined): string | undefined {
  const textual = m?.fields.filter((f) => f.kind === "text") ?? [];
  return (textual.find((f) => f.required) ?? textual[0])?.name;
}

// ---------- modules ----------

export interface ModuleManifest {
  name: string;
  title?: string;
  summary?: string;
  description?: string;
  version?: string;
  provides: string[];
  requires: string[];
  uses: string[];
  models: { name: string; fields: string[] }[];
  actions: { name: string; description: string; scope: string; readOnly?: boolean; destructive?: boolean }[];
  scopes: string[];
  routes: string[];
  hooks: string[];
}

export interface CommunityModule {
  name: string;
  title: string;
  summary: string;
  package: string;
  author: string;
  license: string;
  homepage?: string;
  provides: string[];
  requires: string[];
  uses: string[];
  scopes: string[];
  routes: string[];
  hooks: string[];
  install: string;
}

interface ModulesInfo {
  installed: ModuleManifest[];
  available: ModuleManifest[];
  community?: CommunityModule[];
  youCan: "install" | "propose";
}

const ModulesContext = createContext<{ modules?: ModulesInfo; has(name: string): boolean; reload(): void }>({ has: () => false, reload() {} });

export function ModulesProvider({ children }: { children: ReactNode }) {
  const data = useApi(() => cms.call<ModulesInfo>("cms.modules"), []);
  const has = useCallback((name: string) => !!data.data?.installed.some((m) => m.name === name), [data.data]);
  return <ModulesContext.Provider value={{ modules: data.data, has, reload: data.reload }}>{children}</ModulesContext.Provider>;
}

export const useModules = () => useContext(ModulesContext);

export const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
