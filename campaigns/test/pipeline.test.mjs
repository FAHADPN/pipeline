import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCampaign } from "../lib/campaign.mjs";
import { createSecrets } from "../lib/secrets.mjs";
import { buildPublishDeps } from "../../publishing/lib/campaign-deps.mjs";
import { buildCreationDeps } from "../../creation/lib/campaign-deps.mjs";
import { createCreationStore, itemState } from "../../creation/lib/cstate.mjs";
import { createNightly, loadActive, main, publishTick, shareBuilds, telegramTick } from "../pipeline.mjs";
import { buildPipelineTasks, CREATION_TASK, PUBLISH_TASK, TELEGRAM_TASK } from "../install-tasks.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
process.env.PIPELINE_CAMPAIGNS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "campaigns-root-"));

const OWNER_ENV = { TELEGRAM_BOT_TOKEN: "bot-owner", TELEGRAM_CHAT_ID: "999" };

// Sun 25 Oct 2026. London is on GMT from 01:00 UTC that day.
const at = (iso) => new Date(iso);
const IST_1915 = at("2026-10-25T13:45:00Z");
const IST_1930 = at("2026-10-25T14:00:00Z"); // 14:00 in London
const LONDON_1930 = at("2026-10-25T19:30:00Z"); // 01:00 IST on Mon 26 Oct
const minutesAfter = (date, n) => new Date(date.getTime() + n * 60000);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writePiece(root, dir, line) {
  const out = path.join(root, dir, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "piece.mp4"), "video");
  fs.writeFileSync(path.join(out, "piece-cover.png"), "cover");
  fs.writeFileSync(path.join(out, "piece-caption.txt"), `INSTAGRAM / TIKTOK\n${line}\n\n#test\n\nYOUTUBE SHORTS TITLE\n${line} #shorts\n`);
}

function entry(id, targetDate) {
  return { id, kind: "post", format: "episode", type: "story", title: `Title of ${id}`, premise: `Premise of ${id}.`, targetDate, hook: 3, reference: "starter" };
}

// Two campaigns in temp dirs:
//  - acme: a campaign in London at 19:30 local, with the default layout
//  - globex: a campaign on the default time zone (IST) and slot (19:30), with its
//    schedule and pieces in folders of its own
// Each has a two-item queue and its own Instagram token and bot; acme has a build list.
function setup(t, { globex = {}, acme = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "campaigns");
  const home = path.join(tmp, "home");

  const globexRoot = path.join(tmp, "globex-root");
  writeJson(path.join(globexRoot, "publishing", "schedule.json"), [
    { id: "g-one", kind: "ep", dir: "reels/g-one" },
    { id: "g-two", kind: "ep", dir: "reels/g-two" },
  ]);
  writePiece(globexRoot, "reels/g-one", "Globex Tea a");
  writePiece(globexRoot, "reels/g-two", "Globex Tea b");
  writeJson(path.join(root, "globex", "campaign.json"), {
    id: "globex",
    name: "Globex Tea",
    root: globexRoot,
    approvers: ["900"],
    paths: { schedule: "publishing/schedule.json", piecesDir: "reels" },
    ...globex,
  });

  const acmeRoot = path.join(tmp, "acme-root");
  writeJson(path.join(acmeRoot, "schedule.json"), [
    { id: "a-one", kind: "post", dir: "pieces/a-one" },
    { id: "a-two", kind: "post", dir: "pieces/a-two" },
  ]);
  writePiece(acmeRoot, "pieces/a-one", "Acme one");
  writePiece(acmeRoot, "pieces/a-two", "Acme two");
  writeJson(path.join(acmeRoot, "backlog.json"), [entry("a-three", "2026-11-02"), entry("a-four", "2026-11-03")]);
  writeJson(path.join(root, "acme", "campaign.json"), {
    id: "acme",
    name: "Acme Coffee",
    root: acmeRoot,
    timezone: "Europe/London",
    slot: "19:30",
    approvers: ["111"],
    ...acme,
  });

  const secrets = createSecrets(home);
  for (const id of ["globex", "acme"]) {
    secrets.set(id, "IG_ACCESS_TOKEN", `ig-${id}`);
    secrets.set(id, "IG_USER_ID", "1");
    secrets.set(id, "IG_ISSUED_AT", "2026-10-20T14:00:00.000Z");
    secrets.set(id, "TELEGRAM_BOT_TOKEN", `bot-${id}`);
  }
  const campaigns = () => ["acme", "globex"].map((id) => getCampaign(id, { root, home }));
  return { tmp, root, home, secrets, campaigns };
}

