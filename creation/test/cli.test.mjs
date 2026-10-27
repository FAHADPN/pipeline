import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { main } from "../create.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(REPO_ROOT, "creation", "create.mjs");

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "creation-home-"));
const emptyRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "creation-cli-empty-"));

// Each run gets its own empty publisher home (no .env, so no Telegram) and, unless
// the test gives one, an empty campaigns root.
function run(args, { home = tempHome(), env: extra = {} } = {}) {
  const env = { ...process.env, PIPELINE_HOME: home, PIPELINE_CAMPAIGNS_ROOT: emptyRoot(), ...extra };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8", env, timeout: 60000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, out: res.stdout + res.stderr, home };
}

function writeState(home, cstate) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "creation-state.json"), JSON.stringify(cstate, null, 2));
}

const readState = (home) => JSON.parse(fs.readFileSync(path.join(home, "creation-state.json"), "utf8"));

const entry = (id, targetDate, title) => ({
  id, kind: "post", format: "episode", type: "story", title, premise: "A premise.", targetDate, hook: 3, reference: "starter",
});
const BACKLOG = [entry("post-01-first", "2026-11-02", "First"), entry("post-02-second", "2026-11-03", "Second"), entry("post-03-third", "2026-11-04", "Third")];

// A campaign under the campaigns root: its own folder and build list. More campaigns
// can be added to the same root with add().
function sampleCampaign(t, over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "creation-cli-campaign-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const campaignsRoot = path.join(tmp, "campaigns");
  const add = (id, config = {}, backlog = BACKLOG) => {
    const root = path.join(tmp, `${id}-root`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "backlog.json"), JSON.stringify(backlog));
    fs.mkdirSync(path.join(campaignsRoot, id), { recursive: true });
    fs.writeFileSync(path.join(campaignsRoot, id, "campaign.json"), JSON.stringify({ id, name: `${id} Co`, root, ...config }));
    return root;
  };
  const root = add("sample", over);
  return { campaignsRoot, root, add, env: { PIPELINE_CAMPAIGNS_ROOT: campaignsRoot } };
}

const campaignHome = (home, id = "sample") => path.join(home, "campaigns", id);

test("status prints every backlog id of the only campaign", (t) => {
  const { env } = sampleCampaign(t);
  const home = tempHome();
  const [first, second, third] = BACKLOG;
  writeState(campaignHome(home), {
    items: {
      [first.id]: { status: "awaiting-approval", attempts: 0, at: "2026-10-24T20:00:00.000Z" },
      [second.id]: { status: "failed", attempts: 1, reason: "checks failed: hook WEAK", at: "2026-10-24T20:00:00.000Z" },
      [third.id]: { status: "redo", attempts: 0, note: "Slower ending.", at: "2026-10-24T20:00:00.000Z" },
    },
  });
  const r = run(["status"], { home, env });
  assert.equal(r.code, 0, r.out);
  for (const e of BACKLOG) assert.match(r.stdout, new RegExp(`^${e.id}\\s`, "m"), e.id);
  assert.match(r.stdout, new RegExp(`^${first.id}\\s.*awaiting-approval`, "m"));
  assert.match(r.stdout, new RegExp(`^${second.id}\\s.*failed\\s+1`, "m"));
  assert.match(r.stdout, new RegExp(`Awaiting approval \\(1\\): ${first.id}`));
  assert.match(r.stdout, /Failed post-02-second: checks failed: hook WEAK/);
  assert.match(r.stdout, /Redo post-03-third: Slower ending\./);
  assert.match(r.stdout, /^Today: \d{4}-\d\d-\d\d$/m);
  // status only reads.
  assert.deepEqual(readState(campaignHome(home)).items[first.id].status, "awaiting-approval");
});

