import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule } from "../src/kernel/modules.ts";
import { OWNER } from "../src/kernel/policy.ts";
import { publishDue } from "../src/kernel/changesets.ts";
import { viewEvent } from "../src/gates/events.ts";
import { lint, lintEntry } from "../src/modules/lint.ts";
import { seo } from "../src/modules/seo.ts";
import { resolveConfig } from "../src/config.ts";
import { makeCms, post, stats } from "./helpers.ts";

const owner = { actor: OWNER, gate: "studio" as const };
const soon = (ms = 60_000) => new Date(Date.now() + ms).toISOString();

const house = defineModule({
  name: "house",
  uses: ["post"],
  checks: {
    // Titles must not shout; "draft" in a title is only a warning.
    titles: ({ data, changed, op }) => {
      if (op === "update" && !changed.includes("title")) return [];
      const title = String(data.title ?? "");
      const out = [];
      if (title === title.toUpperCase() && /[A-Z]/.test(title)) out.push({ level: "error" as const, field: "title", message: "Don't shout" });
      if (/draft/i.test(title)) out.push({ level: "warning" as const, field: "title", message: "Title says draft" });
      return out;
    },
    flaky: ({ data }) => {
      if (data.title === "boom") throw new Error("kaboom");
    },
  },
});

test("checks: module errors block, warnings reach the reviewer, cms_check previews, crashes don't block", async () => {
  const k = await makeCms({ modules: [stats, house] });
  const writer = { actor: k.actor("writer"), gate: "mcp" as const };

  const loud: any = await k.call("post.draft", { title: "LOUD TITLE" }, writer);
  const preview: any = await k.call("cms.check", {}, writer);
  assert.equal(preview.ready, false);
  assert.deepEqual(preview.issues.map((i: any) => [i.field, i.message, i.check]), [["title", "Don't shout", "house/titles"]]);
  const blocked: any = await k.call("cms.submit", {}, writer);
  assert.equal(blocked.status, "needs_changes");
  assert.equal(blocked.issues[0].check, "house/titles");

  const d: any = await k.call("post.draft", { id: loud.id, title: "A draft about spring" }, writer);
  const ok: any = await k.call("cms.check", {}, writer);
  assert.equal(ok.ready, true);
  assert.equal(ok.warnings[0].message, "Title says draft");
  assert.match(ok.onSubmit, /waits for a person/);
  const sent: any = await k.call("cms.submit", { note: "spring" }, writer);
  assert.equal(sent.status, "submitted");
  assert.equal(sent.warnings.length, 1);
  const review: any = await k.call("cms.review", { id: sent.changeset }, owner);
  assert.equal(review.warnings[0].check, "house/titles");
  await k.call("cms.merge", { id: sent.changeset }, owner);

  // An update that doesn't touch the title isn't checked for it; the published post keeps its warning-free state.
  await k.call("post.draft", { id: d.id, seo: { description: "About spring" } }, writer);
  assert.deepEqual((await k.call<any>("cms.check", {}, writer)).warnings, []);
  await k.call("cms.discard", {}, writer);

  // A check that throws becomes a warning, not a blocker.
  await k.call("post.draft", { title: "boom" }, writer);
  const crashed: any = await k.call("cms.submit", {}, writer);
  assert.equal(crashed.status, "submitted");
  assert.match(crashed.warnings[0].message, /house\/flaky check failed: kaboom/);

  // Checks only see the models their module uses.
  await k.call("tag.draft", { name: "LOUD" }, { actor: k.actor("tagger"), gate: "mcp" });
  assert.equal((await k.call<any>("cms.submit", {}, { actor: k.actor("tagger"), gate: "mcp" })).status, "merged");
  await k.close();
});