// Fake clients: they record every call and never touch the network.
function fakes() {
  const calls = [];
  const bots = [];
  const updates = {};
  let n = 0;
  const make = {
    instagram(opts) {
      const rec = (method) => calls.push({ client: "instagram", token: opts.token, method });
      return {
        async listMedia() {
          rec("listMedia");
          return [];
        },
        async publishReel() {
          rec("publishReel");
          n++;
          return { mediaId: `M${n}`, url: `https://www.instagram.com/reel/${opts.token}-${n}/` };
        },
        async refreshToken() {
          rec("refreshToken");
          return { token: `${opts.token}-refreshed` };
        },
      };
    },
    youtube(opts) {
      return { opts };
    },
    telegram({ token, chatId }) {
      const bot = { token, chatId, sent: [], offsets: [] };
      const say = (text) => {
        bot.sent.push(text);
        calls.push({ client: "telegram", token, method: "send" });
      };
      Object.assign(bot, {
        send: async (text) => say(text),
        sendMessage: async (text) => say(text),
        sendVideo: async ({ caption }) => say(caption),
        answerCallbackQuery: async (id, text) => say(text),
        async getUpdates({ offset } = {}) {
          bot.offsets.push(offset);
          calls.push({ client: "telegram", token, method: "getUpdates", offset });
          return (updates[token] ?? []).filter((u) => offset === undefined || u.update_id >= offset);
        },
      });
      bots.push(bot);
      return bot;
    },
  };
  const sentBy = (token) => bots.filter((b) => b.token === token).flatMap((b) => b.sent);
  const posts = () => calls.filter((c) => c.method === "publishReel").map((c) => c.token);
  return { make, calls, bots, updates, sentBy, posts };
}

const fakeServe = async ({ files }) => ({
  urls: Object.fromEntries(files.map((f) => [f.name, `https://t.ngrok-free.app/s/${f.name}`])),
  async close() {},
});

function publishDepsFor(w, f) {
  return (campaign) => ({
    ...buildPublishDeps(campaign, { secrets: w.secrets, ownerEnv: OWNER_ENV, make: f.make }),
    servePublicly: fakeServe,
    sleep: async () => {},
  });
}

const tick = (w, f, now, extra = {}) =>
  publishTick({ campaigns: w.campaigns(), now, depsFor: publishDepsFor(w, f), ...extra });

test("tick before the slot does nothing", async (t) => {
  const w = setup(t);
  const f = fakes();
  const results = await tick(w, f, IST_1915);
  assert.deepEqual(results.map((r) => [r.id, r.outcome]), [["acme", "early"], ["globex", "early"]]);
  assert.deepEqual(f.calls, []);
  assert.ok(!fs.existsSync(path.join(w.home, "campaigns", "globex", "state.json")));
});

