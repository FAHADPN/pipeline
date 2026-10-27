// The publisher CLI: one campaign's posting queue, by hand. With no command it is
// the daily run, the same runDay the scheduler loop (campaigns/pipeline.mjs
// publish-tick) runs for every campaign. See publishing/README.md for setup and
// every command.
//
// Every command works on one campaign under the campaigns root (PIPELINE_CAMPAIGNS_ROOT,
// or C:\Campaigns): `--campaign <id>` picks it; without it, the only campaign there is
// used, and none or several is a usage error that lists the ids found. The campaign's
// schedule, settings, state, secrets, Telegram bot and locks come from
// lib/campaign-deps.mjs. The owner's <home>/.env holds the Google client `auth youtube`
// uses and the owner chat a crashed daily run is reported to.
//
// Exit code 0 means OK, 1 means something failed.

import http from "node:http";
import path from "node:path";
import { campaignsRoot, getCampaign, pickCampaignId } from "../campaigns/lib/campaign.mjs";
import { createSecrets } from "../campaigns/lib/secrets.mjs";
import { isRealDate, istDate, istMinutes } from "./lib/dates.mjs";
import { isFloating, inWindow } from "./lib/schedule.mjs";
import { checkItem, firstLine } from "./lib/content.mjs";
import { publisherHome, loadEnv } from "./lib/env.mjs";
import { getEntry, isDone, setEntry } from "./lib/state.mjs";
import { createLogger } from "./lib/log.mjs";
import { planDay, projectRunDry } from "./lib/planner.mjs";
import { runDay, postNow } from "./lib/run.mjs";
import { formatReport } from "./lib/report.mjs";
import { syncState } from "./lib/sync.mjs";
import { createInstagram } from "./lib/instagram.mjs";
import { servePublicly } from "./lib/public-file.mjs";
import { buildAuthUrl, exchangeCode, REDIRECT_URI } from "./lib/youtube.mjs";
import { createTelegram } from "./lib/telegram.mjs";
import { buildPublishDeps } from "./lib/campaign-deps.mjs";

const PLATFORMS = ["instagram", "youtube"];
const MARKS = ["posted", "manual", "dropped", "clear"];
const DAY_MS = 86400000;

const USAGE = `Usage: node publishing/publish.mjs [command] [options] [--campaign <id>]

  (no command)                       the daily run: post what's due today
  --dry-run                          show what the daily run would do now, change nothing
  status                             every item's status, the rhythm, run-dry date, token ages
  check                              check every item not yet on Instagram; exit 1 if any fail
  post <id> [--platform instagram|youtube] --now
                                     post one item now, bypassing the planner
  sync-state [--platform instagram|youtube]
                                     record posts that are already live
  mark <id> <instagram|youtube> <posted|manual|dropped|clear> [--date YYYY-MM-DD]
                                     correct one item's state by hand
  auth instagram                     look up the account behind IG_ACCESS_TOKEN in the
                                     campaign's secrets and save it there
  auth youtube                       run the Google consent flow on ${REDIRECT_URI}
  test-telegram                      send a test message to the campaign's approvers
  ig-fetch-test <id>                 check Instagram can fetch the item through ngrok,
                                     without publishing anything

  --campaign <id> picks the campaign under the campaigns root (PIPELINE_CAMPAIGNS_ROOT,
  default C:\\Campaigns). Without it, the only campaign there is used.
`;

// Which flags each command accepts. A flag a command doesn't take is refused, so a
// mistyped `post x --now --dry-run` can never post for real.
const COMMANDS = {
  run: { flags: ["--dry-run"] },
  status: { flags: [] },
  check: { flags: [] },
  post: { flags: ["--platform", "--now"] },
  "sync-state": { flags: ["--platform"] },
  mark: { flags: ["--date"] },
  auth: { flags: [] },
  "test-telegram": { flags: [] },
  "ig-fetch-test": { flags: [] },
};
const VALUE_FLAGS = new Set(["--platform", "--date", "--campaign"]);
// Taken by every command.
const GLOBAL_FLAGS = ["--campaign"];

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      flags[arg] = argv[++i];
    } else {
      flags[arg] = true;
    }
  }
  const command = positional.shift() ?? "run";
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command: ${command}`);
  for (const flag of Object.keys(flags)) {
    if (!spec.flags.includes(flag) && !GLOBAL_FLAGS.includes(flag)) throw new UsageError(`${command === "run" ? "the daily run" : command} doesn't take ${flag}`);
  }
  return { command, args: positional, flags };
}

