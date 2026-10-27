import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock } from "../../publishing/lib/lock.mjs";
import { createCreationStore, itemState } from "../../creation/lib/cstate.mjs";
import { formatSchedule } from "../../creation/lib/insert.mjs";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { readQueue } from "../../creation/lib/build-queue.mjs";
import { createCreationActions, creationDeps } from "../lib/creation-actions.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));

const SCHEDULE = "publishing/schedule.json";
const BUSY = "a build is running for Test Campaign; try again when it finishes";
const PIPELINE = path.join(os.tmpdir(), "pipeline-code");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const entry = (id, targetDate) => ({ id, kind: "ep", format: "episode", type: "story", title: id, premise: "A premise.", targetDate, hook: 21, reference: "ep-01-japan" });
const BACKLOG = [entry("ep-17-payday", "2026-11-12"), entry("ep-18-rain-holiday", "2026-11-17"), entry("ep-19-parked", "2026-11-20"), entry("ep-20-redo", "2026-11-21")];
const ORIGINAL = [{ id: "ep-01-japan", kind: "ep", dir: "pieces/ep-01-japan" }];
const AT = "2026-10-24T20:00:00.000Z";
// 10:00 IST, well before the posting window of CONFIG's 19:30 slot.
const MORNING = new Date("2026-10-26T10:00:00+05:30");
const CONFIG = {
  timezone: "Asia/Kolkata",
  slot: "19:30",
  lateLimitMinutes: 60,
  bufferMin: 3,
  fallbackDays: [],
  retryDelaySeconds: 60,
  platforms: { instagram: { enabled: true }, youtube: { enabled: false } },
};
const CAMPAIGN = { id: "test", name: "Test Campaign", lockName: (name) => `test:${name}`, config: CONFIG };

function fakeLog() {
  const lines = [];
  return { lines, info: (msg, data) => lines.push(["info", msg, data]), error: (msg, data) => lines.push(["error", msg, data]) };
}

// The approval fixture: a git repo with a schedule and postable pieces, a home whose
// build progress has ep-17 and ep-18 awaiting approval, ep-19 parked after two failed
// builds (no video) and ep-20 back for a redo. spawn records every call.
function setup({ lock, now = () => MORNING } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cactions-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cactions-home-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, ".gitignore", "out/\n");
  write(repo, SCHEDULE, formatSchedule(ORIGINAL));
  write(repo, "pieces/ep-01-japan/cues.js", "export default {};\n");
  for (const { id } of BACKLOG) {
    write(repo, `pieces/${id}/cues.js`, "export default {};\n");
    if (id === "ep-19-parked") continue;
    write(repo, `pieces/${id}/out/acme-${id}.mp4`, "video");
    write(repo, `pieces/${id}/out/acme-${id}-cover.png`, "png");
    write(repo, `pieces/${id}/out/acme-${id}-caption.txt`, "INSTAGRAM / TIKTOK\nCoffee, but colder.\n\nYOUTUBE SHORTS TITLE\nCold brew\n");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const store = createCreationStore(home);
  store.save({
    items: {
      "ep-17-payday": { status: "awaiting-approval", attempts: 0, at: AT },
      "ep-18-rain-holiday": { status: "failed", attempts: 1, reason: "checks failed", at: AT },
      "ep-19-parked": { status: "failed", attempts: 2, reason: "review said FIX twice", at: AT },
      "ep-20-redo": { status: "redo", attempts: 0, note: "slower", at: AT },
    },
  });
  const spawned = [];
  const spawn = (cmd, args, options) => {
    const child = { unrefed: false, unref() { this.unrefed = true; }, on() {} };
    spawned.push({ cmd, args, options, child });
    return child;
  };
  const locks = [];
  const deps = {
    home,
    repoRoot: repo,
    store,
    backlog: BACKLOG,
    scheduleFile: SCHEDULE,
    pieceDir: (id) => `pieces/${id}`,
    withLock: (name, fn, options) => {
      locks.push([name, options]);
      return (lock ?? ((n, f, o) => withLock(home, `test:${n}`, f, o)))(name, fn, options);
    },
    log: fakeLog(),
    spawn,
    pipelineRoot: PIPELINE,
    lockHome: home,
    now,
  };
  return { repo, home, store, deps, spawned, locks, actions: createCreationActions({ campaign: CAMPAIGN, deps }), commits: () => git(repo, "log", "--format=%s").split("\n") };
}

