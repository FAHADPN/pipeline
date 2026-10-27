import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLines, buildProgress, listReviews, loadReview } from "../lib/review.mjs";

const TOKEN = "IGQVJ-fixture-instagram-token-123";
const REVIEW = {
  verdict: "FIX",
  scores: { director: 70, copy_art_ui: 64, brand: 88, forensics: 80 },
  skills: { caption_py: "READY" },
  must_fix: ["Captions start at 240 px, inside Instagram's top band.", "The emoji covers the labels."],
  nice_to_have: ["Hold the end card longer."],
  summary: "Two layout problems.",
};
const CHECKS = { id: "p1", caption_py: { verdict: "READY" }, detect_caption: { verdict: "PASS", human_score: 81.7 }, detect_onscreen: null, hook_caption: null, hook_onscreen: { verdict: "OK", score: 66 } };

// A campaign's Data (sources.mjs) on a temp folder: pieces/<id>/out with media and a
// caption, creation-out/ for the reviewer's files, and a home for the log.
function makeData({ cstate = {}, backlog = [], secretValues = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-root-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "review-home-"));
  const outDir = path.join(root, "creation-out");
  fs.mkdirSync(outDir);
  const piece = (id, { video = true } = {}) => {
    const out = path.join(root, "pieces", id, "out");
    fs.mkdirSync(out, { recursive: true });
    if (video) fs.writeFileSync(path.join(out, "clip.mp4"), "video");
    fs.writeFileSync(path.join(out, "clip-cover.png"), "png");
    fs.writeFileSync(path.join(out, "clip-caption.txt"), "INSTAGRAM / TIKTOK\nBangalore to Chennai is 350 km.\n\nYOUTUBE SHORTS TITLE\nTwo phones\n");
  };
  return {
    root,
    home,
    outDir,
    piece,
    backlog,
    cstate: { items: cstate },
    secretValues,
    pieceDir: (id) => `pieces/${id}`,
    mediaUrl: (id, file) => `/media/${id}/${file}?campaign=beta`,
  };
}

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

test("review: reads verdict, scores and must_fix from <outDir>/<id>.review.json, and the checks from <id>.checks.json", () => {
  const data = makeData({
    backlog: [{ id: "p1", title: "Two phones", type: "teach" }],
    cstate: { p1: { status: "awaiting-approval", attempts: 1, at: "2026-10-25T02:00:00.000Z" } },
  });
  data.piece("p1");
  writeJson(path.join(data.outDir, "p1.review.json"), REVIEW);
  writeJson(path.join(data.outDir, "p1.checks.json"), CHECKS);
  // The builder's notes are not the review.
  writeJson(path.join(data.outDir, "p1.json"), { verdict: "SHIP", notes: "builder" });

  const review = loadReview({ data, id: "p1" });
  assert.deepEqual(review, {
    id: "p1",
    title: "Two phones",
    type: "teach",
    status: "awaiting-approval",
    reason: null,
    note: null,
    attempts: 1,
    canBuild: false,
    checks: CHECKS,
    review: REVIEW,
    caption: "Bangalore to Chennai is 350 km.",
    youtubeTitle: "Two phones",
    video: "/media/p1/clip.mp4?campaign=beta",
    cover: "/media/p1/clip-cover.png?campaign=beta",
    queued: null,
  });
  // Second in the build queue.
  const queue = [{ id: "p0", kind: "build" }, { id: "p1", kind: "recheck" }];
  assert.deepEqual(loadReview({ data, id: "p1", queue }).queued, { position: 2 });
});

test("review: a missing review or checks file gives null for that part", () => {
  const data = makeData({
    backlog: [{ id: "p2", title: "Parked", type: "story", format: "episode" }],
    cstate: { p2: { status: "failed", attempts: 2, reason: "review said FIX twice. Must fix: captions too high", at: "x" } },
  });
  data.piece("p2", { video: false });
  let review = loadReview({ data, id: "p2" });
  assert.equal(review.checks, null);
  assert.equal(review.review, null);
  assert.equal(review.reason, "review said FIX twice. Must fix: captions too high");
  assert.equal(review.video, null);
  assert.equal(review.canBuild, false, "two failed attempts park it");

  writeJson(path.join(data.outDir, "p2.checks.json"), CHECKS);
  fs.writeFileSync(path.join(data.outDir, "p2.review.json"), "{ not json");
  review = loadReview({ data, id: "p2" });
  assert.deepEqual(review.checks, CHECKS);
  assert.equal(review.review, null, "an unreadable review is no review");

  // Not in the build list or the build progress: nothing to review.
  assert.equal(loadReview({ data, id: "nope" }), null);
});

test("review: a token in the reason, a must-fix item or the caption never leaves", () => {
  const data = makeData({
    backlog: [{ id: "p3", title: "t", format: "episode" }],
    cstate: { p3: { status: "failed", attempts: 1, reason: `upload failed for ${TOKEN}`, at: "x" } },
    secretValues: [TOKEN],
  });
  data.piece("p3");
  writeJson(path.join(data.outDir, "p3.review.json"), { ...REVIEW, must_fix: [`token ${TOKEN}`] });
  const text = JSON.stringify(loadReview({ data, id: "p3" }));
  assert.ok(!text.includes(TOKEN));
  assert.match(text, /\[redacted\]/);
  assert.equal(loadReview({ data, id: "p3" }).canBuild, true, "one failed attempt can build again");
});

