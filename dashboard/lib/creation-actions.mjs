// The console's creation controls for one campaign, from the Review screen and the
// player. approve is the Telegram Approve (creation/lib/approval.mjs): under the
// campaign's "schedule" lock it inserts the piece, commits "content: approve <id>" and
// marks it approved. redo sends a piece back with the owner's note. Neither tells any
// chat: the console's audit is the "dashboard <action>" log line every action writes.
// A lock is waited for 3 s at most, as for the queue controls.
//
// buildNow and recheck start creation/create.mjs in its own detached process (a build
// or a review runs for many minutes) and return at once: `nightly --now --id <id>` or
// `recheck <id>`, with --campaign. A request that is valid but can't start now goes in
// the campaign's build queue (creation/lib/build-queue.mjs) instead, to start when it
// can: while the campaign's "creation" lock is held (a build already running would make
// the new run skip), and, for buildNow, while the build could still be running during
// today's posting window (postingOverlap), and while other pieces wait ahead of it (first
// in first out; only the queue's head may start at once). A recheck runs no session, only
// the checks and the review, so the window doesn't hold it, nor do the builds the window
// holds. unqueue takes a piece out of the queue.
//
// Every action returns { ok: true, message, started? } or { ok: false, error }; a queued
// request returns { ok: true, queued: true, position, message }.
//
// deps = { home, repoRoot, store, backlog, withLock(name, fn, options), scheduleFile,
//          pieceDir(id), log, lockHome (where the creation lock is), pipelineRoot (where
//          creation/create.mjs is), spawn?, now?, alive?(pid), secretValues? }
//          (creationDeps builds them)

import path from "node:path";
import { fileURLToPath } from "node:url";
import { approve, redoWithNote } from "../../creation/lib/approval.mjs";
import {
  creationRunning,
  MAX_QUEUE,
  postingOverlap,
  queuePosition,
  saveQueue,
  startBuild,
  updateQueue,
  whyNotBuildable,
  whyNotRecheckable,
} from "../../creation/lib/build-queue.mjs";
import { buildCreationDeps } from "../../creation/lib/campaign-deps.mjs";
import { itemState } from "../../creation/lib/cstate.mjs";
import { loadCampaignData, scrub } from "./sources.mjs";

const WAIT_MS = 3000;
const PIPELINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const QUEUE_BUSY = "the build queue is busy; try again in a moment";
const QUEUE_FULL = `the build queue is full (${MAX_QUEUE} pieces); remove one or try again when one has started`;

const refuse = (error) => ({ ok: false, error });