test("creation actions: approve from the console inserts into the schedule and commits \"content: approve <id>\"", async () => {
  const { repo, store, deps, locks, actions, commits } = setup();
  const res = await actions.approve({ id: "ep-17-payday" });
  assert.equal(res.ok, true, res.error);
  assert.match(res.message, /Approved ep-17-payday/);
  assert.deepEqual(commits(), ["content: approve ep-17-payday", "init"]);
  assert.equal(git(repo, "log", "-1", "--format=%B"), "content: approve ep-17-payday", "no attribution lines");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, SCHEDULE), "utf8")).map((i) => [i.id, i.dir]), [
    ["ep-01-japan", "pieces/ep-01-japan"],
    ["ep-17-payday", "pieces/ep-17-payday"],
  ]);
  assert.equal(itemState(store.load(), "ep-17-payday").status, "approved");
  assert.deepEqual(locks.map(([name, options]) => [name, options.waitMs]), [["schedule", 3000], ["creation-state", 3000]]);
  assert.deepEqual(deps.log.lines.map(([level, msg, data]) => [level, msg, data.id, data.ok]), [["info", "dashboard approve", "ep-17-payday", true]]);

  // Not awaiting approval: refused with the reason, as { ok: false, error }.
  const again = await actions.approve({ id: "ep-17-payday" });
  assert.deepEqual(again, { ok: false, error: "ep-17-payday is approved, not awaiting approval" });
  assert.equal(deps.log.lines.at(-1)[0], "error");
});

test("creation actions: approve while a build holds the schedule lock is the build-running refusal", async () => {
  const busy = async (name) => {
    throw new Error(`lock test:${name} busy`);
  };
  const { actions, commits, store } = setup({ lock: busy });
  assert.deepEqual(await actions.approve({ id: "ep-17-payday" }), { ok: false, error: BUSY });
  assert.deepEqual(commits(), ["init"]);
  assert.equal(itemState(store.load(), "ep-17-payday").status, "awaiting-approval");
});

test("creation actions: redo with a note sends the piece back; an empty note is refused", async () => {
  const { store, deps, actions } = setup();
  const empty = await actions.redo({ id: "ep-17-payday", note: "   " });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /note/);
  const res = await actions.redo({ id: "ep-17-payday", note: "Make the hook shorter." });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(itemState(store.load(), "ep-17-payday").note, "Make the hook shorter.");
  assert.equal(itemState(store.load(), "ep-17-payday").status, "redo");
  assert.ok(deps.log.lines.some(([level, msg, data]) => level === "info" && msg === "dashboard redo" && data.id === "ep-17-payday"));
});

const holdCreation = (home, content = { pid: process.pid, at: new Date().toISOString() }) => write(home, "locks/test.creation.lock", JSON.stringify(content));
const queueOf = (home) => readQueue(home).map((e) => [e.id, e.kind]);
const RUNNING = (nth) => `Queued: starts when the current build finishes (${nth} in line).`;

test("queue: buildNow while a build runs enqueues and returns position 1, then 2 for another piece", async () => {
  const { deps, spawned, actions } = setup();
  holdCreation(deps.home);
  assert.deepEqual(await actions.buildNow({ id: "ep-18-rain-holiday" }), { ok: true, queued: true, position: 1, message: RUNNING("1st") });
  assert.deepEqual(await actions.buildNow({ id: "ep-20-redo" }), { ok: true, queued: true, position: 2, message: RUNNING("2nd") });
  // A recheck waits in the same line.
  assert.deepEqual(await actions.recheck({ id: "ep-17-payday" }), { ok: true, queued: true, position: 3, message: RUNNING("3rd") });
  assert.equal(spawned.length, 0);
  assert.deepEqual(queueOf(deps.home), [["ep-18-rain-holiday", "build"], ["ep-20-redo", "build"], ["ep-17-payday", "recheck"]]);
  for (const { queuedAt } of readQueue(deps.home)) assert.ok(!Number.isNaN(Date.parse(queuedAt)), queuedAt);
  assert.ok(deps.log.lines.some(([level, msg, data]) => level === "info" && msg === "dashboard buildNow" && data.queued === true && data.position === 2));

  // An invalid request is still refused, build running or not; nothing is queued for it.
  assert.match((await actions.buildNow({ id: "ep-19-parked" })).error, /failed 2 times/);
  assert.match((await actions.buildNow({ id: "ep-99-unknown" })).error, /not in the build list/);
  assert.match((await actions.recheck({ id: "ep-19-parked" })).error, /no video/);
  assert.equal(readQueue(deps.home).length, 3);
});