test("review rules: { auto: scopes } merges only what the scopes cover; warnings send auto agents to a person", async () => {
  assert.throws(() => resolveConfig({ agents: { x: { scopes: [], review: "sometimes" as any } } }), /review must be/);
  const flagTags = defineModule({ name: "flag", uses: ["tag"], checks: { names: ({ data }) => (String(data.name).includes("?") ? [{ level: "warning", message: "Question mark in a tag" }] : []) } });
  const k = await makeCms({
    modules: [stats, flagTags],
    agents: {
      writer: { scopes: ["post:draft", "tag:draft"], review: "human" },
      tidy: { scopes: ["tag:draft"], review: { auto: ["tag:update.name"] } },
      tagger: { scopes: ["tag:draft"], review: "auto" },
    },
  });
  const tidy = { actor: k.actor("tidy"), gate: "mcp" as const };
  const tagger = { actor: k.actor("tagger"), gate: "mcp" as const };
  const t: any = await k.call("tag.draft", { name: "Spring" }, tagger);
  assert.equal((await k.call<any>("cms.submit", {}, tagger)).status, "merged");

  // Renaming is covered by the rule; creating isn't.
  await k.call("tag.draft", { id: t.id, name: "Spring menu" }, tidy);
  assert.equal((await k.call<any>("cms.submit", {}, tidy)).status, "merged");
  await k.call("tag.draft", { name: "Summer" }, tidy);
  const created: any = await k.call("cms.submit", {}, tidy);
  assert.equal(created.status, "submitted");
  assert.match(created.reason, /publishes without review only tag:update\.name; this also changes tag:create/);
  const described: any = await k.call("cms.describe", {}, tidy);
  assert.equal(described.you.review, "auto for tag:update.name");

  // An auto agent's change with a warning waits for a person.
  await k.call("tag.draft", { name: "Why?" }, tagger);
  const warned: any = await k.call("cms.submit", {}, tagger);
  assert.equal(warned.status, "submitted");
  assert.match(warned.reason, /1 check warning for a person/);
  await k.close();
});

