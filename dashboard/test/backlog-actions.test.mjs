import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCreationStore } from "../../creation/lib/cstate.mjs";
import { formatBacklog } from "../../creation/lib/backlog.mjs";
import { createBacklogActions } from "../lib/backlog-actions.mjs";

const NOW = new Date("2026-10-25T04:30:00Z"); // Sun 10:00 IST
const BUSY = "a build is running for Test Campaign; try again when it finishes";
const CONFIG = { timezone: "Asia/Kolkata", formats: ["episode", "this-or-that", "greeting"] };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

const entry = (id, targetDate, extra = {}) => ({
  id,
  kind: "post",
  format: "this-or-that",
  type: "participation",
  title: `Title ${id}`,
  premise: `Premise ${id}`,
  targetDate,
  hook: null,
  reference: "ref-piece",
  ...extra,
});
const BACKLOG = [
  entry("a-todo", "2026-11-01"),
  entry("b-building", "2026-11-02"),
  entry("c-awaiting", "2026-11-03"),
  entry("d-approved", "2026-11-04"),
  entry("e-failed", "2026-11-05"),
  entry("f-redo", "2026-11-06", { kind: "ep", format: "episode", type: "story" }),
  entry("g-scheduled", "2026-11-07"),
];
const CSTATE = {
  items: {
    "b-building": { status: "building", attempts: 0 },
    "c-awaiting": { status: "awaiting-approval", attempts: 1 },
    "d-approved": { status: "approved", attempts: 1 },
    "e-failed": { status: "failed", attempts: 1 },
    "f-redo": { status: "redo", attempts: 1 },
  },
};
const GOOD = { title: "Chai or coffee", premise: "Which one wins the morning?", format: "this-or-that", type: "participation", targetDate: "2026-11-10" };

function fakeLog() {
  return {
    lines: [],
    info(msg, data) {
      this.lines.push(["info", msg, data]);
    },
    error(msg, data) {
      this.lines.push(["error", msg, data]);
    },
  };
}

function setup({ withLock, config = CONFIG, crlf = false } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  const text = formatBacklog(BACKLOG);
  fs.writeFileSync(path.join(repo, "backlog.json"), crlf ? text.replace(/\n/g, "\r\n") : text);
  fs.writeFileSync(path.join(repo, "schedule.json"), '[\n  { "id": "g-scheduled", "kind": "post", "dir": "pieces/g-scheduled" }\n]\n');
  fs.mkdirSync(path.join(repo, "pieces", "g-scheduled"), { recursive: true });
  fs.writeFileSync(path.join(repo, "pieces", "g-scheduled", "keep.txt"), "x");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-home-"));
  const store = createCreationStore(home);
  store.save(structuredClone(CSTATE));
  const locks = [];
  const campaign = { id: "test", name: "Test Campaign", lockName: (name) => `test:${name}`, config };
  const deps = {
    repoRoot: repo,
    backlogFile: "backlog.json",
    scheduleFile: "schedule.json",
    store,
    log: fakeLog(),
    now: () => NOW,
    withLock:
      withLock ??
      (async (name, fn, options) => {
        locks.push([name, options]);
        return fn();
      }),
  };
  const file = path.join(repo, "backlog.json");
  return {
    repo,
    deps,
    locks,
    actions: createBacklogActions({ campaign, deps }),
    original: fs.readFileSync(file),
    read: () => fs.readFileSync(file),
    entries: () => JSON.parse(fs.readFileSync(file, "utf8")),
    commits: () => git(repo, "log", "--format=%s").split("\n"),
  };
}

test("formatBacklog writes a build list's own layout byte for byte", () => {
  const text = [
    "[",
    "  {",
    '    "id": "post-01-launch",',
    '    "kind": "post",',
    '    "format": "episode",',
    '    "type": "story",',
    '    "title": "Launch day",',
    '    "premise": "The first cup from the new roaster.",',
    '    "targetDate": "2026-11-02",',
    '    "hook": 3,',
    '    "reference": "starter",',
    '    "notAfter": "2026-11-30"',
    "  }",
    "]",
    "",
  ].join("\n");
  assert.equal(formatBacklog(JSON.parse(text)), text);
});