test("queue: the same piece twice keeps one entry and returns its position", async () => {
  const { deps, actions } = setup();
  holdCreation(deps.home);
  await actions.buildNow({ id: "ep-20-redo" });
  await actions.buildNow({ id: "ep-18-rain-holiday" });
  assert.deepEqual(await actions.buildNow({ id: "ep-18-rain-holiday" }), { ok: true, queued: true, position: 2, message: RUNNING("2nd") });
  assert.deepEqual(await actions.recheck({ id: "ep-18-rain-holiday" }), { ok: true, queued: true, position: 2, message: RUNNING("2nd") });
  assert.deepEqual(queueOf(deps.home), [["ep-20-redo", "build"], ["ep-18-rain-holiday", "build"]]);
});

test("queue: buildNow inside the posting window enqueues with the \"after today's post\" message (injected now)", async () => {
  // CONFIG: a 19:30 IST slot with a 60-minute late limit, so builds wait from 16:50 to 20:45.
  const message = "Queued: starts after today's 7:30 pm post window (about 8:45 pm).";
  const cases = [["16:49", false], ["16:50", true], ["19:30", true], ["20:45", true], ["20:46", false], ["23:59", false]];
  for (const [hhmm, waits] of cases) {
    const { deps, spawned, actions } = setup({ now: () => new Date(`2026-10-26T${hhmm}:00+05:30`) });
    if (waits) {
      const res = await actions.buildNow({ id: "ep-18-rain-holiday" });
      assert.deepEqual(res, { ok: true, queued: true, position: 1, message }, hhmm);
      assert.equal(spawned.length, 0, hhmm);
      // A recheck runs no session: neither the window nor the build it holds holds it.
      const recheck = await actions.recheck({ id: "ep-17-payday" });
      assert.equal(recheck.started, true, `${hhmm}: ${recheck.error ?? recheck.message}`);
      assert.deepEqual(queueOf(deps.home), [["ep-18-rain-holiday", "build"]], `${hhmm}: the build stays queued`);
    } else {
      const res = await actions.buildNow({ id: "ep-18-rain-holiday" });
      assert.equal(res.started, true, `${hhmm}: ${res.error ?? res.message}`);
    }
  }

  // A build running too: both reasons.
  const { deps, actions } = setup({ now: () => new Date("2026-10-26T18:00:00+05:30") });
  holdCreation(deps.home);
  assert.deepEqual(await actions.buildNow({ id: "ep-18-rain-holiday" }), {
    ok: true,
    queued: true,
    position: 1,
    message: "Queued: starts after the current build and today's 7:30 pm post window.",
  });
  // Only the running build holds a recheck.
  assert.deepEqual(await actions.recheck({ id: "ep-17-payday" }), { ok: true, queued: true, position: 2, message: RUNNING("2nd") });
});

test("queue: at most 10 entries; the 11th is refused with a clear message", async () => {
  const { deps, spawned } = setup();
  holdCreation(deps.home);
  const ideas = Array.from({ length: 11 }, (_, i) => entry(`idea-${String(i + 1).padStart(2, "0")}`, "2026-12-01"));
  const actions = createCreationActions({ campaign: CAMPAIGN, deps: { ...deps, backlog: ideas } });
  for (const [i, { id }] of ideas.slice(0, 10).entries()) assert.equal((await actions.buildNow({ id })).position, i + 1, id);
  assert.deepEqual(await actions.buildNow({ id: "idea-11" }), { ok: false, error: "the build queue is full (10 pieces); remove one or try again when one has started" });
  assert.equal(readQueue(deps.home).length, 10);
  // One already in the line still gets its place.
  assert.equal((await actions.buildNow({ id: "idea-04" })).position, 4);
  assert.equal(spawned.length, 0);
});