function platformFlag(flags) {
  const platform = flags["--platform"] ?? "instagram";
  if (!PLATFORMS.includes(platform)) throw new UsageError(`unknown platform: ${platform}`);
  return platform;
}

// What every command works on: one campaign's deps (lib/campaign-deps.mjs). Loading
// it only reads. `alert` learns the campaign's name and home as soon as they're
// known, for the crash report.
function campaignContext(id, { home, root, env, alert }) {
  const campaign = getCampaign(id, { home, root });
  alert.label = campaign.name;
  alert.home = campaign.home;
  const secrets = createSecrets(home);
  const deps = buildPublishDeps(campaign, { secrets, ownerEnv: env });
  return {
    home: campaign.home,
    // Only what `auth` reads: the owner's Google client and this campaign's Instagram token.
    env: { YT_CLIENT_ID: env.YT_CLIENT_ID, YT_CLIENT_SECRET: env.YT_CLIENT_SECRET, IG_ACCESS_TOKEN: secrets.get(id, "IG_ACCESS_TOKEN") },
    config: deps.config,
    items: deps.items,
    store: deps.store,
    tokens: deps.tokens,
    name: deps.name,
    repoRoot: deps.repoRoot,
    configFile: `the ${id} campaign.json`,
    envFile: path.join(home, ".env"),
    secretsFile: path.join(home, "secrets", `${id}.json`),
    client: deps.client,
    telegram: deps.telegram,
    withPublishLock: (fn) => deps.withLock("publish", fn),
  };
}

