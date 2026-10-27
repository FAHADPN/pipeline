// The scheduler loops: one process per loop, each going over every campaign under
// the campaigns root (campaigns/lib/campaign.mjs). Task Scheduler starts them
// (install-tasks.mjs):
//
//   publish-tick [--shadow]  every 15 minutes. For each campaign that isn't paused,
//       works out its posting window in its own time zone. Before the slot it does
//       nothing. From the slot on, the first tick of the day runs that campaign's
//       runDay under "<id>:publish" and records the day in <campaign home>/
//       publish-day.json, so later ticks leave it alone: one run a day, with one
//       report and no same-day retry of a failed post. A first tick after the window
//       (the machine was asleep) is that day's late run. runDay's own once-a-day rule
//       (postedFloatingOn) still holds if the record is lost.
//       --shadow runs runDay as a dry run with no clients and no Telegram, logs what
//       it would post, and records the day in publish-shadow-day.json instead.
//   create-nightly           at 02:00. Shares PIPELINE_MAX_BUILDS_TOTAL builds
//       (default 3) round-robin across the campaigns that aren't paused, each within
//       its own maxBuilds and maxAwaiting, starting from a different campaign each
//       night. Then runs each campaign's runNightly with its share
//       (creation/lib/campaign-deps.mjs). A campaign the cap left out builds nothing
//       and the owner is told.
//   telegram-tick            every 5 minutes. Polls each campaign's bot, keeping its
//       offset in <campaign home>/telegram-offset.json. Campaigns that share a bot
//       (the owner's) share one getUpdates, and each tap or note goes only to the
//       campaign it's for. Paused campaigns are polled too, so a tap on a piece
//       already sent still lands; pausing stops posting and building. It never starts
//       queued builds: it runs as S4U, outside the owner's desktop session, where
//       renders and Claude Code don't run (the dashboard server runs the build queue,
//       in the owner's session).
//
// One campaign failing never stops the next. A crash goes to the owner chat (the
// owner's bot and TELEGRAM_CHAT_ID in <home>/.env), never to a campaign's approvers.
// An invalid campaign.json skips that campaign only, and the owner is told once a day.
//
// Importing this file runs nothing; the tests call the loops with fakes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { istDate, istMinutes, parseSlot } from "../publishing/lib/dates.mjs";
import { loadEnv, publisherHome } from "../publishing/lib/env.mjs";
import { createLogger } from "../publishing/lib/log.mjs";
import { createTelegram } from "../publishing/lib/telegram.mjs";
import { buildPublishDeps } from "../publishing/lib/campaign-deps.mjs";
import { runDay as realRunDay } from "../publishing/lib/run.mjs";
import { handleUpdates } from "../creation/lib/approval.mjs";
import { buildCreationDeps } from "../creation/lib/campaign-deps.mjs";
import { runNightly as realRunNightly } from "../creation/lib/nightly.mjs";
import { pickWork } from "../creation/lib/picker.mjs";
import { campaignIds, getCampaign, loadCampaigns } from "./lib/campaign.mjs";
import { createSecrets } from "./lib/secrets.mjs";

const DAY_MS = 86400000;
const PUBLISH_MARKER = "publish-day.json";
const SHADOW_MARKER = "publish-shadow-day.json";
const OFFSET_FILE = "telegram-offset.json";
const ALERTS_FILE = "pipeline-alerts.json";
const BUTTON = /^(?:approve|redo):([a-z0-9-]+)$/;
export const DEFAULT_MAX_BUILDS_TOTAL = 3;
// How long a tick waits for a campaign's publish lock (held by the CLI or the
// dashboard) before leaving that campaign to the next tick.
const PUBLISH_LOCK_WAIT_MS = 2 * 60000;

const USAGE = `Usage: node campaigns/pipeline.mjs <command>

  publish-tick [--shadow]   post what's due for every campaign whose window is open
                            (--shadow: a dry run that only logs what it would post)
  create-nightly            tonight's builds, shared across the campaigns
  telegram-tick             handle Approve and Redo taps from every campaign's bot
`;

const COMMANDS = { "publish-tick": ["--shadow"], "create-nightly": [], "telegram-tick": [] };

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError("no command given");
  if (!COMMANDS[command]) throw new UsageError(`unknown command: ${command}`);
  const flags = {};
  for (const arg of rest) {
    if (!arg.startsWith("--")) throw new UsageError(`${command} takes no arguments`);
    if (!COMMANDS[command].includes(arg)) throw new UsageError(`${command} doesn't take ${arg}`);
    flags[arg] = true;
  }
  return { command, flags };
}

