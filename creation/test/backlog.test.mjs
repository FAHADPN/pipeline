import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBacklog, validateBacklog } from "../lib/backlog.mjs";
import { createCreationStore, transition } from "../lib/cstate.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "creation-cstate-"));
}

function entry(over = {}) {
  return {
    id: "ep-90-test",
    kind: "ep",
    format: "episode",
    type: "story",
    title: "Test piece",
    premise: "A test premise.",
    targetDate: "2026-11-20",
    hook: 21,
    reference: "reel-00-intro",
    ...over,
  };
}

test("validateBacklog passes a good entry, with and without a window", () => {
  assert.deepEqual(validateBacklog([
    entry(),
    entry({ id: "post-90-x", kind: "post", format: "hot-take", type: "opinion", hook: 2, notBefore: "2026-11-25", notAfter: "2026-12-31" }),
    entry({ id: "special-90-x", kind: "special", format: "greeting", type: "greeting", hook: null, targetDate: "2026-12-25", on: "2026-12-25" }),
  ]), []);
});

test("reference is free text: required, but never looked up as a folder", () => {
  assert.deepEqual(validateBacklog([entry({ reference: "the launch reel's opening, slower" })]), []);
  assert.deepEqual(validateBacklog([entry({ reference: "  " })]), ["ep-90-test: reference is missing"]);
});

test("validateBacklog flags duplicate ids, unknown format, on combined with a window", () => {
  const errors = validateBacklog([
    entry({ id: "dup" }),
    entry({ id: "dup" }),
    entry({ id: "fmt", format: "slideshow" }),
    entry({ id: "both", on: "2026-11-20", notAfter: "2026-11-30" }),
  ]);
  assert.equal(errors.length, 3, errors.join("\n"));
  for (const id of ["dup", "fmt", "both"]) {
    assert.equal(errors.filter((e) => e.startsWith(`${id}:`)).length, 1, `one error for ${id}:\n${errors.join("\n")}`);
  }
});

test("validateBacklog flags bad fields, an empty reference and targetDate out of order", () => {
  const errors = validateBacklog([
    entry({ id: "Bad_Id" }),
    entry({ id: "kind-x", kind: "reel" }),
    entry({ id: "type-x", type: "meme" }),
    entry({ id: "date-x", targetDate: "2026-02-30" }),
    entry({ id: "hook-x", hook: "21" }),
    entry({ id: "ref-x", reference: "" }),
    entry({ id: "title-x", title: "" }),
    entry({ id: "late", targetDate: "2026-12-01" }),
    entry({ id: "early", targetDate: "2026-11-01" }),
    entry({ id: "order", notBefore: "2026-12-01", notAfter: "2026-11-30" }),
  ]);
  assert.equal(errors.length, 9, errors.join("\n"));
  for (const id of ["Bad_Id", "kind-x", "type-x", "date-x", "hook-x", "ref-x", "title-x", "early", "order"]) {
    assert.equal(errors.filter((e) => e.startsWith(`${id}:`)).length, 1, `one error for ${id}:\n${errors.join("\n")}`);
  }
});

