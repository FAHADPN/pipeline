import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planDay } from "../../publishing/lib/planner.mjs";
import { addDays, parseSlot } from "../../publishing/lib/dates.mjs";
import { setEntry } from "../../publishing/lib/state.mjs";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { projectQueue, buildStatus, healthSummary } from "../lib/status.mjs";
import { loadCampaignData } from "../lib/sources.mjs";
import { CONFIG } from "../../publishing/test/fixtures.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));

const TODAY = "2026-10-25"; // Sun
const EARLY = new Date("2026-10-25T10:00:00Z"); // 15:30 IST
const LATE = new Date("2026-10-25T17:00:00Z"); // 22:30 IST
const IG_TOKEN = "IGQVJ-fixture-instagram-token-123";
const YT_TOKEN = "1//fixture-youtube-refresh-token-456";

// Floating items F1..Fn.
function F(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `f${i + 1}`, kind: "ep", dir: `pieces/f${i + 1}` }));
}

// S({ f1: { instagram: { status: "posted", date: "2026-10-24" } } })
function S(entries = {}) {
  const items = {};
  for (const [id, platforms] of Object.entries(entries)) {
    items[id] = {};
    for (const [platform, entry] of Object.entries(platforms)) items[id][platform] = { at: "2026-10-24T14:00:00.000Z", ...entry };
  }
  return { version: 1, items };
}

function writeItem(repoRoot, dir, name = "clip") {
  const out = path.join(repoRoot, dir, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${name}.mp4`), "video");
  fs.writeFileSync(path.join(out, `${name}-cover.png`), "png");
  fs.writeFileSync(
    path.join(out, `${name}-caption.txt`),
    `INSTAGRAM / TIKTOK\n${name} first line\n\n#acme\n\nYOUTUBE SHORTS TITLE\n${name} title #shorts\n`,
  );
}

// A temp campaign folder with a schedule whose folders all pass the check, except the ids
// in `broken`, which get no out/ folder.
function makeRepo(items, { broken = [] } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-repo-"));
  fs.writeFileSync(path.join(repoRoot, "schedule.json"), JSON.stringify(items));
  for (const item of items) {
    if (broken.includes(item.id)) fs.mkdirSync(path.join(repoRoot, item.dir), { recursive: true });
    else writeItem(repoRoot, item.dir, item.id);
  }
  return repoRoot;
}

const TOKENS = {
  instagram: { token: IG_TOKEN, userId: "17841", username: "acme.coffee", issuedAt: "2026-10-15T14:00:00.000Z" },
  youtube: { refreshToken: YT_TOKEN, obtainedAt: "2026-10-05T14:00:00.000Z" },
};

function fakeExec({ registered = true } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, args]);
    if (!registered) throw new Error("ERROR: The system cannot find the file specified.");
    return { stdout: "Pipeline Publisher  Ready" };
  };
  return { exec, calls };
}

// A campaigns root holding `configs` (id -> campaign.json), and a publisher home.
function makeCampaigns(configs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-campaigns-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  for (const [id, config] of Object.entries(configs)) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, "campaign.json"), JSON.stringify(config));
  }
  return { root, home };
}

// A campaign's state, run log and build progress, in its own home.
function fillCampaignHome(campaign, { state, log, creation } = {}) {
  fs.mkdirSync(campaign.home, { recursive: true });
  if (state) fs.writeFileSync(path.join(campaign.home, "state.json"), JSON.stringify(state));
  if (log) {
    fs.mkdirSync(path.join(campaign.home, "logs"));
    for (const [month, lines] of Object.entries(log)) fs.writeFileSync(path.join(campaign.home, "logs", `${month}.log`), lines.join("\n") + "\n");
  }
  if (creation) fs.writeFileSync(path.join(campaign.home, "creation-state.json"), JSON.stringify(creation));
}