// 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st.
function ordinal(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

// What a queued request waits for, as the owner's toast says it.
function queuedMessage({ running, overlap, position }) {
  if (running && overlap) return `Queued: starts after the current build and today's ${overlap.slot} post window.`;
  if (overlap) return `Queued: starts after today's ${overlap.slot} post window (about ${overlap.until}).`;
  if (running) return `Queued: starts when the current build finishes (${ordinal(position)} in line).`;
  if (position === 1) return "Queued: next in line; starts within a minute.";
  return `Queued: starts after the pieces queued before it (${ordinal(position)} in line).`;
}

export function createCreationActions({ campaign, deps }) {
  const { log, lockHome, now = () => new Date(), secretValues = [] } = deps;
  const buildRunning = `a build is running for ${campaign.name}; try again when it finishes`;
  const building = () => creationRunning({ lockHome, campaign, alive: deps.alive });
  const busy = `lock ${campaign.lockName("schedule")} busy`;
  const queueBusy = `lock ${campaign.lockName("build-queue")} busy`;

  // What approval.mjs needs, with the console's 3-second wait.
  const approvalDeps = () => ({
    home: deps.home,
    repoRoot: deps.repoRoot,
    store: deps.store,
    backlog: deps.backlog,
    withLock: deps.withLock,
    scheduleFile: deps.scheduleFile,
    pieceDir: deps.pieceDir,
    lock: { waitMs: WAIT_MS },
  });

  // approval.mjs's { ok, message } as an action result.
  const fromApproval = (id, res) => {
    if (res.ok) return { ok: true, message: res.message };
    return refuse(res.message === `${id}: ${busy}` ? buildRunning : res.message);
  };

  // Runs one action and logs its result, whatever it was.
  async function act(name, args, fn) {
    let result;
    try {
      result = await fn();
    } catch (err) {
      result = refuse(err.message);
    }
    result = scrub(result, secretValues);
    // The arguments too: a redo note is typed by hand and could hold anything.
    const line = scrub({ ...args, ...result }, secretValues);
    if (result.ok) log.info(`dashboard ${name}`, line);
    else log.error(`dashboard ${name}`, line);
    return result;
  }

  // Starts `node creation/create.mjs` for the piece on its own; the console doesn't wait for it.
  function start(name, kind, id) {
    startBuild({
      campaign,
      deps,
      kind,
      id,
      onError: (err) => log.error(`dashboard ${name} didn't start`, { id, error: scrub(err.message, secretValues) }),
    });
  }

  // The queue change `fn` makes, with the queue's lock busy as a refusal.
  async function withQueue(fn) {
    try {
      return await updateQueue(deps, fn);
    } catch (err) {
      if (err.message === queueBusy) return refuse(QUEUE_BUSY);
      throw err;
    }
  }

  // `queue` with `id` at the back (or left where it is), and why it waits.
  function enqueue(queue, kind, id, why) {
    let position = queuePosition(queue, id);
    if (position !== null) return { result: { ok: true, queued: true, position, message: queuedMessage({ ...why, position }) } };
    if (queue.length >= MAX_QUEUE) return { result: refuse(QUEUE_FULL) };
    const next = [...queue, { id, kind, queuedAt: now().toISOString() }];
    position = next.length;
    return { queue: next, result: { ok: true, queued: true, position, message: queuedMessage({ ...why, position }) } };
  }

  // Starts the piece's `kind` of run now, or queues it: while a build runs, while (for a
  // build) the posting window is near, and while other pieces wait ahead of it, first in
  // first out. A recheck runs no session, so builds the window holds don't hold it, as in
  // startNextQueued. A piece queued already keeps its entry, whatever kind was asked for
  // now (a stale screen's Recheck never replaces a queued build); its own entry, with
  // nothing left ahead of it, starts and leaves the queue. The queue is saved before the
  // spawn; a spawn that throws puts it back as it was.
  function startOrQueue(name, kind, id, started) {
    const running = building();
    const window = postingOverlap(campaign, now());
    const why = (k) => ({ running, overlap: k === "build" ? window : null });
    return withQueue((queue) => {
      const position = queuePosition(queue, id);
      const entry = position === null ? null : queue[position - 1];
      if (entry && entry.kind !== kind) return enqueue(queue, entry.kind, id, why(entry.kind));
      const ahead = position === null ? queue : queue.slice(0, position - 1);
      const waiting = ahead.some((e) => !(kind === "recheck" && e.kind === "build" && window));
      const { overlap } = why(kind);
      if (running || overlap || waiting) return enqueue(queue, kind, id, why(kind));
      return {
        queue: queue.filter((e) => e.id !== id),
        after: () => {
          try {
            start(name, kind, id);
          } catch (err) {
            if (position !== null) saveQueue(deps.home, queue);
            throw err;
          }
          return started;
        },
      };
    });
  }

  return {
    approve({ id } = {}) {
      return act("approve", { id }, async () => fromApproval(id, await approve({ id, deps: approvalDeps() })));
    },

    redo({ id, note } = {}) {
      return act("redo", { id, note }, async () => fromApproval(id, await redoWithNote({ id, text: note, deps: approvalDeps() })));
    },

    buildNow({ id } = {}) {
      return act("buildNow", { id }, () => {
        const why = whyNotBuildable(deps, id);
        if (why) return refuse(why);
        return startOrQueue("buildNow", "build", id, {
          ok: true,
          started: true,
          message: `Building ${id} now. This takes a while; its progress shows on its Review page.`,
        });
      });
    },

    // runRecheck, through the CLI: the checks and the review run again on the video
    // already built. A SHIP goes to the approvers on Telegram, as from the nightly run.
    recheck({ id } = {}) {
      return act("recheck", { id }, () => {
        const why = whyNotRecheckable(deps, id);
        if (why) return refuse(why);
        return startOrQueue("recheck", "recheck", id, {
          ok: true,
          started: true,
          message: `Rechecking ${id}. The checks and the review take a few minutes.`,
        });
      });
    },

    // Takes a queued piece out of the queue, before it starts.
    unqueue({ id } = {}) {
      return act("unqueue", { id }, () =>
        withQueue((queue) => {
          if (queuePosition(queue, id) === null) return { result: refuse(`${id} isn't in the build queue`) };
          if (itemState(deps.store.load(), id).status === "building") return { result: refuse(`${id} is building already`) };
          return { queue: queue.filter((e) => e.id !== id), result: { ok: true, message: `Took ${id} out of the build queue.` } };
        }),
      );
    },
  };
}

// One campaign's creation dependencies: its build list, build progress, schedule and
// lock helper from buildCreationDeps, where its creation lock file is, and its secret
// values (and the owner's, from `env`) for scrubbing. Telegram isn't needed: the
// console tells no chat.
export function creationDeps({ campaign, secrets, env }) {
  const deps = buildCreationDeps(campaign, { secrets });
  return {
    home: deps.home,
    repoRoot: deps.repoRoot,
    store: deps.store,
    get backlog() {
      return deps.backlog;
    },
    withLock: deps.withLock,
    scheduleFile: deps.scheduleFile,
    pieceDir: deps.pieceDir,
    log: deps.log,
    lockHome: deps.lockHome,
    pipelineRoot: PIPELINE_ROOT,
    secretValues: loadCampaignData({ campaign, secrets, env }).secretValues,
  };
}