test("add: creates a slug id and commits \"ideas: add <id>\"", async () => {
  const { actions, entries, commits, locks, deps } = setup();
  const res = await actions.saveIdea({ entry: { ...GOOD, title: "  Chai or Coffee?! " } });
  assert.equal(res.ok, true, res.error);
  const added = entries().find((e) => e.id === "chai-or-coffee");
  assert.deepEqual(added, {
    id: "chai-or-coffee",
    kind: "post",
    format: "this-or-that",
    type: "participation",
    title: "Chai or Coffee?!",
    premise: GOOD.premise,
    targetDate: "2026-11-10",
    hook: null,
    reference: "ref-piece",
  });
  assert.equal(commits()[0], "ideas: add chai-or-coffee");
  assert.deepEqual(locks, [["schedule", { waitMs: 3000 }]]);
  assert.deepEqual(deps.log.lines.at(-1)[0], "info");
  assert.match(deps.log.lines.at(-1)[1], /dashboard saveIdea/);
});

test("add: an episode gets kind ep, and the entry lands in date order", async () => {
  const { actions, entries } = setup();
  const res = await actions.saveIdea({ entry: { ...GOOD, format: "episode", type: "story", targetDate: "2026-11-02" } });
  assert.equal(res.ok, true, res.error);
  const list = entries();
  const at = list.findIndex((e) => e.id === "chai-or-coffee");
  assert.equal(list[at].kind, "ep");
  assert.equal(list[at].reference, "ref-piece");
  assert.deepEqual(list.map((e) => e.targetDate), list.map((e) => e.targetDate).toSorted());
  assert.equal(list[at - 1].id, "b-building");
});

test("add: a duplicate title gets -2, then -3, also against the schedule", async () => {
  const { actions, entries } = setup();
  assert.equal((await actions.saveIdea({ entry: GOOD })).ok, true);
  assert.equal((await actions.saveIdea({ entry: GOOD })).ok, true);
  assert.equal((await actions.saveIdea({ entry: GOOD })).ok, true);
  assert.deepEqual(entries().filter((e) => e.id.startsWith("chai-or-coffee")).map((e) => e.id), ["chai-or-coffee", "chai-or-coffee-2", "chai-or-coffee-3"]);
  // g-scheduled is only in the schedule's id space too: a title slugging to it gets -2.
  const res = await actions.saveIdea({ entry: { ...GOOD, title: "G scheduled" } });
  assert.equal(res.ok, true, res.error);
  assert.ok(entries().some((e) => e.id === "g-scheduled-2"));
});

test("add: an id only the schedule has is taken too", async () => {
  const { actions, entries, repo } = setup();
  fs.writeFileSync(path.join(repo, "schedule.json"), '[\n  { "id": "old-one", "kind": "post", "dir": "pieces/g-scheduled" }\n]\n');
  const res = await actions.saveIdea({ entry: { ...GOOD, title: "Old one" } });
  assert.equal(res.ok, true, res.error);
  assert.ok(entries().some((e) => e.id === "old-one-2"));
});

test("add: keeps the file's CRLF line endings", async () => {
  const { actions, read } = setup({ crlf: true });
  assert.equal((await actions.saveIdea({ entry: GOOD })).ok, true);
  const text = read().toString();
  assert.ok(text.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(text));
});