test("queue: unqueue removes an entry; unqueue of an id not queued is refused", async () => {
  const { deps, store, actions } = setup();
  holdCreation(deps.home);
  await actions.buildNow({ id: "ep-18-rain-holiday" });
  await actions.buildNow({ id: "ep-20-redo" });
  assert.deepEqual(await actions.unqueue({ id: "ep-18-rain-holiday" }), { ok: true, message: "Took ep-18-rain-holiday out of the build queue." });
  assert.deepEqual(queueOf(deps.home), [["ep-20-redo", "build"]]);
  assert.deepEqual(await actions.unqueue({ id: "ep-18-rain-holiday" }), { ok: false, error: "ep-18-rain-holiday isn't in the build queue" });
  assert.ok(deps.log.lines.some(([level, msg, data]) => level === "info" && msg === "dashboard unqueue" && data.id === "ep-18-rain-holiday"));

  // Once it builds, it's the build's: the queue entry stays for the queue to drop.
  store.save({ items: { ...store.load().items, "ep-20-redo": { status: "building", attempts: 0, at: AT } } });
  assert.deepEqual(await actions.unqueue({ id: "ep-20-redo" }), { ok: false, error: "ep-20-redo is building already" });
  assert.deepEqual(queueOf(deps.home), [["ep-20-redo", "build"]]);

  // The queue's lock busy is refused within the wait, not hung.
  const busy = async (name) => {
    throw new Error(`lock test:${name} busy`);
  };
  const locked = setup({ lock: busy });
  assert.deepEqual(await locked.actions.unqueue({ id: "ep-20-redo" }), { ok: false, error: "the build queue is busy; try again in a moment" });
});

test("queue: a corrupt queue file reads as empty and doesn't throw", async () => {
  const { deps, actions } = setup();
  write(deps.home, "build-queue.json", "{ not json");
  assert.deepEqual(readQueue(deps.home, deps.log), []);
  assert.ok(deps.log.lines.some(([level, msg]) => level === "error" && msg === "build queue unreadable; treated as empty"), JSON.stringify(deps.log.lines));
  for (const bad of ["", "{}", "[1, 2]", "null"]) {
    write(deps.home, "build-queue.json", bad);
    assert.deepEqual(readQueue(deps.home), [], JSON.stringify(bad));
  }
  write(deps.home, "build-queue.json", "{ not json");
  holdCreation(deps.home);
  assert.deepEqual(await actions.buildNow({ id: "ep-18-rain-holiday" }), { ok: true, queued: true, position: 1, message: RUNNING("1st") });
  assert.deepEqual(queueOf(deps.home), [["ep-18-rain-holiday", "build"]], "rewritten whole");
  assert.deepEqual(await actions.unqueue({ id: "ep-20-redo" }), { ok: false, error: "ep-20-redo isn't in the build queue" });
});

test("buildNow: a crashed build's lock doesn't block, whether its process is gone or it is 25 h old", async () => {
  const { deps, spawned } = setup();
  const lock = (content) => write(deps.home, "locks/test.creation.lock", JSON.stringify(content));
  const actions = createCreationActions({ campaign: CAMPAIGN, deps: { ...deps, alive: (pid) => pid !== 4242 } });

  lock({ pid: 4242, at: new Date().toISOString() });
  assert.equal((await actions.buildNow({ id: "ep-18-rain-holiday" })).ok, true, "its process is gone");
  assert.equal((await actions.recheck({ id: "ep-18-rain-holiday" })).ok, true);

  lock({ pid: process.pid, at: new Date(Date.now() - 25 * 3600000).toISOString() });
  assert.equal((await actions.buildNow({ id: "ep-20-redo" })).ok, true, "older than the nightly run's 24 h staleMs");

  // An older lock with no pid goes by its age alone: the build waits in the queue.
  lock({ at: new Date().toISOString() });
  assert.deepEqual(await actions.buildNow({ id: "ep-20-redo" }), { ok: true, queued: true, position: 1, message: RUNNING("1st") });
  assert.equal(spawned.length, 3);
});

test("buildNow: a slot just after midnight makes the evening before its window", async () => {
  const campaign = { ...CAMPAIGN, config: { ...CONFIG, slot: "00:30", lateLimitMinutes: 30 } };
  const { deps } = setup();
  const at = (iso) => createCreationActions({ campaign, deps: { ...deps, now: () => new Date(iso) } });
  assert.deepEqual(await at("2026-10-26T23:00:00+05:30").buildNow({ id: "ep-18-rain-holiday" }), {
    ok: true,
    queued: true,
    position: 1,
    message: "Queued: starts after today's 12:30 am post window (about 1:15 am).",
  });
  // Out of the window it's the queue's head, so it starts at once and leaves the queue.
  assert.equal((await at("2026-10-26T21:00:00+05:30").buildNow({ id: "ep-18-rain-holiday" })).started, true);
  assert.deepEqual(queueOf(deps.home), []);
});

