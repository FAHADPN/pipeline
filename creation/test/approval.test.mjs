import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatSchedule, insertIntoSchedule, scheduleItem } from "../lib/insert.mjs";
import { approve, handleUpdates, poll, redoWithNote } from "../lib/approval.mjs";
import { createCreationStore, itemState, MAX_ATTEMPTS, transition } from "../lib/cstate.mjs";
import { pickWork } from "../lib/picker.mjs";

// The owner's chat, the campaign's only approver here.
const CHAT = "4242";
const SCHEDULE = "schedule.json";
const pieceDir = (id) => `pieces/${id}`;
const itemOf = (e) => scheduleItem(e, pieceDir(e.id));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

function entry(id, targetDate, over = {}) {
  return {
    id,
    kind: id.startsWith("post") ? "post" : "ep",
    format: "episode",
    type: "story",
    title: id,
    premise: "A premise.",
    targetDate,
    hook: 21,
    reference: "reel-00-intro",
    ...over,
  };
}

const BACKLOG = [
  entry("post-01-how-many", "2026-11-11"),
  entry("reel-01-launch", "2026-11-12"),
  entry("reel-02-menu", "2026-11-17", { notAfter: "2026-12-15" }),
];

const ORIGINAL = [
  { id: "reel-00-intro", kind: "ep", dir: "pieces/reel-00-intro" },
  { id: "special-new-year", kind: "special", dir: "pieces/special-new-year", on: "2026-12-30" },
];

// A postable piece: the out/ files checkItem looks for (out/ is gitignored, as in the repo).
function piece(repo, id, { video = "video" } = {}) {
  write(repo, `pieces/${id}/cues.js`, "export default {};\n");
  write(repo, `pieces/${id}/out/${id}.mp4`, video);
  write(repo, `pieces/${id}/out/${id}-cover.png`, "png");
  write(repo, `pieces/${id}/out/${id}-caption.txt`,
    "INSTAGRAM / TIKTOK\nFresh beans today.\n\nYOUTUBE SHORTS TITLE\nFresh beans\n");
}

// A small campaign folder plus its home where every backlog piece is awaiting
// approval.
function setup(t, { pieces = BACKLOG.map((e) => e.id) } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, ".gitignore", "out/\n");
  write(repo, SCHEDULE, formatSchedule(ORIGINAL));
  for (const item of ORIGINAL) write(repo, `${item.dir}/cues.js`, "export default {};\n");
  for (const id of pieces) piece(repo, id);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const store = createCreationStore(home);
  const at = "2026-10-24T20:00:00.000Z";
  store.save({ items: Object.fromEntries(BACKLOG.map((e) => [e.id, { status: "awaiting-approval", attempts: 0, at }])) });

  const telegram = fakeTelegram();
  const deps = {
    home,
    repoRoot: repo,
    approvers: [CHAT],
    ownerChatId: CHAT,
    store,
    telegram,
    backlog: BACKLOG,
    scheduleFile: SCHEDULE,
    pieceDir,
    lock: { pollMs: 1 },
  };
  return { repo, home, store, telegram, deps };
}

function fakeTelegram(updates = []) {
  const calls = [];
  return {
    calls,
    sendMessage: async (text, options) => void calls.push(["sendMessage", text, options]),
    answerCallbackQuery: async (id, text) => void calls.push(["answerCallbackQuery", id, text]),
    getUpdates: async (args) => {
      calls.push(["getUpdates", args]);
      return updates.shift() ?? [];
    },
  };
}

const commits = (repo) => git(repo, "log", "--format=%s").split("\n");

const tap = (update_id, data, chat = CHAT) => ({
  update_id,
  callback_query: { id: `cb${update_id}`, data, from: { id: Number(chat) }, message: { message_id: 1, chat: { id: Number(chat) } } },
});

const text = (update_id, body, chat = CHAT) => ({
  update_id,
  message: { message_id: update_id, chat: { id: Number(chat) }, text: body },
});

