// The console's queue controls for one campaign. hold, release, pin, unpin and
// reorder edit its schedule.json through editSchedule, under the campaign's
// "schedule" lock, and commit it as "queue: <action> <id>". drop records the item
// dropped in state.json, as `publish.mjs mark <id> <platform> dropped` does, under the
// "publish" lock the scheduler loop takes. A lock is waited for 3 s at most: a build
// session holds "schedule" for its whole run, and a tap must never hang or land
// mid-build. drop is refused while the campaign builds too: a build session fails if
// its state.json changes (build-guard.mjs).
//
// An item already posted, manual or dropped on Instagram is refused with a reason, so
// a stale tab can't move it. Every action is logged as "dashboard <action>" with its
// arguments and result, the console's audit trail, and returns { ok: true, message }
// or { ok: false, error }.
//
// deps = { withLock(name, fn, options), repoRoot, scheduleFile, store, log, git?,
//          now?, secretValues?, buildRunning?() (the refusal while the campaign's build
//          runs, or null) } (queueDeps builds them for a campaign)

import { istDate, istMinutes, isRealDate, parseSlot } from "../../publishing/lib/dates.mjs";
import { publishConfig } from "../../publishing/lib/campaign-deps.mjs";
import { isFloating, loadSchedule } from "../../publishing/lib/schedule.mjs";
import { editSchedule } from "../../publishing/lib/schedule-edit.mjs";
import { createStateStore, getEntry, holdsDate, isDone, postedOn, setEntry } from "../../publishing/lib/state.mjs";
import { buildCreationDeps } from "../../creation/lib/campaign-deps.mjs";
import { buildRunningError } from "./build-guard.mjs";
import { loadCampaignData, scrub } from "./sources.mjs";

const WAIT_MS = 3000;
const BUFFER_PLATFORM = "instagram";
const LABELS = { instagram: "Instagram", youtube: "YouTube" };

const refuse = (error) => ({ ok: false, error });