test("queue: a request of the other kind for a queued piece keeps the queued entry", async () => {
  const { deps, spawned, actions } = setup();
  write(deps.home, "build-queue.json", JSON.stringify([{ id: "ep-18-rain-holiday", kind: "build", queuedAt: AT }]));
  // A stale screen's Recheck of the queued build: it's the head, nothing runs, but it
  // isn't the head's kind, so the build keeps its entry and nothing starts.
  assert.deepEqual(await actions.recheck({ id: "ep-18-rain-holiday" }), {
    ok: true,
    queued: true,
    position: 1,
    message: "Queued: next in line; starts within a minute.",
  });
  assert.equal(spawned.length, 0);
  assert.deepEqual(queueOf(deps.home), [["ep-18-rain-holiday", "build"]]);
  // The head's own kind still starts at once.
  assert.equal((await actions.buildNow({ id: "ep-18-rain-holiday" })).started, true);
  assert.deepEqual(spawned.map((s) => s.args[1]), ["nightly"]);
  assert.deepEqual(queueOf(deps.home), []);
});

test("queue: a recheck behind builds the window holds starts, or waits only for the running build", async () => {
  const { deps, spawned, actions } = setup({ now: () => new Date("2026-10-26T18:00:00+05:30") });
  write(deps.home, "build-queue.json", JSON.stringify([
    { id: "ep-20-redo", kind: "build", queuedAt: AT },
    { id: "ep-17-payday", kind: "recheck", queuedAt: AT },
  ]));
  // Queued itself, behind a held build only: it starts and leaves the queue.
  assert.equal((await actions.recheck({ id: "ep-17-payday" })).started, true);
  assert.deepEqual(queueOf(deps.home), [["ep-20-redo", "build"]]);
  // A build running: it waits for that, not for the evening.
  holdCreation(deps.home);
  assert.deepEqual(await actions.recheck({ id: "ep-18-rain-holiday" }), { ok: true, queued: true, position: 2, message: RUNNING("2nd") });
  assert.equal(spawned.length, 1);
});

test("queue: with one entry queued and no build running, Build now on another piece enqueues it at position 2", async () => {
  const { deps, spawned, actions } = setup();
  write(deps.home, "build-queue.json", JSON.stringify([{ id: "ep-20-redo", kind: "build", queuedAt: AT }]));
  const waiting = "Queued: starts after the pieces queued before it (2nd in line).";
  assert.deepEqual(await actions.buildNow({ id: "ep-18-rain-holiday" }), { ok: true, queued: true, position: 2, message: waiting });
  // A recheck keeps the line too.
  assert.deepEqual(await actions.recheck({ id: "ep-17-payday" }), {
    ok: true,
    queued: true,
    position: 3,
    message: "Queued: starts after the pieces queued before it (3rd in line).",
  });
  assert.equal(spawned.length, 0);
  assert.deepEqual(queueOf(deps.home), [["ep-20-redo", "build"], ["ep-18-rain-holiday", "build"], ["ep-17-payday", "recheck"]]);

  // The head itself may start: it leaves the queue first, then spawns.
  let queuedAtSpawn;
  const head = createCreationActions({
    campaign: CAMPAIGN,
    deps: {
      ...deps,
      spawn: (...args) => {
        queuedAtSpawn = queueOf(deps.home);
        return deps.spawn(...args);
      },
    },
  });
  assert.equal((await head.buildNow({ id: "ep-20-redo" })).started, true);
  assert.deepEqual(queuedAtSpawn, [["ep-18-rain-holiday", "build"], ["ep-17-payday", "recheck"]], "saved before the spawn");
  assert.deepEqual(spawned.map((s) => s.args[4]), ["ep-20-redo"]);

  // A spawn that throws puts the queue back as it was.
  const broken = createCreationActions({ campaign: CAMPAIGN, deps: { ...deps, spawn: () => { throw new Error("spawn EACCES"); } } });
  assert.deepEqual(await broken.buildNow({ id: "ep-18-rain-holiday" }), { ok: false, error: "spawn EACCES" });
  assert.deepEqual(queueOf(deps.home), [["ep-18-rain-holiday", "build"], ["ep-17-payday", "recheck"]]);
});

