import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleItem } from "../lib/insert.mjs";

const ENTRY = { id: "reel-01-launch", kind: "ep", targetDate: "2026-11-02", title: "Launch day", type: "story" };

test("scheduleItem copies title and type from the build-list entry, in the piece folder given", () => {
  assert.deepEqual(scheduleItem(ENTRY, "pieces/reel-01-launch"), {
    id: "reel-01-launch",
    kind: "ep",
    dir: "pieces/reel-01-launch",
    targetDate: "2026-11-02",
    title: "Launch day",
    type: "story",
  });
});

test("scheduleItem leaves title and type out when the entry has none", () => {
  const item = scheduleItem({ id: "reel-02-menu", kind: "ep", targetDate: "2026-11-03" }, "pieces/reel-02-menu");
  assert.deepEqual(Object.keys(item), ["id", "kind", "dir", "targetDate"]);
});
