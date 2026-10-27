import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock } from "../../publishing/lib/lock.mjs";
import { createCreationStore, itemState } from "../lib/cstate.mjs";
import { approvalCaption, runNightly, runRecheck } from "../lib/nightly.mjs";

const NOW = new Date("2026-10-24T20:30:00Z"); // 02:00 IST on Sun 25 Oct

function entry(id, targetDate, over = {}) {
  return {
    id,
    kind: id.startsWith("post") ? "post" : "ep",
    format: "episode",
    type: "story",
    title: `Title of ${id}`,
    premise: "A premise.",
    targetDate,
    hook: 21,
    reference: "reel-00-intro",
    ...over,
  };
}

const BACKLOG = [
  entry("reel-01-launch", "2026-11-12"),
  entry("reel-02-menu", "2026-11-17"),
  entry("reel-03-winter", "2026-12-02"),
];

const CAPTION = "Launch day: the first cup from the new roaster.\n\nSave this for your next visit.\n\n#coffee #acmecoffee #launch";

const SHIP = {
  verdict: "SHIP",
  scores: { director: 82, copy_art_ui: 78, brand: 90, forensics: 85 },
  skills: {
    caption_py: "READY",
    detect_caption: { verdict: "PASS", human_score: 91 },
    detect_onscreen: { verdict: "PASS", human_score: 88 },
    hook_caption: { verdict: "STRONG", score: 84, weakest: "specificity" },
    hook_onscreen: { verdict: "OK", score: 66, weakest: "curiosity" },
  },
  must_fix: [],
  nice_to_have: [],
  summary: "The launch lands; ship it.",
};

const fix = (...must_fix) => ({ ...SHIP, verdict: "FIX", must_fix, summary: "Needs work." });

