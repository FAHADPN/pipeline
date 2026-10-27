import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editSchedule } from "../lib/schedule-edit.mjs";

const SCHEDULE = "publishing/schedule.json";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const realGit = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

// A temp git repo whose schedule holds a and b, written as `text(items)`, committed.
function setup({ eol = "\n" } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-edit-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  const items = ["a", "b"].map((id) => ({ id, kind: "ep", dir: `pieces/${id}` }));
  for (const item of items) fs.mkdirSync(path.join(repo, item.dir), { recursive: true });
  fs.writeFileSync(path.join(repo, "pieces", "a", "keep.txt"), "x");
  fs.writeFileSync(path.join(repo, "pieces", "b", "keep.txt"), "x");
  fs.mkdirSync(path.join(repo, "publishing"));
  const text = `[\n  ${items.map((i) => JSON.stringify(i)).join(",\n  ")}\n]\n`.replace(/\n/g, eol);
  fs.writeFileSync(path.join(repo, SCHEDULE), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, file: path.join(repo, SCHEDULE), original: fs.readFileSync(path.join(repo, SCHEDULE)) };
}

const commits = (repo) => git(repo, "log", "--format=%s").split("\n");
const hold = (id) => (items) => items.map((i) => (i.id === id ? { ...i, hold: true } : i));

test("editSchedule: writes the change and commits only the schedule", () => {
  const { repo, file } = setup();
  fs.writeFileSync(path.join(repo, "notes.txt"), "mine");
  git(repo, "add", "notes.txt");

  const res = editSchedule({ root: repo, scheduleFile: SCHEDULE, git: realGit, message: "queue: hold a", change: hold("a") });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((i) => i.hold), [true, undefined]);
  assert.deepEqual(commits(repo), ["queue: hold a", "init"]);
  assert.equal(git(repo, "log", "-1", "--format=%B"), "queue: hold a");
  assert.equal(git(repo, "show", "--format=", "--name-only", "HEAD"), SCHEDULE);
  assert.equal(git(repo, "status", "--porcelain"), "A  notes.txt", "the hand-staged file stays staged");
});

test("editSchedule: a failed commit restores the file byte for byte and resets the index", () => {
  const { repo, file, original } = setup({ eol: "\r\n" });
  const failingGit = (args, cwd) => {
    if (args[0] === "commit") throw new Error("hook said no");
    return realGit(args, cwd);
  };
  const res = editSchedule({ root: repo, scheduleFile: SCHEDULE, git: failingGit, message: "queue: hold a", change: hold("a") });
  assert.equal(res.ok, false);
  assert.match(res.error, /couldn't commit the schedule, left it unchanged: hook said no/);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(git(repo, "diff", "--cached", "--name-only"), "", "nothing left staged");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.deepEqual(commits(repo), ["init"]);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test("editSchedule: CRLF line endings are kept", () => {
  const { repo, file } = setup({ eol: "\r\n" });
  const res = editSchedule({ root: repo, scheduleFile: SCHEDULE, git: realGit, message: "queue: hold b", change: hold("b") });
  assert.equal(res.ok, true);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("\r\n"));
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, "every line ends in CRLF");
  assert.equal(JSON.parse(text)[1].hold, true);

  // An LF file stays LF.
  const lf = setup();
  editSchedule({ root: lf.repo, scheduleFile: SCHEDULE, git: realGit, message: "queue: hold b", change: hold("b") });
  assert.equal(fs.readFileSync(lf.file, "utf8").includes("\r"), false);
});

test("editSchedule: a change that fails validateSchedule writes nothing", () => {
  const { repo, file, original } = setup();
  const calls = [];
  const spyGit = (args, cwd) => {
    calls.push(args);
    return realGit(args, cwd);
  };
  const res = editSchedule({
    root: repo,
    scheduleFile: SCHEDULE,
    git: spyGit,
    message: "queue: pin a",
    change: (items) => items.map((i) => (i.id === "a" ? { ...i, on: "2026-02-30" } : i)),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /on is not a real YYYY-MM-DD date/);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(calls, [], "git is never run");
  assert.deepEqual(commits(repo), ["init"]);
});

test("editSchedule: a change that leaves the file as it is commits nothing", () => {
  const { repo } = setup();
  editSchedule({ root: repo, scheduleFile: SCHEDULE, git: realGit, message: "queue: hold a", change: hold("a") });
  const res = editSchedule({ root: repo, scheduleFile: SCHEDULE, git: realGit, message: "queue: reorder a", change: (items) => items });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(commits(repo), ["queue: hold a", "init"]);
});

test("editSchedule: a change that throws is the refusal, and nothing is written", () => {
  const { repo, file, original } = setup();
  const res = editSchedule({
    root: repo,
    scheduleFile: SCHEDULE,
    git: realGit,
    message: "queue: hold a",
    change: () => {
      throw new Error("a is already held");
    },
  });
  assert.deepEqual(res, { ok: false, error: "a is already held" });
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(commits(repo), ["init"]);
});