test("status works with no creation state yet", (t) => {
  const { env } = sampleCampaign(t);
  const r = run(["status"], { env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /Awaiting approval \(0\): none/);
  assert.ok(!fs.existsSync(path.join(campaignHome(r.home), "creation-state.json")));
});

test("reset sets todo", (t) => {
  const { env } = sampleCampaign(t);
  const home = tempHome();
  const id = BACKLOG[1].id;
  writeState(campaignHome(home), {
    items: { [id]: { status: "failed", attempts: 2, reason: "session timed out and was killed", at: "2026-10-24T20:00:00.000Z" } },
  });
  const r = run(["reset", id], { home, env });
  assert.equal(r.code, 0, r.out);
  const item = readState(campaignHome(home)).items[id];
  assert.equal(item.status, "todo");
  assert.equal(item.attempts, 0);
  assert.equal(item.reason, undefined);
  assert.match(r.stdout, new RegExp(`${id}.*todo`));
});

test("reset clears a redo that was waiting for a note on that piece", (t) => {
  const { env } = sampleCampaign(t);
  const home = tempHome();
  const id = BACKLOG[0].id;
  writeState(campaignHome(home), { pendingNote: id, items: { [id]: { status: "awaiting-approval", attempts: 0, at: "2026-10-24T20:00:00.000Z" } } });
  const r = run(["reset", id], { home, env });
  assert.equal(r.code, 0, r.out);
  const cstate = readState(campaignHome(home));
  assert.equal(cstate.pendingNote, undefined);
  assert.equal(cstate.items[id].status, "todo");
});

test("reset refuses an id not in the backlog, a piece being built, and a missing id", (t) => {
  const { env } = sampleCampaign(t);
  const home = tempHome();
  const id = BACKLOG[0].id;
  writeState(campaignHome(home), { items: { [id]: { status: "building", attempts: 0, at: "2026-10-24T20:00:00.000Z" } } });
  const unknown = run(["reset", "post-99-nope"], { home, env });
  assert.equal(unknown.code, 1, unknown.out);
  assert.match(unknown.stderr, /post-99-nope is not in the backlog/);
  const building = run(["reset", id], { home, env });
  assert.equal(building.code, 1, building.out);
  assert.match(building.stderr, /building/);
  assert.equal(readState(campaignHome(home)).items[id].status, "building");
  const missing = run(["reset"], { home, env });
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.stderr, /Usage:/);
});

test("unknown command exits 1", () => {
  const r = run(["bake"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /unknown command: bake/);
  assert.match(r.stderr, /Usage:/);
  const none = run([]);
  assert.equal(none.code, 1, none.out);
  assert.match(none.stderr, /Usage:/);
});

test("bad flags are refused before anything runs", (t) => {
  const { env } = sampleCampaign(t);
  const cases = [
    [["status", "--now"], /status doesn't take --now/],
    [["nightly", "--id", "post-01-first"], /--id needs --now/],
    [["nightly", "--max-builds", "0"], /--max-builds must be a positive integer/],
    [["nightly", "--max-builds"], /--max-builds needs a value/],
    [["nightly", "--formats", "episode,carousel"], /unknown or unsupported format: carousel/],
    [["poll", "extra"], /poll takes no arguments/],
    [["recheck"], /recheck takes exactly one piece id/],
    [["recheck", "post-01-first", "--now"], /recheck doesn't take --now/],
  ];
  for (const [args, message] of cases) {
    const r = run(args, { env });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, message, args.join(" "));
    assert.ok(!fs.existsSync(path.join(campaignHome(r.home), "creation-state.json")), args.join(" "));
    assert.ok(!fs.existsSync(path.join(r.home, "locks")), args.join(" "));
  }
});

test("without --campaign, an empty campaigns root or several campaigns is a usage error that lists the ids", (t) => {
  const none = run(["status"]);
  assert.equal(none.code, 1, none.out);
  assert.match(none.stderr, /no campaign found under /);
  assert.match(none.stderr, /Usage:/);

  const { env, add } = sampleCampaign(t);
  add("alpha");
  for (const args of [["status"], ["nightly", "--now"], ["reset", "post-01-first"]]) {
    const r = run(args, { env });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, /several campaigns under .* \(alpha, sample\); pick one with --campaign <id>/, args.join(" "));
    assert.match(r.stderr, /Usage:/);
    assert.ok(!fs.existsSync(path.join(r.home, "campaigns")), "no campaign's state is touched");
    assert.ok(!fs.existsSync(path.join(r.home, "locks")));
  }
});

test("--campaign status and reset work on that campaign's build list and state", (t) => {
  const { env, add } = sampleCampaign(t);
  add("alpha", {}, [entry("post-10-alpha", "2026-11-05", "Alpha")]);
  const home = tempHome();
  writeState(campaignHome(home, "alpha"), { items: { "post-10-alpha": { status: "awaiting-approval", attempts: 0, at: "x" } } });
  writeState(campaignHome(home), { items: { "post-01-first": { status: "failed", attempts: 2, reason: "checks failed: WEAK", at: "x" } } });

  const r = run(["status", "--campaign", "sample"], { home, env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^post-01-first\s.*failed\s+2/m);
  assert.doesNotMatch(r.stdout, /post-10-alpha/);
  assert.match(r.stdout, /Failed post-01-first: checks failed: WEAK/);

  const reset = run(["reset", "post-01-first", "--campaign", "sample"], { home, env });
  assert.equal(reset.code, 0, reset.out);
  assert.equal(readState(campaignHome(home)).items["post-01-first"].status, "todo");
  assert.equal(readState(campaignHome(home, "alpha")).items["post-10-alpha"].status, "awaiting-approval", "the other campaign is untouched");
  const other = run(["reset", "post-10-alpha", "--campaign", "sample"], { home, env });
  assert.equal(other.code, 1, other.out);
  assert.match(other.stderr, /not in the backlog/);
});

test("--campaign refuses an unknown campaign, a missing value, and Telegram commands with no approval chat", (t) => {
  const { env } = sampleCampaign(t);
  const unknown = run(["status", "--campaign", "nope"], { env });
  assert.equal(unknown.code, 1, unknown.out);
  assert.match(unknown.stderr, /unknown campaign nope/);
  const missing = run(["status", "--campaign"], { env });
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.stderr, /--campaign needs a value/);
  for (const args of [["nightly", "--now"], ["poll"], ["recheck", "post-01-first"]]) {
    const r = run([...args, "--campaign", "sample"], { env });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, /sample has no approval chat: no approvers in its campaign\.json/);
    assert.ok(!fs.existsSync(path.join(r.home, "locks")), args.join(" "));
  }
});