// Every dependency faked. Each fake records its call in `calls` as [name, args].
// `script` overrides a fake per id: script.runReview["reel-01-launch"] = [FIX, SHIP]
// returns those in turn.
function setup(t, { backlog = BACKLOG, items = {}, script = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repoRoot = path.join(home, "repo");
  const store = createCreationStore(home);
  store.save({ items });

  const calls = [];
  const sent = [];
  const record = (name, args) => calls.push([name, args]);
  const next = (name, id, fallback) => {
    const list = script[name]?.[id];
    if (!list) return fallback;
    const value = list.length > 1 ? list.shift() : list[0];
    return typeof value === "function" ? value() : value;
  };
  let heads = 0;

  // The approvers' chat, and the owner chat the alerts and the summary go to.
  const telegram = {
    sendMessage: async (text, options) => void sent.push(["sendMessage", text, options]),
    sendVideo: async (args) => void sent.push(["sendVideo", args]),
  };
  const alerts = { sendMessage: async (text) => void sent.push(["alert", text]) };

  const deps = {
    name: "Acme Coffee",
    home,
    repoRoot,
    store,
    telegram,
    alerts,
    backlog,
    brief: "BRIEF",
    references: "REFS",
    pieceDir: (id) => `pieces/${id}`,
    lock: { pollMs: 1, waitMs: 50 },
    snapshot: (args) => {
      record("snapshot", args);
      return { head: `head-${++heads}`, homeHashes: {}, dirty: {} };
    },
    buildPrompt: (args) => {
      record("buildPrompt", args);
      return `prompt for ${args.entry.id}${args.redoNote ? ` / note: ${args.redoNote}` : ""}`;
    },
    runSession: async (args) => {
      record("runSession", args);
      const id = /prompt for (\S+)/.exec(args.prompt)[1];
      return next("runSession", id, { code: 0, output: "done", timedOut: false });
    },
    verifySession: (args) => {
      record("verifySession", args);
      return next("verifySession", args.entryId, { ok: true, violations: [], changed: [`pieces/${args.entryId}/cues.js`] });
    },
    revertSession: (args) => record("revertSession", args),
    runChecks: async (args) => {
      record("runChecks", args);
      return next("runChecks", args.entry.id, { ok: true, failures: [], scores: {}, raw: { caption: { verdict: "READY" } } });
    },
    runReview: async (args) => {
      record("runReview", args);
      return next("runReview", args.entryId, SHIP);
    },
    checkItem: (root, item) => ({
      ok: true,
      assets: { video: path.join(root, item.dir, "out", `${item.id}.mp4`) },
      caption: { instagram: next("caption", item.id, CAPTION), youtubeTitle: "Launch day #shorts" },
      warnings: [],
    }),
  };
  const named = (name) => calls.filter(([n]) => n === name).map(([, args]) => args);
  // Every text message, to the approvers or the owner, in order.
  const messages = () => sent.filter(([kind]) => kind === "sendMessage" || kind === "alert").map(([, text]) => text);
  return { home, repoRoot, store, deps, calls, named, sent, messages };
}

const status = (store, id) => itemState(store.load(), id).status;

test("happy path sends video and marks awaiting", async (t) => {
  const { store, deps, named, sent, messages, repoRoot, home } = setup(t);
  const result = await runNightly({ now: NOW, deps });

  assert.deepEqual(result, { built: ["reel-01-launch", "reel-02-menu"], failed: [] });
  assert.equal(status(store, "reel-01-launch"), "awaiting-approval");
  assert.equal(status(store, "reel-02-menu"), "awaiting-approval");
  assert.equal(status(store, "reel-03-winter"), "todo", "two builds a night by default");

  const [prompt] = named("buildPrompt");
  assert.deepEqual(prompt, { entry: BACKLOG[0], brief: "BRIEF", references: "REFS", redoNote: undefined });
  assert.deepEqual(named("runSession")[0], { prompt: "prompt for reel-01-launch", cwd: repoRoot });
  assert.deepEqual(named("snapshot")[0], { repoRoot, home });
  assert.deepEqual(named("verifySession")[0], { repoRoot, home, before: { head: "head-1", homeHashes: {}, dirty: {} }, entryId: "reel-01-launch" });
  assert.equal(named("runChecks")[0].entry, BACKLOG[0]);
  assert.deepEqual(named("runReview")[0], { entryId: "reel-01-launch", cwd: repoRoot, raw: { caption: { verdict: "READY" } } });
  assert.equal(named("revertSession").length, 0);

  const videos = sent.filter(([kind]) => kind === "sendVideo").map(([, args]) => args);
  assert.equal(videos.length, 2);
  const [video] = videos;
  assert.equal(video.path, path.join(repoRoot, "pieces/reel-01-launch", "out", "reel-01-launch.mp4"));
  assert.deepEqual(video.keyboard, [[
    { text: "Approve", callback_data: "approve:reel-01-launch" },
    { text: "Redo", callback_data: "redo:reel-01-launch" },
  ]]);
  assert.ok(video.caption.length <= 1024);
  for (const part of ["Title of reel-01-launch", "Thu 12 Nov", "The launch lands; ship it.", "82", "78", "90", "85",
    "READY", "PASS 91", "STRONG 84", "Launch day: the first cup from the new roaster.", "#coffee #acmecoffee #launch", "Launch day #shorts"]) {
    assert.ok(video.caption.includes(part), `caption shows ${part}:\n${video.caption}`);
  }

  // A short caption fits: no follow-up, just the summary at the end.
  const texts = messages();
  assert.equal(texts.length, 1);
  const summary = texts[0];
  assert.match(summary, /^Acme Coffee builds · Sun 25 Oct\n/);
  assert.match(summary, /reel-01-launch/);
  assert.match(summary, /reel-02-menu/);
  assert.match(summary, /Awaiting approval: 2 · Left to build: 1$/);
  assert.deepEqual(sent.at(-1), ["alert", summary], "the summary comes last, to the owner chat");
});

test("a caption that doesn't fit shows its first line and follows in its own message", async (t) => {
  const long = `First line that hooks.\n\n${"A long body line about the roaster. ".repeat(40)}\n\n#coffee #acmecoffee #launch`;
  const { deps, sent } = setup(t, { backlog: [BACKLOG[0]], script: { caption: { "reel-01-launch": [long] } } });
  await runNightly({ now: NOW, deps });

  const [[, video], [kind, followUp]] = sent;
  assert.ok(video.caption.length <= 1024);
  assert.ok(video.caption.includes("First line that hooks."));
  assert.ok(!video.caption.includes("A long body line"));
  assert.equal(kind, "sendMessage");
  assert.ok(followUp.includes(long), "the follow-up has the full caption");
  assert.ok(followUp.includes("Launch day #shorts"));
});

test("approvalCaption cuts a long summary rather than the caption's first line", () => {
  const { caption, followUp } = approvalCaption({
    entry: BACKLOG[0],
    review: { ...SHIP, summary: "word ".repeat(400) },
    caption: { instagram: CAPTION, youtubeTitle: "Launch day #shorts" },
  });
  assert.ok(caption.length <= 1024);
  assert.ok(caption.includes("Launch day: the first cup from the new roaster."));
  assert.ok(caption.includes("Thu 12 Nov"));
  assert.ok(followUp.includes(CAPTION));
});

test("review FIX triggers one fix round, then SHIP sends", async (t) => {
  const { store, deps, named, sent } = setup(t, {
    backlog: [BACKLOG[0]],
    items: { "reel-01-launch": { status: "redo", attempts: 0, note: "Make the price card bigger.", at: "x" } },
    script: { runReview: { "reel-01-launch": [fix("End card is clipped at 0:24"), SHIP] } },
  });
  const result = await runNightly({ now: NOW, deps });

  assert.deepEqual(result, { built: ["reel-01-launch"], failed: [] });
  assert.equal(status(store, "reel-01-launch"), "awaiting-approval");
  const prompts = named("buildPrompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].redoNote, "Make the price card bigger.", "the user's note goes into the first build");
  assert.match(prompts[1].redoNote, /End card is clipped at 0:24/);
  assert.match(prompts[1].redoNote, /Make the price card bigger\./, "the user's note still applies in the fix round");
  assert.equal(named("runSession").length, 2);
  assert.equal(named("snapshot").length, 2);
  assert.equal(named("verifySession")[1].before.head, "head-2", "the fix round is verified against its own snapshot");
  assert.equal(named("runChecks").length, 2);
  assert.equal(named("runReview").length, 2);
  assert.equal(sent.filter(([kind]) => kind === "sendVideo").length, 1);
});

test("two FIX verdicts mark failed with must_fix in the summary", async (t) => {
  const { store, deps, sent, messages } = setup(t, {
    backlog: [BACKLOG[0]],
    script: { runReview: { "reel-01-launch": [fix("Hook is a label"), fix("Hook is still a label", "Voiceover at 0:12 misreads the menu")] } },
  });
  const result = await runNightly({ now: NOW, deps });

  assert.deepEqual(result.built, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "reel-01-launch");
  assert.match(result.failed[0].reason, /Hook is still a label/);
  const state = itemState(store.load(), "reel-01-launch");
  assert.equal(state.status, "failed");
  assert.equal(state.attempts, 1);
  assert.match(state.reason, /Voiceover at 0:12 misreads the menu/);
  assert.equal(sent.filter(([kind]) => kind === "sendVideo").length, 0);
  const summary = messages().at(-1);
  assert.match(summary, /Hook is still a label/);
  assert.match(summary, /Voiceover at 0:12 misreads the menu/);
});

test("violation reverts and alerts", async (t) => {
  const violations = ["changed outside pieces/reel-01-launch/: schedule.json"];
  const { store, deps, named, messages, repoRoot } = setup(t, {
    backlog: [BACKLOG[0]],
    script: { verifySession: { "reel-01-launch": [{ ok: false, violations, changed: ["schedule.json"] }] } },
  });
  const result = await runNightly({ now: NOW, deps });

  assert.deepEqual(named("revertSession"), [{ repoRoot, before: { head: "head-1", homeHashes: {}, dirty: {} }, entryId: "reel-01-launch" }]);
  assert.equal(named("runChecks").length, 0);
  assert.equal(named("runReview").length, 0);
  assert.equal(status(store, "reel-01-launch"), "failed");
  assert.match(itemState(store.load(), "reel-01-launch").reason, /schedule\.json/);
  assert.equal(result.failed[0].id, "reel-01-launch");
  const alert = messages().find((m) => /revert/i.test(m) && m !== messages().at(-1));
  assert.ok(alert, `an alert before the summary: ${messages().join("\n---\n")}`);
  assert.match(alert, /schedule\.json/);
});

test("check failure marks failed with reasons", async (t) => {
  const failures = ["detect.py: REVIEW (human score 61, needs PASS)", 'guardrail (brands): "globex" in the caption'];
  const { store, deps, named, messages } = setup(t, {
    backlog: [BACKLOG[0]],
    script: { runChecks: { "reel-01-launch": [{ ok: false, failures, scores: {}, raw: {} }] } },
  });
  const result = await runNightly({ now: NOW, deps });

  assert.equal(named("runReview").length, 0);
  assert.equal(status(store, "reel-01-launch"), "failed");
  const { reason } = itemState(store.load(), "reel-01-launch");
  assert.match(reason, /detect\.py: REVIEW/);
  assert.match(reason, /globex/);
  assert.deepEqual(result.failed, [{ id: "reel-01-launch", reason }]);
  assert.match(messages().at(-1), /globex/);
});

test("a failed session does not stop the next piece", async (t) => {
  const { store, deps, named, sent } = setup(t, {
    script: { runSession: { "reel-01-launch": [{ code: null, output: "partial", timedOut: true }] } },
  });
  const result = await runNightly({ now: NOW, deps });

  assert.deepEqual(result.built, ["reel-02-menu"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "reel-01-launch");
  assert.match(result.failed[0].reason, /timed out/);
  assert.equal(status(store, "reel-01-launch"), "failed");
  assert.equal(status(store, "reel-02-menu"), "awaiting-approval");
  assert.equal(named("verifySession")[0].entryId, "reel-01-launch", "a failed session is still verified");
  assert.equal(named("runChecks").map((a) => a.entry.id).join(), "reel-02-menu");
  assert.equal(sent.filter(([kind]) => kind === "sendVideo").length, 1);
});

test("a non-zero exit fails the piece with the session's last line", async (t) => {
  const { store, deps } = setup(t, {
    backlog: [BACKLOG[0]],
    script: { runSession: { "reel-01-launch": [{ code: 1, output: "working\nusage limit reached\n", timedOut: false }] } },
  });
  const result = await runNightly({ now: NOW, deps });
  assert.match(result.failed[0].reason, /exited 1.*usage limit reached/);
  assert.equal(status(store, "reel-01-launch"), "failed");
});

test("the move to building removes the piece's last checks and review files, so they always belong to the current attempt", async (t) => {
  const { store, deps, repoRoot, named } = setup(t, {
    backlog: [BACKLOG[0], BACKLOG[1]],
    items: { "reel-01-launch": { status: "failed", attempts: 1, reason: "review said FIX", at: "x" } },
    script: { runSession: { "reel-01-launch": [{ code: 1, output: "render failed\n", timedOut: false }] } },
  });
  const files = (id) => [path.join(repoRoot, "creation-out", `${id}.checks.json`), path.join(repoRoot, "creation-out", `${id}.review.json`)];
  for (const file of [...files("reel-01-launch"), ...files("reel-03-winter")]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
  }
  const result = await runNightly({ now: NOW, onlyId: "reel-01-launch", deps });
  assert.match(result.failed[0].reason, /exited 1/, "the attempt stopped before its review");
  for (const file of files("reel-01-launch")) assert.equal(fs.existsSync(file), false, `${file} removed`);
  for (const file of files("reel-03-winter")) assert.ok(fs.existsSync(file), "another piece's files are left alone");
  assert.equal(itemState(store.load(), "reel-01-launch").attempts, 2);
  assert.equal(named("runReview").length, 0);
});

test("a review file that can't be removed is logged and the piece still builds", async (t) => {
  const { store, deps, sent } = setup(t, { backlog: [BACKLOG[0]] });
  const logged = [];
  const busy = () => {
    throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  };
  const log = { info: () => {}, error: (msg, data) => logged.push([msg, data]) };
  const result = await runNightly({ now: NOW, deps: { ...deps, rm: busy, log } });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.built, ["reel-01-launch"]);
  assert.equal(status(store, "reel-01-launch"), "awaiting-approval");
  assert.equal(sent.filter(([kind]) => kind === "sendVideo").length, 1);
  assert.deepEqual(logged.map(([msg, data]) => [msg, data.id, data.error]), [
    ["review file not removed", "reel-01-launch", "EBUSY: resource busy or locked"],
    ["review file not removed", "reel-01-launch", "EBUSY: resource busy or locked"],
  ]);
});

test("a build that throws fails only its piece; a fault outside any piece rejects the run", async (t) => {
  const { store, deps, messages } = setup(t, {
    script: { runSession: { "reel-01-launch": [() => { throw new Error("spawn EPERM"); }] } },
  });
  const result = await runNightly({ now: NOW, deps });

  assert.deepEqual(result.built, ["reel-02-menu"]);
  assert.match(result.failed[0].reason, /spawn EPERM/);
  assert.equal(status(store, "reel-01-launch"), "failed");
  assert.match(messages().at(-1), /spawn EPERM/);

  // Something outside any one piece breaking reaches the caller, which alerts the owner.
  const second = setup(t);
  let loads = 0;
  second.deps.store = {
    save: second.store.save,
    load: () => {
      if (loads++) throw new Error("disk gone");
      return second.store.load();
    },
  };
  await assert.rejects(runNightly({ now: NOW, deps: second.deps }), /disk gone/);
  assert.ok(!fs.existsSync(path.join(second.home, "locks", "creation.lock")), "the creation lock is released");
});

test("nothing to pick sends summary only", async (t) => {
  const at = "2026-10-24T20:00:00.000Z";
  const items = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((id) => [id, { status: "awaiting-approval", attempts: 0, at }]));
  const { deps, named, sent } = setup(t, { items });
  const result = await runNightly({ now: NOW, deps });

  assert.deepEqual(result.built, []);
  assert.deepEqual(result.failed, []);
  assert.match(result.skipped, /6 await approval/);
  assert.equal(named("snapshot").length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "alert", "to the owner chat");
  assert.match(sent[0][1], /Nothing to build/);
  assert.match(sent[0][1], /6 await approval/);
});

test("maxBuilds, formats and onlyId are passed to the picker", async (t) => {
  const backlog = [BACKLOG[0], entry("post-12-hot-take", "2026-11-13", { format: "hot-take", kind: "post" }), BACKLOG[1]];
  const one = setup(t, { backlog });
  assert.deepEqual((await runNightly({ now: NOW, maxBuilds: 1, deps: one.deps })).built, ["reel-01-launch"]);

  const formats = setup(t, { backlog });
  const built = (await runNightly({ now: NOW, maxBuilds: 3, formats: ["hot-take"], deps: formats.deps })).built;
  assert.deepEqual(built, ["post-12-hot-take"]);

  const only = setup(t, { backlog });
  assert.deepEqual((await runNightly({ now: NOW, onlyId: "reel-02-menu", deps: only.deps })).built, ["reel-02-menu"]);
});

test("the session and its verify run under the schedule lock", async (t) => {
  const { deps, home } = setup(t, { backlog: [BACKLOG[0]] });
  const held = [];
  const lockFile = (name) => fs.existsSync(path.join(home, "locks", `${name}.lock`));
  const { runSession, verifySession, runReview } = deps;
  deps.runSession = async (args) => { held.push(["session", lockFile("schedule"), lockFile("creation")]); return runSession(args); };
  deps.verifySession = (args) => { held.push(["verify", lockFile("schedule")]); return verifySession(args); };
  deps.runReview = async (args) => { held.push(["review", lockFile("schedule")]); return runReview(args); };
  await runNightly({ now: NOW, deps });
  assert.deepEqual(held, [["session", true, true], ["verify", true], ["review", false]]);
  assert.ok(!lockFile("schedule") && !lockFile("creation"), "both locks released");
});

test("a second run waits for the creation lock and then skips", async (t) => {
  const { deps, home, named } = setup(t);
  fs.mkdirSync(path.join(home, "locks"), { recursive: true });
  // A live holder: this test's own process.
  fs.writeFileSync(path.join(home, "locks", "creation.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const result = await runNightly({ now: NOW, deps });
  assert.match(result.skipped, /another build run/);
  assert.equal(result.lockBusy, true, "so a run by hand can re-queue its piece");
  assert.equal(named("snapshot").length, 0);
  await assert.rejects(runRecheck({ id: "reel-01-launch", deps }), (err) => err.lockBusy === true && /another build run/.test(err.message));
});

test("only a busy creation lock is lockBusy; a lock file that can't be used isn't", async (t) => {
  const { deps, home, named } = setup(t);
  // A file where the locks folder goes: every lock fails, and keeps failing, with EEXIST.
  fs.writeFileSync(path.join(home, "locks"), "not a folder");
  const result = await runNightly({ now: NOW, onlyId: "reel-01-launch", deps });
  assert.match(result.skipped, /the creation lock couldn't be taken/);
  assert.equal(result.lockBusy, undefined, "nothing to re-queue: no other run has it");
  assert.equal(named("snapshot").length, 0);
  await assert.rejects(runRecheck({ id: "reel-01-launch", deps }), (err) => err.lockBusy === undefined && /the creation lock couldn't be taken/.test(err.message));
});

test("a run takes over the creation lock of a build whose process died", async (t) => {
  const { deps, home, store } = setup(t, { backlog: [BACKLOG[0]] });
  const lines = [];
  deps.log = { info: (msg, data) => lines.push([msg, data]), error: (msg, data) => lines.push([msg, data]) };
  fs.mkdirSync(path.join(home, "locks"), { recursive: true });
  fs.writeFileSync(path.join(home, "locks", "creation.lock"), JSON.stringify({ pid: 2 ** 30, at: new Date().toISOString() }));
  const result = await runNightly({ now: NOW, deps });
  assert.deepEqual(result.built, ["reel-01-launch"]);
  assert.equal(status(store, "reel-01-launch"), "awaiting-approval");
  assert.ok(lines.some(([msg, data]) => msg === "lock taken over from a dead process" && data.pid === 2 ** 30), JSON.stringify(lines));
});

test("runNightly and runRecheck use takeoverDeadPid for the creation lock only", async (t) => {
  const { deps, home, repoRoot } = setup(t, {
    backlog: [BACKLOG[0], BACKLOG[1]],
    items: { "reel-02-menu": { status: "failed", attempts: 1, reason: "old", at: "x" } },
  });
  const seen = [];
  deps.withLock = (name, fn, options) => {
    seen.push([name, options]);
    return withLock(home, name, fn, options);
  };
  await runNightly({ now: NOW, onlyId: "reel-01-launch", deps });
  built(repoRoot, "reel-02-menu");
  await runRecheck({ id: "reel-02-menu", deps });

  const creation = seen.filter(([name]) => name === "creation");
  assert.equal(creation.length, 2, "one for the nightly run, one for the recheck");
  for (const [, options] of creation) {
    assert.equal(options.takeoverDeadPid, true);
    assert.equal(options.staleMs, 24 * 3600000);
  }
  const others = seen.filter(([name]) => name !== "creation");
  assert.deepEqual([...new Set(others.map(([name]) => name))].sort(), ["build-queue", "creation-state", "schedule"]);
  for (const [name, options] of others) assert.ok(!options?.takeoverDeadPid, `${name} keeps the age rule`);
});

test("nightly: moving a piece to building removes it from the queue", async (t) => {
  const { deps, home } = setup(t, { backlog: [BACKLOG[0], BACKLOG[1]] });
  const queueFile = path.join(home, "build-queue.json");
  const queuedAt = "2026-10-24T19:00:00.000Z";
  fs.writeFileSync(queueFile, JSON.stringify([
    { id: "reel-02-menu", kind: "recheck", queuedAt },
    { id: "reel-01-launch", kind: "build", queuedAt },
  ]));
  const queuedAtSession = [];
  const { runSession } = deps;
  deps.runSession = async (args) => {
    queuedAtSession.push(JSON.parse(fs.readFileSync(queueFile, "utf8")).map((e) => e.id));
    return runSession(args);
  };
  await runNightly({ now: NOW, onlyId: "reel-01-launch", deps });
  assert.deepEqual(queuedAtSession, [["reel-02-menu"]], "gone before its session starts");
  assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, "utf8")), [{ id: "reel-02-menu", kind: "recheck", queuedAt }]);

  // A queue that can't be changed never stops the build.
  const broken = setup(t, { backlog: [BACKLOG[0]] });
  const failing = { ...broken.deps, withLock: (name, fn, options) => (name === "build-queue" ? Promise.reject(new Error("lock build-queue busy")) : withLock(broken.home, name, fn, options)) };
  const result = await runNightly({ now: NOW, deps: failing });
  assert.deepEqual(result.built, ["reel-01-launch"]);
});

test("a piece left building by a crashed run is marked failed first", async (t) => {
  const { store, deps } = setup(t, {
    backlog: [BACKLOG[0]],
    items: { "reel-01-launch": { status: "building", attempts: 0, at: "x" } },
  });
  const result = await runNightly({ now: NOW, deps });
  // Marked failed (attempt 1 of 2), then picked again as a failed piece and built.
  assert.deepEqual(result.built, ["reel-01-launch"]);
  assert.equal(itemState(store.load(), "reel-01-launch").attempts, 1);
  assert.equal(status(store, "reel-01-launch"), "awaiting-approval");
});

test("retry of a failed piece carries its failure reason as the redo note", async (t) => {
  const reason = 'checks failed: hookscore.py on the on-screen hook "first cup at 6 am. watch ????": WEAK (score 30.2, weakest STAKES)';
  const { store, deps, named } = setup(t, {
    backlog: [BACKLOG[0], BACKLOG[1]],
    items: {
      "reel-01-launch": { status: "failed", attempts: 1, reason, at: "x" },
      "reel-02-menu": { status: "failed", attempts: 1, reason: "review said FIX twice. Must fix: Hook is a label", note: "Bigger price card.", at: "x" },
    },
  });
  const result = await runNightly({ now: NOW, deps });

  assert.deepEqual(result.built, ["reel-01-launch", "reel-02-menu"]);
  const [first, second] = named("buildPrompt");
  assert.equal(first.entry.id, "reel-01-launch");
  assert.equal(first.redoNote, `Previous attempt failed automatic checks or review: ${reason}`);
  assert.equal(second.redoNote, [
    "Previous attempt failed automatic checks or review: review said FIX twice. Must fix: Hook is a label",
    "",
    "The user's note on this piece still applies:",
    "Bigger price card.",
  ].join("\n"), "a user's note from an earlier redo still goes in");
  assert.equal(itemState(store.load(), "reel-02-menu").note, "Bigger price card.", "the stored note is unchanged");
});

test("redo piece keeps the user's note", async (t) => {
  const { deps, named } = setup(t, {
    backlog: [BACKLOG[0]],
    items: { "reel-01-launch": { status: "redo", attempts: 1, note: "Make the price card bigger.", at: "x" } },
  });
  await runNightly({ now: NOW, deps });
  assert.deepEqual(named("buildPrompt").map((p) => p.redoNote), ["Make the price card bigger."]);
});

// A built piece: its out/ folder holds the video.
function built(repoRoot, id) {
  const out = path.join(repoRoot, "pieces", id, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${id}.mp4`), "video");
}

const BUILD_STEPS = ["snapshot", "buildPrompt", "runSession", "verifySession", "revertSession"];

test("recheck on a failed piece that now passes sends it for approval", async (t) => {
  const id = "reel-01-launch";
  const { store, deps, named, sent, repoRoot, home } = setup(t, {
    backlog: [BACKLOG[0]],
    items: { [id]: { status: "failed", attempts: 1, reason: "checks failed: hookscore.py: WEAK", note: "Bigger price card.", at: "x" } },
  });
  built(repoRoot, id);
  const lockFile = (name) => fs.existsSync(path.join(home, "locks", `${name}.lock`));
  const held = [];
  const { runChecks } = deps;
  deps.runChecks = async (args) => { held.push(lockFile("creation")); return runChecks(args); };

  const result = await runRecheck({ id, deps });

  assert.deepEqual(result, { id, ok: true });
  const state = itemState(store.load(), id);
  assert.equal(state.status, "awaiting-approval");
  assert.equal(state.attempts, 1, "attempts unchanged");
  assert.equal(state.reason, undefined);
  assert.equal(state.note, "Bigger price card.", "the user's note is kept");
  for (const step of BUILD_STEPS) assert.equal(named(step).length, 0, `${step} doesn't run`);
  assert.equal(named("runChecks")[0].entry, BACKLOG[0]);
  assert.equal(named("runChecks")[0].repoRoot, repoRoot);
  assert.deepEqual(named("runReview"), [{ entryId: id, cwd: repoRoot, raw: { caption: { verdict: "READY" } } }]);
  const videos = sent.filter(([kind]) => kind === "sendVideo").map(([, args]) => args);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].path, path.join(repoRoot, "pieces", id, "out", `${id}.mp4`));
  assert.deepEqual(videos[0].keyboard, [[
    { text: "Approve", callback_data: `approve:${id}` },
    { text: "Redo", callback_data: `redo:${id}` },
  ]]);
  assert.deepEqual(held, [true], "checks run under the creation lock");
  assert.ok(!lockFile("creation") && !lockFile("creation-state"), "locks released");
});