function findItem(items, id) {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no item ${id} in the schedule`);
  return item;
}

function checkAll(repoRoot, items) {
  const checks = new Map();
  for (const item of items) {
    try {
      checks.set(item.id, checkItem(repoRoot, item));
    } catch (err) {
      checks.set(item.id, { ok: false, errors: [err.message], warnings: [] });
    }
  }
  return checks;
}

// The owner chat, from <home>/.env. Only a crashed daily run is reported there.
function ownerTelegram(env) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = env;
  if (!token || !chatId) return undefined;
  return createTelegram({ token, chatId });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatPlan(plan) {
  const out = [`Plan: window ${plan.window} · ${plan.rhythm} · ${plan.postingDay ? "posting day" : "off day"}`];
  for (const p of plan.posts) out.push(`  would post: ${p.platform} ${p.id} (${p.why})`);
  if (!plan.posts.length) out.push("  would post: nothing");
  for (const d of plan.drops) out.push(`  would drop: ${d.platform} ${d.id} (${d.reason})`);
  for (const id of plan.notReady) out.push(`  not ready: ${id}`);
  return out.join("\n");
}

const reportOptions = (ctx) => ({ name: ctx.name, slot: ctx.config.slot, lateLimitMinutes: ctx.config.lateLimitMinutes });

async function cmdRun(ctx, { flags }) {
  const now = new Date();
  const dryRun = Boolean(flags["--dry-run"]);
  const log = createLogger(ctx.home);
  const deps = { repoRoot: ctx.repoRoot, items: ctx.items, config: ctx.config, store: ctx.store, tokens: ctx.tokens, name: ctx.name, log, sleep };

  if (dryRun) {
    // No clients, no Telegram, nothing written.
    const result = await runDay({ now, dryRun: true, deps: { ...deps, clients: {} } });
    console.log(formatReport(result, reportOptions(ctx)));
    console.log("");
    console.log(formatPlan(result.plan));
    return 0;
  }

  // A platform whose credentials are missing gets no client; runDay records that
  // as a failure and the report says so.
  const clients = {};
  const warnings = [];
  for (const [platform, settings] of Object.entries(ctx.config.platforms)) {
    if (!settings.enabled) continue;
    try {
      clients[platform] = ctx.client(platform);
    } catch (err) {
      warnings.push(`${platform}: ${err.message}`);
    }
  }
  for (const w of warnings) log.error("client setup failed", { warning: w });

  const result = await runDay({ now, deps: { ...deps, clients, telegram: ctx.telegram } });
  console.log(formatReport(result, reportOptions(ctx)));
  return result.failed.length ? 1 : 0;
}

function datesOf(item) {
  if (item.on) return `on:${item.on}`;
  const parts = [];
  if (item.notBefore) parts.push(`from:${item.notBefore}`);
  if (item.notAfter) parts.push(`until:${item.notAfter}`);
  return parts.join(",") || "-";
}

function ageInDays(iso, now) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY_MS);
}

function cmdStatus(ctx) {
  const now = new Date();
  const { config, items } = ctx;
  const today = istDate(now, config.timeZone);
  const state = ctx.store.load();
  const checks = checkAll(ctx.repoRoot, items);
  const ready = new Set([...checks].filter(([, c]) => c.ok).map(([id]) => id));

  const rows = [["ID", "DATES", "INSTAGRAM", "YOUTUBE", "READY"]];
  for (const item of items) {
    const status = (p) => getEntry(state, item.id, p)?.status ?? "-";
    rows.push([item.id, datesOf(item), status("instagram"), status("youtube"), ready.has(item.id) ? "yes" : "no"]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const row of rows) console.log(row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join("  "));

  const plan = planDay({ today, minutesNow: istMinutes(now, config.timeZone), items, state, ready, config });
  const runDry = projectRunDry({ today, items, state, ready, config });
  console.log("");
  console.log(`Today: ${today}`);
  for (const [platform, settings] of Object.entries(config.platforms)) {
    if (!settings.enabled) continue;
    const next = items.find(
      (i) => isFloating(i) && !isDone(state, i.id, platform) && inWindow(i, today) && ready.has(i.id),
    );
    console.log(`Next floating on ${platform}: ${next?.id ?? "none"}`);
  }
  console.log(`Ready: ${plan.readyCount} · ${plan.rhythm} · runs dry ${runDry ?? "never"}`);

  const tokens = ctx.tokens.load();
  const igAge = ageInDays(tokens.instagram?.issuedAt, now);
  const ytAge = ageInDays(tokens.youtube?.obtainedAt, now);
  console.log(`Instagram token: ${igAge === null ? "not set" : `${igAge} days old (refreshed after ${config.platforms.instagram.tokenRefreshDays})`}`);
  console.log(`YouTube token: ${ytAge === null ? "not set" : `${ytAge} days old`}`);
  return 0;
}

function cmdCheck(ctx) {
  const state = ctx.store.load();
  let failed = 0;
  for (const item of ctx.items) {
    if (isDone(state, item.id, "instagram")) continue;
    let result;
    try {
      result = checkItem(ctx.repoRoot, item);
    } catch (err) {
      result = { ok: false, errors: [err.message], warnings: [] };
    }
    if (result.ok) {
      console.log(`ok    ${item.id}`);
    } else {
      failed++;
      for (const e of result.errors) console.log(`FAIL  ${item.id}: ${e}`);
    }
    for (const w of result.warnings ?? []) console.log(`warn  ${item.id}: ${w}`);
  }
  console.log(failed ? `${failed} item(s) failed the check.` : "Every queued item passes.");
  return failed ? 1 : 0;
}

async function cmdPost(ctx, { args, flags }) {
  const [id] = args;
  if (!id || args.length > 1) throw new UsageError("post takes exactly one item id");
  if (!flags["--now"]) throw new UsageError("post needs --now to confirm it should post right away");
  const platform = platformFlag(flags);
  const item = findItem(ctx.items, id);
  if (!ctx.config.platforms[platform]?.enabled) throw new Error(`${platform} is disabled in ${ctx.configFile}`);

  const result = await postNow({
    item,
    platform,
    now: new Date(),
    deps: {
      repoRoot: ctx.repoRoot,
      config: ctx.config,
      store: ctx.store,
      clients: { [platform]: ctx.client(platform) },
      log: createLogger(ctx.home),
      sleep,
    },
  });
  for (const w of result.warnings) console.log(`warn  ${id}: ${w}`);
  if (result.outcome === "posted") console.log(`Posted ${id} to ${platform}: ${result.url}`);
  else if (result.outcome === "alreadyLive") console.log(`${id} was already live on ${platform}, recorded ${result.url}`);
  else console.log(`Failed to post ${id} to ${platform}: ${result.error}`);
  return result.outcome === "failed" ? 1 : 0;
}

async function cmdSyncState(ctx, { args, flags }) {
  if (args.length) throw new UsageError("sync-state takes no arguments");
  const platform = platformFlag(flags);
  // Built even while the platform is disabled: Shorts scheduled by hand in Studio
  // are recorded this way before YouTube publishing is switched on.
  const client = ctx.client(platform);
  const { matches, unmatched, marked } = await syncState({
    client,
    items: ctx.items,
    repoRoot: ctx.repoRoot,
    store: ctx.store,
    platform,
    timeZone: ctx.config.timeZone,
  });

  const when = (post) => post.timestamp ?? post.publishedAt;
  const where = (post) => post.permalink ?? `https://youtube.com/shorts/${post.videoId}`;
  const text = (post) => firstLine(post.caption ?? post.title ?? "");
  console.log(`Matched (${matches.length}):`);
  for (const { id, post } of matches) console.log(`  ${id}  ${when(post)}  ${where(post)}`);
  console.log(`Unmatched (${unmatched.length}):`);
  for (const post of unmatched) console.log(`  ${when(post)}  ${where(post)}  "${text(post)}"`);
  console.log(`Marked ${marked} new item(s) as manual on ${platform}.`);
  createLogger(ctx.home).info("sync-state", { platform, matched: matches.length, unmatched: unmatched.length, marked });
  return 0;
}