test("add: the fields are checked", async () => {
  const { actions, read, original } = setup();
  const bad = [
    [{ ...GOOD, title: "" }, /title/],
    [{ ...GOOD, title: "x".repeat(81) }, /title/],
    [{ ...GOOD, title: "!!!" }, /title/],
    [{ ...GOOD, premise: "" }, /premise/],
    [{ ...GOOD, premise: "x".repeat(1001) }, /premise/],
    [{ ...GOOD, type: "nope" }, /type/],
    [{ ...GOOD, targetDate: "2026-02-30" }, /targetDate/],
    [{ ...GOOD, targetDate: "2026-10-24" }, /today or later/],
    [{ ...GOOD, notBefore: "nope" }, /notBefore/],
    [{ ...GOOD, notBefore: "2026-11-20", notAfter: "2026-11-12" }, /notBefore/],
  ];
  for (const [e, pattern] of bad) {
    const res = await actions.saveIdea({ entry: e });
    assert.equal(res.ok, false, JSON.stringify(e));
    assert.match(res.error, pattern);
  }
  assert.deepEqual(read(), original);
});

test("add: today is allowed, and a window is kept", async () => {
  const { actions, entries } = setup();
  const res = await actions.saveIdea({ entry: { ...GOOD, targetDate: "2026-10-25", notBefore: "2026-10-25", notAfter: "2026-11-30" } });
  assert.equal(res.ok, true, res.error);
  const added = entries().find((e) => e.id === "chai-or-coffee");
  assert.equal(added.notBefore, "2026-10-25");
  assert.equal(added.notAfter, "2026-11-30");
});

test("edit: changes a todo entry's fields and commits \"ideas: edit <id>\"", async () => {
  const { actions, entries, commits } = setup();
  const res = await actions.saveIdea({ entry: { id: "a-todo", title: "New title", premise: "New premise", format: "greeting", type: "greeting", targetDate: "2026-11-01", notAfter: "2026-11-09" } });
  assert.equal(res.ok, true, res.error);
  const edited = entries().find((e) => e.id === "a-todo");
  assert.equal(edited.id, "a-todo");
  assert.equal(edited.title, "New title");
  assert.equal(edited.format, "greeting");
  assert.equal(edited.hook, null);
  assert.equal(edited.reference, "ref-piece");
  assert.equal(edited.notAfter, "2026-11-09");
  assert.equal(commits()[0], "ideas: edit a-todo");
  assert.equal(entries().length, BACKLOG.length);
});

test("edit: a cleared window comes off, and an unchanged past date is fine", async () => {
  const { actions, entries, repo } = setup();
  const list = JSON.parse(fs.readFileSync(path.join(repo, "backlog.json"), "utf8"));
  list[0] = { ...list[0], targetDate: "2026-10-01", notBefore: "2026-10-01" };
  fs.writeFileSync(path.join(repo, "backlog.json"), formatBacklog(list));
  git(repo, "commit", "-q", "-am", "stale");
  const res = await actions.saveIdea({ entry: { id: "a-todo", title: "Same", premise: "p", format: "this-or-that", type: "participation", targetDate: "2026-10-01", notBefore: "" } });
  assert.equal(res.ok, true, res.error);
  const edited = entries().find((e) => e.id === "a-todo");
  assert.equal("notBefore" in edited, false);
  assert.equal(edited.targetDate, "2026-10-01");
});

test("edit: a new date moves the entry to its place in the date order", async () => {
  const { actions, entries } = setup();
  const res = await actions.saveIdea({ entry: { id: "a-todo", ...GOOD, targetDate: "2026-11-05" } });
  assert.equal(res.ok, true, res.error);
  const ids = entries().map((e) => e.id);
  assert.ok(ids.indexOf("a-todo") > ids.indexOf("d-approved"));
  assert.ok(ids.indexOf("a-todo") < ids.indexOf("f-redo"));
});

test("edit: a piece not in todo is refused", async () => {
  const { actions, read, original, commits } = setup();
  for (const id of ["b-building", "c-awaiting", "d-approved", "e-failed", "f-redo", "g-scheduled"]) {
    const res = await actions.saveIdea({ entry: { id, ...GOOD } });
    assert.equal(res.ok, false, id);
    assert.match(res.error, new RegExp(`${id} is .*only an idea that hasn't been built`));
  }
  assert.deepEqual(read(), original);
  assert.deepEqual(commits(), ["init"]);
});

