// The build queue: builds and rechecks asked for by hand that couldn't start at once,
// because a build was running for the campaign or a build started now could overlap
// today's post. Builds never run side by side: every session shares the repo's
// working tree, and the verifier reverts any change outside the piece's own folder.
//
// <campaign home>/build-queue.json holds [{ id, kind: "build" | "recheck", queuedAt }],
// first in first out, at most MAX_QUEUE entries, one per id. Every read-modify-write
// runs under the campaign's short "build-queue" lock and is written atomically. A
// missing or empty file is an empty queue; a broken one reads as empty, with a logged
// error, and is rewritten whole by the next change.
//
// startNextQueued starts the head entry when nothing builds and, for a build, the
// posting window is clear, exactly as the console's Build now or Recheck would. While
// the window holds the builds at the front, the first recheck behind them may start (a
// recheck runs no session); the builds keep their places. An entry whose piece can no
// longer be built or rechecked is dropped. create.mjs calls it
// when a nightly or recheck run ends, and the dashboard server every minute
// (startQueueRunner), both in the owner's session, where renders and Claude Code run.
// The S4U Telegram task never does: a build started there would fail.
//
// The hand-off: "a build is running" is the creation lock, and a started process takes
// a second or two to take it. A second start in that gap (create.mjs's end-of-run call,
// the server's minute tick, a console Build now, the 02:00 nightly) sees nothing running
// and starts too. The later process waits up to 10 minutes for the creation lock and, if
// the first run outlasts that (a build does), skips. Its entry has already left the
// queue, so create.mjs puts it back at the head (requeueAtHead) rather than drop the
// piece. Console starts go through the queue while it holds anything (first in first
// out), which keeps that gap rare. An entry leaves the queue, and that is saved, before
// its process is spawned: a save that failed after a spawn would start it twice.
//
// deps = { home (the campaign's), lockHome (where its creation lock is), withLock(name,
//          fn, options) for its own lock names, store, backlog, repoRoot, pieceDir(id),
//          log?, spawn?, now?, alive?(pid), pipelineRoot? (the folder holding creation/create.mjs) }

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { istMinutes, parseSlot } from "../../publishing/lib/dates.mjs";
import { publishConfig } from "../../publishing/lib/campaign-deps.mjs";
import { lockHeld, withLock } from "../../publishing/lib/lock.mjs";
import { BUILD_STARTUP_MINUTES, BUILD_VERIFY_MINUTES, CREATION_STALE_MS } from "./constants.mjs";
import { itemState, MAX_ATTEMPTS } from "./cstate.mjs";
import { pickWork } from "./picker.mjs";

export const QUEUE_FILE = "build-queue.json";
export const MAX_QUEUE = 10;
const QUEUE_LOCK = "build-queue";
const LOCK_WAIT_MS = 3000;
const KINDS = ["build", "recheck"];
const ID_RE = /^[a-z0-9-]+$/;
const PIPELINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = "creation/create.mjs";
const RECHECKABLE = ["failed", "awaiting-approval"];
// A post can run on past its window's close: a retry, Instagram's processing wait.
const POST_MARGIN_MINUTES = 15;
const DAY_MINUTES = 24 * 60;

// The queue in `home`, as well-formed entries. Never throws.
export function readQueue(home, log) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, QUEUE_FILE), "utf8").replace(/^﻿/, "");
  } catch (err) {
    if (err.code !== "ENOENT") log?.error("build queue unreadable; treated as empty", { error: err.message });
    return [];
  }
  if (!text.trim()) return [];
  let value;
  try {
    value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error("not a list");
  } catch (err) {
    log?.error("build queue unreadable; treated as empty", { error: err.message });
    return [];
  }
  const seen = new Set();
  return value
    .filter((e) => e && typeof e.id === "string" && ID_RE.test(e.id) && KINDS.includes(e.kind) && typeof e.queuedAt === "string")
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .map(({ id, kind, queuedAt }) => ({ id, kind, queuedAt }));
}