test("tick inside the window posts once, later ticks post nothing", async (t) => {
  const w = setup(t);
  const f = fakes();
  const first = await tick(w, f, IST_1930);
  assert.equal(first.find((r) => r.id === "globex").outcome, "ran");
  assert.deepEqual(f.posts(), ["ig-globex"]);
  assert.equal(f.sentBy("bot-globex").length, 1);
  assert.match(f.sentBy("bot-globex")[0], /^Globex Tea · Sun 25 Oct\n✅ Instagram: g-one/);

  // Every 15 minutes until the window closes, and on into the night.
  for (let m = 15; m <= 240; m += 15) {
    const later = await tick(w, f, minutesAfter(IST_1930, m));
    assert.equal(later.find((r) => r.id === "globex").outcome, "done today");
  }
  assert.deepEqual(f.posts(), ["ig-globex"]);
  assert.equal(f.sentBy("bot-globex").length, 1);

  // Even without the once-a-day marker, the run's own rule posts nothing more today.
  fs.rmSync(path.join(w.home, "campaigns", "globex", "publish-day.json"));
  const again = await tick(w, f, minutesAfter(IST_1930, 30));
  assert.deepEqual(again.find((r) => r.id === "globex").result.posted, []);
  assert.deepEqual(f.posts(), ["ig-globex"]);

  // The next posting day posts the next item.
  const tomorrow = await tick(w, f, minutesAfter(IST_1930, 24 * 60));
  assert.deepEqual(tomorrow.find((r) => r.id === "globex").result.posted.map((p) => p.id), ["g-two"]);
});

test("a run that starts after the window reports late once, with the campaign's own times", async (t) => {
  const w = setup(t, { acme: { slot: "17:00", lateLimitMinutes: 60 } });
  const f = fakes();
  const late = at("2026-10-25T18:15:00Z"); // 18:15 in London, 23:45 IST
  const [acme, globex] = await tick(w, f, late);
  assert.equal(acme.outcome, "ran");
  assert.equal(acme.result.window, "late");
  assert.equal(globex.result.window, "late");
  assert.deepEqual(f.posts(), []);
  assert.match(f.sentBy("bot-acme")[0], /⏰ Started after 18:00: nothing posted today\./);
  assert.match(f.sentBy("bot-globex")[0], /⏰ Started after 21:30: nothing posted today\./);
  await tick(w, f, minutesAfter(late, 10));
  assert.equal(f.sentBy("bot-acme").length, 1);
});

