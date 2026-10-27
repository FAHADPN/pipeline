import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../../publishing/lib/state.mjs";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { planDay } from "../../publishing/lib/planner.mjs";
import { createActions, campaignDeps } from "../lib/actions.mjs";
import { CONFIG } from "../../publishing/test/fixtures.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));

const TODAY = "2026-10-25"; // Sun
const MORNING = new Date("2026-10-25T04:30:00Z"); // 10:00 IST, outside the window

// Floating items f1..fn, plus a pinned one.
function F(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `f${i + 1}`, kind: "ep", dir: `x/f${i + 1}` }));
}

const captionOf = (id) => ({ instagram: `${id} first line\n\n#acme (link in bio)`, youtubeTitle: `${id} title #shorts` });

function fakeCheck(broken = []) {
  return (repoRoot, item) =>
    broken.includes(item.id)
      ? { ok: false, errors: ["no out/ folder"], warnings: [] }
      : { ok: true, assets: { video: `/videos/${item.id}.mp4` }, caption: captionOf(item.id), warnings: [] };
}

function fakeInstagram() {
  let n = 0;
  return {
    calls: [],
    async publishReel(args) {
      this.calls.push(["publishReel", args]);
      n++;
      return { mediaId: `M${n}`, url: `https://www.instagram.com/reel/r${n}/` };
    },
    async listMedia() {
      return [];
    },
  };
}

function fakeYouTube() {
  return {
    calls: [],
    async uploadShort(args) {
      this.calls.push(["uploadShort", args]);
      return { videoId: "V1", url: "https://youtube.com/shorts/V1" };
    },
    async listUploads() {
      return [];
    },
  };
}

function fakeTelegram() {
  return {
    sent: [],
    async send(text) {
      this.sent.push(text);
    },
  };
}

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

// A temp publisher home with `state`, and actions wired to fakes. Nothing reaches
// the network or Telegram.
function setup({ items = [...F(3), { id: "pin", kind: "special", dir: "x/pin", on: "2026-10-28" }], state, broken, config = CONFIG, now = MORNING } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  const store = createStateStore(home);
  if (state) store.save(state);
  const clients = { instagram: fakeInstagram(), youtube: fakeYouTube() };
  const deps = {
    home,
    repoRoot: "/repo",
    loadConfig: () => config,
    loadItems: () => items,
    store,
    client: (platform) => clients[platform],
    telegram: fakeTelegram(),
    log: fakeLog(),
    sleep: async () => {},
    // No real ngrok: a tunnel whose urls just name the files.
    servePublicly: async ({ files }) => ({
      urls: Object.fromEntries(files.map((f) => [f.name, `https://tunnel.test${f.path}`])),
      close: async () => {},
    }),
    check: fakeCheck(broken),
    now: () => now,
    lock: { pollMs: 5, waitMs: 5000 },
  };
  return { deps, clients, store, home, actions: createActions({ deps }) };
}

const publishes = (client) => client.calls.filter(([name]) => name === "publishReel" || name === "uploadShort");

test("post now posts the next queued item and notifies Telegram", async () => {
  const { actions, deps, clients, store, home } = setup({
    state: { version: 1, items: { f1: { instagram: { status: "posted", date: "2026-10-23", at: "x" } } } },
    broken: ["f2"],
  });
  const result = await actions.postNow({});

  // f1 is done and f2 fails its check, so the next queued item is f3.
  assert.equal(result.ok, true);
  assert.equal(result.id, "f3");
  assert.equal(result.platform, "instagram");
  assert.equal(result.outcome, "posted");
  assert.equal(result.url, "https://www.instagram.com/reel/r1/");
  assert.equal(publishes(clients.instagram).length, 1);
  assert.equal(publishes(clients.instagram)[0][1].videoUrl, "https://tunnel.test/videos/f3.mp4");
  assert.equal(publishes(clients.youtube).length, 0);

  const entry = store.load().items.f3.instagram;
  assert.equal(entry.status, "posted");
  assert.equal(entry.date, TODAY);

  assert.deepEqual(deps.telegram.sent, ["Posted via dashboard: f3 https://www.instagram.com/reel/r1/"]);
  assert.ok(deps.log.lines.some(([level, msg, data]) => level === "info" && msg === "dashboard post now" && data.id === "f3"));
  assert.ok(!fs.existsSync(path.join(home, "locks", "publish.lock")), "lock released");
});

