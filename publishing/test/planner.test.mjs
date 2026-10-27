import { test } from "node:test";
import assert from "node:assert/strict";
import { planDay, projectRunDry } from "../lib/planner.mjs";
import { CONFIG } from "./fixtures.mjs";

const TODAY = "2026-10-25"; // Sun
const SLOT = 1170; // 19:30

// Floating items F1..Fn.
function F(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}`, kind: "ep", dir: `x/F${i + 1}` }));
}

// The real config, with platform overrides merged per platform.
function cfg(overrides = {}) {
  const { platforms = {}, ...rest } = overrides;
  const merged = structuredClone(CONFIG);
  for (const [name, p] of Object.entries(platforms)) merged.platforms[name] = { ...merged.platforms[name], ...p };
  return { ...merged, ...rest };
}

// S({ F1: { instagram: { status: "posted", date: "2026-10-24" } } })
function S(entries = {}) {
  const items = {};
  for (const [id, platforms] of Object.entries(entries)) {
    items[id] = {};
    for (const [platform, entry] of Object.entries(platforms)) items[id][platform] = { at: "2026-10-24T14:00:00.000Z", ...entry };
  }
  return { version: 1, items };
}

function plan({ today = TODAY, minutesNow = SLOT, items, state = S(), ready, config = cfg() }) {
  return planDay({ today, minutesNow, items, state, ready: ready ?? new Set(items.map((i) => i.id)), config });
}

test("posts the first ready floating item on instagram", () => {
  const p = plan({ items: F(7) });
  assert.deepEqual(p.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);
  assert.equal(p.rhythm, "daily");
  assert.equal(p.readyCount, 7);
  assert.equal(p.window, "open");
  assert.equal(p.postingDay, true);
  assert.deepEqual(p.drops, []);
  assert.deepEqual(p.notReady, []);
});

test("skips done items", () => {
  const p = plan({ items: F(7), state: S({ F1: { instagram: { status: "posted", date: "2026-10-24" } } }) });
  assert.deepEqual(p.posts, [{ id: "F2", platform: "instagram", why: "queue" }]);
});

test("re-run on the same day posts nothing", () => {
  for (const status of ["posted", "manual"]) {
    const p = plan({ items: F(7), state: S({ F1: { instagram: { status, date: TODAY } } }) });
    assert.deepEqual(p.posts, [], status);
  }
});

test("failed item is retried first", () => {
  const p = plan({ items: F(7), state: S({ F1: { instagram: { status: "failed", error: "boom", attempts: 2 } } }) });
  assert.deepEqual(p.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);
});

test("pinned item takes the slot", () => {
  const items = [{ id: "P", kind: "special", dir: "x/P", on: TODAY }, ...F(7)];
  const p = plan({ items });
  assert.deepEqual(p.posts, [{ id: "P", platform: "instagram", why: "pinned" }]);
});

test("pinned item that isn't ready doesn't post and doesn't block the queue", () => {
  const items = [{ id: "P", kind: "special", dir: "x/P", on: TODAY }, ...F(7)];
  const ready = new Set(F(7).map((i) => i.id));
  const p = plan({ items, ready });
  assert.deepEqual(p.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);
  assert.ok(p.notReady.includes("P"));
});

test("broken pinned item is flagged up to 7 days ahead", () => {
  const ready = new Set(F(7).map((i) => i.id));

  const inRange = plan({ items: [{ id: "P", kind: "special", dir: "x/P", on: "2026-11-01" }, ...F(7)], ready });
  assert.ok(inRange.notReady.includes("P"));

  const tooFar = plan({ items: [{ id: "P", kind: "special", dir: "x/P", on: "2026-11-02" }, ...F(7)], ready });
  assert.ok(!tooFar.notReady.includes("P"));
});

test("pinned item already posted → nothing else that day", () => {
  const items = [{ id: "P", kind: "special", dir: "x/P", on: TODAY }, ...F(7)];
  const p = plan({ items, state: S({ P: { instagram: { status: "posted", date: TODAY } } }) });
  assert.deepEqual(p.posts, []);
});

test("planner: a pinned item posted early or dropped no longer holds its date", () => {
  const items = [{ id: "P", kind: "special", dir: "x/P", on: TODAY }, ...F(7)];
  for (const entry of [{ status: "posted", date: "2026-10-20" }, { status: "manual", date: "2026-10-21" }, { status: "dropped", reason: "dropped in the console" }]) {
    const p = plan({ items, state: S({ P: { instagram: entry } }) });
    assert.deepEqual(p.posts, [{ id: "F1", platform: "instagram", why: "queue" }], entry.status);
  }

  // Per platform: posted early on Instagram, YouTube still posts it on its day.
  const config = cfg({ platforms: { youtube: { enabled: true } } });
  const p = plan({ items, config, state: S({ P: { instagram: { status: "posted", date: "2026-10-20" } } }) });
  assert.deepEqual(p.posts, [
    { id: "F1", platform: "instagram", why: "queue" },
    { id: "P", platform: "youtube", why: "pinned" },
  ]);

  // The projection follows: P posted early leaves Mon 26 to the floating queue (8 ready:
  // Mon, Tue daily, then Wed Fri Sun Mon Wed Fri), where holding it would end on Sun Nov 8.
  const ahead = [{ id: "P", kind: "special", dir: "x/P", on: "2026-10-26" }, ...F(8)];
  assert.equal(runDry({ items: ahead, state: S({ P: { instagram: { status: "posted", date: TODAY } } }) }), "2026-11-06");
  assert.equal(runDry({ items: ahead }), "2026-11-08", "P not posted yet still takes Mon 26");
});

test("pinned date passed → dropped, not posted", () => {
  const items = [{ id: "P", kind: "special", dir: "x/P", on: "2026-10-11" }, ...F(7)];
  const p = plan({ items });
  assert.deepEqual(p.drops, [{ id: "P", platform: "instagram", reason: "pinned date passed" }]);
  assert.deepEqual(p.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);
});

test("an already-dropped pinned item is not dropped again", () => {
  const items = [{ id: "P", kind: "special", dir: "x/P", on: "2026-10-11" }, ...F(7)];
  const p = plan({ items, state: S({ P: { instagram: { status: "dropped", reason: "pinned date passed" } } }) });
  assert.deepEqual(p.drops, []);
});

test("notAfter passed → dropped; notBefore future → neither posted nor counted", () => {
  const items = [
    { id: "OLD", kind: "ep", dir: "x/OLD", notAfter: "2026-10-24" },
    { id: "LATER", kind: "ep", dir: "x/LATER", notBefore: "2026-10-26" },
    ...F(2),
  ];
  const p = plan({ items });
  assert.deepEqual(p.drops, [{ id: "OLD", platform: "instagram", reason: "past notAfter" }]);
  assert.deepEqual(p.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);
  assert.equal(p.readyCount, 2);
  assert.deepEqual(p.notReady, []);

  // notAfter is inclusive: on its last day the item still posts.
  const last = plan({ items: [{ id: "OLD", kind: "ep", dir: "x/OLD", notAfter: TODAY }, ...F(2)] });
  assert.deepEqual(last.drops, []);
  assert.deepEqual(last.posts, [{ id: "OLD", platform: "instagram", why: "queue" }]);
});

test("below buffer posts only on fallback days", () => {
  const tue = plan({ items: F(3), today: "2026-10-27" });
  assert.equal(tue.rhythm, "4-a-week");
  assert.equal(tue.postingDay, false);
  assert.deepEqual(tue.posts, []);

  const wed = plan({ items: F(3), today: "2026-10-28" });
  assert.equal(wed.postingDay, true);
  assert.deepEqual(wed.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);
});

test("not-ready item is skipped and listed", () => {
  const items = F(7);
  const ready = new Set(items.map((i) => i.id).filter((id) => id !== "F1"));
  const p = plan({ items, ready });
  assert.deepEqual(p.posts, [{ id: "F2", platform: "instagram", why: "queue" }]);
  assert.deepEqual(p.notReady, ["F1"]);
  assert.equal(p.readyCount, 6);
});

test("window", () => {
  const items = [{ id: "P", kind: "special", dir: "x/P", on: "2026-10-11" }, ...F(7)];

  const early = plan({ items, minutesNow: 1169 });
  assert.equal(early.window, "early");
  assert.deepEqual(early.posts, []);

  const open = plan({ items, minutesNow: 1290 });
  assert.equal(open.window, "open");
  assert.deepEqual(open.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);

  const late = plan({ items, minutesNow: 1291 });
  assert.equal(late.window, "late");
  assert.deepEqual(late.posts, []);
  assert.deepEqual(late.drops, [{ id: "P", platform: "instagram", reason: "pinned date passed" }]);

  // The laptop wakes at 00:30 the next day: nothing posts for either day.
  const afterMidnight = plan({ items, today: "2026-10-26", minutesNow: 30 });
  assert.equal(afterMidnight.window, "early");
  assert.deepEqual(afterMidnight.posts, []);
});

test("disabled platform gets nothing; enabled platforms keep their own place", () => {
  const state = S({ F1: { instagram: { status: "posted", date: "2026-10-24" } } });

  const igOnly = plan({ items: F(8), state });
  assert.deepEqual(igOnly.posts, [{ id: "F2", platform: "instagram", why: "queue" }]);

  const both = plan({ items: F(8), state, config: cfg({ platforms: { youtube: { enabled: true } } }) });
  assert.deepEqual(both.posts, [
    { id: "F2", platform: "instagram", why: "queue" },
    { id: "F1", platform: "youtube", why: "queue" },
  ]);
});

test("drops and pinned posts are per platform", () => {
  const items = [
    { id: "OLD", kind: "special", dir: "x/OLD", on: "2026-10-11" },
    { id: "P", kind: "special", dir: "x/P", on: TODAY },
    ...F(7),
  ];
  const state = S({
    OLD: { instagram: { status: "dropped", reason: "pinned date passed" } },
    P: { instagram: { status: "posted", date: TODAY } },
  });
  const p = plan({ items, state, config: cfg({ platforms: { youtube: { enabled: true } } }) });
  assert.deepEqual(p.drops, [{ id: "OLD", platform: "youtube", reason: "pinned date passed" }]);
  assert.deepEqual(p.posts, [{ id: "P", platform: "youtube", why: "pinned" }]);
});

test("readyCount excludes pinned and done items", () => {
  const items = [
    { id: "P", kind: "special", dir: "x/P", on: "2026-11-01" },
    ...F(8),
  ];
  const state = S({
    F1: { instagram: { status: "posted", date: "2026-10-20" } },
    F2: { instagram: { status: "manual", date: "2026-10-21" } },
    F3: { instagram: { status: "dropped", reason: "past notAfter" } },
    F4: { instagram: { status: "failed", error: "boom" } },
  });
  const p = plan({ items, state });
  assert.equal(p.readyCount, 5); // F4..F8
  assert.equal(p.rhythm, "4-a-week");
  assert.deepEqual(p.posts, [{ id: "F4", platform: "instagram", why: "queue" }]);
});

test("does not mutate its inputs", () => {
  const items = [{ id: "P", kind: "special", dir: "x/P", on: "2026-10-11" }, ...F(7)];
  const state = S({ F1: { instagram: { status: "failed", error: "boom" } } });
  const before = structuredClone({ items, state });
  plan({ items, state });
  assert.deepEqual({ items, state }, before);
});

function runDry({ today = TODAY, items, state = S(), ready, config = cfg() }) {
  return projectRunDry({ today, items, state, ready: ready ?? new Set(items.map((i) => i.id)), config });
}

test("7 ready from Sun Oct 25 runs dry Fri Nov 6", () => {
  // Mon 26 daily (7 ready), then 4 a week: Wed 28, Fri 30, Sun 1, Mon 2, Wed 4, Fri 6.
  assert.equal(runDry({ items: F(7) }), "2026-11-06");
});

test("nothing ready → null", () => {
  assert.equal(runDry({ items: F(7), ready: new Set() }), null);
  assert.equal(runDry({ items: [] }), null);
});

test("a pinned day in between doesn't consume a floating item", () => {
  // P on Mon, F1 Tue while still 7 ready, then the same days.
  const items = [{ id: "P", kind: "special", dir: "x/P", on: "2026-10-26" }, ...F(7)];
  assert.equal(runDry({ items }), "2026-11-06");
});

test("run-dry waits for a notBefore item and skips a notAfter one", () => {
  const items = [
    { id: "OLD", kind: "ep", dir: "x/OLD", notAfter: "2026-10-25" },
    { id: "LATER", kind: "ep", dir: "x/LATER", notBefore: "2026-11-20" },
  ];
  // OLD is dropped on Mon 26; LATER posts on Fri Nov 20, a fallback day.
  assert.equal(runDry({ items }), "2026-11-20");
});

test("run-dry does not mutate the state", () => {
  const state = S({ F1: { instagram: { status: "failed", error: "boom" } } });
  const before = structuredClone(state);
  runDry({ items: F(7), state });
  assert.deepEqual(state, before);
});

test("planner: a held floating item is skipped and not counted ready", () => {
  const items = F(8).map((item) => (item.id === "F1" ? { ...item, hold: true } : item));
  const p = plan({ items });
  assert.deepEqual(p.posts, [{ id: "F2", platform: "instagram", why: "queue" }]);
  assert.equal(p.readyCount, 7);
  assert.deepEqual(p.notReady, [], "held, not broken");

  // Only held items left: nothing posts, and the run-dry projection ignores them.
  const held = F(2).map((item) => ({ ...item, hold: true }));
  assert.deepEqual(plan({ items: held }).posts, []);
  assert.equal(plan({ items: held }).readyCount, 0);
  assert.equal(runDry({ items: held }), null);
  // 7 ready plus a held one runs dry as 7 do.
  assert.equal(runDry({ items: [{ id: "H", kind: "ep", dir: "x/H", hold: true }, ...F(7)] }), "2026-11-06");
});

test("planner: a held pinned item past its date is dropped", () => {
  const past = { id: "P", kind: "special", dir: "x/P", on: "2026-10-24", hold: true };
  const p = plan({ items: [past, ...F(7)] });
  assert.deepEqual(p.drops, [{ id: "P", platform: "instagram", reason: "pinned date passed" }]);

  // On its own day it doesn't post, and the floating queue keeps the slot.
  const onToday = { id: "P", kind: "special", dir: "x/P", on: TODAY, hold: true };
  const q = plan({ items: [onToday, ...F(7)] });
  assert.deepEqual(q.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);
  assert.deepEqual(q.drops, []);
});