test("nightly, poll and recheck refuse to run without a bot or the owner's Telegram settings", (t) => {
  const { env } = sampleCampaign(t, { approvers: ["111"] });
  for (const args of [["nightly", "--now"], ["poll"], ["recheck", BACKLOG[0].id]]) {
    const noBot = run(args, { env });
    assert.equal(noBot.code, 1, `${args.join(" ")}: ${noBot.out}`);
    assert.match(noBot.stderr, /sample has no approval chat: no TELEGRAM_BOT_TOKEN in secrets\/sample\.json or the owner's \.env/);
    assert.ok(!fs.existsSync(path.join(noBot.home, "locks")), args.join(" "));

    // The campaign's own bot is not enough: internal alerts go to the owner chat.
    const home = tempHome();
    createSecrets(home).set("sample", "TELEGRAM_BOT_TOKEN", "123:sample-bot");
    const noOwner = run(args, { home, env });
    assert.equal(noOwner.code, 1, `${args.join(" ")}: ${noOwner.out}`);
    assert.match(noOwner.stderr, /TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .*\.env for the owner's alerts/);
    assert.ok(!fs.existsSync(path.join(home, "locks")), args.join(" "));
  }
});

// main() in this process, with console output kept out of the test's.
async function quietly(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, error });
  }
}

test("create.mjs: startNextQueued runs after nightly and after recheck, and its failure doesn't change the exit code", async (t) => {
  const { campaignsRoot } = sampleCampaign(t, { approvers: ["111"] });
  const home = tempHome();
  fs.writeFileSync(path.join(home, ".env"), "TELEGRAM_BOT_TOKEN=123:owner-bot\nTELEGRAM_CHAT_ID=999\n");
  const calls = [];
  let nightly = { built: ["post-01-first"], failed: [] };
  let recheck = { id: "post-01-first", ok: true };
  const options = {
    home,
    root: campaignsRoot,
    runNightly: async ({ onlyId, deps }) => {
      calls.push(["nightly", onlyId, deps.campaign.id]);
      return nightly;
    },
    runRecheck: async ({ id }) => {
      calls.push(["recheck", id]);
      return recheck;
    },
    startNextQueued: async ({ campaign, deps }) => {
      calls.push(["startNextQueued", campaign.id, deps.home === campaign.home]);
      throw new Error("queue file locked");
    },
  };
  const run = (argv) => quietly(() => main(argv, options));

  assert.equal(await run(["nightly", "--now", "--id", "post-01-first", "--campaign", "sample"]), 0);
  assert.equal(await run(["recheck", "post-01-first", "--campaign", "sample"]), 0);
  nightly = { built: [], failed: [{ id: "post-01-first", reason: "checks failed" }] };
  recheck = { id: "post-01-first", ok: false, reason: "review said FIX" };
  assert.equal(await run(["nightly"]), 1, "the only campaign, without --campaign");
  assert.equal(await run(["recheck", "post-01-first", "--campaign", "sample"]), 1);
  assert.deepEqual(calls, [
    ["nightly", "post-01-first", "sample"], ["startNextQueued", "sample", true],
    ["recheck", "post-01-first"], ["startNextQueued", "sample", true],
    ["nightly", undefined, "sample"], ["startNextQueued", "sample", true],
    ["recheck", "post-01-first"], ["startNextQueued", "sample", true],
  ]);
  // Its failure is in the campaign's log.
  const logs = path.join(home, "campaigns", "sample", "logs");
  const text = fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), "utf8")).join("");
  assert.match(text, /build queue: next not started.*queue file locked/);

  // A run that crashed still lets the next queued piece go; status and reset don't touch the queue.
  calls.length = 0;
  options.runRecheck = async () => {
    throw new Error("post-01-first is approved");
  };
  assert.equal(await run(["recheck", "post-01-first", "--campaign", "sample"]), 1);
  assert.equal(await run(["status", "--campaign", "sample"]), 0);
  assert.deepEqual(calls, [["startNextQueued", "sample", true]]);
});