export function createQueueActions({ campaign, deps }) {
  const { withLock, repoRoot, scheduleFile, store, log, git, now = () => new Date(), secretValues = [] } = deps;
  const busy = {
    [`lock ${campaign.lockName("schedule")} busy`]: `a build is running for ${campaign.name}; try again when it finishes`,
    [`lock ${campaign.lockName("publish")} busy`]: `a post is running for ${campaign.name}; try again when it finishes`,
  };

  // Runs one action under `lockName` and logs its result, whatever it was.
  async function act(name, args, lockName, fn) {
    let result;
    try {
      result = await withLock(lockName, fn, { waitMs: WAIT_MS });
    } catch (err) {
      result = refuse(busy[err.message] ?? err.message);
    }
    result = scrub(result, secretValues);
    if (result.ok) log.info(`dashboard ${name}`, { ...args, ...result });
    else log.error(`dashboard ${name}`, { ...args, ...result });
    return result;
  }

  // The refusal for an item that's already done on `platform`, or null.
  function doneReason(state, id, platform) {
    if (!isDone(state, id, platform)) return null;
    return `${id} is already ${getEntry(state, id, platform).status} on ${LABELS[platform]}; reload to see it`;
  }

  // Edits item `id` under the schedule lock: change(item, items, state) returns the new
  // items or throws the refusal. Committed as "queue: <commit>"; `message` is the reply.
  function edit(name, args, commit, message, change) {
    return act(name, args, "schedule", () => {
      const state = store.load();
      const res = editSchedule({
        root: repoRoot,
        scheduleFile,
        git,
        message: `queue: ${commit}`,
        change: (items) => {
          const item = items.find((i) => i.id === args.id);
          if (!item) throw new Error(`no item ${args.id} in the schedule`);
          const done = doneReason(state, item.id, BUFFER_PLATFORM);
          if (done) throw new Error(done);
          return change(item, items, state);
        },
      });
      return res.ok ? { ok: true, message } : res;
    });
  }

  const replace = (items, item, next) => items.map((i) => (i === item ? next : i));

  return {
    hold({ id } = {}) {
      return edit("hold", { id }, `hold ${id}`, `Held ${id}: it won't post until it's released.`, (item, items) => {
        if (item.hold === true) throw new Error(`${id} is already held`);
        return replace(items, item, { ...item, hold: true });
      });
    },

    release({ id } = {}) {
      return edit("release", { id }, `release ${id}`, `Released ${id}.`, (item, items) => {
        if (item.hold !== true) throw new Error(`${id} isn't held`);
        const { hold, ...rest } = item;
        return replace(items, item, rest);
      });
    },

    pin({ id, date } = {}) {
      return edit("pin", { id, date }, `pin ${id} ${date}`, `Pinned ${id} to ${date}.`, (item, items, state) => {
        if (!isRealDate(date)) throw new Error("pin needs a real YYYY-MM-DD date");
        const config = publishConfig(campaign);
        const at = now();
        const today = istDate(at, config.timeZone);
        if (date < today) throw new Error(`the date ${date} has passed`);
        // After the window closes nothing posts a pin for today, and tomorrow's run drops it.
        if (date === today && istMinutes(at, config.timeZone) > parseSlot(config.slot) + config.lateLimitMinutes) {
          throw new Error("today's posting window has closed; pick a later date or use Post now");
        }
        // The date is taken while another pin holds it on any enabled platform, by the
        // planner's own rule.
        const enabled = Object.keys(config.platforms).filter((p) => config.platforms[p].enabled);
        const taken = items.find((i) => i !== item && enabled.some((p) => holdsDate(state, i, p, date)));
        if (taken) throw new Error(`${taken.id} is already pinned on ${date}`);
        // Anything already out today, floating or pinned, would make a pin for today a second post.
        if (date === today && items.some((i) => postedOn(state, i.id, BUFFER_PLATFORM, today))) {
          throw new Error("something already posted today; pick a later date");
        }
        return replace(items, item, { ...item, on: date });
      });
    },

    unpin({ id } = {}) {
      return edit("unpin", { id }, `unpin ${id}`, `Unpinned ${id}: it's back in the queue.`, (item, items) => {
        if (item.on === undefined) throw new Error(`${id} isn't pinned`);
        const { on, ...rest } = item;
        return replace(items, item, rest);
      });
    },

    // Moves a floating item before another floating one, or after the last floating
    // item when `before` is null.
    reorder({ id, before } = {}) {
      const message = before === null ? `Moved ${id} to the end of the queue.` : `Moved ${id} before ${before}.`;
      return edit("reorder", { id, before }, `reorder ${id}`, message, (item, items) => {
        if (!isFloating(item)) throw new Error(`${id} is pinned on ${item.on}; unpin it to move it in the queue`);
        if (before === id) throw new Error(`${id} can't move before itself`);
        const rest = items.filter((i) => i !== item);
        let at;
        if (before === null) {
          at = rest.findLastIndex(isFloating) + 1;
        } else {
          const target = rest.find((i) => i.id === before);
          if (!target) throw new Error(`no item ${before} in the schedule`);
          if (!isFloating(target)) throw new Error(`${before} is pinned on ${target.on}, not in the queue`);
          at = rest.indexOf(target);
        }
        rest.splice(at, 0, item);
        return rest;
      });
    },

    drop({ id, platform } = {}) {
      return act("drop", { id, platform }, "publish", () => {
        const running = deps.buildRunning?.();
        if (running) return refuse(running);
        if (!LABELS[platform]) return refuse(`unknown platform: ${platform}`);
        if (!loadSchedule(scheduleFile, repoRoot).some((i) => i.id === id)) return refuse(`no item ${id} in the schedule`);
        const state = store.load();
        const done = doneReason(state, id, platform);
        if (done) return refuse(done);
        setEntry(state, id, platform, { status: "dropped", at: now().toISOString(), reason: "dropped in the console" });
        store.save(state);
        return { ok: true, message: `Dropped ${id} on ${LABELS[platform]}.` };
      });
    },
  };
}

// One campaign's queue dependencies: its schedule and lock helper from
// buildCreationDeps, its state store and log, whether it is building, and its secret
// values (and the owner's, from `env`) for scrubbing.
export function queueDeps({ campaign, secrets, env }) {
  const deps = buildCreationDeps(campaign, { secrets });
  return {
    withLock: deps.withLock,
    repoRoot: deps.repoRoot,
    scheduleFile: deps.scheduleFile,
    store: createStateStore(campaign.home, { timeZone: campaign.config.timezone }),
    log: deps.log,
    secretValues: loadCampaignData({ campaign, secrets, env }).secretValues,
    buildRunning: () => buildRunningError({ lockHome: deps.lockHome, campaigns: [campaign] }),
  };
}
