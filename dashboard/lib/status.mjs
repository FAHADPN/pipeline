// The dashboard's status: everything the page shows, built from the same files the
// pipeline reads. Read-only: it writes nothing, and no token value ever reaches it.
//
// Status = { generatedAt, today, campaign: { id, name, paused, instagramEnabled }, connected,
//            next, lastRun, queue, posted, problems, health, creation, connections }
//
// It reads one campaign (campaigns/lib/campaign.mjs) through loadCampaignData: that
// campaign's schedule, settings, state home and secrets only.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { addDays, istDate, istMinutes, parseSlot } from "../../publishing/lib/dates.mjs";
import { checkItem, parseCaption } from "../../publishing/lib/content.mjs";
import { isDone, setEntry } from "../../publishing/lib/state.mjs";
import { planDay, projectRunDry } from "../../publishing/lib/planner.mjs";
import { SECRET_NAMES } from "../../campaigns/lib/secrets.mjs";
import { loadSeenChats } from "../../creation/lib/approval.mjs";
import { loadCampaignData, scrub } from "./sources.mjs";

const DAY_MS = 86400000;
const POSTED_DAYS = 14;
// The scheduler loop that posts for every campaign (campaigns/install-tasks.mjs).
const TASK_NAME = "Pipeline Publisher";
const LOG_LINE = /^(\S+) (INFO|ERROR) (.*?)(?: (\{.*\}))?$/;
const RUN_MESSAGES = new Set(["run", "run crashed"]);
// The build states listed with their reason: a failure's, or a redo's note.
const LISTED = ["failed", "redo", "building"];

const defaultExec = promisify(execFile);

// What posts on each of the next `days` days, playing planDay forward on a copy of
// the state the way projectRunDry does. Today is included until its window closes.
export function projectQueue({ today, items, state, ready, config, days = 14, minutesNow }) {
  const sim = structuredClone(state);
  const slot = parseSlot(config.slot);
  const todayPassed = minutesNow !== undefined && minutesNow > slot + config.lateLimitMinutes;

  const queue = [];
  for (let n = todayPassed ? 1 : 0; n < days; n++) {
    const d = addDays(today, n);
    const plan = planDay({ today: d, minutesNow: slot, items, state: sim, ready, config });
    for (const drop of plan.drops) setEntry(sim, drop.id, drop.platform, { status: "dropped", at: d, reason: drop.reason });
    for (const post of plan.posts) {
      setEntry(sim, post.id, post.platform, { status: "posted", at: d, date: d });
      queue.push({ date: d, ...post });
    }
  }
  return queue;
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

function ageInDays(iso, now) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY_MS);
}

function entries(state) {
  const out = [];
  for (const [id, platforms] of Object.entries(state.items)) {
    for (const [platform, entry] of Object.entries(platforms)) out.push({ id, platform, entry });
  }
  return out;
}

function summarize(msg, data) {
  if (msg === "run crashed") return `crashed: ${data?.error ?? "unknown error"}`;
  const parts = [];
  const list = (label, rows, detail = () => "") => {
    if (rows?.length) parts.push(`${label} ${rows.map((r) => `${r.id} (${r.platform})${detail(r)}`).join(", ")}`);
  };
  list("posted", data?.posted);
  list("already live", data?.alreadyLive);
  list("failed", data?.failed, (r) => `: ${r.error}`);
  return parts.join("; ") || "nothing posted";
}

// The last daily run in the newest monthly log: { at, summary } or null.
function lastRun(home) {
  const dir = path.join(home, "logs");
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.log$/.test(f)).sort();
  } catch {
    return null;
  }
  for (const file of files.reverse()) {
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split(/\r?\n/).reverse();
    for (const line of lines) {
      const m = LOG_LINE.exec(line);
      if (!m || !RUN_MESSAGES.has(m[3])) continue;
      let data;
      try {
        data = m[4] && JSON.parse(m[4]);
      } catch {
        data = undefined;
      }
      return { at: m[1], summary: summarize(m[3], data) };
    }
  }
  return null;
}

// A piece awaiting approval, with its caption and a /media URL the server can serve.
function awaitingPiece(data, id, title) {
  let checked;
  try {
    checked = checkItem(data.root, { id, dir: data.pieceDir(id) });
  } catch {
    checked = {}; // Listed with no caption or video rather than failing the status.
  }
  let caption = checked.caption?.instagram ?? null;
  if (!caption && checked.assets) {
    try {
      caption = parseCaption(fs.readFileSync(checked.assets.caption, "utf8")).instagram;
    } catch {
      caption = null;
    }
  }
  const video = checked.assets && fs.existsSync(checked.assets.video) ? data.mediaUrl(id, path.basename(checked.assets.video)) : null;
  return { id, title, caption, video };
}