function cmdMark(ctx, { args, flags }) {
  const [id, platform, status] = args;
  if (args.length !== 3) throw new UsageError("mark takes <id> <platform> <status>");
  findItem(ctx.items, id);
  if (!PLATFORMS.includes(platform)) throw new UsageError(`unknown platform: ${platform}`);
  if (!MARKS.includes(status)) throw new UsageError(`status must be one of ${MARKS.join(", ")}`);
  const date = flags["--date"];
  if (date !== undefined && !isRealDate(date)) throw new UsageError(`--date must be a real YYYY-MM-DD date: ${date}`);

  const now = new Date();
  const state = ctx.store.load();
  if (status === "clear") {
    if (state.items[id]) {
      delete state.items[id][platform];
      if (!Object.keys(state.items[id]).length) delete state.items[id];
    }
  } else {
    const entry = { status, at: now.toISOString(), reason: "marked by hand" };
    // A posted or manual entry counts as that day's post, so a same-day run won't add another.
    if (status !== "dropped") entry.date = date ?? istDate(now, ctx.config.timeZone);
    setEntry(state, id, platform, entry);
  }
  ctx.store.save(state);
  createLogger(ctx.home).info("mark", { id, platform, status, date });
  console.log(status === "clear" ? `Cleared ${id} on ${platform}.` : `Marked ${id} ${status} on ${platform}.`);
  return 0;
}

async function authInstagram(ctx) {
  const token = ctx.env.IG_ACCESS_TOKEN;
  if (!token) throw new Error(`IG_ACCESS_TOKEN is not set in ${ctx.secretsFile}`);
  const ig = createInstagram({ token, userId: undefined, graphVersion: ctx.config.platforms.instagram.graphVersion });
  const { userId, username } = await ig.me();
  const tokens = ctx.tokens.load();
  ctx.tokens.save({ ...tokens, instagram: { token, userId, username, issuedAt: new Date().toISOString() } });
  console.log(`Instagram connected: ${username}`);
  return 0;
}

// Waits for Google to redirect the browser to REDIRECT_URI with ?code=. The page
// the browser shows names the campaign.
function waitForCode(name) {
  const { port, pathname } = new URL(REDIRECT_URI);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== pathname) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(code ? `${name} publisher: YouTube connected. You can close this tab.` : `${name} publisher: consent failed (${error}).`);
      server.close();
      if (code) resolve(code);
      else reject(new Error(`Google consent failed: ${error ?? "no code"}`));
    });
    server.on("error", reject);
    server.listen(Number(port), "127.0.0.1");
  });
}

async function authYouTube(ctx) {
  const { YT_CLIENT_ID: clientId, YT_CLIENT_SECRET: clientSecret } = ctx.env;
  if (!clientId || !clientSecret) throw new Error(`YT_CLIENT_ID and YT_CLIENT_SECRET must be set in ${ctx.envFile}`);
  const codePromise = waitForCode(ctx.name);
  console.log(`Open this URL in a browser, sign in as the ${ctx.name} channel and allow access:`);
  console.log("");
  console.log(buildAuthUrl({ clientId }));
  console.log("");
  console.log(`Waiting for the redirect to ${REDIRECT_URI} ...`);
  const code = await codePromise;
  const { refreshToken } = await exchangeCode({ clientId, clientSecret, code });
  const tokens = ctx.tokens.load();
  ctx.tokens.save({ ...tokens, youtube: { refreshToken, obtainedAt: new Date().toISOString() } });
  console.log("YouTube connected.");
  return 0;
}

