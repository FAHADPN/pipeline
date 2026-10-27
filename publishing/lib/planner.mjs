// The planner: decides what each platform posts today from the date, the queue
// and the state. Pure: no I/O and no clock, so it can be tested exhaustively.
//
// Plan = { window: "early"|"open"|"late", rhythm: "daily"|"4-a-week", postingDay, readyCount,
//          drops: [{ id, platform, reason }], posts: [{ id, platform, why }], notReady: [id] }

import { addDays, parseSlot, weekday } from "./dates.mjs";
import { isFloating, isHeld, inWindow } from "./schedule.mjs";
import { holdsDate, isDone, postedFloatingOn, setEntry } from "./state.mjs";

const PROJECTION_DAYS = 366;
const PINNED_WARN_DAYS = 7;

// The buffer and the run-dry date are measured on Instagram, the platform that's always on.
const BUFFER_PLATFORM = "instagram";

function enabledPlatforms(config) {
  return Object.entries(config.platforms)
    .filter(([, p]) => p.enabled)
    .map(([name]) => name);
}

function dropReason(item, today) {
  if (item.on !== undefined && item.on < today) return "pinned date passed";
  if (item.notAfter !== undefined && item.notAfter < today) return "past notAfter";
  return null;
}

export function planDay({ today, minutesNow, items, state, ready, config }) {
  const platforms = enabledPlatforms(config);

  const drops = [];
  for (const platform of platforms) {
    for (const item of items) {
      if (isDone(state, item.id, platform)) continue;
      const reason = dropReason(item, today);
      if (reason) drops.push({ id: item.id, platform, reason });
    }
  }

  // Held items are dropped as above, and otherwise left out entirely.
  const live = items.filter((item) => !isHeld(item));

  // Floating items still to post on the buffer platform and allowed today.
  const pending = live.filter(
    (item) => isFloating(item) && !isDone(state, item.id, BUFFER_PLATFORM) && inWindow(item, today),
  );
  const readyCount = pending.filter((item) => ready.has(item.id)).length;

  // Broken pinned items are flagged a week ahead, so there's time to fix them.
  const horizon = addDays(today, PINNED_WARN_DAYS);
  const brokenPinned = live.filter(
    (item) =>
      item.on !== undefined &&
      item.on >= today &&
      item.on <= horizon &&
      !isDone(state, item.id, BUFFER_PLATFORM) &&
      !ready.has(item.id),
  );
  const notReady = [
    ...new Set([...pending, ...brokenPinned].filter((item) => !ready.has(item.id)).map((item) => item.id)),
  ];

  const rhythm = readyCount >= config.bufferMin ? "daily" : "4-a-week";
  const postingDay = rhythm === "daily" || config.fallbackDays.includes(weekday(today));

  const slot = parseSlot(config.slot);
  const window = minutesNow < slot ? "early" : minutesNow > slot + config.lateLimitMinutes ? "late" : "open";

  const posts = [];
  if (window === "open") {
    // A pinned item that fails its check never posts; the floating queue carries on instead.
    const pinnedToday = live.filter((item) => item.on === today && ready.has(item.id));
    for (const platform of platforms) {
      // A pinned item done here before today (posted early, or dropped) no longer holds
      // the day; one posted today still does, so a re-run adds nothing.
      const holding = pinnedToday.filter((item) => holdsDate(state, item, platform, today));
      if (holding.length) {
        // A ready pinned item takes the day's slot; the floating queue waits a day.
        for (const item of holding) {
          if (!isDone(state, item.id, platform)) posts.push({ id: item.id, platform, why: "pinned" });
        }
      } else if (postingDay && !postedFloatingOn(state, items, platform, today)) {
        const next = live.find(
          (item) => isFloating(item) && !isDone(state, item.id, platform) && inWindow(item, today) && ready.has(item.id),
        );
        if (next) posts.push({ id: next.id, platform, why: "queue" });
      }
    }
  }

  return { window, rhythm, postingDay, readyCount, drops, posts, notReady };
}

// The date of the last floating Instagram post if posting continues from tomorrow at the
// current rhythm, or null if nothing floating is ready. Plays planDay forward on a copy of
// the state, so the projection follows exactly the rules the daily run uses.
export function projectRunDry({ today, items, state, ready, config }) {
  const sim = structuredClone(state);
  const minutesNow = parseSlot(config.slot);
  const left = () =>
    items.some((item) => isFloating(item) && !isHeld(item) && ready.has(item.id) && !isDone(sim, item.id, BUFFER_PLATFORM));

  let last = null;
  for (let n = 1; n <= PROJECTION_DAYS && left(); n++) {
    const d = addDays(today, n);
    const plan = planDay({ today: d, minutesNow, items, state: sim, ready, config });
    for (const drop of plan.drops) {
      setEntry(sim, drop.id, drop.platform, { status: "dropped", at: d, reason: drop.reason });
    }
    for (const post of plan.posts) {
      if (post.platform !== BUFFER_PLATFORM) continue;
      setEntry(sim, post.id, post.platform, { status: "posted", at: d, date: d });
      if (post.why === "queue") last = d;
    }
  }
  return last;
}
