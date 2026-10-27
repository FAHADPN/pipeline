import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLibrary } from "../lib/library.mjs";
import { loadCampaignData } from "../lib/sources.mjs";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";

const NOW = new Date("2026-10-25T10:00:00Z"); // 15:30 IST, Sun 2026-10-25

const dirOf = (id) => `pieces/${id}`;
const item = (id, extra = {}) => ({ id, kind: "ep", dir: dirOf(id), ...extra });

function writePiece(repoRoot, id, { cover = true, video = true } = {}) {
  const out = path.join(repoRoot, dirOf(id), "out");
  fs.mkdirSync(out, { recursive: true });
  if (video) fs.writeFileSync(path.join(out, `${id}.mp4`), "video");
  if (cover) fs.writeFileSync(path.join(out, `${id}-cover.png`), "png");
  fs.writeFileSync(
    path.join(out, `${id}-caption.txt`),
    `INSTAGRAM / TIKTOK\n${id} first line\n\n#acme\n\nYOUTUBE SHORTS TITLE\n${id} title #shorts\n`,
  );
}

const posted = (date, url) => ({ instagram: { status: "posted", at: "2026-10-24T14:00:00.000Z", date, url } });

// The acme campaign rooted at a temp repo. `items` are written to the schedule and
// get a good out/ folder unless listed in `bare`; `pieces` are extra folders with out/.
function setup({ items = [], backlog, cstate, state, pieces = [], bare = [] } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-repo-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-campaigns-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  fs.mkdirSync(path.join(root, "acme"));
  fs.writeFileSync(path.join(root, "acme", "campaign.json"), JSON.stringify({ id: "acme", name: "Acme Coffee", root: repoRoot }));
  fs.writeFileSync(path.join(repoRoot, "schedule.json"), JSON.stringify(items));
  for (const it of items) {
    if (bare.includes(it.id)) fs.mkdirSync(path.join(repoRoot, it.dir), { recursive: true });
    else writePiece(repoRoot, it.id);
  }
  for (const id of pieces) writePiece(repoRoot, id);
  if (backlog) {
    fs.writeFileSync(path.join(repoRoot, "backlog.json"), JSON.stringify(backlog));
  }
  const campaign = getCampaign("acme", { root, home });
  fs.mkdirSync(campaign.home, { recursive: true });
  if (state) fs.writeFileSync(path.join(campaign.home, "state.json"), JSON.stringify({ version: 1, items: state }));
  if (cstate) fs.writeFileSync(path.join(campaign.home, "creation-state.json"), JSON.stringify({ items: cstate }));
  return loadCampaignData({ campaign, secrets: createSecrets(home) });
}

const byId = (library, id) => library.pieces.find((p) => p.id === id);

test("library: a posted item is \"posted\" with its date and permalink", () => {
  const data = setup({ items: [item("a")], state: { a: posted("2026-10-24", "https://instagram.com/reel/abc") } });
  const lib = buildLibrary({ data, now: NOW });
  assert.deepEqual(byId(lib, "a"), {
    id: "a",
    title: "a",
    type: null,
    status: "posted",
    date: "2026-10-24",
    pinned: false,
    video: "/media/a/a.mp4?campaign=acme",
    cover: "/media/a/a-cover.png?campaign=acme",
    caption: "a first line\n\n#acme",
    youtubeTitle: "a title #shorts",
    url: "https://instagram.com/reel/abc",
    reason: null,
  });
  assert.equal(lib.counts.posted, 1);
});

test("library: a schedule item that passes checkItem is \"ready\" with its projected date; pinned is true when it has \"on\"", () => {
  const data = setup({ items: [item("a"), item("b"), item("c", { on: "2026-11-03" })] });
  const lib = buildLibrary({ data, now: NOW });
  const [a, b, c] = ["a", "b", "c"].map((id) => byId(lib, id));
  assert.equal(a.status, "ready");
  assert.equal(a.date, "2026-10-25");
  assert.equal(a.pinned, false);
  assert.equal(b.date, "2026-10-26");
  assert.equal(c.status, "ready");
  assert.equal(c.date, "2026-11-03");
  assert.equal(c.pinned, true);
  assert.equal(lib.counts.ready, 3);
});

test("library: hold true is \"held\"", () => {
  const data = setup({ items: [item("a", { hold: true }), item("b")] });
  const lib = buildLibrary({ data, now: NOW });
  assert.equal(byId(lib, "a").status, "held");
  assert.equal(byId(lib, "b").status, "ready");
  assert.equal(lib.counts.held, 1);
});

