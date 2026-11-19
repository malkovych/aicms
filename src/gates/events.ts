import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { FeedEvent, Kernel } from "../kernel/cms.ts";
import { allows, modelPermissions, type Actor } from "../kernel/policy.ts";

const HEARTBEAT_MS = 25_000;

/**
 * What this actor may see of a feed event, or null.
 * Admins (`events:read`) see everything, including the action log. Reviewers see every
 * changeset event. Authors see their own. Anyone who can read a model hears when it is published.
 */
export function viewEvent(k: Kernel, actor: Actor, e: FeedEvent): FeedEvent | null {
  if (allows(actor.scopes, "events:read")) return e;
  if (e.event === "presence") {
    const m = k.models.get(e.payload?.model);
    return m && actor.kind !== "public" && modelPermissions(actor, m).read ? e : null;
  }
  if (e.event === "action" || !e.event.startsWith("changeset.")) return null;
  const p = e.payload ?? {};
  if (allows(actor.scopes, "changesets:review") || p.actor === actor.id) return e;
  if (e.event !== "changeset.merged") return null;
  const entries = (p.entries ?? []).filter((x: { model: string }) => {
    const m = k.models.get(x.model);
    return m && modelPermissions(actor, m).read;
  });
  return entries.length ? { ...e, payload: { changeset: p.changeset, entries } } : null;
}

/**
 * GET /api/v1/events — Server-Sent Events. New events only, unless the client
 * resumes with `Last-Event-ID` (or `?after=<id>`, `?after=0` for the whole buffer).
 */
export function eventStream(k: Kernel, c: Context, actor: Actor) {
  const resume = c.req.header("last-event-id") ?? c.req.query("after");
  const after = resume === undefined ? k.feed.lastId() : Number(resume) || 0;
  return streamSSE(c, async (stream) => {
    const queue: FeedEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const unsubscribe = k.feed.subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      wake?.();
    });
    queue.unshift(...k.feed.since(after));
    let last = after;
    // `last` lets a client that reconnects before its first event resume from here.
    await stream.writeSSE({ event: "ready", data: JSON.stringify({ you: actor.id, last: after }), retry: 3000 });
    while (!closed) {
      while (queue.length && !closed) {
        const e = queue.shift()!;
        if (e.id <= last) continue;
        last = e.id;
        const shown = viewEvent(k, actor, e);
        if (shown) await stream.writeSSE({ id: String(e.id), event: e.event, data: JSON.stringify(shown) });
      }
      if (closed) break;
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), HEARTBEAT_MS);
        wake = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      wake = null;
      if (timedOut && !closed) await stream.write(": keep-alive\n\n");
    }
  });
}