// TOKENS, as a campaign's secrets. The YouTube token's age is when it was set.
function setTokens(home, id, tokens = TOKENS) {
  let at = new Date(tokens.instagram.issuedAt);
  const secrets = createSecrets(home, { now: () => at });
  secrets.set(id, "IG_ACCESS_TOKEN", tokens.instagram.token);
  secrets.set(id, "IG_USER_ID", tokens.instagram.userId);
  secrets.set(id, "IG_USERNAME", tokens.instagram.username);
  secrets.set(id, "IG_ISSUED_AT", tokens.instagram.issuedAt);
  if (tokens.youtube) {
    at = new Date(tokens.youtube.obtainedAt);
    secrets.set(id, "YT_REFRESH_TOKEN", tokens.youtube.refreshToken);
  }
  return createSecrets(home);
}

// The acme campaign rooted at a temp repo holding `items`, its home filled with
// `state`, `log` and `creation`, and `tokens` in its secrets.
function acmeCampaign({ items = F(8), broken, tokens, ...fill } = {}) {
  const repoRoot = makeRepo(items, { broken });
  const { root, home } = makeCampaigns({ acme: { id: "acme", name: "Acme Coffee", root: repoRoot } });
  const campaign = getCampaign("acme", { root, home });
  fillCampaignHome(campaign, fill);
  const secrets = tokens ? setTokens(home, "acme", tokens) : createSecrets(home);
  return { repoRoot, home, campaign, secrets };
}

async function status({ now = EARLY, ...opts } = {}) {
  const { campaign, secrets } = acmeCampaign(opts);
  return buildStatus({ now, campaign, secrets, exec: fakeExec().exec });
}

test("next is the first queue entry", async () => {
  const s = await status({ tokens: TOKENS });
  assert.deepEqual(s.next, s.queue[0]);
  assert.deepEqual(s.next, { date: TODAY, id: "f1", platform: "instagram", why: "queue" });
  assert.equal(s.today, TODAY);
  assert.equal(s.generatedAt, EARLY.toISOString());

  const done = await status({ items: F(1), state: S({ f1: { instagram: { status: "posted", date: "2026-10-24" } } }) });
  assert.equal(done.next, null);
  assert.deepEqual(done.queue, []);
});

test("queue matches planDay day by day", () => {
  // Under bufferMin ready, so the 4-a-week rhythm, plus a pinned item, a window and a broken item.
  const items = [
    ...F(3),
    { id: "pin", kind: "special", dir: "x/pin", on: "2026-10-28" },
    { id: "late", kind: "ep", dir: "x/late", notBefore: "2026-11-01" },
    { id: "gone", kind: "ep", dir: "x/gone", notAfter: "2026-10-20" },
    { id: "broken", kind: "ep", dir: "x/broken" },
  ];
  const ready = new Set(items.map((i) => i.id).filter((id) => id !== "broken"));
  const state = S({ f1: { instagram: { status: "posted", date: "2026-10-24" } } });
  const before = structuredClone(state);

  const queue = projectQueue({ today: TODAY, items, state, ready, config: CONFIG });
  assert.deepEqual(state, before, "the real state is never touched");

  const sim = structuredClone(state);
  const expected = [];
  for (let n = 0; n < 14; n++) {
    const d = addDays(TODAY, n);
    const plan = planDay({ today: d, minutesNow: parseSlot(CONFIG.slot), items, state: sim, ready, config: CONFIG });
    for (const drop of plan.drops) setEntry(sim, drop.id, drop.platform, { status: "dropped", at: d, reason: drop.reason });
    for (const post of plan.posts) {
      setEntry(sim, post.id, post.platform, { status: "posted", at: d, date: d });
      expected.push({ date: d, ...post });
    }
  }
  assert.deepEqual(queue, expected);
  assert.deepEqual(
    queue.map((q) => `${q.date} ${q.id} ${q.why}`),
    ["2026-10-25 f2 queue", "2026-10-26 f3 queue", "2026-10-28 pin pinned", "2026-11-01 late queue"],
  );
  assert.ok(queue.every((q) => q.date < addDays(TODAY, 14)));
  assert.equal(projectQueue({ today: TODAY, items, state, ready, config: CONFIG, days: 2 }).length, 2);
});

