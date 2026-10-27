import { test } from "node:test";
import assert from "node:assert/strict";
import { needsYou } from "../lib/inbox.mjs";

const NOW = new Date("2026-10-25T10:00:00Z");

// A status with nothing wrong; each test breaks one thing.
function healthy() {
  return {
    today: "2026-10-25",
    connected: true,
    next: { date: "2026-10-25", id: "ep-04", platform: "instagram" },
    queue: [],
    posted: [],
    problems: { failed: [], dropped: [], notReady: [], warnings: [] },
    health: { readyCount: 13, rhythm: "daily", runDry: "2026-11-13", tokenAgeDays: { instagram: 1, youtube: null }, taskRegistered: true },
    creation: { counts: {}, awaiting: [], failed: [], redo: [], building: [], error: null },
  };
}

test("needsYou: a running campaign with Instagram switched off is red; a paused one isn't", () => {
  const status = { ...healthy(), campaign: { id: "globex", name: "Globex", paused: false, instagramEnabled: false } };
  assert.deepEqual(needsYou(status, { now: NOW }), [
    {
      kind: "instagramOff",
      severity: "red",
      title: "Instagram posting is off for Globex",
      detail: "Nothing posts to Instagram until it is switched back on in its settings.",
      action: { label: "Campaigns", route: "#/campaigns" },
    },
  ]);
  assert.deepEqual(needsYou({ ...status, campaign: { ...status.campaign, paused: true } }, { now: NOW }), []);
  assert.deepEqual(needsYou({ ...status, campaign: { ...status.campaign, instagramEnabled: true } }, { now: NOW }), []);
});

test("needsYou: a failed Instagram post is red with action Retry", () => {
  const status = healthy();
  status.problems.failed.push({ id: "ep-03", platform: "instagram", error: "Graph 190: session expired", at: "x" });
  const todos = needsYou(status, { now: NOW });
  assert.equal(todos.length, 1);
  const [t] = todos;
  assert.equal(t.severity, "red");
  assert.match(t.title, /ep-03/);
  assert.match(t.title, /Instagram/);
  assert.equal(t.detail, "Graph 190: session expired");
  assert.deepEqual(t.action, { label: "Retry", action: "retry", id: "ep-03", platform: "instagram" });
});

test("needsYou: a failed build is amber with its reason and action Build again", () => {
  const status = healthy();
  status.creation.failed.push({ id: "post-07", title: "How many · Bangalore", reason: "capture sign-in failed", attempts: 1, at: "x" });
  status.creation.redo.push({ id: "ep-17", title: "Payday deals", reason: "tighter hook", attempts: 0, at: "x" });
  const todos = needsYou(status, { now: NOW });
  assert.equal(todos.length, 2);
  const [failed, redo] = todos;
  assert.equal(failed.severity, "amber");
  assert.match(failed.title, /How many · Bangalore/);
  assert.equal(failed.detail, "capture sign-in failed");
  assert.deepEqual(failed.action, { label: "Build again", route: "#/review/post-07" });
  assert.equal(redo.severity, "amber");
  assert.equal(redo.detail, "tighter hook");
  assert.deepEqual(redo.action, { label: "Build again", route: "#/review/ep-17" });
});

test("needsYou: a piece awaiting approval is purple with route #/review/<id>", () => {
  const status = healthy();
  status.creation.awaiting.push({ id: "post-06", title: "Two phones · long-distance", caption: "hi", video: "/media/post-06/v.mp4" });
  const [t, ...rest] = needsYou(status, { now: NOW });
  assert.deepEqual(rest, []);
  assert.equal(t.severity, "purple");
  assert.match(t.title, /Two phones · long-distance/);
  assert.equal(t.action.route, "#/review/post-06");
});

test("needsYou: an Instagram token 50 or more days old is amber", () => {
  const status = healthy();
  status.health.tokenAgeDays.instagram = 49;
  assert.deepEqual(needsYou(status, { now: NOW }), []);
  status.health.tokenAgeDays.instagram = 50;
  const [t] = needsYou(status, { now: NOW });
  assert.equal(t.severity, "amber");
  assert.match(t.title, /50 days/);
  assert.equal(t.action.route, "#/connections");
});

test("needsYou: a missing scheduled task is red", () => {
  const status = healthy();
  status.health.taskRegistered = false;
  const [t, ...rest] = needsYou(status, { now: NOW });
  assert.deepEqual(rest, []);
  assert.equal(t.severity, "red");
  assert.equal(t.action.route, "#/health");
});

