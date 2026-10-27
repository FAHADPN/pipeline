import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSchedule, validateSchedule, isFloating, inWindow } from "../lib/schedule.mjs";

function tempRepo(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-schedule-"));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

test("validateSchedule passes a good schedule", () => {
  const root = tempRepo(["c/a", "c/b"]);
  const errors = validateSchedule([
    { id: "a", kind: "ep", dir: "c/a" },
    { id: "b", kind: "special", dir: "c/b", on: "2026-11-01" },
  ], root);
  assert.deepEqual(errors, []);
});

test("validateSchedule flags duplicate ids, missing dirs, bad dates, on+notAfter together, notBefore > notAfter", () => {
  const root = tempRepo(["c/dup", "c/bad-date", "c/both", "c/order"]);
  const errors = validateSchedule([
    { id: "dup", kind: "ep", dir: "c/dup" },
    { id: "dup", kind: "ep", dir: "c/dup" },
    { id: "missing-dir", kind: "ep", dir: "c/nowhere" },
    { id: "bad-date", kind: "ep", dir: "c/bad-date", notAfter: "2026-02-30" },
    { id: "both", kind: "special", dir: "c/both", on: "2026-11-01", notAfter: "2026-11-30" },
    { id: "order", kind: "ep", dir: "c/order", notBefore: "2026-12-01", notAfter: "2026-11-30" },
  ], root);
  assert.equal(errors.length, 5, errors.join("\n"));
  for (const id of ["dup", "missing-dir", "bad-date", "both", "order"]) {
    assert.equal(errors.filter((e) => e.includes(id)).length, 1, `one error for ${id}:\n${errors.join("\n")}`);
  }
});

test("validateSchedule flags a bad id, kind and date format", () => {
  const root = tempRepo(["c/x"]);
  const errors = validateSchedule([
    { id: "Bad_Id", kind: "ep", dir: "c/x" },
    { id: "kind-x", kind: "reel", dir: "c/x" },
    { id: "fmt-x", kind: "ep", dir: "c/x", notBefore: "1/12/2026" },
  ], root);
  assert.equal(errors.length, 3, errors.join("\n"));
  assert.ok(errors[0].includes("Bad_Id"));
  assert.ok(errors[1].includes("kind-x"));
  assert.ok(errors[2].includes("fmt-x"));
});

test("schedule accepts targetDate", () => {
  const root = tempRepo(["c/t", "c/bad"]);
  const errors = validateSchedule([
    { id: "t", kind: "ep", dir: "c/t", targetDate: "2026-11-20", notAfter: "2026-12-15" },
    { id: "bad", kind: "ep", dir: "c/bad", targetDate: "2026-11-31" },
  ], root);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.ok(errors[0].startsWith("bad:") && errors[0].includes("targetDate"), errors[0]);
});

test("validateSchedule rejects a non-array", () => {
  assert.equal(validateSchedule({}, tempRepo([])).length, 1);
});

test("loadSchedule reads a schedule relative to the root, BOM and all", () => {
  const root = tempRepo(["pieces/reel-01-launch", "pieces/reel-02-holiday"]);
  const items = [
    { id: "reel-01-launch", kind: "post", dir: "pieces/reel-01-launch", title: "Launch", type: "teach" },
    { id: "reel-02-holiday", kind: "special", dir: "pieces/reel-02-holiday", on: "2026-11-01" },
  ];
  fs.writeFileSync(path.join(root, "schedule.json"), "﻿" + JSON.stringify(items, null, 2));
  assert.deepEqual(loadSchedule("schedule.json", root), items);
});

test("loadSchedule throws one Error listing every problem", () => {
  const root = tempRepo([]);
  const file = path.join(root, "schedule.json");
  fs.writeFileSync(file, JSON.stringify([
    { id: "one", kind: "ep", dir: "c/one" },
    { id: "two", kind: "ep", dir: "c/two" },
  ]));
  assert.throws(() => loadSchedule(file, root), (err) => err.message.includes("one") && err.message.includes("two"));
});

test("inWindow respects notBefore/notAfter inclusively", () => {
  const item = { id: "w", kind: "ep", dir: "x", notBefore: "2026-11-01", notAfter: "2026-11-30" };
  assert.equal(inWindow(item, "2026-10-31"), false);
  assert.equal(inWindow(item, "2026-11-01"), true);
  assert.equal(inWindow(item, "2026-11-30"), true);
  assert.equal(inWindow(item, "2026-12-01"), false);
  assert.equal(inWindow({ id: "f", kind: "ep", dir: "x" }, "2026-10-25"), true);
});

test("validateSchedule accepts title, type and hold, and rejects a title over 80 characters and a hold that isn't a boolean", () => {
  const root = tempRepo(["c/a", "c/b", "c/c", "c/d"]);
  const good = [{ id: "a", kind: "ep", dir: "c/a", title: "Morning #1 Launch", type: "story", hold: true }];
  assert.deepEqual(validateSchedule(good, root), []);

  const errors = validateSchedule([
    { id: "b", kind: "ep", dir: "c/b", title: "x".repeat(81) },
    { id: "c", kind: "ep", dir: "c/c", hold: "yes" },
    { id: "d", kind: "ep", dir: "c/d", title: "", type: "y".repeat(41) },
  ], root);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /^b: title must be a string of 1-80 characters/);
  assert.match(errors[1], /^c: hold must be true or false/);
  assert.match(errors[2], /^d: title must .*; type must be a string of 1-40 characters/);
});

test("isFloating is false only when on is set", () => {
  assert.equal(isFloating({ id: "a", kind: "ep", dir: "x" }), true);
  assert.equal(isFloating({ id: "b", kind: "ep", dir: "x", notAfter: "2026-11-30" }), true);
  assert.equal(isFloating({ id: "c", kind: "special", dir: "x", on: "2026-11-01" }), false);
});