test("queue skips today once today's window has passed", async () => {
  const s = await status({ now: LATE });
  assert.deepEqual(s.queue[0], { date: "2026-10-26", id: "f1", platform: "instagram", why: "queue" });
  assert.ok(s.queue.every((q) => q.date > TODAY));
});

test("posted lists the last 14 days with urls", async () => {
  const state = S({
    f1: { instagram: { status: "posted", date: "2026-10-01", url: "https://www.instagram.com/reel/old/" } },
    f2: { instagram: { status: "manual", date: "2026-10-12", url: "https://www.instagram.com/reel/r2/" } },
    f3: { instagram: { status: "posted", date: "2026-10-24", url: "https://www.instagram.com/reel/r3/" } },
    f4: {
      instagram: { status: "posted", date: "2026-10-20", url: "https://www.instagram.com/reel/r4/" },
      youtube: { status: "posted", date: "2026-10-21", url: "https://youtube.com/shorts/y4" },
    },
    f5: { instagram: { status: "failed", error: "boom", attempts: 2 } },
    f6: { instagram: { status: "dropped", reason: "past notAfter" } },
  });
  const s = await status({ state });
  assert.deepEqual(s.posted, [
    { id: "f3", platform: "instagram", date: "2026-10-24", url: "https://www.instagram.com/reel/r3/" },
    { id: "f4", platform: "youtube", date: "2026-10-21", url: "https://youtube.com/shorts/y4" },
    { id: "f4", platform: "instagram", date: "2026-10-20", url: "https://www.instagram.com/reel/r4/" },
    { id: "f2", platform: "instagram", date: "2026-10-12", url: "https://www.instagram.com/reel/r2/" },
  ]);
  assert.deepEqual(s.problems.failed, [{ id: "f5", platform: "instagram", error: "boom", at: "2026-10-24T14:00:00.000Z" }]);
  assert.deepEqual(s.problems.dropped.map((d) => [d.id, d.platform, d.reason]), [["f6", "instagram", "past notAfter"]]);
});

test("connected false without tokens", async () => {
  const s = await status();
  assert.equal(s.connected, false);
  assert.deepEqual(s.health.tokenAgeDays, { instagram: null, youtube: null });

  const withTokens = await status({ tokens: TOKENS });
  assert.equal(withTokens.connected, true);
  assert.deepEqual(withTokens.health.tokenAgeDays, { instagram: 9, youtube: 19 });
});

test("status JSON never contains a token value", async () => {
  const crash = `2026-10-24T14:00:05.000Z ERROR run crashed {"error":"bad request for ${IG_TOKEN}"}`;
  const s = await status({ tokens: TOKENS, log: { "2026-10": [crash] } });
  const json = JSON.stringify(s);
  assert.ok(!json.includes(IG_TOKEN), "instagram token leaked");
  assert.ok(!json.includes(YT_TOKEN), "youtube refresh token leaked");
  assert.equal(s.next.id, "f1", "the status itself is still there");
  assert.match(s.lastRun.summary, /^crashed: bad request for /);
});