test("different timezones open at different times", async (t) => {
  const w = setup(t);
  const f = fakes();
  const india = await tick(w, f, IST_1930);
  assert.deepEqual(india.map((r) => [r.id, r.outcome]), [["acme", "early"], ["globex", "ran"]]);
  assert.deepEqual(f.posts(), ["ig-globex"]);

  // 19:30 in London is 01:00 on Monday in India: early there again.
  const london = await tick(w, f, LONDON_1930);
  assert.deepEqual(london.map((r) => [r.id, r.outcome]), [["acme", "ran"], ["globex", "early"]]);
  assert.deepEqual(f.posts(), ["ig-globex", "ig-acme"]);

  const stateOf = (id) => JSON.parse(fs.readFileSync(path.join(w.home, "campaigns", id, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(stateOf("globex").items), ["g-one"]);
  assert.deepEqual(Object.keys(stateOf("acme").items), ["a-one"]);
  assert.equal(stateOf("acme").items["a-one"].instagram.date, "2026-10-25");
});

test("paused campaign never posts or builds", async (t) => {
  const w = setup(t, { acme: { paused: true, slot: "14:00" } });
  const f = fakes();
  const results = await tick(w, f, IST_1930); // 14:00 in London: acme's window, were it running
  assert.deepEqual(results.map((r) => [r.id, r.outcome]), [["acme", "paused"], ["globex", "ran"]]);
  assert.deepEqual(f.posts(), ["ig-globex"]);
  assert.deepEqual(f.sentBy("bot-acme"), []);

  const built = [];
  const depsAsked = [];
  const nightly = await createNightly({
    campaigns: w.campaigns(),
    now: IST_1930,
    maxTotal: 3,
    depsFor: (c) => {
      depsAsked.push(c.id);
      return fakeCreationDeps(c.id, ["one", "two"]);
    },
    runNightly: async ({ deps, maxBuilds }) => {
      built.push([deps.campaign.id, maxBuilds]);
      return { built: [], failed: [] };
    },
  });
  assert.deepEqual(depsAsked, ["globex"]);
  assert.deepEqual(built, [["globex", 2]]);
  assert.deepEqual(nightly.map((r) => [r.id, r.outcome]), [["acme", "paused"], ["globex", "ran"]]);
});

// Creation deps with a build list of `todo` ids and nothing awaiting approval.
function fakeCreationDeps(id, ids, { maxBuilds = 2, maxAwaiting = 6, awaiting = 0 } = {}) {
  const items = {};
  for (let i = 0; i < awaiting; i++) items[`waiting-${i}`] = { status: "awaiting-approval", attempts: 0 };
  const alerts = [];
  return {
    campaign: { id },
    name: id,
    backlog: ids.map((x, i) => ({ ...entry(`${id}-${x}`, `2026-11-${String(i + 1).padStart(2, "0")}`) })),
    store: { load: () => ({ items }) },
    picker: { formats: ["episode"], maxBuilds, maxAwaiting },
    telegram: {},
    alerts: { sendMessage: async (text) => void alerts.push(text) },
    alertsSent: alerts,
    log: { info() {}, error() {} },
  };
}

test("round-robin shares the build cap", async (t) => {
  const w = setup(t);
  // Three campaigns wanting 2, 3 and 1 builds; 4 builds tonight in all.
  const campaigns = [...w.campaigns(), { ...w.campaigns()[0], id: "third", name: "Third", paused: false }];
  const want = { acme: ["a", "b"], globex: ["a", "b", "c"], third: ["a"] };
  const caps = { acme: 2, globex: 3, third: 2 };
  const made = {};
  const run = (now) => {
    const ran = [];
    return createNightly({
      campaigns,
      now,
      maxTotal: 4,
      depsFor: (c) => (made[c.id] = fakeCreationDeps(c.id, want[c.id], { maxBuilds: caps[c.id] })),
      runNightly: async ({ deps, maxBuilds, maxAwaiting, formats }) => {
        ran.push([deps.campaign.id, maxBuilds]);
        assert.equal(maxAwaiting, 6);
        assert.deepEqual(formats, ["episode"]);
        return { built: [], failed: [] };
      },
    }).then((results) => ({ ran, results }));
  };

  const night1 = await run(at("2026-10-24T20:30:00Z"));
  const total = (ran) => ran.reduce((s, [, n]) => s + n, 0);
  assert.equal(total(night1.ran), 4);
  for (const [id, n] of night1.ran) assert.ok(n <= caps[id] && n <= want[id].length, `${id} got ${n}`);
  // Every campaign that wants work gets at least one build when the cap allows it.
  assert.deepEqual(night1.ran.map(([id]) => id).sort(), ["acme", "globex", "third"]);

  // A cap of 2 for three campaigns: who misses out rotates night by night.
  const left = [];
  for (const day of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
    const ran = [];
    const results = await createNightly({
      campaigns,
      now: at(`${day}T20:30:00Z`),
      maxTotal: 2,
      depsFor: (c) => (made[c.id] = fakeCreationDeps(c.id, want[c.id], { maxBuilds: caps[c.id] })),
      runNightly: async ({ deps, maxBuilds }) => {
        ran.push([deps.campaign.id, maxBuilds]);
        return { built: [], failed: [] };
      },
    });
    assert.equal(total(ran), 2);
    const deferred = results.filter((r) => r.outcome === "deferred").map((r) => r.id);
    assert.equal(deferred.length, 1);
    left.push(deferred[0]);
    // The campaign left out is told why, through the owner chat.
    assert.match(made[deferred[0]].alertsSent[0], /cap of 2 builds/);
  }
  assert.equal(new Set(left).size, 3);

  // Each campaign's own caps still hold.
  assert.deepEqual(shareBuilds([2, 3, 1], 10, 0), [2, 3, 1]);
  assert.deepEqual(shareBuilds([0, 5], 3, 0), [0, 3]);
  assert.deepEqual(shareBuilds([2, 2], 3, 1), [1, 2]);
});

test("a campaign at its awaiting limit builds nothing and leaves the cap to others", async (t) => {
  const w = setup(t);
  const ran = [];
  await createNightly({
    campaigns: w.campaigns(),
    now: at("2026-10-24T20:30:00Z"),
    maxTotal: 3,
    depsFor: (c) => fakeCreationDeps(c.id, ["a", "b", "c"], { maxBuilds: 3, maxAwaiting: 2, awaiting: c.id === "acme" ? 2 : 0 }),
    runNightly: async ({ deps, maxBuilds }) => {
      ran.push([deps.campaign.id, maxBuilds]);
      return { built: [], failed: [], skipped: maxBuilds ? undefined : "2 await approval" };
    },
  });
  // acme still runs (its summary says why it built nothing), with no builds.
  assert.deepEqual(ran, [["acme", 0], ["globex", 3]]);
});

test("telegram tick keeps a separate offset per campaign", async (t) => {
  const w = setup(t);
  const f = fakes();
  // Each campaign's piece is waiting for approval.
  const acme = w.campaigns()[0];
  createCreationStore(acme.home).save({ items: { "a-three": { status: "awaiting-approval", attempts: 0 } } });
  const tap = (update_id, chat, data) => ({ update_id, callback_query: { id: `q${update_id}`, data, message: { chat: { id: chat } } } });
  f.updates["bot-acme"] = [tap(10, 111, "redo:a-three"), tap(11, 555, "redo:a-three")];
  f.updates["bot-globex"] = [{ update_id: 500, message: { chat: { id: 900 }, text: "hello" } }];

  const depsFor = (c) => buildCreationDeps(c, { secrets: w.secrets, ownerEnv: OWNER_ENV, make: { telegram: f.make.telegram } });
  const botOf = (c) => w.secrets.get(c.id, "TELEGRAM_BOT_TOKEN") ?? OWNER_ENV.TELEGRAM_BOT_TOKEN;
  await telegramTick({ campaigns: w.campaigns(), depsFor, botOf });

  const offsetOf = (id) => JSON.parse(fs.readFileSync(path.join(w.home, "campaigns", id, "telegram-offset.json"), "utf8")).offset;
  assert.equal(offsetOf("acme"), 12);
  assert.equal(offsetOf("globex"), 501);
  // acme's approver asked for a redo; the stranger's tap was ignored.
  assert.equal(createCreationStore(acme.home).load().pendingNote, "a-three");
  assert.deepEqual(f.sentBy("bot-globex"), []);

  // The next tick asks each bot from its own offset.
  await telegramTick({ campaigns: w.campaigns(), depsFor, botOf });
  const asked = (token) => f.calls.filter((c) => c.token === token && c.method === "getUpdates").map((c) => c.offset);
  assert.deepEqual(asked("bot-acme"), [undefined, 12]);
  assert.deepEqual(asked("bot-globex"), [undefined, 501]);
});

test("pipeline telegram-tick: never starts queued work", async (t) => {
  const w = setup(t);
  const f = fakes();
  // A queue the build queue's runner would change: an entry whose piece is gone is
  // dropped on sight. The tick runs as S4U, where a build can't run, so it must leave it.
  const queue = JSON.stringify([{ id: "k-gone", kind: "build", queuedAt: "2026-10-25T10:00:00.000Z" }]);
  for (const id of ["acme", "globex"]) writeJson(path.join(w.home, "campaigns", id, "build-queue.json"), JSON.parse(queue));
  const code = await main(["telegram-tick"], { root: w.root, home: w.home, make: f.make, ownerEnv: OWNER_ENV, print() {} });
  assert.equal(code, 0);
  for (const id of ["acme", "globex"]) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.home, "campaigns", id, "build-queue.json"), "utf8")), JSON.parse(queue), id);
  }
  assert.doesNotMatch(fs.readFileSync(new URL("../pipeline.mjs", import.meta.url), "utf8"), /startNextQueued|build-queue/);
});