test("buildNow: spawn gets exactly the args above, detached", async () => {
  const { spawned, actions, deps } = setup();
  const res = await actions.buildNow({ id: "ep-18-rain-holiday" });
  assert.equal(res.ok, true);
  assert.equal(res.started, true);
  assert.equal(spawned.length, 1);
  const [{ cmd, args, options, child }] = spawned;
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ["creation/create.mjs", "nightly", "--now", "--id", "ep-18-rain-holiday", "--campaign", "test"]);
  assert.deepEqual(options, { cwd: PIPELINE, detached: true, windowsHide: true, stdio: "ignore" });
  assert.equal(child.unrefed, true);
  assert.ok(deps.log.lines.some(([level, msg, data]) => level === "info" && msg === "dashboard buildNow" && data.id === "ep-18-rain-holiday"));

  // A redo piece builds too.
  assert.equal((await actions.buildNow({ id: "ep-20-redo" })).ok, true);
  assert.equal(spawned.length, 2);
});

test("buildNow: a piece the nightly run wouldn't build is refused with why; spawn not called", async () => {
  const { spawned, actions } = setup();
  const parked = await actions.buildNow({ id: "ep-19-parked" });
  assert.equal(parked.ok, false);
  assert.match(parked.error, /ep-19-parked failed 2 times; redo it with a note/);
  const awaiting = await actions.buildNow({ id: "ep-17-payday" });
  assert.equal(awaiting.ok, false);
  assert.match(awaiting.error, /ep-17-payday can't be built now \(awaiting-approval\)/);
  assert.match((await actions.buildNow({ id: "ep-99-unknown" })).error, /not in the build list/);
  assert.equal(spawned.length, 0);
});

test("buildNow: a parked piece redone with a note builds by hand, as the UI offers", async () => {
  const { spawned, actions, store } = setup();
  assert.equal((await actions.redo({ id: "ep-19-parked", note: "Move the captions down." })).ok, true);
  assert.equal(itemState(store.load(), "ep-19-parked").attempts, 2);
  const res = await actions.buildNow({ id: "ep-19-parked" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(spawned.map((s) => s.args), [["creation/create.mjs", "nightly", "--now", "--id", "ep-19-parked", "--campaign", "test"]]);
});

test("creation actions: the audit log is scrubbed, a redo note included", async () => {
  const SECRET = "IGQVJ-fixture-secret-456";
  const { deps } = setup();
  const actions = createCreationActions({ campaign: CAMPAIGN, deps: { ...deps, secretValues: [SECRET] } });
  assert.equal((await actions.redo({ id: "ep-17-payday", note: `Use the token ${SECRET} in the end card.` })).ok, true);
  assert.equal((await actions.approve({ id: `${SECRET}` })).ok, false);
  const logged = JSON.stringify(deps.log.lines);
  assert.ok(!logged.includes(SECRET), logged);
  const [, msg, data] = deps.log.lines[0];
  assert.equal(msg, "dashboard redo");
  assert.equal(data.note, "Use the token [redacted] in the end card.");
});

test("recheck: spawns the CLI's recheck for a failed piece with a video; a redo piece or one without a video is refused", async () => {
  const { spawned, actions } = setup();
  const res = await actions.recheck({ id: "ep-18-rain-holiday" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.started, true);
  assert.deepEqual(
    spawned.map((s) => [s.cmd, s.args, s.options]),
    [[process.execPath, ["creation/create.mjs", "recheck", "ep-18-rain-holiday", "--campaign", "test"], { cwd: PIPELINE, detached: true, windowsHide: true, stdio: "ignore" }]],
  );
  assert.match((await actions.recheck({ id: "ep-20-redo" })).error, /ep-20-redo is redo/);
  assert.match((await actions.recheck({ id: "ep-19-parked" })).error, /no video/);
  assert.equal(spawned.length, 1);
});

test("creation actions: creationDeps looks for the campaign's creation lock in the publisher home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cactions-campaigns-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cactions-publisher-"));
  const campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cactions-campaign-"));
  fs.mkdirSync(path.join(root, "beta"));
  fs.writeFileSync(path.join(root, "beta", "campaign.json"), JSON.stringify({ id: "beta", name: "Beta", root: campaignRoot }));
  const campaign = getCampaign("beta", { root, home });
  const deps = creationDeps({ campaign, secrets: createSecrets(home) });
  assert.equal(deps.lockHome, home);
  assert.equal(deps.pipelineRoot, path.resolve(import.meta.dirname, "..", ".."));
  assert.equal(deps.repoRoot, campaignRoot);
});