test("status.connections never contains a secret value", async () => {
  // Every name in the store, each with a value nothing else in the status could hold.
  const values = {
    IG_ACCESS_TOKEN: "IGAAfixture-connections-token-111",
    IG_USER_ID: "17841499999999901",
    IG_USERNAME: "fixture.account",
    IG_ISSUED_AT: "2026-10-18T09:09:09.999Z",
    YT_REFRESH_TOKEN: "1//fixture-connections-refresh-222",
    YT_CHANNEL: "Fixture Channel",
    TELEGRAM_BOT_TOKEN: "987654321:AAfixture-connections-bot-333",
    ANTHROPIC_API_KEY: "sk-ant-fixture-connections-444",
  };
  const { campaign, home } = acmeCampaign({ items: F(1) });
  const secrets = createSecrets(home, { now: () => new Date("2026-10-22T10:00:00.000Z") });
  for (const [name, value] of Object.entries(values)) secrets.set("acme", name, value);
  campaign.config.approvers = ["4242"];
  fs.mkdirSync(campaign.home, { recursive: true });
  fs.writeFileSync(
    path.join(campaign.home, "telegram-seen.json"),
    JSON.stringify({ chats: [{ chatId: "555", name: "Asha", at: "2026-10-24T10:00:00.000Z" }, { chatId: "4242", name: "Owner", at: "2026-10-23T10:00:00.000Z" }] }),
  );

  const s = await buildStatus({ now: EARLY, campaign, secrets, exec: fakeExec().exec });
  const json = JSON.stringify(s.connections);
  // The account names are shown by design; every other value, credential or id, never is.
  for (const [name, value] of Object.entries(values)) {
    if (name === "IG_USERNAME" || name === "YT_CHANNEL") continue;
    assert.ok(!json.includes(value), `${name} leaked into status.connections`);
  }
  const at = "2026-10-22T10:00:00.000Z";
  assert.deepEqual(s.connections, {
    secrets: Object.fromEntries(Object.keys(values).map((name) => [name, { set: true, updatedAt: at }])),
    instagram: { username: "fixture.account", tokenAgeDays: 7 },
    youtube: { connected: true, channel: "Fixture Channel" },
    telegram: { approvers: ["4242"], ownBot: true, seenChats: [{ chatId: "555", name: "Asha", at: "2026-10-24T10:00:00.000Z" }] },
  });

  const empty = await status();
  assert.deepEqual(empty.connections.secrets.IG_ACCESS_TOKEN, { set: false, updatedAt: null });
  assert.deepEqual(empty.connections.instagram, { username: null, tokenAgeDays: null });
  assert.deepEqual(empty.connections.telegram, { approvers: [], ownBot: false, seenChats: [] });
});

test("health reports readiness, run-dry, the last run and the task", async () => {
  const runLine = `2026-10-24T14:00:09.000Z INFO run ${JSON.stringify({
    today: "2026-10-24",
    posted: [{ id: "f0", platform: "instagram", url: "https://www.instagram.com/reel/r0/" }],
    failed: [],
    alreadyLive: [],
  })}`;
  const log = {
    "2026-09": ["2026-09-30T14:00:09.000Z INFO run {\"posted\":[],\"failed\":[]}"],
    "2026-10": [
      "2026-10-24T14:00:01.000Z ERROR instagram f0 attempt 1 failed {\"error\":\"x\"}",
      runLine,
      "2026-10-24T15:00:00.000Z INFO sync-state {\"platform\":\"instagram\"}",
    ],
  };
  const { campaign, secrets } = acmeCampaign({ broken: ["f8"], log });
  const { exec, calls } = fakeExec();
  const s = await buildStatus({ now: EARLY, campaign, secrets, exec });

  assert.deepEqual(calls, [["schtasks", ["/Query", "/TN", "Pipeline Publisher"]]]);
  assert.equal(s.health.taskRegistered, true);
  assert.equal(s.health.readyCount, 7);
  assert.equal(s.health.rhythm, "daily");
  // From tomorrow: daily for one day, then 4-a-week (Mon/Wed/Fri/Sun) once under 7 ready.
  assert.equal(s.health.runDry, "2026-11-06");
  assert.deepEqual(s.lastRun, { at: "2026-10-24T14:00:09.000Z", summary: "posted f0 (instagram)" });
  assert.deepEqual(s.problems.notReady, [{ id: "f8", errors: ["no out/ folder in pieces/f8"] }]);

  const fresh = acmeCampaign({ broken: ["f8"] });
  const missing = await buildStatus({ now: EARLY, campaign: fresh.campaign, secrets: fresh.secrets, exec: fakeExec({ registered: false }).exec });
  assert.equal(missing.health.taskRegistered, false);
  assert.equal(missing.lastRun, null);
});