test("library: a build-list piece awaiting approval is \"awaiting\" with its video URL", () => {
  const data = setup({
    pieces: ["p1"],
    backlog: [{ id: "p1", title: "Piece one", type: "teach", targetDate: "2026-11-09" }],
    cstate: { p1: { status: "awaiting-approval", attempts: 0, at: "2026-10-25T08:00:00.000Z" } },
  });
  const lib = buildLibrary({ data, now: NOW });
  assert.deepEqual(byId(lib, "p1"), {
    id: "p1",
    title: "Piece one",
    type: "teach",
    status: "awaiting",
    date: "2026-11-09",
    pinned: false,
    video: "/media/p1/p1.mp4?campaign=acme",
    cover: "/media/p1/p1-cover.png?campaign=acme",
    caption: "p1 first line\n\n#acme",
    youtubeTitle: "p1 title #shorts",
    url: null,
    reason: null,
  });
  assert.equal(lib.counts.awaiting, 1);
});

test("library: a failed piece with no video is \"fix\" with video null and its reason", () => {
  const data = setup({
    backlog: [{ id: "f1", title: "Broken one" }],
    cstate: { f1: { status: "failed", attempts: 2, reason: "render crashed" } },
  });
  const lib = buildLibrary({ data, now: NOW });
  const f1 = byId(lib, "f1");
  assert.equal(f1.status, "fix");
  assert.equal(f1.video, null);
  assert.equal(f1.cover, null);
  assert.equal(f1.caption, null);
  assert.equal(f1.youtubeTitle, null);
  assert.equal(f1.reason, "render crashed");
  assert.equal(lib.counts.fix, 1);
});

test("library: a schedule item that fails checkItem is \"fix\" with the check errors, and a failed post is \"fix\" with its error", () => {
  const data = setup({
    items: [item("a"), item("b")],
    bare: ["a"],
    state: { b: { instagram: { status: "failed", at: "2026-10-25T01:00:00.000Z", error: "token expired" } } },
  });
  const lib = buildLibrary({ data, now: NOW });
  assert.equal(byId(lib, "a").status, "fix");
  assert.match(byId(lib, "a").reason, /no out\/ folder/);
  assert.equal(byId(lib, "a").video, null);
  assert.equal(byId(lib, "b").status, "fix");
  assert.equal(byId(lib, "b").reason, "token expired");
  assert.equal(byId(lib, "b").video, "/media/b/b.mp4?campaign=acme");
});

test("library: a dropped item is \"dropped\" with its reason", () => {
  const data = setup({
    items: [item("a", { on: "2026-10-01" })],
    state: { a: { instagram: { status: "dropped", at: "2026-10-02T00:00:00.000Z", reason: "pinned date passed" } } },
  });
  const a = byId(buildLibrary({ data, now: NOW }), "a");
  assert.equal(a.status, "dropped");
  assert.equal(a.reason, "pinned date passed");
  assert.equal(a.date, "2026-10-01");
});

test("library: title falls back from schedule title, to build-list title, to the id", () => {
  const data = setup({
    items: [item("a", { title: "Scheduled title", type: "story" }), item("b"), item("c")],
    backlog: [
      { id: "a", title: "Build title A", type: "teach" },
      { id: "b", title: "Build title B", type: "teach" },
    ],
  });
  const lib = buildLibrary({ data, now: NOW });
  assert.equal(byId(lib, "a").title, "Scheduled title");
  assert.equal(byId(lib, "a").type, "story");
  assert.equal(byId(lib, "b").title, "Build title B");
  assert.equal(byId(lib, "b").type, "teach");
  assert.equal(byId(lib, "c").title, "c");
  assert.equal(byId(lib, "c").type, null);
});

test("library: todo, building and approved pieces are not listed, and a piece in both lists appears once", () => {
  const data = setup({
    items: [item("a")],
    backlog: [{ id: "a" }, { id: "t" }, { id: "b" }, { id: "x" }],
    cstate: {
      a: { status: "approved" },
      t: { status: "todo" },
      b: { status: "building" },
      x: { status: "approved" },
    },
  });
  assert.deepEqual(buildLibrary({ data, now: NOW }).pieces.map((p) => p.id), ["a"]);
});

test("library: pieces sort by date descending, no date last, then by id", () => {
  const data = setup({
    items: [item("a", { on: "2026-11-05" }), item("b", { on: "2026-11-20" }), item("c")],
    backlog: [{ id: "z" }, { id: "y" }],
    cstate: { z: { status: "failed", reason: "r" }, y: { status: "redo", reason: "redo me" } },
  });
  const lib = buildLibrary({ data, now: NOW });
  assert.deepEqual(lib.pieces.map((p) => p.id), ["b", "a", "c", "y", "z"]);
  assert.equal(byId(lib, "y").reason, "redo me");
});

test("library: a null build-progress entry is skipped", () => {
  const data = setup({ backlog: [{ id: "n" }], cstate: { n: null } });
  assert.deepEqual(buildLibrary({ data, now: NOW }).pieces, []);
});

test("library: an empty campaign gives pieces [] and all counts 0", () => {
  const lib = buildLibrary({ data: setup(), now: NOW });
  assert.deepEqual(lib, { pieces: [], counts: { all: 0, ready: 0, held: 0, awaiting: 0, posted: 0, fix: 0, dropped: 0 } });
});