test("create.mjs: a nightly run that crashes tells the owner chat and still exits 1", async (t) => {
  const { campaignsRoot } = sampleCampaign(t, { approvers: ["111"] });
  const home = tempHome();
  fs.writeFileSync(path.join(home, ".env"), "TELEGRAM_BOT_TOKEN=123:owner-bot\nTELEGRAM_CHAT_ID=999\n");
  const sent = [];
  const options = {
    home,
    root: campaignsRoot,
    runNightly: async ({ deps }) => {
      deps.alerts.sendMessage = async (text) => void sent.push(text);
      throw new Error("disk gone");
    },
    startNextQueued: async () => null,
  };
  assert.equal(await quietly(() => main(["nightly"], options)), 1);
  assert.deepEqual(sent, ["❌ builds crashed: disk gone"]);
});

// A sample campaign with an approver and the owner's Telegram settings, so nightly and
// recheck get as far as their run; `queue` reads and writes its build queue.
function queueCampaign(t) {
  const { campaignsRoot, root } = sampleCampaign(t, { approvers: ["111"] });
  const home = tempHome();
  fs.writeFileSync(path.join(home, ".env"), "TELEGRAM_BOT_TOKEN=123:owner-bot\nTELEGRAM_CHAT_ID=999\n");
  const file = path.join(campaignHome(home), "build-queue.json");
  const queue = {
    write: (entries) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(entries.map(([id, kind]) => ({ id, kind, queuedAt: "2026-10-26T10:00:00.000Z" }))));
    },
    read: () => JSON.parse(fs.readFileSync(file, "utf8")).map((e) => [e.id, e.kind]),
  };
  return { campaignsRoot, root, home, queue };
}

const lockBusyRun = async () => ({ built: [], failed: [], skipped: "another build run holds the creation lock (lock sample:creation busy)", lockBusy: true });
const lockBusyRecheck = async () => {
  const err = new Error("another build run holds the creation lock (lock sample:creation busy)");
  err.lockBusy = true;
  throw err;
};

test("cli: a by-hand nightly that finds the creation lock busy re-queues its piece at the head", async (t) => {
  const { campaignsRoot, home, queue } = queueCampaign(t);
  queue.write([["post-02-later", "build"]]);
  const order = [];
  const options = {
    home,
    root: campaignsRoot,
    runNightly: lockBusyRun,
    startNextQueued: async () => order.push(["startNext", queue.read()]),
  };
  assert.equal(await quietly(() => main(["nightly", "--now", "--id", "post-01-first", "--campaign", "sample"], options)), 0);
  assert.deepEqual(queue.read(), [["post-01-first", "build"], ["post-02-later", "build"]]);
  assert.deepEqual(order, [["startNext", [["post-01-first", "build"], ["post-02-later", "build"]]]], "re-queued before the next start is tried");

  // A night run (no --id) that skips has no piece of its own to put back.
  queue.write([["post-02-later", "build"]]);
  assert.equal(await quietly(() => main(["nightly", "--campaign", "sample"], options)), 0);
  assert.deepEqual(queue.read(), [["post-02-later", "build"]]);
});

test("cli: a by-hand recheck that finds the creation lock busy re-queues its piece at the head", async (t) => {
  const { campaignsRoot, home, queue } = queueCampaign(t);
  queue.write([["post-02-later", "build"]]);
  const options = { home, root: campaignsRoot, runRecheck: lockBusyRecheck, startNextQueued: async () => null };
  assert.equal(await quietly(() => main(["recheck", "post-01-first", "--campaign", "sample"], options)), 1, "still a failed run");
  assert.deepEqual(queue.read(), [["post-01-first", "recheck"], ["post-02-later", "build"]]);

  // Any other failure isn't a lost race: nothing is put back.
  queue.write([]);
  options.runRecheck = async () => {
    throw new Error("post-01-first is approved");
  };
  assert.equal(await quietly(() => main(["recheck", "post-01-first", "--campaign", "sample"], options)), 1);
  assert.deepEqual(queue.read(), []);
});