test("campaigns sharing the owner's bot each get only their own taps", async (t) => {
  const w = setup(t, { globex: { approvers: ["999"] }, acme: { approvers: ["999", "111"] } });
  w.secrets.remove("acme", "TELEGRAM_BOT_TOKEN");
  w.secrets.set("globex", "TELEGRAM_BOT_TOKEN", "bot-owner");
  const f = fakes();
  const acme = w.campaigns()[0];
  createCreationStore(acme.home).save({ items: { "a-three": { status: "awaiting-approval", attempts: 0 } } });
  writeJson(path.join(w.home, "campaigns", "globex", "telegram-offset.json"), { offset: 7 });
  const tap = (update_id, data) => ({ update_id, callback_query: { id: `q${update_id}`, data, message: { chat: { id: 999 } } } });
  f.updates["bot-owner"] = [tap(5, "redo:a-three"), tap(7, "redo:a-three"), tap(8, "redo:a-four")];

  const depsFor = (c) => buildCreationDeps(c, { secrets: w.secrets, ownerEnv: OWNER_ENV, make: { telegram: f.make.telegram } });
  const botOf = (c) => w.secrets.get(c.id, "TELEGRAM_BOT_TOKEN") ?? OWNER_ENV.TELEGRAM_BOT_TOKEN;
  await telegramTick({ campaigns: w.campaigns(), depsFor, botOf });

  // One getUpdates for the shared bot, from the lowest offset.
  const asked = f.calls.filter((c) => c.method === "getUpdates");
  assert.deepEqual(asked.map((c) => [c.token, c.offset]), [["bot-owner", undefined]]);
  // Globex Tea never saw acme's pieces; both offsets moved past everything fetched.
  const offsetOf = (id) => JSON.parse(fs.readFileSync(path.join(w.home, "campaigns", id, "telegram-offset.json"), "utf8")).offset;
  assert.equal(offsetOf("acme"), 9);
  assert.equal(offsetOf("globex"), 9);
  assert.equal(createCreationStore(acme.home).load().pendingNote, "a-three");
  assert.equal(itemState(createCreationStore(path.join(w.home, "campaigns", "globex")).load(), "a-three").status, "todo");
  const sent = f.sentBy("bot-owner");
  assert.ok(!sent.some((s) => /a-three is todo/.test(s)), sent.join("\n"));
  assert.ok(sent.includes("[Acme Coffee] a-four is todo, not awaiting approval"), sent.join("\n"));
});

