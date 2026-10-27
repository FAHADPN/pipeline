import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../../publishing/lib/state.mjs";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { createQueueActions, queueDeps } from "../lib/queue-actions.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));

const NOW = new Date("2026-10-25T04:30:00Z"); // Sun 10:00 IST
const BUSY = "a build is running for Test Campaign; try again when it finishes";
// The posting fields publishConfig reads: a 19:30 slot, closing 120 minutes later.
const CAMPAIGN_CONFIG = {
  timezone: "Asia/Kolkata",
  slot: "19:30",
  lateLimitMinutes: 120,
  bufferMin: 7,
  fallbackDays: ["Mon", "Wed", "Fri", "Sun"],
  retryDelaySeconds: 60,
  platforms: { instagram: { enabled: true }, youtube: { enabled: false } },
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

// done, man and gone are posted, manual and dropped on Instagram; f1..f3 float; pin is pinned.
const ITEMS = [
  ...["done", "man", "gone", "f1", "f2", "f3"].map((id) => ({ id, kind: "ep", dir: `pieces/${id}` })),
  { id: "pin", kind: "special", dir: "pieces/pin", on: "2026-10-28" },
];
const STATE = {
  version: 1,
  items: {
    done: { instagram: { status: "posted", date: "2026-10-20", at: "x" } },
    man: { instagram: { status: "manual", date: "2026-10-21", at: "x" } },
    gone: { instagram: { status: "dropped", at: "x", reason: "pinned date passed" } },
  },
};

function fakeLog() {
  return {
    lines: [],
    info(msg, data) {
      this.lines.push(["info", msg, data]);
    },
    error(msg, data) {
      this.lines.push(["error", msg, data]);
    },
  };
}

// A git repo at `root` whose schedule.json holds `items`, committed.
function makeRepo(root, items) {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  for (const item of items) {
    fs.mkdirSync(path.join(root, item.dir), { recursive: true });
    fs.writeFileSync(path.join(root, item.dir, "keep.txt"), "x");
  }
  fs.writeFileSync(path.join(root, "schedule.json"), JSON.stringify(items, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
}

// Queue actions on a temp repo and state home. withLock runs fn straight away and
// records what it was asked for, unless `withLock` replaces it.
function setup({ withLock, now = NOW, config = CAMPAIGN_CONFIG } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "queue-repo-"));
  makeRepo(repo, ITEMS);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-home-"));
  const store = createStateStore(home);
  store.save(structuredClone(STATE));
  const locks = [];
  const campaign = { id: "test", name: "Test Campaign", lockName: (name) => `test:${name}`, config };
  const deps = {
    repoRoot: repo,
    scheduleFile: "schedule.json",
    store,
    log: fakeLog(),
    now: () => now,
    withLock:
      withLock ??
      (async (name, fn, options) => {
        locks.push([name, options]);
        return fn();
      }),
  };
  const file = path.join(repo, "schedule.json");
  return {
    repo,
    store,
    deps,
    locks,
    actions: createQueueActions({ campaign, deps }),
    original: fs.readFileSync(file),
    read: () => fs.readFileSync(file),
    items: () => JSON.parse(fs.readFileSync(file, "utf8")),
    commits: () => git(repo, "log", "--format=%s").split("\n"),
  };
}

const item = (items, id) => items.find((i) => i.id === id);

test("queue: pin sets on and commits \"queue: pin <id> <date>\"", async () => {
  const { actions, items, commits, locks, deps, repo } = setup();
  const res = await actions.pin({ id: "f2", date: "2026-11-02" });
  assert.equal(res.ok, true);
  assert.equal(typeof res.message, "string");
  assert.equal(item(items(), "f2").on, "2026-11-02");
  assert.deepEqual(commits(), ["queue: pin f2 2026-11-02", "init"]);
  assert.equal(git(repo, "log", "-1", "--format=%B"), "queue: pin f2 2026-11-02");
  assert.deepEqual(locks, [["schedule", { waitMs: 3000 }]]);
  assert.ok(deps.log.lines.some(([level, msg, data]) => level === "info" && msg === "dashboard pin" && data.id === "f2" && data.ok === true));

  // Today is not past.
  assert.equal((await actions.pin({ id: "f3", date: "2026-10-25" })).ok, true);
});

test("queue: pin to a past or unreal date is refused", async () => {
  const { actions, read, original, commits, deps } = setup();
  for (const date of ["2026-10-24", "2026-02-30", "2026-13-01", "soon", undefined]) {
    const res = await actions.pin({ id: "f1", date });
    assert.equal(res.ok, false, String(date));
    assert.match(res.error, /date/, String(date));
  }
  assert.deepEqual(read(), original);
  assert.deepEqual(commits(), ["init"]);
  assert.ok(deps.log.lines.every(([level, msg]) => level === "error" && msg === "dashboard pin"));
});

test("queue: pin to a date another item is pinned on is refused naming that item", async () => {
  const { actions, read, original, commits } = setup();
  const res = await actions.pin({ id: "f1", date: "2026-10-28" });
  assert.deepEqual(res, { ok: false, error: "pin is already pinned on 2026-10-28" });
  assert.deepEqual(read(), original);
  assert.deepEqual(commits(), ["init"]);
});

test("queue: re-pinning an item to its own date doesn't name the item itself", async () => {
  const { actions, items } = setup();
  const res = await actions.pin({ id: "pin", date: "2026-10-28" });
  assert.equal(res.ok, true, res.error);
  assert.equal(item(items(), "pin").on, "2026-10-28");
});

test("queue: drop while a post holds the publish lock is refused in words", async () => {
  const { deps } = setup();
  const busy = async (name) => {
    throw new Error(`lock test:${name} busy`);
  };
  const campaign = { id: "test", name: "Test Campaign", lockName: (name) => `test:${name}`, config: CAMPAIGN_CONFIG };
  const actions = createQueueActions({ campaign, deps: { ...deps, withLock: busy } });
  assert.deepEqual(await actions.drop({ id: "f1", platform: "instagram" }), {
    ok: false,
    error: "a post is running for Test Campaign; try again when it finishes",
  });
});

test("queue: pin to today is refused once today's posting window has closed", async () => {
  // 21:30 IST is the last open minute (19:30 + 120).
  const open = setup({ now: new Date("2026-10-25T16:00:00Z") });
  assert.equal((await open.actions.pin({ id: "f1", date: "2026-10-25" })).ok, true);

  const closed = setup({ now: new Date("2026-10-25T16:01:00Z") });
  assert.deepEqual(await closed.actions.pin({ id: "f1", date: "2026-10-25" }), {
    ok: false,
    error: "today's posting window has closed; pick a later date or use Post now",
  });
  assert.deepEqual(closed.read(), closed.original);
  assert.deepEqual(closed.commits(), ["init"]);
  // Tomorrow is still fine.
  assert.equal((await closed.actions.pin({ id: "f1", date: "2026-10-26" })).ok, true);
});

test("queue: a pinned item posted early or dropped frees its date for another pin", async () => {
  const posted = setup();
  posted.store.save({ ...structuredClone(STATE), items: { ...structuredClone(STATE.items), pin: { instagram: { status: "posted", date: "2026-10-25", at: "x" } } } });
  const res = await posted.actions.pin({ id: "f1", date: "2026-10-28" });
  assert.equal(res.ok, true, res.error);
  assert.equal(item(posted.items(), "f1").on, "2026-10-28");

  const dropped = setup();
  assert.equal((await dropped.actions.drop({ id: "pin", platform: "instagram" })).ok, true);
  assert.equal((await dropped.actions.pin({ id: "f2", date: "2026-10-28" })).ok, true);
  assert.deepEqual(dropped.commits(), ["queue: pin f2 2026-10-28", "init"]);

  // A dropped pin on another platform still holds the date on Instagram.
  const youtube = setup();
  assert.equal((await youtube.actions.drop({ id: "pin", platform: "youtube" })).ok, true);
  assert.deepEqual(await youtube.actions.pin({ id: "f2", date: "2026-10-28" }), { ok: false, error: "pin is already pinned on 2026-10-28" });
});

// The state with `entries` (id -> { platform: entry }) added to STATE.
const withEntries = (entries) => ({ version: 1, items: { ...structuredClone(STATE.items), ...entries } });

test("queue: a pin posted today still holds today", async () => {
  // 20:00 IST: today's run has posted x (f3, pinned to today); the window is still open.
  const { actions, store, read, commits } = setup({ now: new Date("2026-10-25T14:30:00Z") });
  assert.equal((await actions.pin({ id: "f3", date: "2026-10-25" })).ok, true);
  store.save(withEntries({ f3: { instagram: { status: "posted", date: "2026-10-25", at: "x" } } }));
  const before = read();
  assert.deepEqual(await actions.pin({ id: "f1", date: "2026-10-25" }), { ok: false, error: "f3 is already pinned on 2026-10-25" });
  assert.deepEqual(read(), before);
  assert.deepEqual(commits(), ["queue: pin f3 2026-10-25", "init"]);
});

test("queue: a pin to today after something posted today is refused", async () => {
  const already = "something already posted today; pick a later date";
  // A floating post went out today.
  const floating = setup({ now: new Date("2026-10-25T14:30:00Z") });
  floating.store.save(withEntries({ f1: { instagram: { status: "posted", date: "2026-10-25", at: "x" } } }));
  assert.deepEqual(await floating.actions.pin({ id: "f2", date: "2026-10-25" }), { ok: false, error: already });
  assert.deepEqual(floating.read(), floating.original);
  assert.equal((await floating.actions.pin({ id: "f2", date: "2026-10-26" })).ok, true, "a later date is fine");

  // A pinned item posted early today, through Post now.
  const early = setup({ now: new Date("2026-10-25T14:30:00Z") });
  early.store.save(withEntries({ pin: { instagram: { status: "posted", date: "2026-10-25", at: "x" } } }));
  assert.deepEqual(await early.actions.pin({ id: "f2", date: "2026-10-25" }), { ok: false, error: already });
});

test("queue: a pin posted early on Instagram still holds its date on an enabled YouTube", async () => {
  const youtube = structuredClone(CAMPAIGN_CONFIG);
  youtube.platforms.youtube.enabled = true;
  const early = { pin: { instagram: { status: "posted", date: "2026-10-25", at: "x" } } };

  const on = setup({ config: youtube });
  on.store.save(withEntries(early));
  assert.deepEqual(await on.actions.pin({ id: "f1", date: "2026-10-28" }), { ok: false, error: "pin is already pinned on 2026-10-28" });
  assert.deepEqual(on.read(), on.original);

  const off = setup();
  off.store.save(withEntries(early));
  assert.equal((await off.actions.pin({ id: "f1", date: "2026-10-28" })).ok, true);
});

test("queue: hold, pin or reorder on a posted, manual or dropped item is refused", async () => {
  const { actions, read, original, commits } = setup();
  const done = { done: "posted", man: "manual", gone: "dropped" };
  for (const [id, status] of Object.entries(done)) {
    for (const [name, args] of [
      ["hold", { id }],
      ["release", { id }],
      ["pin", { id, date: "2026-11-02" }],
      ["unpin", { id }],
      ["reorder", { id, before: "f1" }],
      ["reorder", { id, before: null }],
      ["drop", { id, platform: "instagram" }],
    ]) {
      const res = await actions[name](args);
      assert.equal(res.ok, false, `${name} ${id}`);
      assert.equal(res.error, `${id} is already ${status} on Instagram; reload to see it`, `${name} ${id}`);
    }
  }
  assert.deepEqual(read(), original);
  assert.deepEqual(commits(), ["init"]);
});

test("queue: lock busy -> the build-running refusal within 3.5 s and the file is unchanged", async () => {
  const asked = [];
  // The build session holds the schedule lock: withLock gives up after waitMs.
  const withLock = async (name, fn, options) => {
    asked.push([name, options]);
    await new Promise((r) => setTimeout(r, options.waitMs));
    throw new Error(`lock test:${name} busy`);
  };
  const { actions, read, original, commits, store } = setup({ withLock });
  const started = Date.now();
  const res = await actions.hold({ id: "f1" });
  const took = Date.now() - started;
  assert.deepEqual(res, { ok: false, error: BUSY });
  assert.ok(took < 3500, `took ${took} ms`);
  assert.deepEqual(asked, [["schedule", { waitMs: 3000 }]]);
  assert.deepEqual(read(), original);
  assert.deepEqual(commits(), ["init"]);
  assert.deepEqual(store.load(), STATE);
});

test("queue: an error other than a busy lock keeps its own message", async () => {
  const withLock = async () => {
    throw new Error("EPERM: operation not permitted");
  };
  const { actions } = setup({ withLock });
  assert.deepEqual(await actions.hold({ id: "f1" }), { ok: false, error: "EPERM: operation not permitted" });
});

test("queue: reorder moves the item before the given id", async () => {
  const { actions, items, commits } = setup();
  const res = await actions.reorder({ id: "f3", before: "f1" });
  assert.equal(res.ok, true);
  assert.deepEqual(items().map((i) => i.id), ["done", "man", "gone", "f3", "f1", "f2", "pin"]);
  assert.deepEqual(commits(), ["queue: reorder f3", "init"]);
});

test("queue: reorder with before null moves it after the last floating item", async () => {
  const { actions, items, commits } = setup();
  assert.equal((await actions.reorder({ id: "f1", before: null })).ok, true);
  assert.deepEqual(items().map((i) => i.id), ["done", "man", "gone", "f2", "f3", "f1", "pin"]);
  assert.deepEqual(commits(), ["queue: reorder f1", "init"]);
});

test("queue: reorder refuses a pinned item, a pinned or unknown target and itself", async () => {
  const { actions, read, original } = setup();
  for (const args of [
    { id: "pin", before: "f1" },
    { id: "f1", before: "pin" },
    { id: "f1", before: "nope" },
    { id: "f1", before: "f1" },
    { id: "nope", before: null },
  ]) {
    const res = await actions.reorder(args);
    assert.equal(res.ok, false, JSON.stringify(args));
    assert.equal(typeof res.error, "string");
  }
  assert.deepEqual(read(), original);
});

test("queue: hold, release and unpin commit their change", async () => {
  const { actions, items, commits } = setup();
  assert.equal((await actions.hold({ id: "f2" })).ok, true);
  assert.equal(item(items(), "f2").hold, true);
  assert.deepEqual(await actions.hold({ id: "f2" }), { ok: false, error: "f2 is already held" });
  assert.equal((await actions.release({ id: "f2" })).ok, true);
  assert.equal("hold" in item(items(), "f2"), false);
  assert.deepEqual(await actions.release({ id: "f2" }), { ok: false, error: "f2 isn't held" });
  assert.equal((await actions.unpin({ id: "pin" })).ok, true);
  assert.equal("on" in item(items(), "pin"), false);
  assert.deepEqual(await actions.unpin({ id: "pin" }), { ok: false, error: "pin isn't pinned" });
  assert.deepEqual(await actions.hold({ id: "nope" }), { ok: false, error: "no item nope in the schedule" });
  assert.deepEqual(commits(), ["queue: unpin pin", "queue: release f2", "queue: hold f2", "init"]);
});

test("queue: drop records dropped in state under the publish lock, and leaves the schedule alone", async () => {
  const { actions, store, read, original, commits, locks, deps } = setup();
  const res = await actions.drop({ id: "f1", platform: "instagram" });
  assert.equal(res.ok, true);
  assert.deepEqual(store.load().items.f1, { instagram: { status: "dropped", at: NOW.toISOString(), reason: "dropped in the console" } });
  assert.deepEqual(store.load().items.done, STATE.items.done, "the rest of the state is kept");
  assert.deepEqual(locks, [["publish", { waitMs: 3000 }]]);
  assert.deepEqual(read(), original);
  assert.deepEqual(commits(), ["init"]);
  assert.ok(deps.log.lines.some(([, msg, data]) => msg === "dashboard drop" && data.id === "f1" && data.platform === "instagram"));

  assert.equal((await actions.drop({ id: "f1", platform: "tiktok" })).ok, false);
  assert.deepEqual(await actions.drop({ id: "nope", platform: "instagram" }), { ok: false, error: "no item nope in the schedule" });
});

test("queue: a campaign's real lock and files, through queueDeps", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-campaigns-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-publisher-"));
  const campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "queue-campaign-"));
  makeRepo(campaignRoot, [{ id: "b1", kind: "ep", dir: "pieces/b1" }, { id: "b2", kind: "ep", dir: "pieces/b2" }]);
  fs.mkdirSync(path.join(root, "beta"));
  fs.writeFileSync(path.join(root, "beta", "campaign.json"), JSON.stringify({ id: "beta", name: "Beta", root: campaignRoot }));
  const campaign = getCampaign("beta", { root, home });
  const actions = () => createQueueActions({ campaign, deps: queueDeps({ campaign, secrets: createSecrets(home) }) });

  const res = await actions().hold({ id: "b2" });
  assert.equal(res.ok, true);
  assert.equal(git(campaignRoot, "log", "-1", "--format=%s"), "queue: hold b2");
  assert.ok(!fs.existsSync(path.join(home, "locks", "beta.schedule.lock")), "lock released");
  assert.equal((await actions().drop({ id: "b1", platform: "instagram" })).ok, true);
  assert.equal(createStateStore(campaign.home).load().items.b1.instagram.status, "dropped");

  // A build session holds beta's schedule lock.
  const lock = path.join(home, "locks", "beta.schedule.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  const before = fs.readFileSync(path.join(campaignRoot, "schedule.json"));
  const started = Date.now();
  const busy = await actions().release({ id: "b2" });
  assert.deepEqual(busy, { ok: false, error: "a build is running for Beta; try again when it finishes" });
  assert.ok(Date.now() - started < 3500);
  assert.deepEqual(fs.readFileSync(path.join(campaignRoot, "schedule.json")), before);
  assert.ok(fs.existsSync(lock), "the build's lock is left alone");
});