test("cli: a non-busy lock error does not re-queue", async (t) => {
  const { campaignsRoot, home, queue } = queueCampaign(t);
  queue.write([["post-02-later", "build"]]);
  // A file where the publisher home's locks folder goes: a lasting lock error, not a
  // lock another run holds. The real runNightly and runRecheck meet it.
  fs.writeFileSync(path.join(home, "locks"), "not a folder");
  const options = { home, root: campaignsRoot, startNextQueued: async () => null };
  assert.equal(await quietly(() => main(["nightly", "--now", "--id", "post-01-first", "--campaign", "sample"], options)), 0);
  assert.equal(await quietly(() => main(["recheck", "post-01-first", "--campaign", "sample"], options)), 1);
  assert.deepEqual(queue.read(), [["post-02-later", "build"]]);
  const logs = path.join(campaignHome(home), "logs");
  const text = fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), "utf8")).join("");
  assert.match(text, /creation lock couldn't be taken/);
  assert.doesNotMatch(text, /re-queued/, "no re-queue was even tried");
});

test("cli: re-queue doesn't duplicate an id already queued", async (t) => {
  const { campaignsRoot, home, queue } = queueCampaign(t);
  const others = Array.from({ length: 9 }, (_, i) => [`post-1${i}-other`, "build"]);
  queue.write([...others.slice(0, 4), ["post-01-first", "build"], ...others.slice(4)]);
  const options = { home, root: campaignsRoot, runNightly: lockBusyRun, runRecheck: lockBusyRecheck, startNextQueued: async () => null };
  await quietly(() => main(["nightly", "--now", "--id", "post-01-first", "--campaign", "sample"], options));
  await quietly(() => main(["recheck", "post-01-first", "--campaign", "sample"], options));
  assert.deepEqual(queue.read(), [...others.slice(0, 4), ["post-01-first", "build"], ...others.slice(4)], "left where it was");

  // Not queued, in a full queue: it goes first, past the cap of 10.
  queue.write([...others, ["post-20-tenth", "build"]]);
  await quietly(() => main(["nightly", "--now", "--id", "post-01-first", "--campaign", "sample"], options));
  assert.equal(queue.read().length, 11);
  assert.deepEqual(queue.read()[0], ["post-01-first", "build"]);
});

test("cli: the real startNextQueued with create.mjs's own deps starts nothing while a build holds the creation lock", async (t) => {
  const { campaignsRoot, root, home, queue } = queueCampaign(t);
  // A recheck, so the posting window can't be what holds it back: only the lock can.
  writeState(campaignHome(home), { items: { "post-01-first": { status: "failed", attempts: 1, reason: "checks failed", at: "x" } } });
  fs.mkdirSync(path.join(root, "pieces", "post-01-first", "out"), { recursive: true });
  fs.writeFileSync(path.join(root, "pieces", "post-01-first", "out", "post-01-first.mp4"), "video");
  queue.write([["post-01-first", "recheck"]]);
  // The creation lock in the publisher home, held by this live process.
  fs.mkdirSync(path.join(home, "locks"), { recursive: true });
  fs.writeFileSync(path.join(home, "locks", "sample.creation.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  // Were it to spawn after all, the child must find nothing real.
  const saved = { home: process.env.PIPELINE_HOME, root: process.env.PIPELINE_CAMPAIGNS_ROOT };
  process.env.PIPELINE_HOME = tempHome();
  process.env.PIPELINE_CAMPAIGNS_ROOT = emptyRoot();
  t.after(() => {
    for (const [key, value] of [["PIPELINE_HOME", saved.home], ["PIPELINE_CAMPAIGNS_ROOT", saved.root]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const code = await quietly(() => main(["nightly", "--now", "--id", "post-01-first", "--campaign", "sample"], {
    home,
    root: campaignsRoot,
    runNightly: async () => ({ built: [], failed: [] }),
  }));
  assert.equal(code, 0);
  assert.deepEqual(queue.read(), [["post-01-first", "recheck"]], "nothing was started: the entry is still queued");
  const logs = path.join(campaignHome(home), "logs");
  const text = fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), "utf8")).join("");
  assert.doesNotMatch(text, / ERROR /, text);
  assert.doesNotMatch(text, /build queue/, text);
});