// A missing file is undefined; a broken one throws.
function readJson(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function readJsonSafe(file) {
  try {
    return readJson(file);
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n");
  fs.renameSync(tmp, file);
}

// Sends, and swallows a failure: an alert that can't go out is never a crash.
async function safely(fn, log, what) {
  try {
    await fn();
  } catch (err) {
    log?.error(`${what} failed`, { error: err.message });
  }
}

// Every campaign that loads. An invalid campaign.json skips only that campaign; its
// problems come back for the owner.
export function loadActive({ root, home }) {
  try {
    return { campaigns: loadCampaigns({ root, home }), problems: [] };
  } catch (err) {
    if (!err.problems) throw err;
    const campaigns = [];
    for (const dir of campaignIds({ root })) {
      try {
        campaigns.push(getCampaign(dir, { root, home }));
      } catch {
        // Listed in err.problems.
      }
    }
    return { campaigns, problems: err.problems };
  }
}

// The campaign's posting window at `now`, in its own time zone, by the same rule
// as the planner: open from the slot to slot + lateLimitMinutes.
export function postingWindow(campaign, now) {
  const { timezone, slot, lateLimitMinutes } = campaign.config;
  const minutes = istMinutes(now, timezone);
  const start = parseSlot(slot);
  const window = minutes < start ? "early" : minutes > start + lateLimitMinutes ? "late" : "open";
  return { today: istDate(now, timezone), window };
}

function shadowLines(id, plan) {
  const out = [`${id}: shadow · window ${plan.window} · ${plan.rhythm} · ${plan.postingDay ? "posting day" : "off day"}`];
  for (const p of plan.posts) out.push(`${id}: would post ${p.platform} ${p.id} (${p.why})`);
  if (!plan.posts.length) out.push(`${id}: would post nothing`);
  for (const d of plan.drops) out.push(`${id}: would drop ${d.platform} ${d.id} (${d.reason})`);
  for (const n of plan.notReady) out.push(`${id}: not ready: ${n}`);
  return out;
}

function liveLines(id, result) {
  const out = [];
  for (const p of result.posted) out.push(`${id}: posted ${p.platform} ${p.id} ${p.url}`);
  for (const a of result.alreadyLive) out.push(`${id}: already live ${a.platform} ${a.id} ${a.url}`);
  for (const f of result.failed) out.push(`${id}: failed ${f.platform} ${f.id}: ${f.error}`);
  if (!out.length) out.push(`${id}: ran (window ${result.window}), posted nothing`);
  return out;
}

// One publish tick. depsFor(campaign) gives buildPublishDeps' deps. Returns one
// { id, outcome, result?, error? } per campaign; outcome is paused, early,
// done today, busy, ran or crashed.
export async function publishTick({
  campaigns,
  now = new Date(),
  shadow = false,
  depsFor,
  runDay = realRunDay,
  alert = async () => {},
  print = () => {},
  log,
  lock = {},
}) {
  const results = [];
  for (const campaign of campaigns) {
    const { id } = campaign;
    if (campaign.paused) {
      results.push({ id, outcome: "paused" });
      continue;
    }
    const { today, window } = postingWindow(campaign, now);
    if (window === "early") {
      results.push({ id, outcome: "early" });
      continue;
    }
    const marker = path.join(campaign.home, shadow ? SHADOW_MARKER : PUBLISH_MARKER);
    const ranToday = () => readJsonSafe(marker)?.date === today;
    if (ranToday()) {
      results.push({ id, outcome: "done today" });
      continue;
    }

    let deps;
    let entered = false;
    try {
      deps = depsFor(campaign);
      const result = await deps.withLock("publish", async () => {
        entered = true;
        if (ranToday()) return undefined;
        let out;
        if (shadow) {
          // No clients and no Telegram: nothing is fetched, posted, sent or written.
          out = await runDay({ now, dryRun: true, deps: { ...deps, clients: {}, telegram: undefined } });
          const lines = shadowLines(id, out.plan);
          for (const line of lines) print(line);
          deps.log.info("shadow run", { lines });
        } else {
          for (const w of deps.warnings ?? []) deps.log.error("client setup failed", { warning: w });
          out = await runDay({ now, deps });
          for (const line of liveLines(id, out)) print(line);
        }
        writeJson(marker, { date: today, window, at: now.toISOString() });
        return out;
      }, { waitMs: PUBLISH_LOCK_WAIT_MS, ...lock });
      results.push(result ? { id, outcome: "ran", result } : { id, outcome: "done today" });
    } catch (err) {
      if (!entered && deps) {
        // Another run holds this campaign's lock; the next tick tries again.
        results.push({ id, outcome: "busy", error: err.message });
        print(`${id}: skipped, ${err.message}`);
        (deps.log ?? log)?.info("publish tick skipped", { error: err.message });
        continue;
      }
      results.push({ id, outcome: "crashed", error: err.message });
      print(`${id}: crashed: ${err.message}`);
      (deps?.log ?? log)?.error(shadow ? "shadow run crashed" : "publish tick crashed", { error: err.message });
      if (!shadow) await safely(() => alert(`❌ ${campaign.name} publisher crashed: ${err.message}`), log, "owner alert");
    }
  }
  return results;
}

// Shares `total` builds one at a time round-robin, starting at index `start`,
// never giving a campaign more than it wants. Returns the share per campaign.
export function shareBuilds(wants, total, start = 0) {
  const got = wants.map(() => 0);
  let left = total;
  while (left > 0) {
    let gave = false;
    for (let k = 0; k < wants.length && left > 0; k++) {
      const i = (start + k) % wants.length;
      if (got[i] < wants[i]) {
        got[i]++;
        left--;
        gave = true;
      }
    }
    if (!gave) break;
  }
  return got;
}

// Days since 1970 of the night's date in India, so the round-robin's first
// campaign moves on by one each night.
const nightNumber = (now) => Math.floor(Date.parse(istDate(now)) / DAY_MS);

// The nightly builds. depsFor(campaign) gives buildCreationDeps' deps. Returns one
// { id, outcome, want?, builds?, result?, error? } per campaign; outcome is paused,
// deferred (the cap went to others), ran or crashed.
export async function createNightly({
  campaigns,
  now = new Date(),
  maxTotal = DEFAULT_MAX_BUILDS_TOTAL,
  depsFor,
  runNightly = realRunNightly,
  alert = async () => {},
  print = () => {},
  log,
}) {
  const results = [];
  const ready = [];
  for (const campaign of campaigns) {
    const { id } = campaign;
    if (campaign.paused) {
      results.push({ id, outcome: "paused" });
      continue;
    }
    try {
      const deps = depsFor(campaign);
      if (!deps.telegram) throw new Error(deps.telegramProblem ?? `${id} has no approval chat`);
      const { formats, maxBuilds, maxAwaiting } = deps.picker;
      const want = pickWork({ backlog: deps.backlog, cstate: deps.store.load(), formats, maxBuilds, maxAwaiting }).length;
      const entry = { id, outcome: "pending", want };
      results.push(entry);
      ready.push({ campaign, deps, entry, want });
    } catch (err) {
      results.push({ id, outcome: "crashed", error: err.message });
      print(`${id}: crashed: ${err.message}`);
      log?.error("create nightly: campaign not loaded", { id, error: err.message });
      await safely(() => alert(`❌ ${campaign.name} builds crashed: ${err.message}`), log, "owner alert");
    }
  }

  const shares = ready.length ? shareBuilds(ready.map((r) => r.want), maxTotal, nightNumber(now) % ready.length) : [];
  for (const [i, { campaign, deps, entry, want }] of ready.entries()) {
    const builds = shares[i];
    if (want > 0 && builds === 0) {
      entry.outcome = "deferred";
      print(`${campaign.id}: nothing built, the cap of ${maxTotal} went to other campaigns`);
      deps.log?.info("nightly deferred", { want, maxTotal });
      await safely(
        () => deps.alerts.sendMessage(`Nothing built tonight: the nightly cap of ${maxTotal} builds across campaigns went to other campaigns. ${want} piece(s) wait for the next night.`),
        deps.log,
        "deferred alert",
      );
      continue;
    }
    // A campaign with nothing to build still runs, for its summary and to clear a
    // build left stuck by a run that stopped; it gets no builds.
    const { formats, maxAwaiting } = deps.picker;
    try {
      const out = await runNightly({ now, maxBuilds: builds, maxAwaiting, formats, deps });
      Object.assign(entry, { outcome: "ran", builds, result: out });
      if (out.skipped) print(`${campaign.id}: skipped: ${out.skipped}`);
      for (const id of out.built ?? []) print(`${campaign.id}: sent for approval ${id}`);
      for (const f of out.failed ?? []) print(`${campaign.id}: failed ${f.id}: ${f.reason}`);
    } catch (err) {
      Object.assign(entry, { outcome: "crashed", builds, error: err.message });
      print(`${campaign.id}: crashed: ${err.message}`);
      deps.log?.error("nightly crashed", { error: err.message });
      await safely(() => deps.alerts.sendMessage(`❌ builds crashed: ${err.message}`), deps.log, "owner alert");
    }
  }
  return results;
}

function readOffset(deps) {
  return readJson(path.join(deps.home, OFFSET_FILE))?.offset;
}

function hasPiece(deps, id) {
  try {
    return deps.backlog.some((e) => e.id === id);
  } catch {
    return false;
  }
}

function pendingNote(deps) {
  try {
    return deps.store.load().pendingNote;
  } catch {
    return undefined;
  }
}

// Which of the campaigns sharing a bot an update is for: a tap goes to the
// approver's campaign holding that piece, a note to the approver's campaign
// waiting for one (the one named in the message it replies to, if several are).
// undefined means none of them; handleUpdates would ignore it anyway.
function routeTo(update, members) {
  const query = update?.callback_query;
  const chat = query ? query.message?.chat?.id : update?.message?.chat?.id;
  if (chat === undefined) return undefined;
  const theirs = members.filter((m) => m.deps.approvers.includes(String(chat)));
  if (!theirs.length) return undefined;
  if (query) {
    const [, id] = BUTTON.exec(query.data ?? "") ?? [];
    return theirs.find((m) => id && hasPiece(m.deps, id)) ?? theirs[0];
  }
  const waiting = theirs.filter((m) => pendingNote(m.deps));
  if (waiting.length <= 1) return waiting[0];
  const replied = update.message.reply_to_message?.text ?? "";
  return waiting.find((m) => replied.startsWith(`[${m.campaign.name}] `)) ?? waiting[0];
}

// One getUpdates for every campaign on the same bot, from the lowest saved offset,
// so no campaign's unread updates are confirmed away. Each campaign handles only
// the updates past its own offset that are for it, then moves its offset past
// everything fetched.
async function pollBot(members) {
  const offsets = members.map((m) => readOffset(m.deps));
  const from = offsets.includes(undefined) ? undefined : Math.min(...offsets);
  const updates = await members[0].deps.telegram.getUpdates({ offset: from });
  const owner = members.length === 1 ? undefined : new Map(updates.map((u) => [u, routeTo(u, members)]));
  for (const [i, member] of members.entries()) {
    const own = offsets[i];
    const fresh = updates.filter((u) => own === undefined || !Number.isInteger(u?.update_id) || u.update_id >= own);
    const mine = owner ? fresh.filter((u) => owner.get(u) === member) : fresh;
    await handleUpdates({ updates: mine, offset: own, deps: member.deps });
    const ids = fresh.map((u) => u?.update_id).filter(Number.isInteger);
    const next = ids.length ? Math.max(own ?? 0, Math.max(...ids) + 1) : own;
    if (next !== own) writeJson(path.join(member.deps.home, OFFSET_FILE), { offset: next });
  }
}

// One Telegram tick. depsFor(campaign) gives buildCreationDeps' deps; botOf(campaign)
// the bot token it uses, only to group campaigns that share one. Returns one
// { id, outcome, error? } per campaign; outcome is polled, no bot or crashed.
export async function telegramTick({ campaigns, depsFor, botOf, print = () => {}, log }) {
  const results = [];
  const bots = new Map();
  for (const campaign of campaigns) {
    const { id } = campaign;
    try {
      const deps = depsFor(campaign);
      if (!deps.telegram) {
        results.push({ id, outcome: "no bot", error: deps.telegramProblem });
        continue;
      }
      const token = botOf(campaign);
      if (!bots.has(token)) bots.set(token, []);
      bots.get(token).push({ campaign, deps });
    } catch (err) {
      results.push({ id, outcome: "crashed", error: err.message });
      print(`${id}: crashed: ${err.message}`);
      log?.error("telegram tick: campaign not loaded", { id, error: err.message });
    }
  }
  for (const members of bots.values()) {
    try {
      await pollBot(members);
      for (const m of members) results.push({ id: m.campaign.id, outcome: "polled" });
    } catch (err) {
      for (const m of members) {
        results.push({ id: m.campaign.id, outcome: "crashed", error: err.message });
        print(`${m.campaign.id}: crashed: ${err.message}`);
        m.deps.log?.error("telegram tick failed", { error: err.message });
      }
    }
  }
  return results;
}

function maxBuildsTotal(env) {
  const raw = env.PIPELINE_MAX_BUILDS_TOTAL;
  if (raw === undefined || raw === "") return DEFAULT_MAX_BUILDS_TOTAL;
  if (!/^\d+$/.test(raw)) throw new Error(`PIPELINE_MAX_BUILDS_TOTAL must be a whole number: ${raw}`);
  return Number(raw);
}

// Invalid campaign files go to the owner once a day (or when they change), not
// every tick.
async function reportProblems(problems, { home, today, alert, log }) {
  if (!problems.length) return;
  log.error("invalid campaigns skipped", { problems });
  const text = `⚠️ Skipped campaigns with an invalid campaign.json:\n${problems.join("\n")}`;
  const file = path.join(home, ALERTS_FILE);
  const last = readJsonSafe(file);
  if (last?.date === today && last?.text === text) return;
  await safely(() => alert(text), log, "owner alert");
  writeJson(file, { date: today, text });
}

// `options` replace the environment, for tests: root, home, now (a function), env,
// ownerEnv, make (client constructors for the deps builders), print, printError.
export async function main(argv, {
  root,
  home = publisherHome(),
  now = () => new Date(),
  env = process.env,
  ownerEnv,
  make = {},
  print = console.log,
  printError = console.error,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    printError(`${err.message}\n\n${USAGE}`);
    return 1;
  }
  const { command, flags } = parsed;
  const shadow = Boolean(flags["--shadow"]);
  const log = createLogger(home);
  let alert = async (text) => log.error("pipeline alert", { text });
  try {
    const campaignsRoot = root ?? env.PIPELINE_CAMPAIGNS_ROOT ?? "C:\\Campaigns";
    const owner = ownerEnv ?? loadEnv(path.join(home, ".env"));
    const secrets = createSecrets(home);
    const makeTelegram = make.telegram ?? createTelegram;
    const ownerBot = owner.TELEGRAM_BOT_TOKEN && owner.TELEGRAM_CHAT_ID
      ? makeTelegram({ token: owner.TELEGRAM_BOT_TOKEN, chatId: owner.TELEGRAM_CHAT_ID })
      : undefined;
    // Shadow mode sends nothing anywhere: alerts are logged only.
    alert = async (text) => {
      log.error("pipeline alert", { text });
      if (!shadow && ownerBot) await ownerBot.send(text);
    };
    const at = now();
    const { campaigns, problems } = loadActive({ root: campaignsRoot, home });
    await reportProblems(problems, { home, today: istDate(at), alert, log });

    let results;
    if (command === "publish-tick") {
      results = await publishTick({
        campaigns,
        now: at,
        shadow,
        depsFor: (c) => buildPublishDeps(c, { secrets, ownerEnv: owner, now, make }),
        alert,
        print,
        log,
      });
      return results.some((r) => r.outcome === "crashed" || r.result?.failed?.length) ? 1 : 0;
    }
    if (command === "create-nightly") {
      results = await createNightly({
        campaigns,
        now: at,
        maxTotal: maxBuildsTotal(env),
        depsFor: (c) => buildCreationDeps(c, { secrets, ownerEnv: owner, make }),
        alert,
        print,
        log,
      });
      return results.some((r) => r.outcome === "crashed" || r.result?.failed?.length) ? 1 : 0;
    }
    results = await telegramTick({
      campaigns,
      depsFor: (c) => buildCreationDeps(c, { secrets, ownerEnv: owner, make }),
      botOf: (c) => secrets.get(c.id, "TELEGRAM_BOT_TOKEN") ?? owner.TELEGRAM_BOT_TOKEN,
      print,
      log,
    });
    return results.some((r) => r.outcome === "crashed") ? 1 : 0;
  } catch (err) {
    printError(`Error: ${err.message}`);
    // The unattended loops must never fail silently. The 5-minute Telegram tick
    // only logs, so a lasting fault doesn't message the owner every 5 minutes.
    if (command === "telegram-tick") log.error(`${command} crashed`, { error: err.message });
    else await safely(() => alert(`❌ pipeline ${command} crashed: ${err.message}`), log, "owner alert");
    return 1;
  }
}

const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (runDirectly) process.exitCode = await main(process.argv.slice(2));