test("scheduling: approve for later, publish when due, unschedule, conflicts go back", async () => {
  const k = await makeCms();
  const writer = { actor: k.actor("writer"), gate: "mcp" as const };
  const events: string[] = [];
  k.feed.subscribe((e) => events.push(e.event));

  // The writer asks for a time; merging without { at } schedules it.
  const d: any = await k.call("post.draft", { title: "Friday menu" }, writer);
  await assert.rejects(k.call("cms.submit", { publishAt: "next friday" }, writer), /isn't a date/);
  const at = soon();
  const sent: any = await k.call("cms.submit", { publishAt: at }, writer);
  assert.equal(sent.publishAt, at);
  assert.match(sent.next, /published at/);
  const scheduled: any = await k.call("cms.merge", { id: sent.changeset }, owner);
  assert.deepEqual([scheduled.status, scheduled.publishAt], ["scheduled", at]);
  assert.equal(await k.store.getEntry(d.id), null, "not public yet");
  assert.equal((await k.call<any>("cms.review", { status: "scheduled" }, owner)).changesets.length, 1);
  assert.ok(events.includes("changeset.scheduled"));

  assert.deepEqual(await publishDue(k), { merged: [], failed: [] }, "not due yet");
  const due = await publishDue(k, new Date(Date.parse(at) + 1000));
  assert.deepEqual(due.merged, [sent.changeset]);
  const entry = await k.store.getEntry(d.id);
  assert.equal(entry?.data.title, "Friday menu");
  const cs = await k.store.getChangeset(sent.changeset);
  assert.deepEqual([cs?.status, cs?.mergedBy], ["merged", "owner"], "merged in the name of the person who scheduled it");

  // A reviewer can schedule anything, publish a scheduled one now, or take it off the schedule.
  await k.call("post.draft", { id: d.id, title: "Friday menu, updated" }, writer);
  const second: any = await k.call("cms.submit", {}, writer);
  await k.call("cms.merge", { id: second.changeset, at: soon(120_000) }, owner);
  const off: any = await k.call("cms.unschedule", { id: second.changeset }, owner);
  assert.equal(off.status, "submitted");
  assert.equal((await k.store.getChangeset(second.changeset))?.publishAt, undefined);
  await k.call("cms.merge", { id: second.changeset, at: soon() }, owner);
  const now: any = await k.call("cms.merge", { id: second.changeset, at: "now" }, owner);
  assert.equal(now.entries[0].version, 2);

  // Someone edits the entry before the scheduled time: it goes back to the author.
  await k.call("post.draft", { id: d.id, title: "Scheduled edit" }, writer);
  const third: any = await k.call("cms.submit", {}, writer);
  const at3 = soon();
  await k.call("cms.merge", { id: third.changeset, at: at3 }, owner);
  await k.call("post.draft", { id: d.id, title: "Owner's quick fix" }, owner);
  await k.call("cms.submit", {}, owner);
  const late = await publishDue(k, new Date(Date.parse(at3) + 1000));
  assert.equal(late.failed[0].changeset, third.changeset);
  assert.equal((await k.store.getChangeset(third.changeset))?.status, "open");

  // An auto agent's change with a time is scheduled without review; rejecting a scheduled one is allowed.
  const tagger = { actor: k.actor("tagger"), gate: "mcp" as const };
  await k.call("tag.draft", { name: "Later" }, tagger);
  const auto: any = await k.call("cms.submit", { publishAt: soon() }, tagger);
  assert.equal(auto.status, "scheduled");
  await k.call("cms.reject", { id: auto.changeset, comment: "Not this week" }, owner);
  assert.equal((await k.store.getChangeset(auto.changeset))?.status, "open");
  await k.close();
});

test("briefs: people hand agents work; submit, merge and reject move the brief", async () => {
  const k = await makeCms({
    agents: {
      writer: { scopes: ["post:draft", "tag:draft"], review: "human" },
      tagger: { scopes: ["tag:draft"], review: "auto" },
      planner: { scopes: ["post:read", "briefs:write"] },
    },
  });
  const writer = { actor: k.actor("writer"), gate: "mcp" as const };
  const tagger = { actor: k.actor("tagger"), gate: "mcp" as const };
  const planner = { actor: k.actor("planner"), gate: "mcp" as const };
  const feed: any[] = [];
  k.feed.subscribe((e) => feed.push(e));

  await assert.rejects(k.call("cms.brief", { title: "x", agent: "nobody" }, owner), /No agent "nobody"/);
  await assert.rejects(k.call("cms.brief", { title: "x" }, writer), /may not call/, "agents without briefs:write can't write briefs");
  const at = soon(3_600_000);
  const made: any = await k.call("cms.brief", { title: "Spring menu post", details: "300 words, link the menu.", agent: "writer", model: "post", due: "2026-12-01", publishAt: at }, owner);
  const id = made.brief.id;
  assert.match(made.next, /writer sees it/);
  const created = feed.find((e) => e.event === "brief.created");
  assert.ok(viewEvent(k, k.actor("writer"), created), "the agent hears about its brief");
  assert.equal(viewEvent(k, k.actor("tagger"), created), null, "other agents don't");

  // The writer finds it, takes it, asks a question; a person answers.
  assert.match((await k.call<any>("cms.describe", {}, writer)).briefs, /1 brief for you/);
  assert.deepEqual((await k.call<any>("cms.briefs", {}, writer)).briefs.map((b: any) => b.id), [id]);
  assert.equal((await k.call<any>("cms.briefs", {}, tagger)).total, 0);
  await assert.rejects(k.call("cms.brief_update", { id, status: "in_progress" }, tagger), /No brief/);
  await k.call("cms.brief_update", { id, status: "in_progress" }, writer);
  await assert.rejects(k.call("cms.brief_update", { id, status: "blocked" }, writer), /Say what you need/);
  await k.call("cms.brief_update", { id, status: "blocked", note: "Which dishes are new?" }, writer);
  const answered: any = await k.call("cms.brief", { id, note: "The asparagus and the tart." }, owner);
  assert.equal(answered.brief.status, "in_progress");
  assert.deepEqual(answered.brief.notes.map((n: any) => n.by), ["writer", "owner"]);

  // Submitting with the brief links it and carries its publish time; rejecting brings the comment back.
  const d: any = await k.call("post.draft", { title: "Spring menu" }, writer);
  const sent: any = await k.call("cms.submit", { brief: id }, writer);
  assert.equal(sent.publishAt, at);
  let brief: any = (await k.call<any>("cms.briefs", { id }, writer)).brief;
  assert.deepEqual([brief.status, brief.changesets], ["in_review", [sent.changeset]]);
  assert.equal((await k.call<any>("cms.review", { id: sent.changeset }, owner)).brief, id);
  await k.call("cms.reject", { id: sent.changeset, comment: "Add prices" }, owner);
  brief = (await k.call<any>("cms.briefs", { id }, writer)).brief;
  assert.equal(brief.status, "in_progress");
  assert.match(brief.notes.at(-1).text, /Add prices/);

  await k.call("post.draft", { id: d.id, title: "Spring menu, with prices" }, writer);
  const again: any = await k.call("cms.submit", { brief: id }, writer);
  await k.call("cms.merge", { id: again.changeset, at: "now" }, owner);
  brief = (await k.call<any>("cms.briefs", { id }, owner)).brief;
  assert.equal(brief.status, "done");
  assert.equal((await k.call<any>("cms.briefs", {}, writer)).total, 0, "done briefs leave the default list");
  await assert.rejects(k.call("cms.submit", { brief: id }, writer), /already done|no drafted/i);

  // A planning agent briefs anyone; an open brief is claimed by whoever takes it.
  const open: any = await k.call("cms.brief", { title: "Tag the spring posts" }, planner);
  assert.equal((await k.call<any>("cms.briefs", {}, tagger)).total, 1);
  assert.equal((await k.call<any>("cms.briefs", {}, writer)).total, 1);
  await k.call("tag.draft", { name: "Spring" }, tagger);
  const tagged: any = await k.call("cms.submit", { brief: open.brief.id }, tagger);
  assert.equal(tagged.status, "merged");
  const closed: any = (await k.call<any>("cms.briefs", { id: open.brief.id }, planner)).brief;
  assert.deepEqual([closed.status, closed.claimedBy], ["done", "tagger"]);
  assert.equal((await k.call<any>("cms.briefs", {}, writer)).total, 0, "a claimed brief leaves other agents' lists");
  await k.close();
});

test("lint: placeholders block, filler and sloppiness warn, only in touched fields", async () => {
  const blocks = [
    { type: "heading", level: 2, text: "" },
    { type: "paragraph", text: "Let's delve into the menu. It's important to note that [insert price] applies." },
    { type: "image", src: "/media/a.jpg", alt: "" },
    { type: "paragraph", text: `${"word ".repeat(45)}end.` },
    { type: "paragraph", text: "See [the menu](#)." },
  ];
  const found = lintEntry({ model: post, data: { title: "Menu", body: blocks }, op: "create", changed: [] });
  const msgs = found.map((f) => `${f.level}:${f.message}`);
  assert.ok(msgs.some((m) => m.startsWith('error:body: paragraph 1: placeholder "[insert price]"')), msgs.join("\n"));
  assert.ok(msgs.includes('warning:body: paragraph 1: avoid "delve"'));
  assert.ok(msgs.includes('warning:body: paragraph 1: avoid "It\'s important to note"'));
  assert.ok(msgs.some((m) => /46-word sentence/.test(m)));
  assert.ok(msgs.includes("warning:body: block 1 is an empty heading"));
  assert.ok(msgs.some((m) => /image \/media\/a\.jpg has no alt text/.test(m)));
  assert.ok(msgs.some((m) => /goes nowhere/.test(m)));
  assert.deepEqual(lintEntry({ model: post, data: { title: "Delve", body: blocks }, op: "update", changed: ["title"] }).map((f) => f.message), ['title: avoid "Delve"']);
  assert.deepEqual(lintEntry({ model: post, data: { title: "TODO" }, op: "create", changed: [] }, { placeholders: false, avoid: [] }), []);

  const k = await makeCms({ modules: [stats, lint()] });
  const writer = { actor: k.actor("writer"), gate: "mcp" as const };
  await k.call("post.draft", { title: "Menu", body: "Prices: [insert price]." }, writer);
  const r: any = await k.call("cms.submit", {}, writer);
  assert.equal(r.status, "needs_changes");
  assert.equal(r.issues[0].check, "lint/text");
  await k.close();
});

test("seo checks: problems in the fields a change touches become warnings", async () => {
  const k = await makeCms({ modules: [stats, seo()] });
  const writer = { actor: k.actor("writer"), gate: "mcp" as const };
  const d: any = await k.call("post.draft", { title: "Hi" }, writer);
  const r: any = await k.call("cms.submit", {}, writer);
  assert.equal(r.status, "submitted");
  assert.ok(r.warnings.some((w: any) => w.check === "seo/audit" && /meta description/.test(w.message)));
  await k.call("cms.merge", { id: r.changeset }, owner);
  // A long SEO title is flagged; the short body isn't, because this change doesn't touch it.
  await k.call("post.draft", { id: d.id, seo: { title: "A".repeat(59), description: "D".repeat(80) } }, writer);
  const w: any = await k.call("cms.check", {}, writer);
  assert.deepEqual(w.warnings.map((x: any) => x.field), [], JSON.stringify(w.warnings));
  const off = await makeCms({ modules: [stats, seo({ checks: false })] });
  await off.call("post.draft", { title: "Hi" }, { actor: off.actor("writer"), gate: "mcp" });
  assert.deepEqual((await off.call<any>("cms.check", {}, { actor: off.actor("writer"), gate: "mcp" })).warnings, []);
  await off.close();
  await k.close();
});