// Writes the queue whole: a temp file, then a rename. Callers hold the queue's lock.
export function saveQueue(home, entries) {
  const file = path.join(home, QUEUE_FILE);
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// `id`'s place in `queue`, from 1, or null when it isn't queued.
export function queuePosition(queue, id) {
  const i = queue.findIndex((e) => e.id === id);
  return i < 0 ? null : i + 1;
}

// Reads, changes and writes the queue under its lock (3 s wait). fn(queue) returns
// { queue?, result, after? }: the new entries (left out for no change), what to return,
// and optionally a step to run once they are saved, still under the lock, whose value
// is returned instead. A save that fails throws before `after` runs, so nothing is ever
// started from a queue that still holds it.
export function updateQueue(deps, fn) {
  const lock = deps.withLock ?? ((name, f, options) => withLock(deps.home, name, f, options));
  return lock(QUEUE_LOCK, () => {
    const queue = readQueue(deps.home, deps.log);
    const { queue: next, result, after } = fn(queue);
    if (next && JSON.stringify(next) !== JSON.stringify(queue)) saveQueue(deps.home, next);
    return after ? after() : result;
  }, { waitMs: LOCK_WAIT_MS });
}

// Takes `id` out of the queue, if it's there: the nightly run is building it.
export function dropQueued(deps, id) {
  return updateQueue(deps, (queue) => ({ queue: queue.filter((e) => e.id !== id) }));
}

// Puts `id` back at the head of the queue, past the cap, unless it's queued already or
// building: a run by hand that lost the creation lock to another start (the hand-off
// race above). A piece already building is the winner's own. If the winner went on to
// build it, the entry is dropped at its turn as no longer buildable. Returns whether it
// was added.
export function requeueAtHead(deps, { kind, id, now = new Date() }) {
  return updateQueue(deps, (queue) => {
    if (queuePosition(queue, id) !== null) return { result: false };
    if (itemState(deps.store.load(), id).status === "building") return { result: false };
    return { queue: [{ id, kind, queuedAt: now.toISOString() }, ...queue], result: true };
  });
}

// "7:30 pm" for minutes past midnight.
function clockText(minutes) {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

// Whether a build started at `at` could still be starting up or checking its session
// during the campaign's posting window: from BUILD_VERIFY_MINUTES + BUILD_STARTUP_MINUTES
// before the slot to POST_MARGIN_MINUTES after the window closes, in the campaign's time
// zone. The scheduler writes the campaign's state.json (and a refreshed token) when it
// posts, and a session that sees either change is reverted and burns an attempt.
// Returns { slot, until } as clock text, or null when a build may start.
export function postingOverlap(campaign, at) {
  const config = publishConfig(campaign);
  const slot = parseSlot(config.slot);
  const from = slot - (BUILD_VERIFY_MINUTES + BUILD_STARTUP_MINUTES);
  const to = slot + config.lateLimitMinutes + POST_MARGIN_MINUTES;
  const now = istMinutes(at, config.timeZone);
  // Yesterday's and tomorrow's windows too, for a slot near midnight.
  const inside = [-DAY_MINUTES, 0, DAY_MINUTES].some((d) => now >= from + d && now <= to + d);
  return inside ? { slot: clockText(slot), until: clockText(to) } : null;
}

// Whether a build holds the campaign's "creation" lock. One older than the nightly
// run's staleMs, or whose process has died, isn't running.
export function creationRunning({ lockHome, campaign, now = Date.now, alive }) {
  return lockHeld(lockHome, campaign.lockName("creation"), { staleMs: CREATION_STALE_MS, now, alive });
}

// Why a build by hand (nightly --now --id) wouldn't build `id` now, or null when it would.
export function whyNotBuildable(deps, id) {
  const backlog = deps.backlog;
  if (!backlog.some((e) => e.id === id)) return `${id} is not in the build list`;
  const cstate = deps.store.load();
  if (pickWork({ backlog, cstate, onlyId: id }).length) return null;
  const { status, attempts = 0 } = itemState(cstate, id);
  if (status === "failed" && attempts >= MAX_ATTEMPTS) return `${id} failed ${attempts} times; redo it with a note to build it again`;
  return `${id} can't be built now (${status})`;
}

function hasVideo(deps, id) {
  try {
    return fs.readdirSync(path.join(deps.repoRoot, deps.pieceDir(id), "out")).some((f) => f.endsWith(".mp4"));
  } catch {
    return false;
  }
}

// Why runRecheck wouldn't recheck `id` now, or null when it would.
export function whyNotRecheckable(deps, id) {
  if (!deps.backlog.some((e) => e.id === id)) return `${id} is not in the build list`;
  const { status } = itemState(deps.store.load(), id);
  if (!RECHECKABLE.includes(status)) return `${id} is ${status}: only a failed piece or one awaiting approval can be rechecked`;
  if (!hasVideo(deps, id)) return `${id} has no video to recheck; build it first`;
  return null;
}

// Starts `node creation/create.mjs` for a "build" (nightly --now --id) or a "recheck"
// of `id` in its own detached process, and doesn't wait for it. onError(err) hears of a
// process that didn't start.
export function startBuild({ campaign, deps, kind, id, onError }) {
  const { spawn = nodeSpawn, pipelineRoot = PIPELINE_ROOT } = deps;
  const args = kind === "build" ? ["nightly", "--now", "--id", id] : ["recheck", id];
  const child = spawn(process.execPath, [CLI, ...args, "--campaign", campaign.id], {
    cwd: pipelineRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", onError);
  child.unref();
}

// Starts the head of the queue when it may start (or the first recheck behind builds the
// posting window holds), dropping entries that can no longer run on the way. Returns the
// entry started, or null.
export function startNextQueued({ campaign, deps }) {
  const now = deps.now ?? (() => new Date());
  return updateQueue(deps, (queue) => {
    if (!queue.length) return { result: null };
    if (creationRunning({ lockHome: deps.lockHome, campaign, alive: deps.alive })) return { result: null };
    const window = postingOverlap(campaign, now());
    // First in first out, except that a recheck runs no session: the builds the posting
    // window holds keep their places, and the first recheck behind them may go.
    const held = [];
    const left = [...queue];
    let head = null;
    while (left.length) {
      const next = left.shift();
      if (next.kind === "build" && window) {
        held.push(next);
        continue;
      }
      const why = next.kind === "build" ? whyNotBuildable(deps, next.id) : whyNotRecheckable(deps, next.id);
      if (!why) {
        head = next;
        break;
      }
      deps.log?.info("build queue: dropped", { id: next.id, kind: next.kind, why });
    }
    const rest = [...held, ...left];
    if (!head) return { queue: rest, result: null };
    // Saved without it first: a start from a queue that still held it would run twice.
    return {
      queue: rest,
      after: () => {
        const failed = (err) => deps.log?.error("build queue: didn't start", { id: head.id, error: err.message });
        try {
          startBuild({ campaign, deps, kind: head.kind, id: head.id, onError: failed });
        } catch (err) {
          // Back in its place before anything else can go wrong.
          saveQueue(deps.home, [...held, head, ...left]);
          failed(err);
          return null;
        }
        deps.log?.info(`build queue: started ${head.id}`, { kind: head.kind, queuedAt: head.queuedAt });
        return head;
      },
    };
  });
}