test("review: the list holds every awaiting, failed and redo piece, newest first", () => {
  const data = makeData({
    backlog: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }],
    cstate: {
      a: { status: "awaiting-approval", attempts: 0, at: "2026-10-23T02:00:00.000Z" },
      b: { status: "failed", attempts: 1, reason: "checks failed", at: "2026-10-25T02:00:00.000Z" },
      c: { status: "redo", attempts: 0, note: "slower", at: "2026-10-24T02:00:00.000Z" },
      d: { status: "approved", attempts: 0, at: "2026-10-25T03:00:00.000Z" },
      e: { status: "building", attempts: 0, at: "2026-10-25T04:00:00.000Z" },
    },
  });
  data.piece("a");
  const list = listReviews({ data });
  assert.deepEqual(list.map((p) => [p.id, p.status]), [["b", "failed"], ["c", "redo"], ["a", "awaiting-approval"]]);
  assert.deepEqual(list[2], { id: "a", title: "A", type: null, status: "awaiting-approval", reason: null, at: "2026-10-23T02:00:00.000Z", cover: "/media/a/clip-cover.png?campaign=beta", queued: null });
  assert.equal(list[1].reason, "slower");
});

const LOG = [
  '2026-10-24T20:30:00.000Z INFO nightly start {"manual":true,"onlyId":"p1"}',
  '2026-10-24T21:40:00.000Z ERROR nightly: piece failed {"id":"p1","reason":"old run"}',
  '2026-10-25T02:00:00.000Z INFO nightly start {"manual":false}',
  '2026-10-25T02:10:00.000Z INFO nightly: sent for approval {"id":"p10"}',
  '2026-10-25T02:30:00.000Z INFO nightly start {"manual":true,"onlyId":"other"}',
  '2026-10-25T02:31:00.000Z INFO dashboard hold {"id":"p1","ok":true}',
  '2026-10-25T03:00:00.000Z INFO nightly start {"manual":true,"onlyId":"p1"}',
  "2026-10-25T03:01:00.000Z INFO something else entirely",
  `2026-10-25T03:40:00.000Z ERROR nightly: piece failed {"id":"p1","reason":"session exited 1: ${TOKEN}"}`,
  '2026-10-25T03:41:00.000Z INFO nightly done {"built":[],"failed":["p1"]}',
  '2026-10-25T03:42:00.000Z INFO nightly: sent for approval {"id":"p1-extra"}',
  "",
].join("\n");

test("build: lines are only those mentioning the id since its last nightly start", () => {
  assert.deepEqual(buildLines(LOG, "p1"), [
    '2026-10-25T03:00:00.000Z INFO nightly start {"manual":true,"onlyId":"p1"}',
    `2026-10-25T03:40:00.000Z ERROR nightly: piece failed {"id":"p1","reason":"session exited 1: ${TOKEN}"}`,
    '2026-10-25T03:41:00.000Z INFO nightly done {"built":[],"failed":["p1"]}',
  ]);
  // A night run (no onlyId) may build any piece; one for another piece can't.
  assert.deepEqual(buildLines(LOG, "p10"), ['2026-10-25T02:10:00.000Z INFO nightly: sent for approval {"id":"p10"}']);
  assert.deepEqual(buildLines("", "p1"), []);
  assert.deepEqual(buildLines("2026-10-25T03:00:00.000Z INFO dashboard hold {\"id\":\"p1\"}\n", "p1"), [], "no nightly start, no lines");

  const many = ['2026-10-25T03:00:00.000Z INFO nightly start {"onlyId":"p1"}', ...Array.from({ length: 40 }, (_, i) => `t INFO step ${i} {"id":"p1"}`)].join("\n");
  const last = buildLines(many, "p1");
  assert.equal(last.length, 30);
  assert.equal(last.at(-1), 't INFO step 39 {"id":"p1"}');
});

test("build: progress reads the newest monthly log, with the status, its start and secrets scrubbed", () => {
  const data = makeData({
    backlog: [{ id: "p1", title: "Two phones" }],
    cstate: { p1: { status: "building", attempts: 0, at: "2026-10-25T03:00:30.000Z" } },
    secretValues: [TOKEN],
  });
  fs.mkdirSync(path.join(data.home, "logs"));
  fs.writeFileSync(path.join(data.home, "logs", "2026-09.log"), '2026-09-30T03:00:00.000Z INFO nightly start {"onlyId":"p1"}\nold {"id":"p1"}\n');
  fs.writeFileSync(path.join(data.home, "logs", "2026-10.log"), LOG);
  const progress = buildProgress({ data, id: "p1", now: new Date("2026-10-25T03:05:30.000Z") });
  assert.equal(progress.status, "building");
  assert.equal(progress.since, "2026-10-25T03:00:30.000Z");
  assert.equal(progress.elapsedSeconds, 300);
  assert.equal(progress.lines.length, 3);
  assert.ok(!JSON.stringify(progress).includes(TOKEN));

  // No log yet: no lines. An unknown piece: null.
  const empty = makeData({ backlog: [{ id: "p1" }] });
  assert.deepEqual(buildProgress({ data: empty, id: "p1", now: new Date() }), { status: "todo", since: null, elapsedSeconds: null, lines: [], queued: null });
  assert.equal(buildProgress({ data: empty, id: "nope", now: new Date() }), null);
});
