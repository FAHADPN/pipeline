import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPublishDeps } from "../lib/campaign-deps.mjs";
import { loadSchedule } from "../lib/schedule.mjs";
import { runDay } from "../lib/run.mjs";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { CONFIG } from "./fixtures.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
process.env.PIPELINE_CAMPAIGNS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "campaigns-root-"));

const AT_SLOT = new Date("2026-10-25T14:00:00Z"); // Sun 19:30 IST, 14:00 in London (GMT)

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A postable piece in the folder contract, under root/dir.
function writePiece(root, dir, line) {
  const out = path.join(root, dir, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "piece.mp4"), "video");
  fs.writeFileSync(path.join(out, "piece-cover.png"), "cover");
  fs.writeFileSync(path.join(out, "piece-caption.txt"), `INSTAGRAM / TIKTOK\n${line}\n\n#test\n\nYOUTUBE SHORTS TITLE\n${line} #shorts\n`);
}

// A campaigns root holding:
//  - acme: Acme Coffee, on the default settings, its schedule and pieces under content/
//  - globex: a campaign in London with its own slot, two approvers and its own pieces
function setup({ globex = {} } = {}) {
  const root = tmp("campaigns-root-");
  const home = tmp("pipeline-home-");

  const acmeRoot = tmp("acme-");
  writeJson(path.join(acmeRoot, "content", "schedule.json"), [
    { id: "reel-01-launch", kind: "post", dir: "content/reels/reel-01-launch" },
    { id: "reel-02-menu", kind: "post", dir: "content/reels/reel-02-menu" },
  ]);
  writePiece(acmeRoot, "content/reels/reel-01-launch", "Acme launch");
  writePiece(acmeRoot, "content/reels/reel-02-menu", "Acme menu");
  writeJson(path.join(root, "acme", "campaign.json"), {
    id: "acme",
    name: "Acme Coffee",
    root: acmeRoot,
    approvers: ["900"],
    paths: { schedule: "content/schedule.json", piecesDir: "content/reels" },
  });

  const globexRoot = tmp("globex-");
  writeJson(path.join(globexRoot, "schedule.json"), [
    { id: "g-one", kind: "post", dir: "pieces/g-one" },
    { id: "g-two", kind: "post", dir: "pieces/g-two" },
  ]);
  writePiece(globexRoot, "pieces/g-one", "Globex one");
  writePiece(globexRoot, "pieces/g-two", "Globex two");
  writeJson(path.join(root, "globex", "campaign.json"), {
    id: "globex",
    name: "Globex",
    root: globexRoot,
    timezone: "Europe/London",
    slot: "14:00",
    approvers: ["111", "222"],
    ...globex,
  });

  const secrets = createSecrets(home);
  secrets.set("acme", "IG_ACCESS_TOKEN", "ig-acme");
  secrets.set("acme", "IG_USER_ID", "1");
  secrets.set("acme", "IG_ISSUED_AT", "2026-10-20T14:00:00.000Z");
  secrets.set("acme", "TELEGRAM_BOT_TOKEN", "bot-acme");
  secrets.set("globex", "IG_ACCESS_TOKEN", "ig-globex");
  secrets.set("globex", "IG_USER_ID", "2");
  secrets.set("globex", "IG_ISSUED_AT", "2026-10-20T14:00:00.000Z");
  secrets.set("globex", "TELEGRAM_BOT_TOKEN", "bot-globex");

  const campaign = (id) => getCampaign(id, { root, home });
  return { root, home, acmeRoot, globexRoot, secrets, campaign };
}

// Fake client makers: they record what each client was built with and never
// touch the network.
function fakeMakers() {
  const made = { instagram: [], youtube: [], telegram: [] };
  let n = 0;
  return {
    made,
    make: {
      instagram(opts) {
        const client = {
          opts,
          published: [],
          async listMedia() {
            return [];
          },
          async publishReel(args) {
            client.published.push(args);
            n++;
            return { mediaId: `M${n}`, url: `https://www.instagram.com/reel/${opts.token}-${n}/` };
          },
          async refreshToken() {
            return { token: `${opts.token}-refreshed` };
          },
        };
        made.instagram.push(client);
        return client;
      },
      youtube(opts) {
        made.youtube.push({ opts });
        return { opts };
      },
      telegram(opts) {
        const bot = {
          opts,
          sent: [],
          async send(text) {
            bot.sent.push(text);
          },
        };
        made.telegram.push(bot);
        return bot;
      },
    },
  };
}

const OWNER_ENV = { TELEGRAM_BOT_TOKEN: "bot-owner", TELEGRAM_CHAT_ID: "999", YT_CLIENT_ID: "cid", YT_CLIENT_SECRET: "csecret" };