test("shadow mode never calls clients", async (t) => {
  const w = setup(t);
  const f = fakes();
  const lines = [];
  const results = await tick(w, f, IST_1930, { shadow: true, print: (l) => lines.push(l) });
  assert.equal(results.find((r) => r.id === "globex").outcome, "ran");
  assert.deepEqual(f.calls, []);
  assert.ok(lines.some((l) => /globex: would post instagram g-one \(queue\)/.test(l)), lines.join("\n"));
  // Nothing written to the campaign's posting record, and the live run is still due.
  const globexHome = path.join(w.home, "campaigns", "globex");
  assert.ok(!fs.existsSync(path.join(globexHome, "state.json")));
  assert.ok(!fs.existsSync(path.join(globexHome, "publish-day.json")));
  assert.match(fs.readdirSync(path.join(globexHome, "logs")).map((f) => fs.readFileSync(path.join(globexHome, "logs", f), "utf8")).join(""), /shadow/);
  // A second shadow tick the same day logs nothing new.
  const again = await tick(w, f, minutesAfter(IST_1930, 15), { shadow: true, print: (l) => lines.push(l) });
  assert.equal(again.find((r) => r.id === "globex").outcome, "done today");

  // Through the CLI too, with the real deps and fake clients.
  fs.rmSync(path.join(globexHome, "publish-shadow-day.json"));
  const out = [];
  const code = await main(["publish-tick", "--shadow"], {
    root: w.root, home: w.home, now: () => minutesAfter(IST_1930, 30), make: f.make, ownerEnv: OWNER_ENV, print: (l) => out.push(l),
  });
  assert.equal(code, 0);
  assert.ok(out.includes("globex: would post instagram g-one (queue)"), out.join("\n"));
  assert.deepEqual(f.calls, []);
  assert.ok(!fs.existsSync(path.join(globexHome, "state.json")));
});