test("insert keeps original order and places by targetDate", () => {
  const items = [
    { id: "a", kind: "ep", dir: "pieces/a" },
    { id: "b", kind: "post", dir: "pieces/b", targetDate: "2026-11-11" },
    { id: "c", kind: "ep", dir: "pieces/c", on: "2026-12-30" },
    { id: "d", kind: "ep", dir: "pieces/d", targetDate: "2026-11-17" },
  ];
  const frozen = JSON.stringify(items);

  const mid = insertIntoSchedule(items, itemOf(entry("reel-01-launch", "2026-11-12")));
  assert.deepEqual(mid.map((i) => i.id), ["a", "b", "c", "reel-01-launch", "d"]);
  assert.deepEqual(mid[3], {
    id: "reel-01-launch",
    kind: "ep",
    dir: "pieces/reel-01-launch",
    targetDate: "2026-11-12",
    title: "reel-01-launch",
    type: "story",
  });
  assert.deepEqual(Object.keys(mid[3]), ["id", "kind", "dir", "targetDate", "title", "type"]);
  assert.equal(JSON.stringify(items), frozen, "the input is left alone");

  const last = insertIntoSchedule(items, itemOf(entry("reel-02-menu", "2026-11-17", { notAfter: "2026-12-15" })));
  assert.deepEqual(last.map((i) => i.id), ["a", "b", "c", "d", "reel-02-menu"], "an equal date goes after");
  assert.deepEqual(last.at(-1), { id: "reel-02-menu", kind: "ep", dir: "pieces/reel-02-menu", targetDate: "2026-11-17", title: "reel-02-menu", type: "story", notAfter: "2026-12-15" });

  const first = insertIntoSchedule(items, itemOf(entry("post-06-x", "2026-11-01", { on: "2026-11-01" })));
  assert.deepEqual(first.map((i) => i.id), ["a", "post-06-x", "b", "c", "d"]);
  assert.equal(first[1].on, "2026-11-01");

  assert.deepEqual(insertIntoSchedule(mid, itemOf(entry("reel-01-launch", "2026-11-30"))), mid, "re-inserting an id is a no-op");
  assert.deepEqual(insertIntoSchedule([], itemOf(entry("reel-01-launch", "2026-11-12"))).map((i) => i.id), ["reel-01-launch"]);
});

test("formatSchedule writes one item per line, keys in order, and reads back the same", () => {
  const text = [
    "[",
    '  { "id": "reel-00-intro", "kind": "ep", "dir": "pieces/reel-00-intro" },',
    '  { "id": "special-new-year", "kind": "special", "dir": "pieces/special-new-year", "on": "2026-12-30" },',
    '  { "id": "reel-01-launch", "kind": "ep", "dir": "pieces/reel-01-launch", "targetDate": "2026-11-12", "title": "Launch day", "type": "story" }',
    "]",
    "",
  ].join("\n");
  assert.equal(formatSchedule(JSON.parse(text)), text);
  assert.equal(formatSchedule([]), "[]\n");
});

test("approve writes schedule, commits, marks approved", async (t) => {
  const { repo, store, deps } = setup(t);
  // Something else staged by hand must not ride along in the approval commit.
  write(repo, "notes.txt", "staged by hand\n");
  git(repo, "add", "notes.txt");

  const res = await approve({ id: "reel-01-launch", deps });
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /reel-01-launch/);
  assert.match(res.message, /2026-11-12/);

  const expected = insertIntoSchedule(ORIGINAL, itemOf(BACKLOG[1]));
  assert.equal(read(repo, SCHEDULE), formatSchedule(expected));
  assert.deepEqual(commits(repo), ["content: approve reel-01-launch", "init"]);
  assert.equal(git(repo, "log", "-1", "--format=%B"), "content: approve reel-01-launch", "no attribution lines");
  assert.equal(git(repo, "show", "--format=", "--name-only", "HEAD"), SCHEDULE);
  assert.equal(git(repo, "status", "--porcelain"), "A  notes.txt", "schedule committed, the hand-staged file still staged");
  assert.equal(itemState(store.load(), "reel-01-launch").status, "approved");
  assert.equal(itemState(store.load(), "post-01-how-many").status, "awaiting-approval");

  // A second piece with an earlier date goes in front of it.
  assert.equal((await approve({ id: "post-01-how-many", deps })).ok, true);
  assert.deepEqual(JSON.parse(read(repo, SCHEDULE)).map((i) => i.id), ["reel-00-intro", "special-new-year", "post-01-how-many", "reel-01-launch"]);
});

