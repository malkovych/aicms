import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER } from "../src/kernel/policy.ts";
import { viewEvent } from "../src/gates/events.ts";
import { makeCms } from "./helpers.ts";

const owner = { actor: OWNER, gate: "studio" as const };

test("presence: people and agents on an entry, conflicting drafts, private to readers", async () => {
  const k = await makeCms();
  const d: any = await k.call("post.draft", { title: "Shared post" }, owner);
  await k.call("cms.submit", {}, owner);
  const events: any[] = [];
  k.feed.subscribe((e) => e.event === "presence" && events.push(e));

  // An agent drafting a change shows up as editing, live.
  const writer = { actor: k.actor("writer"), gate: "mcp" as const };
  await k.call("post.draft", { id: d.id, title: "Shared post, by the writer" }, writer);
  assert.deepEqual(events.at(-1).payload.here.map((h: any) => [h.actor, h.state]), [["writer", "editing"]]);

  const seen: any = await k.call("cms.presence", { id: d.id, state: "viewing" }, owner);
  assert.deepEqual(seen.here.map((h: any) => [h.actor, h.state]), [["writer", "editing"]], "others, not yourself");
  assert.deepEqual(seen.drafts.map((x: any) => [x.actor, x.status, x.fields]), [["writer", "drafting", ["title"]]]);
  await k.call("cms.submit", {}, writer);
  const after: any = await k.call("cms.presence", { id: d.id }, owner);
  assert.equal(after.drafts[0].status, "waiting for review");
  assert.deepEqual(after.here, [], "submitting ends the agent's editing");
  await k.call("cms.presence", { id: d.id, state: "viewing" }, writer);

  // The writer sees the owner, too; the public sees nothing.
  const writerView: any = await k.call("cms.presence", { id: d.id }, writer);
  assert.deepEqual(writerView.here.map((h: any) => h.actor), ["owner"]);
  const last = events.at(-1);
  assert.equal(viewEvent(k, k.actor("public"), last), null);
  assert.ok(viewEvent(k, k.actor("editor"), last));

  await k.call("cms.presence", { id: d.id, state: "left" }, owner);
  assert.deepEqual(k.presence.list(d.id).map((h) => [h.actor, h.state]), [["writer", "viewing"]]);
  const log: any = await k.call("cms.log", { limit: 50 }, owner);
  assert.equal(log.events.some((e: any) => e.action === "cms.presence"), false, "heartbeats stay out of the log");
  await assert.rejects(k.call("cms.presence", { id: "pos_nope" }, owner), /No entry/);
  await k.close();
});