const fakeServe = async ({ files }) => ({
  urls: Object.fromEntries(files.map((f) => [f.name, `https://t.ngrok-free.app/s/${f.name}`])),
  async close() {},
});

test("deps read the schedule at the campaign's own path and take the default settings", () => {
  const { home, acmeRoot, secrets, campaign } = setup();
  const { make, made } = fakeMakers();
  const deps = buildPublishDeps(campaign("acme"), { secrets, ownerEnv: OWNER_ENV, make });

  assert.equal(deps.repoRoot, acmeRoot);
  assert.equal(deps.name, "Acme Coffee");
  assert.deepEqual(deps.items, loadSchedule("content/schedule.json", acmeRoot));
  assert.deepEqual(deps.items.map((i) => i.id), ["reel-01-launch", "reel-02-menu"]);
  assert.deepEqual(deps.loadItems(), deps.items);
  // A campaign.json that sets no posting fields gets the defaults.
  assert.deepEqual(deps.config, CONFIG);

  // State lives in the campaign home.
  assert.equal(deps.home, path.join(home, "campaigns", "acme"));
  deps.store.save({ version: 1, items: { x: { instagram: { status: "manual", at: "t", date: "2026-10-25" } } } });
  assert.ok(fs.existsSync(path.join(home, "campaigns", "acme", "state.json")));

  // Tokens come from secrets/acme.json.
  assert.equal(deps.tokens.load().instagram.token, "ig-acme");
  assert.equal(made.instagram.length, 1);
  assert.deepEqual(made.instagram[0].opts, { token: "ig-acme", userId: "1", graphVersion: "v24.0" });
  assert.equal(deps.clients.instagram, made.instagram[0]);
  assert.equal(deps.clients.youtube, undefined); // disabled by default
  assert.deepEqual(deps.warnings, []);
});

test("deps for a sample campaign use its own schedule, state, secrets and bot", async () => {
  const { home, globexRoot, secrets, campaign } = setup();
  const { make, made } = fakeMakers();
  const deps = buildPublishDeps(campaign("globex"), { secrets, ownerEnv: OWNER_ENV, make });

  assert.equal(deps.repoRoot, globexRoot);
  assert.deepEqual(deps.items.map((i) => i.id), ["g-one", "g-two"]);
  assert.equal(deps.config.timeZone, "Europe/London");
  assert.equal(deps.config.slot, "14:00");
  assert.equal(deps.name, "Globex");
  assert.equal(deps.home, path.join(home, "campaigns", "globex"));

  // Its own Instagram token, nobody else's.
  assert.deepEqual(made.instagram.map((c) => c.opts.token), ["ig-globex"]);
  assert.equal(deps.client("instagram").opts.token, "ig-globex");

  // A refreshed token goes back to its own secrets file only.
  const saved = deps.tokens.load();
  deps.tokens.save({ ...saved, instagram: { ...saved.instagram, token: "ig-globex-2", issuedAt: "2026-10-25T14:00:00.000Z" } });
  assert.equal(secrets.get("globex", "IG_ACCESS_TOKEN"), "ig-globex-2");
  assert.equal(secrets.get("globex", "IG_ISSUED_AT"), "2026-10-25T14:00:00.000Z");
  assert.equal(secrets.get("acme", "IG_ACCESS_TOKEN"), "ig-acme");

  // Reports go through its own bot to each of its approvers.
  await deps.telegram.send("hello");
  const campaignBots = made.telegram.filter((b) => b.opts.token === "bot-globex");
  assert.deepEqual(campaignBots.map((b) => b.opts.chatId), ["111", "222"]);
  for (const bot of campaignBots) assert.deepEqual(bot.sent, ["hello"]);
  // Internal alerts go to the owner chat through the owner's bot.
  assert.deepEqual(deps.ownerTelegram.opts, { token: "bot-owner", chatId: "999" });
  assert.ok(!made.telegram.some((b) => b.opts.token === "bot-acme"));

  // YouTube, once enabled, uses the owner's Google client and its own refresh token.
  secrets.set("globex", "YT_REFRESH_TOKEN", "yt-globex");
  const yt = buildPublishDeps(campaign("globex"), { secrets, ownerEnv: OWNER_ENV, make });
  assert.deepEqual(yt.client("youtube").opts, { clientId: "cid", clientSecret: "csecret", refreshToken: "yt-globex" });
  assert.ok(yt.tokens.load().youtube.obtainedAt);
});

test("a campaign without its own bot uses the owner's, labelled with its name", async () => {
  const { secrets, campaign } = setup();
  secrets.remove("globex", "TELEGRAM_BOT_TOKEN");
  const { make, made } = fakeMakers();
  const deps = buildPublishDeps(campaign("globex"), { secrets, ownerEnv: OWNER_ENV, make });
  await deps.telegram.send("report");
  const toApprovers = made.telegram.filter((b) => b.opts.chatId !== "999");
  assert.deepEqual(toApprovers.map((b) => [b.opts.token, b.opts.chatId]), [["bot-owner", "111"], ["bot-owner", "222"]]);
  for (const bot of toApprovers) assert.deepEqual(bot.sent, ["[Globex] report"]);
});

