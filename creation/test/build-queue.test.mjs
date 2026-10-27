import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock } from "../../publishing/lib/lock.mjs";
import { BUILD_STARTUP_MINUTES, BUILD_VERIFY_MINUTES } from "../lib/constants.mjs";
import { createCreationStore } from "../lib/cstate.mjs";
import { postingOverlap, readQueue, requeueAtHead, startNextQueued } from "../lib/build-queue.mjs";

const PIPELINE = path.join(os.tmpdir(), "pipeline-code");
// A 19:30 IST slot with a 60-minute late limit: builds wait from 16:50 to 20:45.
const CONFIG = { timezone: "Asia/Kolkata", slot: "19:30", lateLimitMinutes: 60, bufferMin: 3, fallbackDays: [], retryDelaySeconds: 60, platforms: {} };
const CAMPAIGN = { id: "test", name: "Test Campaign", lockName: (name) => `test:${name}`, config: CONFIG };
const MORNING = new Date("2026-10-26T10:00:00+05:30");
const AT = "2026-10-24T20:00:00.000Z";
const entry = (id) => ({ id, kind: "post", format: "episode", type: "story", title: id, premise: "A premise.", targetDate: "2026-11-12", hook: 3, reference: "starter" });

// A campaign home (also the lock home) and a repo whose pieces have a video, except
// p-todo. p-fail and p-redo can be built; p-await and p-fail can be rechecked.
function setup(t, { now = () => MORNING } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bqueue-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bqueue-repo-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  const ids = ["p-fail", "p-redo", "p-await", "p-approved", "p-todo"];
  for (const id of ids.filter((i) => i !== "p-todo")) {
    const out = path.join(repoRoot, "pieces", id, "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${id}.mp4`), "video");
  }
  const store = createCreationStore(home);
  store.save({
    items: {
      "p-fail": { status: "failed", attempts: 1, reason: "checks failed", at: AT },
      "p-redo": { status: "redo", attempts: 0, note: "slower", at: AT },
      "p-await": { status: "awaiting-approval", attempts: 0, at: AT },
      "p-approved": { status: "approved", attempts: 0, at: AT },
    },
  });
  const spawned = [];
  const lines = [];
  const deps = {
    home,
    lockHome: home,
    repoRoot,
    store,
    backlog: ids.map(entry),
    pieceDir: (id) => `pieces/${id}`,
    withLock: (name, fn, options) => withLock(home, `test:${name}`, fn, options),
    log: { info: (msg, data) => lines.push(["info", msg, data]), error: (msg, data) => lines.push(["error", msg, data]) },
    spawn: (cmd, args, options) => {
      const child = { unrefed: false, unref() { this.unrefed = true; }, on() {} };
      spawned.push({ cmd, args, options, child });
      return child;
    },
    pipelineRoot: PIPELINE,
    now,
  };
  const queueFile = path.join(home, "build-queue.json");
  const writeQueue = (entries) => fs.writeFileSync(queueFile, JSON.stringify(entries.map(([id, kind]) => ({ id, kind, queuedAt: AT }))));
  const queued = () => readQueue(home).map((e) => [e.id, e.kind]);
  const holdCreation = () => {
    fs.mkdirSync(path.join(home, "locks"), { recursive: true });
    fs.writeFileSync(path.join(home, "locks", "test.creation.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  };
  return { home, deps, spawned, lines, writeQueue, queued, holdCreation };
}

test("startNextQueued: nothing to start while a build runs", async (t) => {
  const { deps, spawned, writeQueue, queued, holdCreation } = setup(t);
  writeQueue([["p-fail", "build"], ["p-await", "recheck"]]);
  holdCreation();
  assert.equal(await startNextQueued({ campaign: CAMPAIGN, deps }), null);
  assert.equal(spawned.length, 0);
  assert.deepEqual(queued(), [["p-fail", "build"], ["p-await", "recheck"]]);

  // An empty queue starts nothing either.
  const empty = setup(t);
  assert.equal(await startNextQueued({ campaign: CAMPAIGN, deps: empty.deps }), null);
  assert.equal(empty.spawned.length, 0);
  assert.equal(fs.existsSync(path.join(empty.home, "build-queue.json")), false, "nothing written");
});

test("startNextQueued: spawns the head entry with the exact buildNow args and removes it", async (t) => {
  const { deps, spawned, lines, writeQueue, queued } = setup(t);
  writeQueue([["p-fail", "build"], ["p-await", "recheck"]]);
  const started = await startNextQueued({ campaign: CAMPAIGN, deps });
  assert.equal(started.id, "p-fail");
  assert.equal(spawned.length, 1);
  const [{ cmd, args, options, child }] = spawned;
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ["creation/create.mjs", "nightly", "--now", "--id", "p-fail", "--campaign", "test"]);
  assert.deepEqual(options, { cwd: PIPELINE, detached: true, windowsHide: true, stdio: "ignore" });
  assert.equal(child.unrefed, true);
  assert.deepEqual(queued(), [["p-await", "recheck"]]);
  assert.ok(lines.some(([level, msg]) => level === "info" && msg === "build queue: started p-fail"), JSON.stringify(lines));

  // The next one is a recheck, started with recheck's args.
  await startNextQueued({ campaign: CAMPAIGN, deps });
  assert.deepEqual(spawned[1].args, ["creation/create.mjs", "recheck", "p-await", "--campaign", "test"]);
  assert.deepEqual(spawned[1].options, { cwd: PIPELINE, detached: true, windowsHide: true, stdio: "ignore" });
  assert.deepEqual(queued(), []);
});

test("startNextQueued: a head build inside the posting window waits; outside it, it starts", async (t) => {
  let now = new Date("2026-10-26T17:00:00+05:30");
  const { deps, spawned, writeQueue, queued } = setup(t, { now: () => now });
  writeQueue([["p-fail", "build"], ["p-redo", "build"]]);
  assert.equal(await startNextQueued({ campaign: CAMPAIGN, deps }), null);
  assert.equal(spawned.length, 0, "the build behind it waits its turn too");
  assert.deepEqual(queued(), [["p-fail", "build"], ["p-redo", "build"]]);

  now = new Date("2026-10-26T20:46:00+05:30");
  assert.equal((await startNextQueued({ campaign: CAMPAIGN, deps })).id, "p-fail");
  assert.deepEqual(spawned.map((s) => s.args[1]), ["nightly"]);
  assert.deepEqual(queued(), [["p-redo", "build"]]);
});

test("startNextQueued: a recheck behind a window-held build starts, and the build stays queued", async (t) => {
  let now = new Date("2026-10-26T18:00:00+05:30");
  const { deps, spawned, lines, writeQueue, queued } = setup(t, { now: () => now });
  // Two builds the window holds, a recheck that can't run any more, then one that can.
  writeQueue([["p-fail", "build"], ["p-redo", "build"], ["p-todo", "recheck"], ["p-await", "recheck"], ["p-approved", "build"]]);
  assert.equal((await startNextQueued({ campaign: CAMPAIGN, deps })).id, "p-await");
  assert.deepEqual(spawned.map((s) => s.args), [["creation/create.mjs", "recheck", "p-await", "--campaign", "test"]]);
  assert.deepEqual(queued(), [["p-fail", "build"], ["p-redo", "build"], ["p-approved", "build"]], "the builds keep their places");
  assert.deepEqual(lines.filter(([, msg]) => msg === "build queue: dropped").map(([, , data]) => data.id), ["p-todo"]);

  // Nothing but held builds left: nothing starts, nothing is dropped.
  assert.equal(await startNextQueued({ campaign: CAMPAIGN, deps }), null);
  assert.deepEqual(queued(), [["p-fail", "build"], ["p-redo", "build"], ["p-approved", "build"]]);

  // The window over, FIFO again from the head.
  now = new Date("2026-10-26T21:00:00+05:30");
  assert.equal((await startNextQueued({ campaign: CAMPAIGN, deps })).id, "p-fail");
});

test("startNextQueued: an entry no longer buildable is dropped and the next one starts", async (t) => {
  const { deps, spawned, lines, writeQueue, queued } = setup(t);
  // Approved, awaiting approval (not buildable), and gone from the build list.
  writeQueue([["p-approved", "build"], ["p-await", "build"], ["p-gone", "build"], ["p-todo", "recheck"], ["p-redo", "build"], ["p-fail", "build"]]);
  const started = await startNextQueued({ campaign: CAMPAIGN, deps });
  assert.equal(started.id, "p-redo");
  assert.deepEqual(spawned.map((s) => s.args), [["creation/create.mjs", "nightly", "--now", "--id", "p-redo", "--campaign", "test"]]);
  assert.deepEqual(queued(), [["p-fail", "build"]]);
  const dropped = lines.filter(([, msg]) => msg === "build queue: dropped").map(([level, , data]) => [level, data.id]);
  assert.deepEqual(dropped, [["info", "p-approved"], ["info", "p-await"], ["info", "p-gone"], ["info", "p-todo"]]);
});

test("startNextQueued: a failing save means no spawn; a spawn that throws puts the entry back at the head", async (t) => {
  const { home, deps, spawned, lines, writeQueue, queued } = setup(t);
  writeQueue([["p-fail", "build"], ["p-redo", "build"]]);
  // A folder where the temp file goes: the save fails.
  const tmp = path.join(home, "build-queue.json.tmp");
  fs.mkdirSync(tmp);
  await assert.rejects(startNextQueued({ campaign: CAMPAIGN, deps }));
  assert.equal(spawned.length, 0, "nothing started from a queue that still holds it");
  assert.deepEqual(queued(), [["p-fail", "build"], ["p-redo", "build"]]);
  fs.rmdirSync(tmp);

  // The spawn itself throws: the entry goes back first, then it is logged.
  let queuedWhenLogged;
  const log = {
    info: deps.log.info,
    error: (msg, data) => {
      queuedWhenLogged = queued();
      deps.log.error(msg, data);
    },
  };
  const throwing = { ...deps, log, spawn: () => { throw new Error("spawn EACCES"); } };
  assert.equal(await startNextQueued({ campaign: CAMPAIGN, deps: throwing }), null);
  assert.deepEqual(queued(), [["p-fail", "build"], ["p-redo", "build"]]);
  assert.deepEqual(queuedWhenLogged, [["p-fail", "build"], ["p-redo", "build"]], "restored before the log line");
  assert.ok(lines.some(([level, msg, data]) => level === "error" && msg === "build queue: didn't start" && data.id === "p-fail" && data.error === "spawn EACCES"), JSON.stringify(lines));
  assert.ok(!lines.some(([, msg]) => msg === "build queue: started p-fail"));

  // Behind builds the window holds, a throwing spawn puts the recheck back in its own place.
  const evening = { ...throwing, now: () => new Date("2026-10-26T18:00:00+05:30") };
  writeQueue([["p-fail", "build"], ["p-await", "recheck"], ["p-redo", "build"]]);
  assert.equal(await startNextQueued({ campaign: CAMPAIGN, deps: evening }), null);
  assert.deepEqual(queued(), [["p-fail", "build"], ["p-await", "recheck"], ["p-redo", "build"]]);
});

test("queue: requeueAtHead leaves a piece the race winner is building alone", async (t) => {
  const { deps, writeQueue, queued } = setup(t);
  const { store } = deps;
  writeQueue([["p-redo", "build"]]);
  // The same piece raced itself: the winner moved it to building.
  store.save({ items: { ...store.load().items, "p-fail": { status: "building", attempts: 1, at: AT } } });
  assert.equal(await requeueAtHead(deps, { kind: "build", id: "p-fail" }), false);
  assert.deepEqual(queued(), [["p-redo", "build"]]);
  // Once it isn't building (here: failed again), a lost race puts it back.
  store.save({ items: { ...store.load().items, "p-fail": { status: "failed", attempts: 1, at: AT } } });
  assert.equal(await requeueAtHead(deps, { kind: "build", id: "p-fail" }), true);
  assert.deepEqual(queued(), [["p-fail", "build"], ["p-redo", "build"]]);
});

test("queue: requeueAtHead puts a piece first, past the cap, and never twice", async (t) => {
  const { deps, writeQueue, queued } = setup(t);
  const ten = Array.from({ length: 10 }, (_, i) => [`q-${i}`, "build"]);
  writeQueue(ten);
  assert.equal(await requeueAtHead(deps, { kind: "recheck", id: "p-await" }), true);
  assert.deepEqual(queued(), [["p-await", "recheck"], ...ten]);
  assert.equal(await requeueAtHead(deps, { kind: "build", id: "q-5" }), false);
  assert.equal(queued().length, 11);
});

test("queue: readQueue keeps only well-formed entries", (t) => {
  const { home } = setup(t);
  const file = path.join(home, "build-queue.json");
  assert.deepEqual(readQueue(home), [], "no file");
  fs.writeFileSync(file, "");
  assert.deepEqual(readQueue(home), [], "an empty file");
  fs.writeFileSync(file, JSON.stringify([{ id: "p-fail", kind: "build", queuedAt: AT }, { id: "../x", kind: "build", queuedAt: AT }, { id: "p-redo", kind: "post", queuedAt: AT }]));
  assert.deepEqual(readQueue(home), [{ id: "p-fail", kind: "build", queuedAt: AT }]);
});

test("posting window: opens at slot − 160 minutes", () => {
  assert.equal(BUILD_STARTUP_MINUTES, 20);
  assert.equal(BUILD_VERIFY_MINUTES + BUILD_STARTUP_MINUTES, 160);
  // 19:30 − 160 minutes is 16:50.
  assert.equal(postingOverlap(CAMPAIGN, new Date("2026-10-26T16:49:00+05:30")), null);
  assert.deepEqual(postingOverlap(CAMPAIGN, new Date("2026-10-26T16:50:00+05:30")), { slot: "7:30 pm", until: "8:45 pm" });
  assert.deepEqual(postingOverlap(CAMPAIGN, new Date("2026-10-26T20:45:00+05:30")), { slot: "7:30 pm", until: "8:45 pm" });
  assert.equal(postingOverlap(CAMPAIGN, new Date("2026-10-26T20:46:00+05:30")), null);
});