test("status: a campaign is read through getCampaign, from its own home", async () => {
  const state = S({ f1: { instagram: { status: "posted", date: "2026-10-24", url: "https://www.instagram.com/reel/r1/" } } });
  const { campaign, secrets, home } = acmeCampaign({ items: F(3), state, tokens: TOKENS });
  // Files at the top of the publisher home aren't a campaign's, so they aren't read.
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(S({ f2: { instagram: { status: "posted", date: "2026-10-24" } } })));
  fs.writeFileSync(path.join(home, "tokens.json"), JSON.stringify({}));

  const s = await buildStatus({ now: EARLY, campaign, secrets, exec: fakeExec().exec });

  assert.deepEqual(s.queue.map((q) => `${q.date} ${q.id}`), ["2026-10-25 f2", "2026-10-26 f3"]);
  assert.deepEqual(s.posted.map((p) => p.id), ["f1"]);
  assert.equal(s.connected, true);
  assert.deepEqual(s.campaign, { id: "acme", name: campaign.name, paused: campaign.paused === true, instagramEnabled: true });
});

test("creation lists the pieces awaiting approval and building, with counts", async () => {
  const creation = {
    items: {
      "post-06-two-phones": { status: "awaiting-approval", attempts: 1, at: "2026-10-24T01:00:00.000Z" },
      "ep-17-payday": { status: "building", attempts: 1, at: "2026-10-24T01:00:00.000Z" },
      "ep-18-rain": { status: "todo", attempts: 0, at: "2026-10-24T01:00:00.000Z" },
      "ep-19-birthday": { status: "todo", attempts: 0, at: "2026-10-24T01:00:00.000Z" },
    },
  };
  const { repoRoot, campaign, secrets } = acmeCampaign({ items: F(1), creation });
  writeItem(repoRoot, "pieces/post-06-two-phones", "two-phones-ld");
  fs.writeFileSync(
    path.join(repoRoot, "backlog.json"),
    JSON.stringify([
      { id: "post-06-two-phones", title: "Two phones, long distance" },
      { id: "ep-17-payday", title: "Payday" },
    ]),
  );
  const s = await buildStatus({ now: EARLY, campaign, secrets, exec: fakeExec().exec });
  assert.deepEqual(s.creation.counts, { "awaiting-approval": 1, building: 1, todo: 2 });
  assert.deepEqual(s.creation.awaiting, [
    {
      id: "post-06-two-phones",
      title: "Two phones, long distance",
      caption: "two-phones-ld first line\n\n#acme",
      video: "/media/post-06-two-phones/two-phones-ld.mp4?campaign=acme",
    },
  ]);
  assert.deepEqual(s.creation.building, [{ id: "ep-17-payday", title: "Payday", reason: null, attempts: 1, at: "2026-10-24T01:00:00.000Z" }]);
  assert.deepEqual(s.creation.failed, []);
  assert.deepEqual(s.creation.redo, []);
});

test("status.creation.failed carries the reason and attempts", async () => {
  const creation = {
    items: {
      "ep-20-rent": { status: "failed", attempts: 1, reason: "checks failed: video missing", at: "2026-10-25T02:00:00.000Z" },
      "ep-21-diwali": { status: "redo", attempts: 0, note: "slower hook", at: "2026-10-25T03:00:00.000Z" },
    },
  };
  const { repoRoot, campaign, secrets } = acmeCampaign({ items: F(1), creation });
  fs.writeFileSync(path.join(repoRoot, "backlog.json"), JSON.stringify([{ id: "ep-20-rent", title: "Rent day" }]));

  const s = await buildStatus({ now: EARLY, campaign, secrets, exec: fakeExec().exec });

  assert.deepEqual(s.creation.failed, [
    { id: "ep-20-rent", title: "Rent day", reason: "checks failed: video missing", attempts: 1, at: "2026-10-25T02:00:00.000Z" },
  ]);
  // A redo's reason is the note it was sent back with; an id missing from the build list is its own title.
  assert.deepEqual(s.creation.redo, [{ id: "ep-21-diwali", title: "ep-21-diwali", reason: "slower hook", attempts: 0, at: "2026-10-25T03:00:00.000Z" }]);
  assert.deepEqual(s.creation.counts, { failed: 1, redo: 1 });
});

