import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCalendar, buildEntries } from "../lib/calendar.mjs";
import { loadCampaignData } from "../lib/sources.mjs";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";

const NOW = new Date("2026-10-25T10:00:00Z"); // 15:30 IST, Sun 2026-10-25
const FROM = "2026-10-19";

const dirOf = (id) => `pieces/${id}`;
const item = (id, extra = {}) => ({ id, kind: "ep", dir: dirOf(id), ...extra });

function writePiece(repoRoot, id) {
  const out = path.join(repoRoot, dirOf(id), "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${id}.mp4`), "video");
  fs.writeFileSync(path.join(out, `${id}-cover.png`), "png");
  fs.writeFileSync(path.join(out, `${id}-caption.txt`), `INSTAGRAM / TIKTOK\n${id} first line\n\nYOUTUBE SHORTS TITLE\n${id} title\n`);
}

// The acme campaign rooted at a temp repo; every schedule item gets a good out/ folder.
function setup({ items = [], backlog, cstate, state } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-repo-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-campaigns-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  fs.mkdirSync(path.join(root, "acme"));
  fs.writeFileSync(path.join(root, "acme", "campaign.json"), JSON.stringify({ id: "acme", name: "Acme Coffee", root: repoRoot }));
  fs.writeFileSync(path.join(repoRoot, "schedule.json"), JSON.stringify(items));
  for (const it of items) writePiece(repoRoot, it.id);
  if (backlog) {
    fs.writeFileSync(path.join(repoRoot, "backlog.json"), JSON.stringify(backlog));
  }
  const campaign = getCampaign("acme", { root, home });
  fs.mkdirSync(campaign.home, { recursive: true });
  if (state) fs.writeFileSync(path.join(campaign.home, "state.json"), JSON.stringify({ version: 1, items: state }));
  if (cstate) fs.writeFileSync(path.join(campaign.home, "creation-state.json"), JSON.stringify({ items: cstate }));
  return loadCampaignData({ campaign, secrets: createSecrets(home) });
}

const day = (cal, date) => cal.days.find((d) => d.date === date);
// [date, id, kind] for every post on the calendar, in day order.
const posts = (cal) => cal.days.flatMap((d) => d.posts.map((p) => [d.date, p.id, p.kind]));

test("calendar: a posted item appears on its posted date as kind posted with its permalink", () => {
  const data = setup({
    items: [item("a", { title: "Sam's additions", type: "story" })],
    state: { a: { instagram: { status: "posted", at: "2026-10-24T14:00:00.000Z", date: "2026-10-24", url: "https://instagram.com/reel/abc" } } },
  });
  const cal = buildCalendar({ data, from: FROM, days: 35, now: NOW });
  assert.deepEqual(day(cal, "2026-10-24").posts, [
    {
      id: "a",
      title: "Sam's additions",
      type: "story",
      kind: "posted",
      url: "https://instagram.com/reel/abc",
      video: "/media/a/a.mp4?campaign=acme",
      cover: "/media/a/a-cover.png?campaign=acme",
    },
  ]);
  assert.deepEqual(posts(cal), [["2026-10-24", "a", "posted"]]);
});

test("calendar: projected floating items fill future days in queue order", () => {
  const ids = ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9"];
  const data = setup({ items: ids.map((id) => item(id)) });
  const cal = buildCalendar({ data, from: FROM, days: 35, now: NOW });
  // Daily while 7 or more are ready, then Mon, Wed, Fri and Sun only, as the planner posts.
  assert.deepEqual(posts(cal), [
    ["2026-10-25", "i1", "scheduled"],
    ["2026-10-26", "i2", "scheduled"],
    ["2026-10-27", "i3", "scheduled"],
    ["2026-10-28", "i4", "scheduled"],
    ["2026-10-30", "i5", "scheduled"],
    ["2026-11-01", "i6", "scheduled"],
    ["2026-11-02", "i7", "scheduled"],
    ["2026-11-04", "i8", "scheduled"],
    ["2026-11-06", "i9", "scheduled"],
  ]);
  assert.equal(day(cal, "2026-10-26").posts[0].url, null);
  // The run-dry date the Needs you stat shows, counted the same way (from tomorrow).
  assert.equal(cal.runDry, "2026-11-08");
});

test("calendar: a 7-day window from today+42 has no scheduled posts, and projectedThrough is today+41", () => {
  // 50 ready floating items: posted daily, the queue runs past today+42.
  const ids = Array.from({ length: 50 }, (_, n) => `i${n + 1}`);
  const data = setup({ items: ids.map((id) => item(id)) });
  const near = buildCalendar({ data, from: "2026-11-30", days: 7, now: NOW });
  assert.equal(near.projectedThrough, "2026-12-05");
  assert.deepEqual(near.days.map((d) => d.posts.length), [1, 1, 1, 1, 1, 1, 0], "posts up to 5 Dec, none on 6 Dec");

  const far = buildCalendar({ data, from: "2026-12-06", days: 7, now: NOW });
  assert.equal(far.projectedThrough, "2026-12-05");
  assert.deepEqual(far.days.flatMap((d) => d.posts), []);
  // The run-dry date lies past the horizon, so the screen says where the chips stop.
  assert.ok(far.runDry > far.projectedThrough);
});

test("calendar: an item with \"on\" is kind pinned on that date", () => {
  const data = setup({ items: [item("a"), item("nov1", { on: "2026-11-01" })] });
  const cal = buildCalendar({ data, from: FROM, days: 35, now: NOW });
  assert.deepEqual(posts(cal), [
    ["2026-10-25", "a", "scheduled"],
    ["2026-11-01", "nov1", "pinned"],
  ]);
});

test("calendar: a held item is listed on no day", () => {
  const data = setup({ items: [item("a", { hold: true }), item("b")] });
  const cal = buildCalendar({ data, from: FROM, days: 35, now: NOW });
  // b takes the first day: the held item takes no day from the ones behind it.
  assert.deepEqual(posts(cal), [["2026-10-25", "b", "scheduled"]]);
});

test("calendar: a held item that is pinned shows as held on its date; a dropped one as dropped", () => {
  const data = setup({
    items: [item("h", { hold: true, on: "2026-11-03" }), item("d", { on: "2026-10-20" })],
    state: { d: { instagram: { status: "dropped", at: "2026-10-21", reason: "pinned date passed" } } },
  });
  const cal = buildCalendar({ data, from: FROM, days: 35, now: NOW });
  assert.deepEqual(posts(cal), [
    ["2026-10-20", "d", "dropped"],
    ["2026-11-03", "h", "held"],
  ]);
});

test("calendar: a build-list entry still todo with a targetDate in range is under builds", () => {
  const data = setup({
    items: [item("ep-04")],
    backlog: [
      { id: "ep-04", title: "Scheduled already", targetDate: "2026-10-30" },
      { id: "idea-1", title: "Hot take", type: "opinion", targetDate: "2026-11-14" },
      { id: "idea-2", title: "Too late", type: "offer", targetDate: "2026-11-23" },
      { id: "done-1", title: "Approved", targetDate: "2026-11-15" },
    ],
    cstate: { "done-1": { status: "approved", attempts: 0 } },
  });
  const cal = buildCalendar({ data, from: FROM, days: 35, now: NOW });
  assert.deepEqual(day(cal, "2026-11-14").builds, [{ id: "idea-1", title: "Hot take", type: "opinion", status: "todo", reason: null }]);
  // Out of range, approved or already scheduled: not under builds.
  assert.deepEqual(cal.days.flatMap((d) => d.builds.map((b) => b.id)), ["idea-1"]);
});

test("calendar: a failed build carries its reason", () => {
  const data = setup({
    backlog: [
      { id: "f1", title: "How many · Bangalore", type: "participation", targetDate: "2026-11-11" },
      { id: "r1", title: "Payday", type: "story", targetDate: "2026-11-12" },
    ],
    cstate: {
      f1: { status: "failed", attempts: 2, reason: "render crashed" },
      r1: { status: "redo", attempts: 0, note: "tighter hook" },
    },
  });
  const cal = buildCalendar({ data, from: FROM, days: 35, now: NOW });
  assert.deepEqual(day(cal, "2026-11-11").builds, [{ id: "f1", title: "How many · Bangalore", type: "participation", status: "failed", reason: "render crashed" }]);
  assert.deepEqual(day(cal, "2026-11-12").builds[0].reason, "tighter hook");
  assert.equal(day(cal, "2026-11-12").builds[0].status, "redo");
});

test("calendar: days 43 or from \"2026-02-30\" throw RangeError, and the server answers 400", () => {
  // The server half is in server.test.mjs.
  const data = setup();
  assert.throws(() => buildCalendar({ data, from: FROM, days: 43, now: NOW }), RangeError);
  assert.throws(() => buildCalendar({ data, from: FROM, days: 0, now: NOW }), RangeError);
  assert.throws(() => buildCalendar({ data, from: FROM, days: 3.5, now: NOW }), RangeError);
  assert.throws(() => buildCalendar({ data, from: "2026-02-30", days: 35, now: NOW }), RangeError);
  assert.throws(() => buildCalendar({ data, from: "next week", now: NOW }), RangeError);
  assert.equal(buildCalendar({ data, from: FROM, days: 42, now: NOW }).days.length, 42);
});

test("calendar: with no from or days, it starts on the Monday of today's week in the campaign's time zone and covers 35 days", () => {
  const data = setup();
  const cal = buildCalendar({ data, now: NOW });
  assert.equal(cal.from, "2026-10-19");
  assert.equal(cal.days.length, 35);
  assert.equal(cal.days[0].date, "2026-10-19");
  assert.equal(cal.days.at(-1).date, "2026-11-22");
  assert.deepEqual(cal.days[0], { date: "2026-10-19", posts: [], builds: [] });
  // 19:00 UTC on Sunday is already Monday 26 Oct in India: a new week.
  assert.equal(buildCalendar({ data, now: new Date("2026-10-25T19:00:00Z") }).from, "2026-10-26");
});

test("calendar: buildEntries lists every unbuilt or unapproved build-list entry with its date, for the pipeline", () => {
  const data = setup({
    items: [item("ep-04")],
    backlog: [
      { id: "ep-04", title: "Scheduled already", targetDate: "2026-10-30" },
      { id: "idea-1", title: "Hot take", type: "opinion", targetDate: "2026-11-14" },
      { id: "b1", title: "Building now", targetDate: "2026-12-01" },
      { id: "w1", title: "Waiting", targetDate: "2026-11-02", on: "2026-11-05" },
      { id: "done-1", title: "Approved", targetDate: "2026-11-15" },
    ],
    cstate: {
      b1: { status: "building", attempts: 0 },
      w1: { status: "awaiting-approval", attempts: 0 },
      "done-1": { status: "approved", attempts: 0 },
    },
  });
  assert.deepEqual(buildEntries({ data }), [
    { id: "idea-1", title: "Hot take", type: "opinion", status: "todo", reason: null, date: "2026-11-14", idea: { targetDate: "2026-11-14" } },
    { id: "b1", title: "Building now", type: null, status: "building", reason: null, date: "2026-12-01" },
    { id: "w1", title: "Waiting", type: null, status: "awaiting", reason: null, date: "2026-11-05" },
  ]);
});