// Pieces built by video creation: counts by status, the ones awaiting approval, and
// the failed, redo and building ones with why and how often. Empty lists when the
// campaign has no build list or build progress yet. A broken build list or build
// progress file is reported in `error` (null otherwise) and never fails the status,
// so the posting queue still shows: titles fall back to ids, or the lists stay empty.
function creationSection(data) {
  const section = { counts: {}, awaiting: [], failed: [], redo: [], building: [], error: null };
  const errors = [];
  const read = (fn, fallback) => {
    try {
      return fn();
    } catch (err) {
      errors.push(err.message);
      return fallback;
    }
  };
  const titles = new Map(read(() => data.backlog, []).map((e) => [e?.id, e?.title]));
  const items = read(() => data.cstate.items ?? {}, {});
  if (errors.length) section.error = errors.join("; ");
  for (const [id, entry] of Object.entries(items)) {
    section.counts[entry.status] = (section.counts[entry.status] ?? 0) + 1;
    const title = titles.get(id) ?? id;
    if (entry.status === "awaiting-approval") section.awaiting.push(awaitingPiece(data, id, title));
    else if (LISTED.includes(entry.status)) {
      section[entry.status].push({ id, title, reason: entry.reason ?? entry.note ?? null, attempts: entry.attempts ?? 0, at: entry.at ?? null });
    }
  }
  return section;
}

// The Connections screen's data, with no secret value: which secrets are set and when,
// the Instagram account and token age, YouTube's channel, and Telegram's approvers and
// the other chats that messaged the campaign's bot lately (seenChats, newest first).
function connectionsSection(data, secrets, now) {
  const { campaign, tokens } = data;
  const set = secrets.status(campaign.id);
  const { approvers } = campaign.config;
  return {
    secrets: Object.fromEntries(SECRET_NAMES.map((name) => [name, { set: Boolean(set[name]), updatedAt: set[name]?.updatedAt ?? null }])),
    instagram: { username: tokens.instagram?.username ?? null, tokenAgeDays: ageInDays(tokens.instagram?.issuedAt, now) },
    youtube: { connected: Boolean(tokens.youtube?.refreshToken), channel: secrets.get(campaign.id, "YT_CHANNEL") ?? null },
    telegram: {
      approvers: [...approvers],
      ownBot: Boolean(set.TELEGRAM_BOT_TOKEN),
      seenChats: loadSeenChats(campaign.home)
        .filter((c) => typeof c?.chatId === "string" && !approvers.includes(c.chatId))
        .slice(0, 20),
    },
  };
}

// One line for the campaign list: "ok", or "problems" when it isn't connected or
// something failed or isn't ready.
export function healthSummary(status) {
  const problems = status.problems.failed.length + status.problems.notReady.length;
  return {
    health: status.connected && problems === 0 ? "ok" : "problems",
    connected: status.connected,
    next: status.next?.date ?? null,
    problems,
  };
}

// `taskRegistered`, when given, is the posting task's state from the machine's cached
// checks (lib/health.mjs); without it the task is queried here. `env` is the owner's
// .env, whose credentials are scrubbed too.
export async function buildStatus({ now, campaign, secrets, env, exec = defaultExec, taskRegistered: known }) {
  const data = loadCampaignData({ campaign, secrets, env });
  const { root, home, config, items, state, tokens } = data;
  const today = istDate(now, config.timeZone);
  const minutesNow = istMinutes(now, config.timeZone);

  const checks = checkAll(root, items);
  const ready = new Set([...checks].filter(([, c]) => c.ok).map(([id]) => id));
  const plan = planDay({ today, minutesNow, items, state, ready, config });
  const queue = projectQueue({ today, items, state, ready, config, minutesNow });

  const all = entries(state);
  const since = addDays(today, -(POSTED_DAYS - 1));
  const posted = all
    .filter(({ entry }) => (entry.status === "posted" || entry.status === "manual") && entry.date >= since && entry.date <= today)
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date) || String(b.entry.at).localeCompare(String(a.entry.at)))
    .map(({ id, platform, entry }) => ({ id, platform, date: entry.date, url: entry.url ?? null }));

  const recordedDrops = all
    .filter(({ entry }) => entry.status === "dropped")
    .map(({ id, platform, entry }) => ({ id, platform, reason: entry.reason ?? null, at: entry.at ?? null }));
  const pendingDrops = plan.drops.map((d) => ({ ...d, at: null, pending: true }));

  const warnings = [];
  for (const item of items) {
    if (isDone(state, item.id, "instagram")) continue;
    for (const w of checks.get(item.id).warnings ?? []) warnings.push(`${item.id}: ${w}`);
  }

  const taskRegistered =
    known ??
    (await exec("schtasks", ["/Query", "/TN", TASK_NAME]).then(
      () => true,
      () => false,
    ));

  const status = {
    generatedAt: now.toISOString(),
    today,
    campaign: { id: campaign.id, name: campaign.name, paused: campaign.paused === true, instagramEnabled: config.platforms.instagram?.enabled === true },
    connected: Boolean(tokens.instagram?.token),
    next: queue[0] ?? null,
    lastRun: lastRun(home),
    queue,
    posted,
    problems: {
      failed: all
        .filter(({ entry }) => entry.status === "failed")
        .map(({ id, platform, entry }) => ({ id, platform, error: entry.error ?? null, at: entry.at ?? null })),
      dropped: [...recordedDrops, ...pendingDrops],
      notReady: plan.notReady.map((id) => ({ id, errors: checks.get(id)?.errors ?? [] })),
      warnings,
    },
    health: {
      readyCount: plan.readyCount,
      rhythm: plan.rhythm,
      runDry: projectRunDry({ today, items, state, ready, config }),
      tokenAgeDays: {
        instagram: ageInDays(tokens.instagram?.issuedAt, now),
        youtube: ageInDays(tokens.youtube?.obtainedAt, now),
      },
      taskRegistered,
    },
    creation: creationSection(data),
    connections: connectionsSection(data, secrets, now),
  };
  return scrub(status, data.secretValues);
}