test("a broken campaign.json doesn't stop the others", async (t) => {
  const w = setup(t);
  writeJson(path.join(w.root, "broken", "campaign.json"), { id: "broken", name: "Broken" });
  const { campaigns, problems } = loadActive({ root: w.root, home: w.home });
  assert.deepEqual(campaigns.map((c) => c.id), ["acme", "globex"]);
  assert.ok(problems.some((p) => /broken.*root is required/.test(p)));
});

test("a crash in one campaign is reported to the owner and the next still runs", async (t) => {
  const w = setup(t, { acme: { slot: "14:00" } });
  const f = fakes();
  fs.writeFileSync(path.join(w.campaigns()[0].root, "schedule.json"), "{ not json");
  const owner = [];
  const results = await tick(w, f, IST_1930, { alert: async (text) => void owner.push(text) });
  assert.equal(results[0].outcome, "crashed");
  assert.equal(results[1].outcome, "ran");
  assert.deepEqual(f.posts(), ["ig-globex"]);
  assert.equal(owner.length, 1);
  assert.match(owner[0], /^❌ Acme Coffee publisher crashed: /);
  assert.ok(!owner[0].includes("ig-acme"));
});

test("the CLI refuses unknown commands and --shadow outside publish-tick", async () => {
  const errors = [];
  const opts = { printError: (l) => errors.push(l), print() {} };
  assert.equal(await main([], opts), 1);
  assert.equal(await main(["post-everything"], opts), 1);
  assert.equal(await main(["create-nightly", "--shadow"], opts), 1);
  assert.equal(await main(["telegram-tick", "--shadow"], opts), 1);
  assert.match(errors.join("\n"), /create-nightly doesn't take --shadow/);
});

test("install-tasks builds the three pipeline tasks, --shadow only on the publisher", () => {
  const base = { nodePath: "C:\\node.exe", repoRoot: "C:\\repo", userId: "PC\\user", startDate: "2026-10-25" };
  const live = buildPipelineTasks(base);
  assert.deepEqual([live.publisher.name, live.creation.name, live.telegram.name], [PUBLISH_TASK, CREATION_TASK, TELEGRAM_TASK]);
  assert.deepEqual([PUBLISH_TASK, CREATION_TASK, TELEGRAM_TASK], ["Pipeline Publisher", "Pipeline Creation", "Pipeline Telegram"]);
  const script = "&quot;C:\\repo\\campaigns\\pipeline.mjs&quot;";
  assert.ok(live.publisher.xml.includes(`<Arguments>${script} publish-tick</Arguments>`));
  assert.match(live.publisher.xml, /<Interval>PT15M<\/Interval>/);
  assert.match(live.publisher.xml, /<LogonType>S4U<\/LogonType>/);
  assert.ok(live.creation.xml.includes(`<Arguments>${script} create-nightly</Arguments>`));
  assert.match(live.creation.xml, /<StartBoundary>2026-10-25T02:00:00<\/StartBoundary>/);
  assert.match(live.creation.xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.doesNotMatch(live.creation.xml, /<Repetition>/);
  assert.ok(live.telegram.xml.includes(`<Arguments>${script} telegram-tick</Arguments>`));
  assert.match(live.telegram.xml, /<Interval>PT5M<\/Interval>/);
  assert.match(live.telegram.xml, /<LogonType>S4U<\/LogonType>/);
  for (const task of Object.values(live)) assert.match(task.xml, /<UserId>PC\\user<\/UserId>/);

  const shadow = buildPipelineTasks({ ...base, shadow: true });
  assert.ok(shadow.publisher.xml.includes(`<Arguments>${script} publish-tick --shadow</Arguments>`));
  assert.equal(shadow.creation.xml, live.creation.xml);
  assert.equal(shadow.telegram.xml, live.telegram.xml);
});