test("a new campaign with no backlog or creation state gives empty lists, not an error", async () => {
  const campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-fresh-"));
  fs.writeFileSync(path.join(campaignRoot, "schedule.json"), "[]");
  const { root, home } = makeCampaigns({ fresh: { id: "fresh", name: "Fresh", root: campaignRoot } });
  const campaign = getCampaign("fresh", { root, home });

  const s = await buildStatus({ now: EARLY, campaign, secrets: createSecrets(home), exec: fakeExec().exec });

  assert.deepEqual(s.creation, { counts: {}, awaiting: [], failed: [], redo: [], building: [], error: null });
  assert.deepEqual(s.queue, []);
  assert.ok(!fs.existsSync(campaign.home), "nothing is written to the campaign's home");
});

test("loadCampaignData: a campaign's files, settings, secrets and media URLs, and a second campaign's", () => {
  const { repoRoot, campaign, secrets } = acmeCampaign({ items: F(2), tokens: TOKENS });
  const data = loadCampaignData({ campaign, secrets, now: EARLY });
  assert.equal(data.campaign, campaign);
  assert.equal(data.root, repoRoot);
  assert.equal(data.home, campaign.home);
  assert.deepEqual(data.config, { ...CONFIG, platforms: { ...CONFIG.platforms, instagram: { ...CONFIG.platforms.instagram, ngrokBin: "ngrok" } } });
  assert.deepEqual(data.items.map((i) => i.id), ["f1", "f2"]);
  assert.deepEqual(data.state, { version: 1, items: {} });
  assert.equal(data.tokens.instagram.token, IG_TOKEN);
  assert.ok(data.secretValues.includes(IG_TOKEN) && data.secretValues.includes(YT_TOKEN));
  assert.deepEqual(data.backlog, []);
  assert.deepEqual(data.cstate, { items: {} });
  assert.equal(data.pieceDir("ep-01"), "pieces/ep-01");
  assert.equal(data.mediaUrl("ep-01", "clip.mp4"), "/media/ep-01/clip.mp4?campaign=acme");
  assert.equal(data.outDir, path.join(repoRoot, "creation-out"));

  const betaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-beta-"));
  fs.writeFileSync(path.join(betaRoot, "schedule.json"), "[]");
  fs.writeFileSync(path.join(betaRoot, "backlog.json"), JSON.stringify([{ id: "b-new", title: "Beta new" }]));
  const { root, home } = makeCampaigns({ beta: { id: "beta", name: "Beta", root: betaRoot } });
  const beta = loadCampaignData({ campaign: getCampaign("beta", { root, home }), secrets: createSecrets(home), now: EARLY });
  assert.deepEqual(beta.backlog, [{ id: "b-new", title: "Beta new" }]);
  assert.equal(beta.pieceDir("b-new"), "pieces/b-new");
  assert.equal(beta.mediaUrl("b-new", "clip.mp4"), "/media/b-new/clip.mp4?campaign=beta");
  assert.equal(beta.outDir, path.join(betaRoot, "creation-out"));
});