test("needsYou: an unreadable build list is amber", () => {
  const status = healthy();
  status.creation.error = "can't read build list backlog.json: Unexpected token";
  const [t] = needsYou(status, { now: NOW });
  assert.equal(t.severity, "amber");
  assert.equal(t.detail, status.creation.error);
});

test("needsYou: an item that isn't ready to post is red with its errors and route #/library", () => {
  const status = healthy();
  status.problems.notReady.push({ id: "ep-09", errors: ["video missing", "caption missing"] });
  const [t, ...rest] = needsYou(status, { now: NOW });
  assert.deepEqual(rest, []);
  assert.equal(t.severity, "red");
  assert.equal(t.title, "ep-09 isn't ready to post");
  assert.equal(t.detail, "video missing; caption missing");
  assert.equal(t.action.route, "#/library");
});

test("needsYou: a pending drop is amber with its reason; recorded drops are not to-dos", () => {
  const status = healthy();
  status.problems.dropped.push(
    { id: "special-pooja", platform: "instagram", reason: "missed its window (11 Oct)", at: null, pending: true },
    { id: "ep-00", platform: "instagram", reason: "old", at: "2026-10-01" },
  );
  const [t, ...rest] = needsYou(status, { now: NOW });
  assert.deepEqual(rest, []);
  assert.equal(t.severity, "amber");
  assert.equal(t.title, "special-pooja will be dropped");
  assert.equal(t.detail, "missed its window (11 Oct)");
});

test("needsYou: a build without a title falls back to its id", () => {
  const status = healthy();
  status.creation.failed.push({ id: "f1", title: null, reason: "r" });
  status.creation.redo.push({ id: "r1", reason: "n" });
  status.creation.awaiting.push({ id: "a1" });
  assert.deepEqual(
    needsYou(status, { now: NOW }).map((t) => t.title),
    ["f1 did not build", "r1 is waiting for a redo", "a1 is waiting for your approval"],
  );
});

test("needsYou: red comes first, then amber, then purple", () => {
  const status = healthy();
  status.creation.awaiting.push({ id: "a1", title: "A1" });
  status.creation.failed.push({ id: "f1", title: "F1", reason: "r" });
  status.problems.failed.push({ id: "p1", platform: "youtube", error: null });
  status.health.taskRegistered = false;
  const todos = needsYou(status, { now: NOW });
  assert.deepEqual(todos.map((t) => t.severity), ["red", "red", "amber", "purple"]);
  for (const t of todos) {
    assert.equal(typeof t.kind, "string");
    assert.equal(typeof t.title, "string");
    assert.equal(typeof t.detail, "string");
    assert.equal(typeof t.action.label, "string");
  }
});

test("needsYou: a healthy status gives []", () => {
  assert.deepEqual(needsYou(healthy(), { now: NOW }), []);
  // A status without creation or health (a campaign that has never built) is healthy too.
  assert.deepEqual(needsYou({ problems: { failed: [] } }, { now: NOW }), []);
});

test("needsYou: skew 130 s is red; 100 s is nothing", () => {
  const status = healthy();
  status.system = { clock: { skewSeconds: -100 }, tasks: [], disk: { freeGb: 50 } };
  assert.deepEqual(needsYou(status, { now: NOW }), []);
  status.system.clock.skewSeconds = -130;
  const [t, ...rest] = needsYou(status, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(t.severity, "red");
  assert.equal(t.title, "This computer's clock is off by 2 min");
});

test("needsYou: a missing scheduled task is red and names the task; a null clock is nothing", () => {
  const status = healthy();
  status.health.taskRegistered = false;
  status.system = {
    clock: null,
    disk: null,
    tasks: [
      { name: "Pipeline Publisher", registered: false },
      { name: "Pipeline Telegram", registered: true },
    ],
  };
  const todos = needsYou(status, { now: NOW });
  assert.deepEqual(todos.map((t) => [t.severity, t.title]), [["red", "Scheduled task Pipeline Publisher is missing"]]);
});

test("needsYou: a task whose state is unknown (registered null) is no to-do", () => {
  const status = healthy();
  status.system = { clock: null, disk: null, tasks: [{ name: "Pipeline Publisher", registered: null }] };
  assert.deepEqual(needsYou(status, { now: NOW }), []);
});

test("needsYou: under 5 GB free on C: is amber", () => {
  const status = healthy();
  status.system = { clock: null, tasks: [], disk: { freeGb: 4.2 } };
  const [t] = needsYou(status, { now: NOW });
  assert.equal(t.severity, "amber");
  assert.match(t.title, /4\.2 GB/);
  status.system.disk.freeGb = 5;
  assert.deepEqual(needsYou(status, { now: NOW }), []);
});