test("recheck failure keeps attempts unchanged", async (t) => {
  const failures = ['hookscore.py on the on-screen hook "first cup at 6 am": WEAK (score 41, weakest CURIOSITY)'];
  const { store, deps, named, sent, repoRoot } = setup(t, {
    backlog: [BACKLOG[0], BACKLOG[1]],
    items: {
      "reel-01-launch": { status: "failed", attempts: 1, reason: "old reason", at: "x" },
      "reel-02-menu": { status: "awaiting-approval", attempts: 0, at: "x" },
    },
    script: {
      runChecks: { "reel-01-launch": [{ ok: false, failures, scores: {}, raw: {} }] },
      runReview: { "reel-02-menu": [fix("Hook is a label", "End card is clipped")] },
    },
  });
  built(repoRoot, "reel-01-launch");
  built(repoRoot, "reel-02-menu");

  const checksFailed = await runRecheck({ id: "reel-01-launch", deps });
  assert.equal(checksFailed.ok, false);
  assert.match(checksFailed.reason, /checks failed: hookscore\.py on the on-screen hook "first cup at 6 am": WEAK/);
  const first = itemState(store.load(), "reel-01-launch");
  assert.equal(first.status, "failed");
  assert.equal(first.attempts, 1);
  assert.equal(first.reason, checksFailed.reason);
  assert.equal(named("runReview").length, 0, "no review after a check failure");

  const fixed = await runRecheck({ id: "reel-02-menu", deps });
  assert.equal(fixed.ok, false);
  assert.match(fixed.reason, /review said FIX\. Must fix: Hook is a label; End card is clipped/);
  const second = itemState(store.load(), "reel-02-menu");
  assert.equal(second.status, "failed");
  assert.equal(second.attempts, 0);
  assert.equal(second.reason, fixed.reason);

  assert.equal(sent.filter(([kind]) => kind === "sendVideo").length, 0);
  for (const step of BUILD_STEPS) assert.equal(named(step).length, 0, `${step} doesn't run`);
});

test("recheck refuses a piece with no out/ video", async (t) => {
  const items = {
    "reel-01-launch": { status: "failed", attempts: 2, reason: "old reason", at: "x" },
    "reel-02-menu": { status: "approved", attempts: 0, at: "x" },
  };
  const { store, deps, named, sent, repoRoot } = setup(t, { backlog: BACKLOG, items });
  await assert.rejects(runRecheck({ id: "reel-01-launch", deps }), /reel-01-launch has no out\/ video to recheck/);
  // A video alone isn't enough: the piece must be failed or awaiting approval.
  built(repoRoot, "reel-02-menu");
  await assert.rejects(runRecheck({ id: "reel-02-menu", deps }), /reel-02-menu is approved/);
  await assert.rejects(runRecheck({ id: "reel-99-nope", deps }), /reel-99-nope is not in the backlog/);
  assert.deepEqual(store.load().items, items, "state unchanged");
  assert.equal(named("runChecks").length, 0);
  assert.equal(named("runReview").length, 0);
  assert.equal(sent.length, 0);
});