test("status for a second campaign reads only its state", async () => {
  const roots = {};
  const configs = {};
  for (const id of ["alpha", "beta"]) {
    roots[id] = fs.mkdtempSync(path.join(os.tmpdir(), `campaign-${id}-`));
    const items = [1, 2, 3].map((n) => ({ id: `${id[0]}${n}`, kind: "ep", dir: `pieces/${id[0]}${n}` }));
    fs.writeFileSync(path.join(roots[id], "schedule.json"), JSON.stringify(items));
    for (const item of items) writeItem(roots[id], item.dir, item.id);
    configs[id] = { id, name: id.toUpperCase(), root: roots[id] };
  }
  const { root, home } = makeCampaigns(configs);
  const alpha = getCampaign("alpha", { root, home });
  const beta = getCampaign("beta", { root, home });

  fillCampaignHome(alpha, {
    state: S({ a1: { instagram: { status: "posted", date: "2026-10-24", url: "https://www.instagram.com/reel/ra1/" } } }),
    log: { "2026-10": ['2026-10-24T14:00:09.000Z INFO run {"posted":[{"id":"a1","platform":"instagram"}],"failed":[]}'] },
    creation: { items: { "a-new": { status: "todo", attempts: 0, at: "x" } } },
  });
  const BOT = "123456:fixture-beta-bot-token";
  fillCampaignHome(beta, {
    state: S({
      b1: { instagram: { status: "posted", date: "2026-10-23", url: "https://www.instagram.com/reel/rb1/" } },
      b2: { instagram: { status: "failed", error: "boom" } },
    }),
    log: { "2026-10": [`2026-10-24T14:00:05.000Z ERROR run crashed ${JSON.stringify({ error: `telegram refused ${BOT}` })}`] },
    creation: { items: { "b-new": { status: "awaiting-approval", attempts: 1, at: "x" } } },
  });
  writeItem(roots.beta, "pieces/b-new", "bnew");
  fs.writeFileSync(path.join(roots.beta, "backlog.json"), JSON.stringify([{ id: "b-new", title: "Beta new" }]));
  setTokens(home, "alpha", { instagram: { ...TOKENS.instagram, token: "IGQVJ-alpha-only-token" } });
  const secrets = setTokens(home, "beta", { instagram: { ...TOKENS.instagram, token: IG_TOKEN, issuedAt: "2026-10-20T14:00:00.000Z" } });
  secrets.set("beta", "TELEGRAM_BOT_TOKEN", BOT);
  const before = fs.readFileSync(path.join(alpha.home, "state.json"), "utf8");

  const s = await buildStatus({ now: EARLY, campaign: beta, secrets, exec: fakeExec().exec });

  assert.deepEqual(s.posted.map((p) => p.id), ["b1"]);
  assert.deepEqual(s.problems.failed.map((f) => f.id), ["b2"]);
  assert.deepEqual(s.queue.map((q) => q.id), ["b2", "b3"]);
  assert.equal(s.connected, true);
  assert.equal(s.health.tokenAgeDays.instagram, 4);
  assert.deepEqual(s.lastRun, { at: "2026-10-24T14:00:05.000Z", summary: "crashed: telegram refused [redacted]" });
  assert.deepEqual(s.creation, {
    counts: { "awaiting-approval": 1 },
    awaiting: [{ id: "b-new", title: "Beta new", caption: "bnew first line\n\n#acme", video: "/media/b-new/bnew.mp4?campaign=beta" }],
    failed: [],
    redo: [],
    building: [],
    error: null,
  });
  const json = JSON.stringify(s);
  for (const leak of ["a1", "a2", "IGQVJ-alpha-only-token", IG_TOKEN, BOT]) assert.ok(!json.includes(leak), leak);
  assert.equal(fs.readFileSync(path.join(alpha.home, "state.json"), "utf8"), before, "alpha's state untouched");
  assert.ok(!fs.existsSync(path.join(home, "state.json")), "nothing is read or written at the top of the publisher home");
});

test("health summary for the campaign list", async () => {
  const fine = await status({ tokens: TOKENS });
  assert.deepEqual(healthSummary(fine), { health: "ok", connected: true, next: fine.next.date, problems: 0 });

  const state = S({ f1: { instagram: { status: "failed", error: "boom" } } });
  const bad = await status({ tokens: TOKENS, state, broken: ["f8"] });
  assert.deepEqual(healthSummary(bad), { health: "problems", connected: true, next: bad.next.date, problems: 2 });

  const offline = await status();
  assert.equal(healthSummary(offline).health, "problems");
  assert.equal(healthSummary(offline).connected, false);
});