test("post now refuses when the confirmed item is no longer next", async () => {
  const { actions, clients } = setup();
  const result = await actions.postNow({ id: "f2" });
  assert.equal(result.ok, false);
  assert.equal(result.next, "f1");
  assert.match(result.error, /f1/);
  assert.equal(publishes(clients.instagram).length, 0);

  assert.equal((await actions.postNow({ id: "f1" })).ok, true);
});

test("post now with nothing queued posts nothing", async () => {
  const { actions, deps, clients } = setup({ broken: ["f1", "f2", "f3"] });
  const result = await actions.postNow({});
  assert.equal(result.ok, false);
  assert.match(result.error, /nothing queued/);
  assert.equal(publishes(clients.instagram).length, 0);
  assert.deepEqual(deps.telegram.sent, []);
});

test("post now after today's post needs force", async () => {
  const { actions, deps, clients, store } = setup({
    state: { version: 1, items: { f1: { instagram: { status: "posted", date: TODAY, at: "x" } } } },
  });
  const refused = await actions.postNow({});
  assert.deepEqual(refused, { ok: false, needsForce: true, id: "f2", platform: "instagram" });
  assert.equal(publishes(clients.instagram).length, 0);
  assert.deepEqual(deps.telegram.sent, []);
  assert.equal(store.load().items.f2, undefined);

  // A post made by hand counts too.
  const manual = setup({ state: { version: 1, items: { f1: { instagram: { status: "manual", date: TODAY, at: "x" } } } } });
  assert.equal((await manual.actions.postNow({})).needsForce, true);

  const forced = await actions.postNow({ force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.id, "f2");
  assert.equal(publishes(clients.instagram).length, 1);
  assert.equal(store.load().items.f2.instagram.status, "posted");
  assert.deepEqual(deps.telegram.sent, ["Posted via dashboard: f2 https://www.instagram.com/reel/r1/"]);
});

test("post now skips a held item", async () => {
  const items = [{ id: "f1", kind: "ep", dir: "x/f1", hold: true }, ...F(3).slice(1)];
  const { actions } = setup({ items });
  const result = await actions.postNow({});
  assert.equal(result.ok, true);
  assert.equal(result.id, "f2");
});

test("actions: postItem posts a pinned future item and records it posted", async () => {
  const { actions, deps, clients, store } = setup();
  const result = await actions.postItem({ id: "pin" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "pin");
  assert.equal(result.platform, "instagram");
  assert.equal(result.outcome, "posted");
  assert.equal(publishes(clients.instagram).length, 1);
  assert.equal(publishes(clients.instagram)[0][1].videoUrl, "https://tunnel.test/videos/pin.mp4");
  const entry = store.load().items.pin.instagram;
  assert.equal(entry.status, "posted");
  assert.equal(entry.date, TODAY);
  assert.deepEqual(deps.telegram.sent, ["Posted via dashboard: pin https://www.instagram.com/reel/r1/"]);
  assert.ok(deps.log.lines.some(([level, msg, data]) => level === "info" && msg === "dashboard post item" && data.id === "pin"));

  // The same guards as postNow: already posted, failing its check, unknown, held.
  assert.match((await actions.postItem({ id: "pin" })).error, /pin is already posted on instagram/);
  const broken = setup({ broken: ["f2"] });
  assert.match((await broken.actions.postItem({ id: "f2" })).error, /f2 fails check: no out\/ folder/);
  assert.match((await broken.actions.postItem({ id: "nope" })).error, /no item nope in the schedule/);
  const held = setup({ items: [{ id: "f1", kind: "ep", dir: "x/f1", hold: true }] });
  assert.match((await held.actions.postItem({ id: "f1" })).error, /f1 is held/);
  assert.equal(publishes(broken.clients.instagram).length + publishes(held.clients.instagram).length, 0);
});

test("actions: postItem refuses an item outside its notBefore/notAfter window", async () => {
  const items = [
    { id: "later", kind: "ep", dir: "x/later", notBefore: "2026-10-30" },
    { id: "old", kind: "ep", dir: "x/old", notAfter: "2026-10-24" },
    { id: "both", kind: "ep", dir: "x/both", notBefore: "2026-10-27", notAfter: "2026-10-31" },
    { id: "open", kind: "ep", dir: "x/open", notBefore: "2026-10-25", notAfter: "2026-10-25" },
    { id: "f9", kind: "ep", dir: "x/f9" },
  ];
  // A floating post went out today: the window is still the reason, not needsForce.
  const { actions, clients, store } = setup({ items, state: { version: 1, items: { f9: { instagram: { status: "posted", date: TODAY, at: "x" } } } } });
  assert.deepEqual(await actions.postItem({ id: "later" }), { ok: false, error: "later can only post from 2026-10-30" });
  assert.deepEqual(await actions.postItem({ id: "old", force: true }), { ok: false, error: "old can only post until 2026-10-24" });
  assert.deepEqual(await actions.postItem({ id: "both" }), { ok: false, error: "both can only post between 2026-10-27 and 2026-10-31" });
  assert.equal(publishes(clients.instagram).length, 0);
  assert.equal(store.load().items.later, undefined);

  // Both bounds are inclusive: today's own window posts.
  assert.equal((await actions.postItem({ id: "open", force: true })).ok, true);
});

test("actions: a pinned item posted early through postItem leaves its date to the floating queue", async () => {
  const { actions, deps, store } = setup();
  assert.equal((await actions.postItem({ id: "pin" })).ok, true);
  const items = deps.loadItems();
  const plan = planDay({ today: "2026-10-28", minutesNow: 1170, items, state: store.load(), ready: new Set(items.map((i) => i.id)), config: CONFIG });
  assert.deepEqual(plan.posts, [{ id: "f1", platform: "instagram", why: "queue" }]);
});

test("actions: postItem without force after any post today returns needsForce, a pinned one included", async () => {
  const { actions, clients, store } = setup({
    state: { version: 1, items: { f1: { instagram: { status: "posted", date: TODAY, at: "x" } } } },
  });
  const refused = await actions.postItem({ id: "f3" });
  assert.deepEqual(refused, { ok: false, needsForce: true, id: "f3", platform: "instagram" });
  assert.equal(publishes(clients.instagram).length, 0);
  assert.equal(store.load().items.f3, undefined);

  const forced = await actions.postItem({ id: "f3", force: true });
  assert.equal(forced.ok, true);
  assert.equal(store.load().items.f3.instagram.status, "posted");

  // A pinned post today counts too: it asks first.
  const pinned = setup({
    items: [{ id: "today", kind: "special", dir: "x/today", on: TODAY }, ...F(2)],
    state: { version: 1, items: { today: { instagram: { status: "posted", date: TODAY, at: "x" } } } },
  });
  assert.deepEqual(await pinned.actions.postItem({ id: "f2" }), { ok: false, needsForce: true, id: "f2", platform: "instagram" });
  assert.equal(publishes(pinned.clients.instagram).length, 0);
  assert.equal((await pinned.actions.postItem({ id: "f2", force: true })).ok, true);

  // Post now still asks only after a floating post, as today's button does.
  const next = setup({
    items: [{ id: "today", kind: "special", dir: "x/today", on: TODAY }, ...F(2)],
    state: { version: 1, items: { today: { instagram: { status: "posted", date: TODAY, at: "x" } } } },
  });
  assert.equal((await next.actions.postNow({})).ok, true);
});

test("post now waits for the publish lock", async () => {
  const { actions, clients, store, home } = setup();
  // The 19:30 run holds the lock.
  const lock = path.join(home, "locks", "publish.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: new Date().toISOString() }));

  let settled = false;
  const pending = actions.postNow({}).finally(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(settled, false, "waits while the run holds the lock");
  assert.equal(publishes(clients.instagram).length, 0);

  // The run posts f1, then releases the lock.
  store.save({ version: 1, items: { f1: { instagram: { status: "posted", date: TODAY, at: "x" } } } });
  fs.rmSync(lock);

  const result = await pending;
  assert.equal(result.needsForce, true, "sees the run's post once it has the lock");
  assert.equal(result.id, "f2");
  assert.equal(publishes(clients.instagram).length, 0);
});

test("a lock that stays busy is an error, and nothing posts", async () => {
  const { deps, clients, home } = setup();
  const lock = path.join(home, "locks", "publish.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  const actions = createActions({ deps: { ...deps, lock: { pollMs: 5, waitMs: 30 } } });

  const result = await actions.postNow({});
  assert.equal(result.ok, false);
  assert.match(result.error, /lock publish busy/);
  assert.equal(publishes(clients.instagram).length, 0);
  assert.ok(fs.existsSync(lock), "someone else's lock is left alone");
});

test("retry posts the failed item on that platform only", async () => {
  const config = structuredClone(CONFIG);
  config.platforms.youtube.enabled = true;
  const failed = { status: "failed", error: "processing failed", attempts: 2, at: "x" };
  const { actions, deps, clients, store } = setup({
    config,
    state: { version: 1, items: { f2: { instagram: failed, youtube: failed } } },
  });

  const result = await actions.retry({ id: "f2", platform: "youtube" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "f2");
  assert.equal(result.platform, "youtube");
  assert.equal(result.url, "https://youtube.com/shorts/V1");
  assert.equal(publishes(clients.youtube).length, 1);
  assert.equal(publishes(clients.instagram).length, 0);

  const saved = store.load().items.f2;
  assert.equal(saved.youtube.status, "posted");
  assert.deepEqual(saved.instagram, failed, "the other platform is untouched");
  assert.deepEqual(deps.telegram.sent, ["Posted via dashboard: f2 https://youtube.com/shorts/V1"]);
  assert.ok(deps.log.lines.some(([, msg, data]) => msg === "dashboard retry" && data.platform === "youtube"));
});

test("retry refuses an item that hasn't failed there, and a disabled platform", async () => {
  const failed = { status: "failed", error: "boom", attempts: 2, at: "x" };
  const { actions, deps, clients } = setup({
    state: { version: 1, items: { f1: { instagram: { status: "posted", date: "2026-10-20", at: "x" } }, f2: { youtube: failed } } },
  });
  for (const args of [
    { id: "f1", platform: "instagram" },
    { id: "f3", platform: "instagram" },
    { id: "f2", platform: "youtube" },
    { id: "nope", platform: "instagram" },
    { id: "f2", platform: "tiktok" },
  ]) {
    const result = await actions.retry(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(typeof result.error, "string");
  }
  assert.equal(publishes(clients.instagram).length + publishes(clients.youtube).length, 0);
  assert.deepEqual(deps.telegram.sent, []);
});

test("a failed post is reported on Telegram", async () => {
  const { actions, deps, clients } = setup({ state: { version: 1, items: { f1: { instagram: { status: "failed", error: "x", at: "x" } } } } });
  clients.instagram.publishReel = async () => {
    throw new Error("processing failed: ERROR");
  };
  const result = await actions.retry({ id: "f1", platform: "instagram" });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failed");
  assert.equal(result.error, "processing failed: ERROR");
  assert.deepEqual(deps.telegram.sent, ["❌ Dashboard post failed: f1 (instagram): processing failed: ERROR"]);
});

test("a Telegram failure doesn't fail the action", async () => {
  const { actions, deps } = setup();
  deps.telegram.send = async () => {
    throw new Error("telegram: Bad Request");
  };
  const result = await actions.postNow({});
  assert.equal(result.ok, true);
  assert.ok(deps.log.lines.some(([level, msg]) => level === "error" && msg === "telegram send failed"));
});

// Two campaigns under a temp campaigns root and publisher home, each with its own
// schedule, secrets and bot. Clients and Telegram are fakes made per credential.
function setupCampaigns() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-campaigns-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  const secrets = createSecrets(home);
  for (const id of ["alpha", "beta"]) {
    const campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), `campaign-${id}-`));
    const items = [1, 2].map((n) => ({ id: `${id[0]}${n}`, kind: "ep", dir: `pieces/${id[0]}${n}` }));
    fs.writeFileSync(path.join(campaignRoot, "schedule.json"), JSON.stringify(items));
    for (const item of items) fs.mkdirSync(path.join(campaignRoot, item.dir), { recursive: true });
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, "campaign.json"), JSON.stringify({ id, name: id.toUpperCase(), root: campaignRoot, approvers: ["111"] }));
    secrets.set(id, "IG_ACCESS_TOKEN", `token-${id}`);
    secrets.set(id, "IG_USER_ID", `user-${id}`);
    secrets.set(id, "TELEGRAM_BOT_TOKEN", `bot-${id}`);
  }
  const made = { instagram: [], telegram: [] };
  const make = {
    instagram(args) {
      const client = { ...fakeInstagram(), args };
      made.instagram.push(client);
      return client;
    },
    telegram(args) {
      const bot = { ...fakeTelegram(), args };
      made.telegram.push(bot);
      return bot;
    },
  };
  const ownerEnv = { TELEGRAM_BOT_TOKEN: "bot-owner", TELEGRAM_CHAT_ID: "999" };
  const actionsFor = (id, extra = {}) => {
    const campaign = getCampaign(id, { root, home });
    const deps = campaignDeps({ campaign, secrets, ownerEnv, make });
    return {
      campaign,
      actions: createActions({
        deps: {
          ...deps,
          check: fakeCheck(),
          now: () => MORNING,
          lock: { pollMs: 5, waitMs: 5000 },
          servePublicly: async ({ files }) => ({
            urls: Object.fromEntries(files.map((f) => [f.name, `https://tunnel.test${f.path}`])),
            close: async () => {},
          }),
          ...extra,
        },
      }),
    };
  };
  return { home, made, actionsFor };
}

test("actions are routed to the named campaign", async () => {
  const { home, made, actionsFor } = setupCampaigns();
  const beta = actionsFor("beta");
  const result = await beta.actions.postNow({ id: "b1" });

  assert.equal(result.ok, true);
  assert.equal(result.id, "b1");
  // Beta's own token, state and log; alpha and the top of the publisher home untouched.
  const posting = made.instagram.filter((c) => publishes(c).length);
  assert.equal(posting.length, 1);
  assert.deepEqual(posting[0].args, { token: "token-beta", userId: "user-beta", graphVersion: "v24.0" });
  assert.equal(createStateStore(beta.campaign.home).load().items.b1.instagram.status, "posted");
  assert.ok(fs.existsSync(path.join(beta.campaign.home, "logs")));
  assert.ok(!fs.existsSync(path.join(home, "campaigns", "alpha")), "alpha untouched");
  assert.ok(!fs.existsSync(path.join(home, "state.json")));
  assert.ok(!fs.existsSync(path.join(home, "logs")));
  // The dashboard's notice goes to the owner chat, labelled, never to beta's approvers.
  const sent = made.telegram.filter((b) => b.sent.length);
  assert.deepEqual(sent.map((b) => b.args), [{ token: "bot-owner", chatId: "999" }]);
  assert.deepEqual(sent[0].sent, ["[BETA] Posted via dashboard: b1 https://www.instagram.com/reel/r1/"]);

  // Beta's publish lock is "beta:publish" in the shared home: holding it stops beta, not alpha.
  const lock = path.join(home, "locks", "beta.publish.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  const busy = await actionsFor("beta", { lock: { pollMs: 5, waitMs: 30 } }).actions.postNow({});
  assert.equal(busy.ok, false);
  assert.match(busy.error, /lock beta:publish busy/);
  const alpha = await actionsFor("alpha").actions.postNow({});
  assert.equal(alpha.ok, true);
  assert.equal(alpha.id, "a1");
  assert.ok(fs.existsSync(lock), "beta's lock is left alone");

  // A disabled platform names the campaign's file.
  const retry = await actionsFor("alpha").actions.retry({ id: "a2", platform: "youtube" });
  assert.match(retry.error, /youtube is disabled in alpha's campaign\.json/);
});

test("postItem, postNow and retry are refused while the same campaign builds, and allowed while only another one does", async () => {
  const { home, made, actionsFor } = setupCampaigns();
  const lock = path.join(home, "locks", "beta.creation.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const building = { ok: false, error: "a build is running for BETA; try again when it finishes" };

  const beta = actionsFor("beta");
  const stateFile = path.join(beta.campaign.home, "state.json");
  assert.deepEqual(await beta.actions.postItem({ id: "b2" }), building);
  assert.deepEqual(await beta.actions.postNow({}), building);
  assert.deepEqual(await beta.actions.retry({ id: "b1", platform: "instagram" }), building);
  assert.ok(!fs.existsSync(stateFile), "beta's state is never written");
  assert.equal(made.instagram.filter((c) => publishes(c).length).length, 0);

  const alpha = await actionsFor("alpha").actions.postItem({ id: "a2" });
  assert.equal(alpha.ok, true, alpha.error);
  assert.ok(fs.existsSync(lock), "the build's lock is left alone");
});

test("a campaign posts through its own schedule, state, token and lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-campaigns-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-repo-"));
  const items = ["f1", "f2"].map((id) => ({ id, kind: "ep", dir: `pieces/${id}` }));
  fs.writeFileSync(path.join(repoRoot, "schedule.json"), JSON.stringify(items));
  for (const item of items) fs.mkdirSync(path.join(repoRoot, item.dir), { recursive: true });
  fs.mkdirSync(path.join(root, "acme"));
  fs.writeFileSync(path.join(root, "acme", "campaign.json"), JSON.stringify({ id: "acme", name: "Acme Coffee", root: repoRoot }));
  const secrets = createSecrets(home);
  secrets.set("acme", "IG_ACCESS_TOKEN", "token-acme");
  secrets.set("acme", "IG_USER_ID", "user-acme");
  const campaign = getCampaign("acme", { root, home });
  const made = [];
  const make = {
    instagram(args) {
      const client = { ...fakeInstagram(), args };
      made.push(client);
      return client;
    },
  };
  const actionsWith = (lock) => createActions({
    deps: {
      ...campaignDeps({ campaign, secrets, make }),
      check: fakeCheck(),
      now: () => MORNING,
      lock,
      servePublicly: async ({ files }) => ({ urls: Object.fromEntries(files.map((f) => [f.name, `https://tunnel.test${f.path}`])), close: async () => {} }),
    },
  });

  const result = await actionsWith({ pollMs: 5, waitMs: 5000 }).postNow({ id: "f1" });
  assert.equal(result.ok, true);
  assert.deepEqual(made.filter((c) => publishes(c).length).map((c) => c.args), [{ token: "token-acme", userId: "user-acme", graphVersion: "v24.0" }]);
  assert.equal(createStateStore(campaign.home).load().items.f1.instagram.status, "posted");
  assert.ok(!fs.existsSync(path.join(home, "state.json")), "nothing is written at the top of the publisher home");

  // Its publish lock is "acme:publish", the one its scheduler loop takes.
  fs.mkdirSync(path.join(home, "locks"), { recursive: true });
  fs.writeFileSync(path.join(home, "locks", "acme.publish.lock"), JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  const busy = await actionsWith({ pollMs: 5, waitMs: 30 }).postNow({});
  assert.match(busy.error, /lock acme:publish busy/);
});

test("an Instagram error quoting the token comes back and is logged as [redacted], the owner's bot token too", async () => {
  const { made, actionsFor } = setupCampaigns();
  const leaky = {
    async publishReel() {
      throw new Error("Instagram 400 on https://graph.facebook.com/v24.0/me/media?access_token=token-beta (owner bot bot-owner)");
    },
    async listMedia() {
      return [];
    },
  };
  const beta = actionsFor("beta", { client: () => leaky, sleep: async () => {} });

  for (const res of [await beta.actions.postItem({ id: "b1" }), await beta.actions.postNow({})]) {
    assert.equal(res.ok, false);
    assert.match(res.error, /access_token=\[redacted\] \(owner bot \[redacted\]\)/);
  }
  const logs = path.join(beta.campaign.home, "logs");
  const logged = fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), "utf8")).join("");
  assert.match(logged, /dashboard post item/);
  assert.match(logged, /access_token=\[redacted\]/);
  assert.ok(!logged.includes("token-beta") && !logged.includes("bot-owner"), logged);
  const notices = made.telegram.flatMap((b) => b.sent).join("\n");
  assert.ok(!notices.includes("token-beta") && !notices.includes("bot-owner"), notices);
});

test("postNow and postItem are refused while Instagram is disabled, as retry is", async () => {
  const config = { ...CONFIG, platforms: { ...CONFIG.platforms, instagram: { ...CONFIG.platforms.instagram, enabled: false } } };
  const { actions, clients, store } = setup({ config });
  const disabled = { ok: false, error: "instagram is disabled in publishing/config.json" };
  assert.deepEqual(await actions.postNow({}), disabled);
  assert.deepEqual(await actions.postItem({ id: "f1" }), disabled);
  assert.deepEqual(await actions.postItem({ id: "f1", force: true }), disabled);
  assert.deepEqual(await actions.retry({ id: "f1", platform: "instagram" }), disabled);
  assert.equal(publishes(clients.instagram).length, 0);
  assert.deepEqual(store.load().items, {});
});