test("validateBacklog rejects a non-array and loadBacklog throws listing every problem", () => {
  assert.equal(validateBacklog({}).length, 1);
  const dir = tempHome();
  const file = path.join(dir, "backlog.json");
  fs.writeFileSync(file, JSON.stringify([entry({ id: "one", format: "x" }), entry({ id: "two", reference: "" })]));
  assert.throws(() => loadBacklog(file), (err) => err.message.includes(file) && err.message.includes("one") && err.message.includes("two"));
  assert.throws(() => loadBacklog(path.join(dir, "missing.json")), /can't read backlog .*missing\.json/);

  // A good file loads, a byte-order mark and all.
  fs.writeFileSync(file, `\uFEFF${JSON.stringify([entry()])}`);
  assert.deepEqual(loadBacklog(file), [entry()]);
});

const AT = "2026-10-25T02:00:00.000Z";

function walk(moves, start = { items: {} }) {
  return moves.reduce((s, [to, extra]) => transition(s, "ep-90-test", to, { at: AT, ...extra }), start);
}

test("transition allows the listed moves and throws on others", () => {
  let s = walk([["building"], ["awaiting-approval"], ["redo", { note: "slower ending" }], ["building"]]);
  assert.equal(s.items["ep-90-test"].status, "building");
  assert.equal(s.items["ep-90-test"].note, "slower ending", "the redo note survives into the rebuild");
  s = walk([["awaiting-approval"], ["approved"]], s);
  assert.deepEqual(s.items["ep-90-test"], { status: "approved", attempts: 0, at: AT });

  s = walk([["building"], ["failed", { reason: "timeout" }]]);
  assert.deepEqual(s.items["ep-90-test"], { status: "failed", attempts: 1, reason: "timeout", at: AT });
  s = walk([["building"]], s);
  assert.equal(s.items["ep-90-test"].status, "building");
  assert.equal(s.items["ep-90-test"].reason, undefined);

  for (const from of ["building", "awaiting-approval", "approved", "redo", "failed"]) {
    const moves = { building: [["building"]], "awaiting-approval": [["building"], ["awaiting-approval"]],
      approved: [["building"], ["awaiting-approval"], ["approved"]], redo: [["building"], ["awaiting-approval"], ["redo", { note: "n" }]],
      failed: [["building"], ["failed", { reason: "r" }]] }[from];
    const reset = walk([...moves, ["todo"]]);
    assert.deepEqual(reset.items["ep-90-test"], { status: "todo", attempts: 0, at: AT }, `${from} → todo`);
  }

  const refused = [
    [[], "awaiting-approval"], [[], "approved"], [[], "failed"], [[], "redo"],
    [[["building"]], "approved"], [[["building"]], "redo"], [[["building"]], "building"],
    [[["building"], ["awaiting-approval"]], "building"], [[["building"], ["awaiting-approval"]], "failed"],
    [[["building"], ["awaiting-approval"], ["approved"]], "building"],
    [[["building"], ["awaiting-approval"], ["redo", { note: "n" }]], "approved"],
    [[["building"], ["failed", { reason: "r" }]], "awaiting-approval"],
    [[], "posted"],
  ];
  for (const [moves, to] of refused) {
    const s0 = walk(moves);
    assert.throws(() => transition(s0, "ep-90-test", to, { at: AT }), /ep-90-test/, `${s0.items["ep-90-test"]?.status ?? "todo"} → ${to}`);
  }
});

test("transition does not mutate its input", () => {
  const s0 = walk([["building"]]);
  const before = structuredClone(s0);
  transition(s0, "ep-90-test", "failed", { at: AT, reason: "x" });
  assert.deepEqual(s0, before);
});

test("failed → building is refused at 2 attempts", () => {
  const s = walk([["building"], ["failed", { reason: "one" }], ["building"], ["failed", { reason: "two" }]]);
  assert.equal(s.items["ep-90-test"].attempts, 2);
  assert.throws(() => transition(s, "ep-90-test", "building", { at: AT }), /attempts/);
  const reset = transition(s, "ep-90-test", "todo", { at: AT });
  assert.equal(transition(reset, "ep-90-test", "building", { at: AT }).items["ep-90-test"].status, "building");
});

test("creation store loads empty, saves and reloads creation-state.json", () => {
  const home = tempHome();
  const store = createCreationStore(home);
  assert.deepEqual(store.load(), { items: {} });
  const s = walk([["building"]]);
  store.save(s);
  assert.ok(fs.existsSync(path.join(home, "creation-state.json")));
  assert.deepEqual(createCreationStore(home).load(), s);
  fs.writeFileSync(path.join(home, "creation-state.json"), "{ not json");
  assert.throws(() => store.load(), /creation-state\.json/);
});
