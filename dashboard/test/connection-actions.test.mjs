import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { withLock } from "../../publishing/lib/lock.mjs";
import { connectionDeps, createConnectionActions } from "../lib/connection-actions.mjs";
import { scrub } from "../lib/sources.mjs";

const NOW = new Date("2026-10-25T04:30:00Z");
const TOKEN = "IGAAfixture-pasted-instagram-token-0987654321";
const OLD_TOKEN = "IGAAfixture-old-instagram-token-1234567890";
const BOT = "123456789:AAfixture-campaign-bot-token-abcdefghij";
const API_KEY = "sk-ant-fixture-api-key-0123456789";
const BUSY = "a build is running for Globex Sample; try again when it finishes";

// campaign.json as a person would lay it out: inline lists and a nested object.
const CAMPAIGN_JSON = `{
  "id": "globex",
  "name": "Globex Sample",
  "root": "ROOT",
  "fallbackDays": ["Mon", "Wed", "Fri", "Sun"],
  "platforms": {
    "instagram": { "enabled": true, "graphVersion": "v24.0" },
    "youtube": { "enabled": false }
  },
  "approvers": ["111"]
}
`;

function writeItem(root, id, firstLine) {
  const out = path.join(root, "pieces", id, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${id}.mp4`), "video");
  fs.writeFileSync(path.join(out, `${id}-cover.png`), "png");
  fs.writeFileSync(path.join(out, `${id}-caption.txt`), `INSTAGRAM / TIKTOK\n${firstLine}\n\n#globex\n\nYOUTUBE SHORTS TITLE\n${id} #shorts\n`);
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

// A fake Instagram: me() answers for TOKEN only, listMedia returns `posts`.
function fakeInstagram({ posts = [], meFails = false, listFails = false } = {}) {
  const made = [];
  const make = ({ token, userId, graphVersion }) => {
    made.push({ token, userId, graphVersion });
    return {
      async me() {
        if (meFails || token !== TOKEN) throw new Error(`Invalid OAuth access token - Cannot parse access token ${token}`);
        return { userId: "17841400000000042", username: "globex.sample" };
      },
      async listMedia() {
        if (listFails) throw new Error(`instagram request failed: socket hang up for ${token}`);
        return posts;
      },
    };
  };
  return { make, made };
}

// `encoded` quotes the token the way a request URL carries it.
function fakeTelegram({ failChats = [], encoded = false } = {}) {
  const sent = [];
  const make = ({ token, chatId }) => ({
    async send(text) {
      const shown = encoded ? `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage` : `bot${token}`;
      if (failChats.includes(chatId)) throw new Error(`telegram: Bad Request: chat not found (${shown})`);
      sent.push({ token, chatId, text });
    },
  });
  return { make, sent };
}

// A sample campaign: its folder (campaign.json + a schedule of two pieces), a publisher
// home, and its secrets with an old Instagram token.
// `others` are more campaigns sharing the publisher home, as { name, lockName }.
function setup(t, { json = CAMPAIGN_JSON, instagram = fakeInstagram(), telegram = fakeTelegram(), others = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "connections-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const campaignsRoot = path.join(tmp, "campaigns");
  const root = path.join(campaignsRoot, "globex");
  const home = path.join(tmp, "home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home);
  const file = path.join(root, "campaign.json");
  fs.writeFileSync(file, json.replace("ROOT", root.replaceAll("\\", "\\\\")));
  fs.writeFileSync(path.join(root, "schedule.json"), JSON.stringify([
    { id: "p1", kind: "post", dir: "pieces/p1" },
    { id: "p2", kind: "post", dir: "pieces/p2" },
  ]));
  writeItem(root, "p1", "First piece hook");
  writeItem(root, "p2", "Second piece hook");
  const campaign = getCampaign("globex", { root: campaignsRoot, home });
  const secrets = createSecrets(home, { now: () => NOW });
  secrets.set("globex", "IG_ACCESS_TOKEN", OLD_TOKEN);
  const log = fakeLog();
  const deps = {
    ...connectionDeps({ campaign, secrets, campaignFile: file, campaigns: [campaign, ...others], make: { instagram: instagram.make, telegram: telegram.make } }),
    log,
    now: () => NOW,
  };
  return {
    home,
    campaign,
    secrets,
    file,
    log,
    deps,
    instagram,
    telegram,
    actions: createConnectionActions({ campaign, secrets, deps }),
    state: () => JSON.parse(fs.readFileSync(path.join(campaign.home, "state.json"), "utf8")),
    backups: () => (fs.existsSync(path.join(campaign.home, "backups")) ? fs.readdirSync(path.join(campaign.home, "backups")).filter((f) => f.startsWith("campaign-")) : []),
  };
}

const leaks = (value, ...secrets) => secrets.filter((s) => JSON.stringify(value).includes(s));

test("setInstagramToken: me() failing saves nothing and the error doesn't contain the token", async (t) => {
  const { actions, secrets, log, instagram } = setup(t, { instagram: fakeInstagram({ meFails: true }) });
  const before = secrets.status("globex");
  const res = await actions.setInstagramToken({ token: `  ${TOKEN}\n` });
  assert.equal(res.ok, false);
  assert.match(res.error, /Instagram didn't accept that token/);
  assert.deepEqual(leaks(res, TOKEN, OLD_TOKEN), []);
  assert.deepEqual(leaks(log.lines, TOKEN, OLD_TOKEN), []);
  assert.deepEqual(instagram.made, [{ token: TOKEN, userId: undefined, graphVersion: "v24.0" }], "validated with the pasted token alone, trimmed");
  assert.deepEqual(secrets.status("globex"), before, "nothing saved");
  assert.equal(secrets.get("globex", "IG_ACCESS_TOKEN"), OLD_TOKEN);
  assert.deepEqual(log.lines.map(([level, msg, data]) => [level, msg, Object.keys(data)]), [["error", "dashboard setInstagramToken", ["campaign", "ok", "error"]]]);

  for (const token of [undefined, "", "   ", "two words", 7]) {
    const bad = await actions.setInstagramToken({ token });
    assert.equal(bad.ok, false, String(token));
  }
  assert.equal(instagram.made.length, 1, "a blank or malformed token never reaches Instagram");
});

test("setInstagramToken: success saves the four secrets, and the response and log lines don't contain the token", async (t) => {
  const posts = [{ id: "m1", caption: "Second piece hook\n\nmore", timestamp: "2026-10-20T14:00:00+0000", permalink: "https://www.instagram.com/reel/r2/" }];
  const { actions, secrets, log, state, instagram } = setup(t, { instagram: fakeInstagram({ posts }) });
  const res = await actions.setInstagramToken({ token: TOKEN });
  assert.deepEqual(res, { ok: true, username: "globex.sample", synced: true, marked: 1, message: "Connected @globex.sample. Marked 1 post already live." });
  assert.equal(secrets.get("globex", "IG_ACCESS_TOKEN"), TOKEN);
  assert.equal(secrets.get("globex", "IG_USER_ID"), "17841400000000042");
  assert.equal(secrets.get("globex", "IG_USERNAME"), "globex.sample");
  assert.equal(secrets.get("globex", "IG_ISSUED_AT"), NOW.toISOString());
  // The sync ran once with the new token and recorded the live post.
  assert.deepEqual(instagram.made.at(-1), { token: TOKEN, userId: "17841400000000042", graphVersion: "v24.0" });
  assert.equal(state().items.p2.instagram.status, "manual");
  assert.equal(state().items.p2.instagram.url, "https://www.instagram.com/reel/r2/");
  assert.deepEqual(leaks(res, TOKEN, OLD_TOKEN), []);
  assert.deepEqual(leaks(log.lines, TOKEN, OLD_TOKEN), []);
  assert.deepEqual(log.lines, [["info", "dashboard setInstagramToken", { campaign: "globex", ...res }]]);
});

test("setInstagramToken: a failed sync keeps the token and says so, scrubbed", async (t) => {
  const { actions, secrets, log } = setup(t, { instagram: fakeInstagram({ listFails: true }) });
  const res = await actions.setInstagramToken({ token: TOKEN });
  assert.equal(res.ok, true);
  assert.equal(res.username, "globex.sample");
  assert.equal(res.synced, false);
  assert.match(res.syncError, /socket hang up for \[redacted\]/);
  assert.deepEqual(leaks([res, log.lines], TOKEN), []);
  assert.equal(secrets.get("globex", "IG_ACCESS_TOKEN"), TOKEN, "the token stays saved");
});

test("setInstagramToken: a busy publish lock saves nothing", async (t) => {
  const { actions, secrets, campaign, home } = setup(t);
  await withLock(home, campaign.lockName("publish"), async () => {
    const res = await actions.setInstagramToken({ token: TOKEN });
    assert.deepEqual(res, { ok: false, error: "a post is running for Globex Sample; try again when it finishes" });
  });
  assert.equal(secrets.get("globex", "IG_ACCESS_TOKEN"), OLD_TOKEN);
});

test("setTelegram: bad chat ids are refused; campaign.json is validated before writing", async (t) => {
  const { actions, file, backups } = setup(t);
  const original = fs.readFileSync(file, "utf8");
  for (const approvers of [["12a"], ["1".repeat(21)], [111], ["--5"], ["", "1"], "111", Array.from({ length: 11 }, (_, i) => String(i + 1)), [" 111"]]) {
    const res = await actions.setTelegram({ approvers });
    assert.equal(res.ok, false, JSON.stringify(approvers));
  }
  assert.equal(fs.readFileSync(file, "utf8"), original);

  // A campaign.json broken by hand since it was loaded is refused, not written over.
  fs.writeFileSync(file, original.replace('"name": "Globex Sample",', '"name": "Globex Sample",\n  "slot": "25:99",'));
  const broken = fs.readFileSync(file, "utf8");
  const res = await actions.setTelegram({ approvers: ["111", "-1002233"] });
  assert.equal(res.ok, false);
  assert.match(res.error, /campaign\.json would be invalid: slot must be HH:MM/);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
  assert.deepEqual(backups(), []);
});

test("setTelegram: approvers are written to campaign.json in its own layout, with a backup and no other change", async (t) => {
  const { actions, file, backups, campaign, secrets } = setup(t);
  const original = fs.readFileSync(file, "utf8");
  const res = await actions.setTelegram({ approvers: ["111", "-1002233", "111"] });
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.readFileSync(file, "utf8"), original.replace('"approvers": ["111"]', '"approvers": ["111", "-1002233"]'));
  assert.equal(backups().length, 1);
  assert.equal(fs.readFileSync(path.join(campaign.home, "backups", backups()[0]), "utf8"), original);
  assert.equal(secrets.get("globex", "TELEGRAM_BOT_TOKEN"), undefined);

  const cleared = await actions.setTelegram({ approvers: [] });
  assert.equal(cleared.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).approvers, []);
});

test("setTelegram: a campaign.json with no approvers gets them; CRLF stays", async (t) => {
  const json = CAMPAIGN_JSON.replace(',\n  "approvers": ["111"]', "").replaceAll("\n", "\r\n");
  const { actions, file } = setup(t, { json });
  const original = fs.readFileSync(file, "utf8");
  assert.equal((await actions.setTelegram({ approvers: ["42"] })).ok, true);
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text, original.replace('}\r\n  }\r\n}', '}\r\n  },\r\n  "approvers": ["42"]\r\n}'));
});

test("setTelegram: the bot token is saved write-only; a busy schedule lock refuses with the build message", async (t) => {
  const { actions, secrets, log, campaign, home, file } = setup(t);
  const res = await actions.setTelegram({ botToken: ` ${BOT} ` });
  assert.equal(res.ok, true, res.error);
  assert.equal(secrets.get("globex", "TELEGRAM_BOT_TOKEN"), BOT);
  assert.deepEqual(leaks([res, log.lines], BOT), []);
  assert.equal((await actions.setTelegram({ botToken: "not a bot token" })).ok, false);
  assert.equal((await actions.setTelegram({})).ok, false, "nothing to save");

  const original = fs.readFileSync(file, "utf8");
  await withLock(home, campaign.lockName("schedule"), async () => {
    const started = Date.now();
    const busy = await actions.setTelegram({ approvers: ["222"] });
    assert.deepEqual(busy, { ok: false, error: BUSY });
    assert.ok(Date.now() - started < 6000);
  });
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("testTelegram: each approver is sent the test with the campaign's own bot; failures name the chat, never the token", async (t) => {
  const telegram = fakeTelegram({ failChats: ["-1002233"] });
  const { actions, secrets, log } = setup(t, { json: CAMPAIGN_JSON.replace('["111"]', '["111", "-1002233"]'), telegram });
  assert.match((await actions.testTelegram()).error, /no bot of its own/);

  secrets.set("globex", "TELEGRAM_BOT_TOKEN", BOT);
  const res = await actions.testTelegram();
  assert.equal(res.ok, false);
  assert.deepEqual(res.results.map((r) => [r.chatId, r.ok]), [["111", true], ["-1002233", false]]);
  assert.match(res.results[1].error, /chat not found/);
  assert.match(res.error, /-1002233/);
  assert.deepEqual(telegram.sent, [{ token: BOT, chatId: "111", text: "Test message from the console" }]);
  assert.deepEqual(leaks([res, log.lines], BOT), []);
});

test("setSecret: only ANTHROPIC_API_KEY; an empty value clears it; the value never comes back", async (t) => {
  const { actions, secrets, log } = setup(t);
  const res = await actions.setSecret({ name: "ANTHROPIC_API_KEY", value: API_KEY });
  assert.equal(res.ok, true, res.error);
  assert.equal(secrets.get("globex", "ANTHROPIC_API_KEY"), API_KEY);
  assert.deepEqual(leaks([res, log.lines], API_KEY), []);

  for (const name of ["IG_ACCESS_TOKEN", "TELEGRAM_BOT_TOKEN", "__proto__", undefined]) {
    const refused = await actions.setSecret({ name, value: API_KEY });
    assert.equal(refused.ok, false, String(name));
  }
  assert.equal(secrets.get("globex", "IG_ACCESS_TOKEN"), OLD_TOKEN);
  assert.equal((await actions.setSecret({ name: "ANTHROPIC_API_KEY", value: "has a space" })).ok, false);

  const cleared = await actions.setSecret({ name: "ANTHROPIC_API_KEY", value: "" });
  assert.equal(cleared.ok, true);
  assert.equal(secrets.get("globex", "ANTHROPIC_API_KEY"), undefined);
  assert.deepEqual(leaks(log.lines, API_KEY), []);
});

const OTHER = { name: "Other Campaign", lockName: (name) => `other:${name}` };
const BUILDING_OTHER = "a build is running for Other Campaign; try again when it finishes";

// A creation lock file in the shared publisher home, taken at `at`.
function holdCreation(home, id, at = new Date()) {
  const file = path.join(home, "locks", `${id}.creation.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: at.toISOString() }));
  return file;
}

test("a secret save while another campaign builds is refused naming it, and the secrets file is unchanged", async (t) => {
  const { actions, home, file, secrets } = setup(t, { others: [OTHER] });
  holdCreation(home, "other");
  const secretsFile = path.join(home, "secrets", "globex.json");
  const before = fs.readFileSync(secretsFile);
  const campaignJson = fs.readFileSync(file);

  assert.deepEqual(await actions.setSecret({ name: "ANTHROPIC_API_KEY", value: API_KEY }), { ok: false, error: BUILDING_OTHER });
  assert.deepEqual(await actions.setSecret({ name: "ANTHROPIC_API_KEY", value: "" }), { ok: false, error: BUILDING_OTHER });
  assert.deepEqual(await actions.setInstagramToken({ token: TOKEN }), { ok: false, error: BUILDING_OTHER });
  assert.deepEqual(await actions.setTelegram({ botToken: BOT }), { ok: false, error: BUILDING_OTHER });
  assert.deepEqual(await actions.setTelegram({ botToken: BOT, approvers: ["222"] }), { ok: false, error: BUILDING_OTHER });
  assert.deepEqual(fs.readFileSync(secretsFile), before, "the secrets file is byte for byte the same");
  assert.deepEqual(fs.readFileSync(file), campaignJson, "a refused bot token leaves the approvers alone too");
  assert.equal(secrets.get("globex", "IG_ACCESS_TOKEN"), OLD_TOKEN);

  // Approvers alone write campaign.json only, which the schedule lock already covers.
  assert.equal((await actions.setTelegram({ approvers: ["222"] })).ok, true);
  assert.deepEqual(fs.readFileSync(secretsFile), before);
});

test("this campaign's own build blocks a secret save too; a creation lock older than its staleMs doesn't", async (t) => {
  const { actions, home, secrets } = setup(t, { others: [OTHER] });
  const own = holdCreation(home, "globex");
  assert.deepEqual(await actions.setSecret({ name: "ANTHROPIC_API_KEY", value: API_KEY }), {
    ok: false,
    error: "a build is running for Globex Sample; try again when it finishes",
  });
  fs.rmSync(own);

  // The nightly run takes the creation lock with a 24-hour staleMs.
  holdCreation(home, "other", new Date(Date.now() - 25 * 3600000));
  const res = await actions.setSecret({ name: "ANTHROPIC_API_KEY", value: API_KEY });
  assert.equal(res.ok, true, res.error);
  assert.equal(secrets.get("globex", "ANTHROPIC_API_KEY"), API_KEY);

  holdCreation(home, "other", new Date(Date.now() - 23 * 3600000));
  assert.deepEqual(await actions.setSecret({ name: "ANTHROPIC_API_KEY", value: "" }), { ok: false, error: BUILDING_OTHER });
});

test("a token quoted URL-encoded in an error is redacted too", async (t) => {
  const telegram = fakeTelegram({ failChats: ["111"], encoded: true });
  const { actions, secrets, log } = setup(t, { telegram });
  secrets.set("globex", "TELEGRAM_BOT_TOKEN", BOT);
  assert.notEqual(encodeURIComponent(BOT), BOT, "the bot token's colon is encoded");
  const res = await actions.testTelegram();
  assert.equal(res.ok, false);
  assert.match(res.results[0].error, /bot\[redacted\]\/sendMessage/);
  assert.deepEqual(leaks([res, log.lines], BOT, encodeURIComponent(BOT)), []);

  assert.equal(scrub(`a ${encodeURIComponent(API_KEY + "/+=")} b ${API_KEY}/+=`, [`${API_KEY}/+=`]), "a [redacted] b [redacted]");
});