test("approve runs under the schedule lock", async (t) => {
  const { repo, home, deps } = setup(t);
  const lockFile = path.join(home, "locks", "schedule.lock");
  write(home, "locks/schedule.lock", JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  const before = read(repo, SCHEDULE);
  let waits = 0;
  const sleep = async () => {
    waits++;
    // While someone else holds the lock, nothing has been written or committed.
    assert.equal(read(repo, SCHEDULE), before);
    assert.deepEqual(commits(repo), ["init"]);
    fs.rmSync(lockFile);
  };

  const res = await approve({ id: "reel-01-launch", deps: { ...deps, lock: { pollMs: 1, sleep } } });
  assert.equal(res.ok, true, res.message);
  assert.equal(waits, 1);
  assert.deepEqual(commits(repo), ["content: approve reel-01-launch", "init"]);
  assert.equal(fs.existsSync(lockFile), false, "the lock is released");

  // A holder that never lets go: approve gives up and changes nothing.
  write(home, "locks/schedule.lock", JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  const busy = await approve({ id: "reel-02-menu", deps: { ...deps, lock: { waitMs: 0, pollMs: 1 } } });
  assert.equal(busy.ok, false);
  assert.match(busy.message, /busy/);
  assert.equal(commits(repo).length, 2);
});

test("same Approve twice approves once", async (t) => {
  const { repo, telegram, deps } = setup(t);
  const offset = await handleUpdates({ updates: [tap(10, "approve:reel-01-launch"), tap(11, "approve:reel-01-launch")], deps });
  assert.equal(offset, 12);
  assert.deepEqual(commits(repo), ["content: approve reel-01-launch", "init"]);
  assert.equal(JSON.parse(read(repo, SCHEDULE)).filter((i) => i.id === "reel-01-launch").length, 1);

  const answers = telegram.calls.filter((c) => c[0] === "answerCallbackQuery");
  assert.deepEqual(answers.map((c) => c[1]), ["cb10", "cb11"], "every tap is answered");
  assert.match(answers[1][2], /approved/i);
  const replies = telegram.calls.filter((c) => c[0] === "sendMessage").map((c) => c[1]);
  assert.match(replies[0], /Approved reel-01-launch/);
  assert.match(replies[1], /reel-01-launch is approved, not awaiting approval/);
});

test("approve failure leaves schedule unchanged", async (t) => {
  const { repo, store, deps } = setup(t);
  const before = read(repo, SCHEDULE);
  const unchanged = () => {
    assert.equal(read(repo, SCHEDULE), before);
    assert.deepEqual(commits(repo), ["init"]);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(fs.existsSync(path.join(repo, `${SCHEDULE}.tmp`)), false);
  };

  // The piece fails checkItem.
  fs.writeFileSync(path.join(repo, "pieces/reel-01-launch/out/reel-01-launch.mp4"), "");
  let res = await approve({ id: "reel-01-launch", deps });
  assert.equal(res.ok, false);
  assert.match(res.message, /video is empty/);
  unchanged();
  assert.equal(itemState(store.load(), "reel-01-launch").status, "awaiting-approval");

  // A YouTube title over 100 characters only warns in posting, but blocks new content.
  write(repo, "pieces/reel-02-menu/out/reel-02-menu-caption.txt",
    `INSTAGRAM / TIKTOK\nFresh beans.\n\nYOUTUBE SHORTS TITLE\n${"x".repeat(101)}\n`);
  res = await approve({ id: "reel-02-menu", deps });
  assert.equal(res.ok, false);
  assert.match(res.message, /YouTube title/);
  unchanged();

  // The commit fails after the file was written: the file and the index are put back.
  const failingGit = (args, cwd) => {
    if (args[0] === "commit") throw new Error("commit failed: no identity");
    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  };
  res = await approve({ id: "post-01-how-many", deps: { ...deps, git: failingGit } });
  assert.equal(res.ok, false);
  assert.match(res.message, /commit failed/);
  unchanged();
  assert.equal(itemState(store.load(), "post-01-how-many").status, "awaiting-approval");

  // Not in the backlog, or not awaiting approval: refused with the reason.
  res = await approve({ id: "reel-99-unknown", deps });
  assert.equal(res.ok, false);
  assert.match(res.message, /not in the backlog/);
  store.save({ items: { ...store.load().items, "post-01-how-many": { status: "building", attempts: 0, at: "x" } } });
  res = await approve({ id: "post-01-how-many", deps });
  assert.equal(res.ok, false);
  assert.match(res.message, /post-01-how-many is building, not awaiting approval/);
  unchanged();
});

test("other chat ignored", async (t) => {
  const { repo, store, telegram, deps } = setup(t);
  store.save({ ...store.load(), pendingNote: "reel-01-launch" });
  const offset = await handleUpdates({
    updates: [tap(5, "approve:reel-01-launch", "999"), tap(6, "redo:reel-02-menu", "999"), text(7, "ship it all", "999")],
    deps,
  });
  assert.equal(offset, 8, "ignored updates are still skipped past");
  assert.deepEqual(telegram.calls, []);
  assert.deepEqual(commits(repo), ["init"]);
  const cstate = store.load();
  assert.equal(cstate.pendingNote, "reel-01-launch");
  assert.equal(itemState(cstate, "reel-01-launch").status, "awaiting-approval");
  assert.equal(itemState(cstate, "reel-02-menu").status, "awaiting-approval");
});

test("handleUpdates: a message from an unknown chat is recorded in telegram-seen.json (max 20, newest first) and still ignored", async (t) => {
  const { home, repo, store, telegram, deps } = setup(t);
  store.save({ ...store.load(), pendingNote: "reel-01-launch" });
  const seen = () => JSON.parse(fs.readFileSync(path.join(home, "telegram-seen.json"), "utf8")).chats;
  const from = (update_id, chat, extra = {}) => ({
    update_id,
    message: { message_id: update_id, date: 1792900000 + update_id, chat: { id: chat, type: "private", ...extra }, text: "/start" },
  });

  await handleUpdates({
    updates: [
      from(1, 555, { first_name: "Alex", last_name: "K", username: "alex_k" }),
      from(2, -100123, { type: "group", title: "<img src=x onerror=alert(1)> team" }),
      tap(3, "approve:reel-01-launch", "777"),
      from(4, 555, { first_name: "Alex", last_name: "K" }),
      text(5, "an approver's note"),
    ],
    deps,
  });
  assert.deepEqual(seen(), [
    { chatId: "555", name: "Alex K", at: new Date((1792900000 + 4) * 1000).toISOString() },
    { chatId: "777", name: null, at: seen()[1].at },
    { chatId: "-100123", name: "<img src=x onerror=alert(1)> team", at: new Date((1792900000 + 2) * 1000).toISOString() },
  ]);
  assert.ok(!seen().some((c) => c.chatId === CHAT), "an approver is never recorded");
  // Still ignored: nothing answered them, nothing approved; the approver's note was taken.
  assert.ok(!telegram.calls.some((c) => c[0] === "answerCallbackQuery"));
  assert.deepEqual(commits(repo), ["init"]);
  assert.equal(itemState(store.load(), "reel-01-launch").status, "redo");
  assert.equal(itemState(store.load(), "reel-01-launch").note, "an approver's note");

  await handleUpdates({ updates: Array.from({ length: 25 }, (_, i) => from(10 + i, 1000 + i, { first_name: "x".repeat(200) })), deps });
  const list = seen();
  assert.equal(list.length, 20);
  assert.equal(list[0].chatId, "1024", "newest first");
  assert.equal(list[19].chatId, "1005");
  assert.equal(list[0].name.length, 64, "names are cut to 64 characters");
});

test("redo asks then stores the next text as the note", async (t) => {
  const { repo, store, telegram, deps } = setup(t);
  await handleUpdates({ updates: [text(1, "hello before any redo")], deps });
  assert.deepEqual(telegram.calls, [], "a text with no redo pending is ignored");

  await handleUpdates({ updates: [tap(2, "redo:reel-01-launch")], deps });
  assert.deepEqual(telegram.calls.find((c) => c[0] === "sendMessage"), ["sendMessage", "What should change?", { forceReply: true }]);
  assert.deepEqual(telegram.calls.filter((c) => c[0] === "answerCallbackQuery").map((c) => c[1]), ["cb2"]);
  assert.equal(store.load().pendingNote, "reel-01-launch");
  assert.equal(itemState(store.load(), "reel-01-launch").status, "awaiting-approval");

  telegram.calls.length = 0;
  await handleUpdates({ updates: [text(3, "Make the hook shorter, and slower ticks.")], deps });
  const cstate = store.load();
  assert.equal(cstate.pendingNote, undefined);
  assert.equal(itemState(cstate, "reel-01-launch").status, "redo");
  assert.equal(itemState(cstate, "reel-01-launch").note, "Make the hook shorter, and slower ticks.");
  assert.match(telegram.calls[0][1], /reel-01-launch/);

  telegram.calls.length = 0;
  await handleUpdates({ updates: [text(4, "another thought")], deps });
  assert.deepEqual(telegram.calls, []);
  assert.equal(itemState(store.load(), "reel-01-launch").note, "Make the hook shorter, and slower ticks.");

  // Redo on a piece that isn't awaiting approval is refused and asks nothing.
  telegram.calls.length = 0;
  await handleUpdates({ updates: [tap(5, "redo:reel-01-launch")], deps });
  assert.equal(store.load().pendingNote, undefined);
  assert.ok(!telegram.calls.some((c) => c[1] === "What should change?"));
  assert.match(telegram.calls.find((c) => c[0] === "sendMessage")[1], /reel-01-launch is redo, not awaiting approval/);
  assert.deepEqual(commits(repo), ["init"]);
});

test("offset advances past handled updates", async (t) => {
  const { home, repo, deps } = setup(t);
  const telegram = fakeTelegram([[tap(41, "approve:reel-01-launch"), text(40, "hi")], []]);
  const d = { ...deps, telegram };

  assert.equal(await poll({ deps: d }), 42);
  assert.deepEqual(telegram.calls[0], ["getUpdates", { offset: undefined }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "telegram-offset.json"), "utf8")), { offset: 42 });
  assert.deepEqual(commits(repo), ["content: approve reel-01-launch", "init"]);

  assert.equal(await poll({ deps: d }), 42, "no updates keeps the offset");
  assert.deepEqual(telegram.calls.filter((c) => c[0] === "getUpdates")[1], ["getUpdates", { offset: 42 }]);

  // A handler that throws doesn't stop the batch or hold the offset back.
  const broken = { ...deps, telegram: { ...fakeTelegram(), answerCallbackQuery: async () => { throw new Error("query is too old"); } } };
  assert.equal(await handleUpdates({ updates: [tap(50, "nonsense"), tap(51, "approve:reel-02-menu")], offset: 42, deps: broken }), 52);
  assert.equal(commits(repo)[0], "content: approve reel-02-menu");
  assert.equal(await handleUpdates({ updates: [], offset: 52, deps }), 52);
});

