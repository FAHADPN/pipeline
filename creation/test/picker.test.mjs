import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FORMATS, PICKER_DEFAULTS, pickWork } from "../lib/picker.mjs";

function entry(id, format = "episode") {
  return { id, format };
}

function state(items = {}) {
  return { items };
}

const backlog = [
  entry("ep-20-a"),
  entry("post-21-b", "this-or-that"),
  entry("post-22-c", "carousel"),
  entry("ep-23-d"),
  entry("post-24-e", "hot-take"),
  entry("ep-25-f"),
];

test("defaults: two builds, six awaiting, every format but carousel and hot-take", () => {
  assert.equal(PICKER_DEFAULTS.maxBuilds, 2);
  assert.equal(PICKER_DEFAULTS.maxAwaiting, 6);
  assert.deepEqual(DEFAULT_FORMATS, ["episode", "this-or-that", "how-many", "two-phones", "greeting"]);
});

test("picks two todo in order", () => {
  assert.deepEqual(pickWork({ backlog, cstate: state() }), ["ep-20-a", "post-21-b"]);
});

test("maxBuilds is configurable", () => {
  assert.deepEqual(pickWork({ backlog, cstate: state(), maxBuilds: 3 }), ["ep-20-a", "post-21-b", "ep-23-d"]);
});

test("redo before failed before todo", () => {
  const cstate = state({
    "ep-20-a": { status: "approved", attempts: 0 },
    "post-21-b": { status: "failed", attempts: 1, reason: "x" },
    "ep-23-d": { status: "todo", attempts: 0 },
    "ep-25-f": { status: "redo", attempts: 0, note: "slower" },
  });
  assert.deepEqual(pickWork({ backlog, cstate, maxBuilds: 3 }), ["ep-25-f", "post-21-b", "ep-23-d"]);
});

test("failed at 2 attempts is not picked", () => {
  const cstate = state({
    "ep-20-a": { status: "failed", attempts: 2, reason: "x" },
    "post-21-b": { status: "building", attempts: 0 },
  });
  assert.deepEqual(pickWork({ backlog, cstate }), ["ep-23-d", "ep-25-f"]);
});

test("nothing while 6 await approval", () => {
  const awaiting = { status: "awaiting-approval", attempts: 0 };
  const items = {};
  for (let i = 0; i < 6; i++) items[`post-9${i}-x`] = awaiting;
  assert.deepEqual(pickWork({ backlog, cstate: state(items) }), []);
  delete items["post-95-x"];
  assert.deepEqual(pickWork({ backlog, cstate: state(items) }), ["ep-20-a", "post-21-b"]);
  assert.deepEqual(pickWork({ backlog, cstate: state(items), maxAwaiting: 5 }), []);
});

test("carousel skipped when unsupported", () => {
  const cstate = state({
    "ep-20-a": { status: "approved", attempts: 0 },
    "post-21-b": { status: "approved", attempts: 0 },
  });
  assert.deepEqual(pickWork({ backlog, cstate }), ["ep-23-d", "ep-25-f"]);
  assert.deepEqual(pickWork({ backlog, cstate, formats: [...DEFAULT_FORMATS, "carousel", "hot-take"], maxBuilds: 3 }),
    ["post-22-c", "ep-23-d", "post-24-e"]);
});

test("onlyId picks just that id if eligible", () => {
  assert.deepEqual(pickWork({ backlog, cstate: state(), onlyId: "ep-23-d" }), ["ep-23-d"]);
  // A hand-started build of the first hot-take, before hot-take is in the nightly formats.
  assert.deepEqual(pickWork({ backlog, cstate: state(), onlyId: "post-24-e" }), ["post-24-e"]);
  // Carousels can't be built until the carousel plan ships.
  assert.deepEqual(pickWork({ backlog, cstate: state(), onlyId: "post-22-c" }), []);
  assert.deepEqual(pickWork({ backlog, cstate: state(), onlyId: "nope" }), []);
  for (const item of [
    { status: "approved", attempts: 0 },
    { status: "awaiting-approval", attempts: 0 },
    { status: "building", attempts: 0 },
    { status: "failed", attempts: 2 },
  ]) {
    assert.deepEqual(pickWork({ backlog, cstate: state({ "ep-23-d": item }), onlyId: "ep-23-d" }), [], item.status);
  }
  assert.deepEqual(pickWork({ backlog, cstate: state({ "ep-23-d": { status: "redo", attempts: 0, note: "n" } }), onlyId: "ep-23-d" }), ["ep-23-d"]);
  // A build started by hand isn't held back by the awaiting-approval cap.
  assert.deepEqual(pickWork({ backlog, cstate: state(), onlyId: "ep-23-d", maxAwaiting: 0 }), ["ep-23-d"]);
});