test("edit: an id that isn't in the list is refused", async () => {
  const { actions } = setup();
  const res = await actions.saveIdea({ entry: { id: "nope", ...GOOD } });
  assert.equal(res.ok, false);
  assert.match(res.error, /no idea nope/);
});

test("edit: a field outside the list is refused", async () => {
  const { actions, read, original } = setup();
  for (const extra of [{ reference: "x" }, { kind: "ep" }, { hook: 3 }, { on: "2026-11-03" }, { status: "approved" }]) {
    const res = await actions.saveIdea({ entry: { id: "a-todo", ...GOOD, ...extra } });
    assert.equal(res.ok, false, JSON.stringify(extra));
    assert.match(res.error, new RegExp(`${Object.keys(extra)[0]} can't be set`));
  }
  assert.deepEqual(read(), original);
});

test("edit: a format the campaign doesn't have is refused", async () => {
  const { actions, read, original } = setup();
  const res = await actions.saveIdea({ entry: { id: "a-todo", ...GOOD, format: "hot-take" } });
  assert.equal(res.ok, false);
  assert.match(res.error, /format must be one of episode, this-or-that, greeting/);
  assert.deepEqual(read(), original);
});

test("edit: a commit that fails leaves the file as it was", async () => {
  const { deps, read, original } = setup();
  deps.git = () => {
    throw new Error("index.lock exists");
  };
  const actions = createBacklogActions({ campaign: { id: "test", name: "Test Campaign", lockName: (n) => `test:${n}`, config: CONFIG }, deps });
  const res = await actions.saveIdea({ entry: { ...GOOD } });
  assert.equal(res.ok, false);
  assert.match(res.error, /left it unchanged/);
  assert.deepEqual(read(), original);
});

test("add: an entry without a reference to build from is refused", async () => {
  const { actions, repo } = setup();
  fs.writeFileSync(path.join(repo, "backlog.json"), "[]\n");
  const res = await actions.saveIdea({ entry: GOOD });
  assert.equal(res.ok, false);
  assert.match(res.error, /reference/);
});

test("lock busy: refused with the build-running message", async () => {
  const { actions, read, original, deps } = setup({
    withLock: async () => {
      throw new Error("lock test:schedule busy");
    },
  });
  for (const res of [await actions.saveIdea({ entry: GOOD }), await actions.removeIdea({ id: "a-todo" })]) {
    assert.deepEqual(res, { ok: false, error: BUSY });
  }
  assert.deepEqual(read(), original);
  assert.equal(deps.log.lines.every(([level]) => level === "error"), true);
});

test("remove: a todo entry goes, committed \"ideas: remove <id>\"", async () => {
  const { actions, entries, commits } = setup();
  const res = await actions.removeIdea({ id: "a-todo" });
  assert.equal(res.ok, true, res.error);
  assert.equal(entries().some((e) => e.id === "a-todo"), false);
  assert.equal(commits()[0], "ideas: remove a-todo");
});

test("remove: only todo", async () => {
  const { actions, read, original } = setup();
  for (const id of ["b-building", "c-awaiting", "d-approved", "e-failed", "f-redo", "g-scheduled"]) {
    const res = await actions.removeIdea({ id });
    assert.equal(res.ok, false, id);
    assert.match(res.error, new RegExp(id));
  }
  const missing = await actions.removeIdea({ id: "nope" });
  assert.equal(missing.ok, false);
  assert.deepEqual(read(), original);
});

test("the audit line holds no secret value", async () => {
  const { deps } = setup();
  deps.secretValues = ["s3cret-token"];
  const actions = createBacklogActions({ campaign: { id: "test", name: "Test Campaign", lockName: (n) => `test:${n}`, config: CONFIG }, deps });
  await actions.saveIdea({ entry: { ...GOOD, premise: "uses s3cret-token here", targetDate: "2020-01-01" } });
  assert.ok(!JSON.stringify(deps.log.lines).includes("s3cret-token"));
});