async function cmdAuth(ctx, { args }) {
  const [platform] = args;
  if (args.length !== 1 || !PLATFORMS.includes(platform)) throw new UsageError("auth takes instagram or youtube");
  return platform === "instagram" ? authInstagram(ctx) : authYouTube(ctx);
}

async function cmdTestTelegram(ctx) {
  const { telegram } = ctx;
  if (!telegram) throw new Error(`no Telegram for ${ctx.name}: it needs approvers in its campaign.json and a TELEGRAM_BOT_TOKEN in ${ctx.secretsFile} or ${ctx.envFile}`);
  await telegram.send(`${ctx.name} publisher connected ✅`);
  console.log("Sent.");
  return 0;
}

// Everything a real post does up to media_publish: serve the item through ngrok,
// create the REELS container and wait for Instagram to fetch and process it. The
// container is never published, and expires by itself after 24 hours.
async function cmdIgFetchTest(ctx, { args }) {
  const [id] = args;
  if (!id || args.length > 1) throw new UsageError("ig-fetch-test takes exactly one item id");
  const item = findItem(ctx.items, id);
  const checked = checkItem(ctx.repoRoot, item);
  if (!checked.ok) throw new Error(`${id} fails check: ${checked.errors.join("; ")}`);
  const ig = ctx.client("instagram");
  const settings = ctx.config.platforms.instagram;

  const tunnel = await servePublicly({
    files: [
      { path: checked.assets.video, name: "video.mp4" },
      { path: checked.assets.cover, name: "cover.png" },
    ],
    ngrokBin: settings.ngrokBin,
  });
  const started = Date.now();
  let status;
  try {
    console.log(`Serving ${id} through ngrok. Creating the Reel container (it will not be published)...`);
    const container = await ig.createReelContainer({
      videoUrl: tunnel.urls["video.mp4"],
      coverUrl: tunnel.urls["cover.png"],
      caption: checked.caption.instagram,
    });
    console.log(`Container ${container}: waiting for Instagram to fetch and process it...`);
    try {
      status = await ig.waitForContainer(container);
    } catch (err) {
      status = err.message;
    }
  } finally {
    await tunnel.close();
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Container status: ${status} after ${seconds}s`);
  createLogger(ctx.home).info("ig-fetch-test", { id, status, seconds });
  return status === "FINISHED" ? 0 : 1;
}

const HANDLERS = {
  run: cmdRun,
  status: cmdStatus,
  check: cmdCheck,
  post: cmdPost,
  "sync-state": cmdSyncState,
  mark: cmdMark,
  auth: cmdAuth,
  "test-telegram": cmdTestTelegram,
  "ig-fetch-test": cmdIgFetchTest,
};

// Commands that post or write state.json run under the campaign's "publish" lock
// (<id>:publish), so they never overlap each other, the scheduler loop or the
// dashboard. The dry run writes nothing. ig-fetch-test takes it too: it opens an
// ngrok tunnel, and two at once can clash.
function needsLock({ command, flags }) {
  if (command === "run") return !flags["--dry-run"];
  return ["post", "sync-state", "mark", "ig-fetch-test"].includes(command);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 1;
  }

  const home = publisherHome();
  const root = campaignsRoot();
  // Where a crash is logged and what the owner's alert calls it.
  const alert = { home, label: "Pipeline" };
  let env = {};
  try {
    env = loadEnv(path.join(home, ".env"));
    const id = pickCampaignId(parsed.flags["--campaign"], { root });
    alert.label = `campaign ${id}`;
    const ctx = campaignContext(id, { home, root, env, alert });
    const handle = () => HANDLERS[parsed.command](ctx, parsed);
    return await (needsLock(parsed) ? ctx.withPublishLock(handle) : handle());
  } catch (err) {
    if (err instanceof UsageError || err.usage) {
      console.error(`${err.message}\n\n${USAGE}`);
      return 1;
    }
    console.error(`Error: ${err.message}`);
    // A daily run must never fail silently, even on a broken schedule.
    if (parsed.command === "run" && !parsed.flags["--dry-run"]) {
      try {
        // Always the owner chat, never a campaign's approvers.
        createLogger(alert.home).error("run crashed", { error: err.message });
        await ownerTelegram(env)?.send(`❌ ${alert.label} publisher crashed: ${err.message}`);
      } catch {
        // Already reported on stderr.
      }
    }
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