test("missing credentials give no client and a warning, never a value", () => {
  const { secrets, campaign } = setup();
  secrets.remove("globex", "IG_ACCESS_TOKEN");
  const { make } = fakeMakers();
  const deps = buildPublishDeps(campaign("globex"), { secrets, ownerEnv: {}, make });
  assert.equal(deps.clients.instagram, undefined);
  assert.equal(deps.warnings.length, 1);
  assert.match(deps.warnings[0], /instagram: no Instagram token saved for globex/);
  assert.ok(!deps.warnings[0].includes("ig-"));
  assert.throws(() => deps.client("instagram"), /no Instagram token saved for globex/);
  // No approvers' bot and no owner .env: nothing to send to.
  assert.equal(buildPublishDeps(campaign("globex"), { secrets, ownerEnv: {}, make, }).ownerTelegram, undefined);
});

test("two campaigns post independently on the same day", async () => {
  const { home, secrets, campaign } = setup();
  const { make, made } = fakeMakers();

  const depsFor = (id) => ({
    ...buildPublishDeps(campaign(id), { secrets, ownerEnv: OWNER_ENV, make }),
    servePublicly: fakeServe,
    sleep: async () => {},
  });
  const acme = depsFor("acme");
  const globex = depsFor("globex");

  const a = await runDay({ now: AT_SLOT, deps: acme });
  const b = await runDay({ now: AT_SLOT, deps: globex });
  assert.deepEqual(a.posted.map((p) => p.id), ["reel-01-launch"]);
  assert.deepEqual(b.posted.map((p) => p.id), ["g-one"]);
  assert.match(a.posted[0].url, /ig-acme/);
  assert.match(b.posted[0].url, /ig-globex/);

  // Each posting record is in its own campaign home.
  const stateOf = (id) => JSON.parse(fs.readFileSync(path.join(home, "campaigns", id, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(stateOf("acme").items), ["reel-01-launch"]);
  assert.deepEqual(Object.keys(stateOf("globex").items), ["g-one"]);
  assert.equal(stateOf("acme").items["reel-01-launch"].instagram.date, "2026-10-25");
  assert.ok(!fs.existsSync(path.join(home, "state.json")));

  // Each report goes through its own bot, naming its campaign.
  const sentBy = (token) => made.telegram.filter((b) => b.opts.token === token).flatMap((b) => b.sent);
  assert.equal(sentBy("bot-acme").length, 1);
  assert.match(sentBy("bot-acme")[0], /^Acme Coffee · Sun 25 Oct/);
  assert.equal(sentBy("bot-globex").length, 2); // two approvers
  for (const text of sentBy("bot-globex")) assert.match(text, /^Globex · Sun 25 Oct/);
  assert.deepEqual(sentBy("bot-owner"), []);

  // Later the same day neither posts again, and neither blocks the other.
  const again = [await runDay({ now: new Date(AT_SLOT.getTime() + 15 * 60000), deps: depsFor("globex") })];
  again.push(await runDay({ now: new Date(AT_SLOT.getTime() + 15 * 60000), deps: depsFor("acme") }));
  for (const r of again) assert.deepEqual(r.posted, []);
  const published = made.instagram.flatMap((c) => c.published.map(() => c.opts.token));
  assert.deepEqual(published.sort(), ["ig-acme", "ig-globex"]);
});

test("campaign lock names are prefixed", async () => {
  const { home, secrets, campaign } = setup();
  const { make } = fakeMakers();
  const globex = buildPublishDeps(campaign("globex"), { secrets, ownerEnv: {}, make });
  const acme = buildPublishDeps(campaign("acme"), { secrets, ownerEnv: {}, make });
  assert.equal(globex.lockName("publish"), "globex:publish");
  assert.equal(acme.lockName("publish"), "acme:publish");

  // Locks sit in the shared publisher home, one file per campaign and name.
  const locks = path.join(home, "locks");
  const order = [];
  await globex.withLock("publish", async () => {
    assert.ok(fs.existsSync(path.join(locks, "globex.publish.lock")));
    // Another campaign's publish lock is free while this one is held.
    await acme.withLock("publish", async () => order.push("acme"), { waitMs: 0 });
    // The same campaign's is not.
    await assert.rejects(globex.withLock("publish", async () => order.push("twice"), { waitMs: 0 }), /lock globex:publish busy/);
    order.push("globex");
  });
  assert.deepEqual(order, ["acme", "globex"]);
  assert.deepEqual(fs.readdirSync(locks), []);
});