test("queue: drop is refused while the same campaign builds, and allowed while only another one does", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-campaigns-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-publisher-"));
  const campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "queue-campaign-"));
  makeRepo(campaignRoot, [{ id: "b1", kind: "ep", dir: "pieces/b1" }, { id: "b2", kind: "ep", dir: "pieces/b2" }]);
  fs.mkdirSync(path.join(root, "beta"));
  fs.writeFileSync(path.join(root, "beta", "campaign.json"), JSON.stringify({ id: "beta", name: "Beta", root: campaignRoot }));
  const campaign = getCampaign("beta", { root, home });
  const actions = () => createQueueActions({ campaign, deps: queueDeps({ campaign, secrets: createSecrets(home) }) });
  const hold = (id) => {
    const file = path.join(home, "locks", `${id}.creation.lock`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return file;
  };

  const own = hold("beta");
  assert.deepEqual(await actions().drop({ id: "b1", platform: "instagram" }), {
    ok: false,
    error: "a build is running for Beta; try again when it finishes",
  });
  assert.ok(!fs.existsSync(path.join(campaign.home, "state.json")), "beta's state is never written");
  fs.rmSync(own);

  hold("alpha");
  assert.equal((await actions().drop({ id: "b1", platform: "instagram" })).ok, true);
  assert.equal(createStateStore(campaign.home).load().items.b1.instagram.status, "dropped");
});