test("redoWithNote: an empty note or one over 500 characters is refused", async (t) => {
  const { store, deps } = setup(t);
  for (const text of ["", "   \n ", "x".repeat(501), undefined]) {
    const res = await redoWithNote({ id: "reel-01-launch", text, deps });
    assert.equal(res.ok, false, JSON.stringify(text));
    assert.match(res.message, /note/);
  }
  assert.equal(itemState(store.load(), "reel-01-launch").status, "awaiting-approval");

  // 500 characters once trimmed is fine, and stored trimmed. A Telegram redo waiting
  // for its note on the same piece is cleared.
  store.save({ ...store.load(), pendingNote: "reel-01-launch" });
  const res = await redoWithNote({ id: "reel-01-launch", text: `  ${"y".repeat(500)}\n`, deps });
  assert.equal(res.ok, true, res.message);
  const cstate = store.load();
  assert.equal(cstate.pendingNote, undefined);
  assert.equal(itemState(cstate, "reel-01-launch").status, "redo");
  assert.equal(itemState(cstate, "reel-01-launch").note, "y".repeat(500));
});

test("redoWithNote: a failed piece goes to redo, keeping its attempts; a todo piece is refused", async (t) => {
  const { store, deps } = setup(t);
  const at = "2026-10-24T20:00:00.000Z";
  store.save({ items: { ...store.load().items, "reel-02-menu": { status: "failed", attempts: MAX_ATTEMPTS, reason: "review said FIX twice", at } } });
  assert.deepEqual(pickWork({ backlog: BACKLOG, cstate: store.load(), onlyId: "reel-02-menu" }), [], "parked: not buildable as it is");
  let res = await redoWithNote({ id: "reel-02-menu", text: "Slower ending.", deps });
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /reel-02-menu/);
  const redo = itemState(store.load(), "reel-02-menu");
  assert.equal(redo.status, "redo");
  assert.equal(redo.attempts, 2);
  assert.equal(redo.note, "Slower ending.");
  // Parked at MAX_ATTEMPTS, a redo gets one more build: the picker takes it by hand,
  // and it can move to building.
  assert.deepEqual(pickWork({ backlog: BACKLOG, cstate: store.load(), onlyId: "reel-02-menu" }), ["reel-02-menu"]);
  assert.equal(itemState(transition(store.load(), "reel-02-menu", "building"), "reel-02-menu").status, "building");

  store.save({ items: { ...store.load().items, "reel-01-launch": { status: "todo", attempts: 0, at } } });
  res = await redoWithNote({ id: "reel-01-launch", text: "Anything.", deps });
  assert.equal(res.ok, false);
  assert.match(res.message, /reel-01-launch is todo/);
  assert.equal(itemState(store.load(), "reel-01-launch").status, "todo");
});
