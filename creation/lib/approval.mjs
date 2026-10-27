// The approvers' Approve and Redo taps on Telegram. Only an Approve puts a piece in
// the campaign's schedule.json: under the "schedule" lock it inserts the item, runs
// the posting checks, writes the file atomically and commits it (`content: approve
// <id>`). Any failure puts the file back as it was. A Redo asks "What should change?"
// and the chat's next text becomes the note. Updates from any other chat are ignored,
// but the chat is recorded in <home>/telegram-seen.json (the last 20, newest first),
// so the console can offer it as an approver.
//
// creation-state.json is read and written under its own short "creation-state" lock,
// always taken after "schedule", so the poller and the nightly run never lose each
// other's update.
//
// deps (campaign-deps.mjs) = { home, repoRoot, store (createCreationStore), telegram,
//          backlog: Entry[], approvers (the chats that may approve), telegramFor?(chatId)
//          (the bot, talking to that chat), ownerChatId and alerts (the owner chat),
//          scheduleFile (relative to repoRoot), pieceDir(id), withLock?(name, fn,
//          options), git?(args, cwd), check?, lock? (withLock options), log? }
// Every action returns { ok, message }; the message is what the chat is told.
// redoWithNote is the console's redo: the note comes with it, and no chat is told.
//
// A note from an approver who isn't the owner is a client's: it's screened
// (client-text.mjs), fenced as data when it's accepted, and the owner gets a copy. A
// client whose tap fails is told so plainly; the details go to the owner.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withLock } from "../../publishing/lib/lock.mjs";
import { validateSchedule } from "../../publishing/lib/schedule.mjs";
import { checkItem } from "../../publishing/lib/content.mjs";
import { fenceClientText, screenClientText } from "./client-text.mjs";
import { itemState, transition } from "./cstate.mjs";
import { formatSchedule, insertIntoSchedule, scheduleItem } from "./insert.mjs";

const OFFSET_FILE = "telegram-offset.json";
const SEEN_FILE = "telegram-seen.json";
const SEEN_KEPT = 20;
const SEEN_NAME_MAX = 64;
const BUTTON = /^(approve|redo):([a-z0-9-]+)$/;
const MAX_ANSWER = 200; // Telegram's limit for a callback answer

// A git that hangs (a credential prompt, a stuck index lock) fails instead of holding the lock.
const GIT_TIMEOUT_MS = 30000;
const defaultGit = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: GIT_TIMEOUT_MS });

const refuse = (message) => ({ ok: false, message });

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const lockOf = (deps) => deps.withLock ?? ((name, fn, options) => withLock(deps.home, name, fn, options));

// Load, change and save creation-state.json under its lock. fn returns
// { cstate?, result }; cstate is saved only when given.
function updateCState(deps, fn) {
  return lockOf(deps)("creation-state", () => {
    const { cstate, result } = fn(deps.store.load());
    if (cstate) deps.store.save(cstate);
    return result;
  }, deps.lock);
}

function notAwaiting(cstate, id) {
  const { status } = itemState(cstate, id);
  return status === "awaiting-approval" ? null : `${id} is ${status}, not awaiting approval`;
}

export async function approve({ id, deps }) {
  try {
    return await lockOf(deps)("schedule", () => updateCState(deps, (cstate) => approveLocked(id, cstate, deps)), deps.lock);
  } catch (err) {
    return refuse(`${id}: ${err.message}`);
  }
}

function approveLocked(id, cstate, deps) {
  const { repoRoot, git = defaultGit, check = checkItem, scheduleFile } = deps;
  const entry = deps.backlog.find((e) => e.id === id);
  if (!entry) return { result: refuse(`${id} is not in the backlog`) };
  const why = notAwaiting(cstate, id);
  if (why) return { result: refuse(why) };

  const file = path.join(repoRoot, scheduleFile);
  const original = fs.readFileSync(file, "utf8");
  const items = JSON.parse(original.replace(/^﻿/, ""));
  // Already there means an earlier approve committed but couldn't save the state.
  const already = items.some((item) => item.id === id);
  if (!already) {
    const item = scheduleItem(entry, deps.pieceDir(entry.id));
    const next = insertIntoSchedule(items, item);
    const errors = validateSchedule(next, repoRoot);
    if (errors.length) return { result: refuse(`${id} can't be queued: ${errors.join("; ")}`) };
    // New content has no YouTube-only exception: a warning blocks too.
    const checked = check(repoRoot, item);
    const problems = [...(checked.errors ?? []), ...(checked.warnings ?? [])];
    if (problems.length) return { result: refuse(`${id} can't be queued: ${problems.join("; ")}`) };

    let text = formatSchedule(next);
    if (original.includes("\r\n")) text = text.replace(/\n/g, "\r\n");
    writeAtomic(file, text);
    try {
      git(["add", "--", scheduleFile], repoRoot);
      // The pathspec keeps anything else that happens to be staged out of this commit.
      git(["commit", "-q", "-m", `content: approve ${id}`, "--", scheduleFile], repoRoot);
    } catch (err) {
      writeAtomic(file, original);
      try {
        git(["reset", "-q", "--", scheduleFile], repoRoot);
      } catch {
        // The file is back; a stale index entry is harmless.
      }
      return { result: refuse(`${id}: couldn't commit the schedule, left it unchanged: ${err.message}`) };
    }
  }

  const { pendingNote, ...rest } = cstate;
  const approved = transition(pendingNote === id ? rest : cstate, id, "approved");
  const message = already
    ? `${id} was already in the schedule; marked approved.`
    : `Approved ${id}: queued for ${entry.targetDate} and committed.`;
  return { cstate: approved, result: { ok: true, message } };
}

export function requestRedo({ id, deps }) {
  return updateCState(deps, (cstate) => {
    const why = notAwaiting(cstate, id);
    if (why) return { result: refuse(why) };
    return { cstate: { ...cstate, pendingNote: id }, result: { ok: true, message: "What should change?" } };
  });
}

export function takeNote({ text, deps }) {
  return updateCState(deps, (cstate) => {
    const { pendingNote: id, ...rest } = cstate;
    if (!id) return { result: refuse("no redo is waiting for a note") };
    const why = notAwaiting(rest, id);
    if (why) return { cstate: rest, result: refuse(`${why}; note dropped`) };
    return {
      cstate: transition(rest, id, "redo", { note: text.trim() }),
      result: { ok: true, message: `Got it. ${id} goes back for a redo with your note.` },
    };
  });
}

const MAX_NOTE = 500;
const REDOABLE = ["awaiting-approval", "failed"];

// The console's Redo with a note: an awaiting or failed piece goes back for a redo with
// the owner's note, trimmed, 1 to 500 characters. The owner wrote it, so it isn't
// screened. A Telegram redo still waiting for its note on the same piece is dropped.
export async function redoWithNote({ id, text, deps }) {
  const note = typeof text === "string" ? text.trim() : "";
  if (!note) return refuse("the note is empty; say what should change");
  if (note.length > MAX_NOTE) return refuse(`the note is ${note.length} characters; keep it to ${MAX_NOTE}`);
  return updateCState(deps, (cstate) => {
    if (!deps.backlog.some((e) => e.id === id)) return { result: refuse(`${id} is not in the backlog`) };
    const { status } = itemState(cstate, id);
    if (!REDOABLE.includes(status)) return { result: refuse(`${id} is ${status}; only a piece awaiting approval or failed can be redone`) };
    const { pendingNote, ...rest } = cstate;
    return {
      cstate: transition(pendingNote === id ? rest : cstate, id, "redo", { note }),
      result: { ok: true, message: `${id} goes back for a redo with your note.` },
    };
  });
}

// The chats in <home>/telegram-seen.json, newest first: [{ chatId, name, at }]. A
// missing or unreadable file is no chats.
export function loadSeenChats(home) {
  try {
    const { chats } = JSON.parse(fs.readFileSync(path.join(home, SEEN_FILE), "utf8").replace(/^﻿/, ""));
    return Array.isArray(chats) ? chats : [];
  } catch {
    return [];
  }
}

// A chat's name as Telegram gives it: a group's title, or a person's name or username.
function chatName(chat) {
  const person = [chat.first_name, chat.last_name].filter((s) => typeof s === "string" && s).join(" ");
  const name = [chat.title, person, chat.username].find((s) => typeof s === "string" && s.trim());
  return name ? name.trim().slice(0, SEEN_NAME_MAX) : null;
}

// Puts `chat` first in the seen list, once, keeping the newest SEEN_KEPT. `date` is the
// message's, in Unix seconds, when it has one.
function recordSeen(home, chat, date) {
  const chatId = String(chat.id);
  const at = (Number.isInteger(date) ? new Date(date * 1000) : new Date()).toISOString();
  const chats = [{ chatId, name: chatName(chat), at }, ...loadSeenChats(home).filter((c) => c?.chatId !== chatId)];
  fs.mkdirSync(home, { recursive: true });
  writeAtomic(path.join(home, SEEN_FILE), JSON.stringify({ chats: chats.slice(0, SEEN_KEPT) }, null, 2) + "\n");
}

// Returns the next offset: one past the last update seen, handled or ignored.
export async function handleUpdates({ updates, offset, deps }) {
  let next = offset;
  for (const update of updates) {
    if (Number.isInteger(update?.update_id)) next = Math.max(next ?? 0, update.update_id + 1);
    try {
      await handleOne(update, deps);
    } catch (err) {
      deps.log?.error("telegram update failed", { update_id: update?.update_id, error: err.message });
    }
  }
  return next;
}

async function handleOne(update, deps) {
  const { telegram } = deps;
  const approvers = deps.approvers.map(String);
  const fromUs = (chat) => chat?.id !== undefined && approvers.includes(String(chat.id));
  // Any approver but the owner chat is a client.
  const isClient = (chat) => String(chat.id) !== String(deps.ownerChatId);
  const replyTo = (chat) => (deps.telegramFor ? deps.telegramFor(chat.id) : telegram);
  const safely = async (fn) => {
    try {
      await fn();
    } catch (err) {
      deps.log?.error("telegram reply failed", { error: err.message });
    }
  };
  const toOwner = (text) => safely(() => deps.alerts.sendMessage(text));
  // Another chat is recorded, never answered. A failed write loses only the record.
  const stranger = (chat, date) => {
    if (chat?.id === undefined) return;
    try {
      recordSeen(deps.home, chat, date);
    } catch (err) {
      deps.log?.error("telegram-seen write failed", { error: err.message });
    }
  };

  const query = update?.callback_query;
  if (query) {
    const chat = query.message?.chat;
    if (!fromUs(chat)) return stranger(chat, query.message?.date);
    const [, action, id] = BUTTON.exec(query.data ?? "") ?? [];
    let res;
    if (action === "approve") res = await approve({ id, deps });
    else if (action === "redo") res = await requestRedo({ id, deps });
    else res = refuse(`unknown button: ${query.data}`);
    let shown = res.message;
    if (!res.ok && isClient(chat)) {
      shown = `${id ? `${id}: that` : "That"} didn't go through. The team has been told.`;
      await toOwner(`${res.message} (from chat ${chat.id})`);
    }
    await safely(() => telegram.answerCallbackQuery(query.id, shown.slice(0, MAX_ANSWER)));
    const reply = replyTo(chat);
    if (action === "redo" && res.ok) await reply.sendMessage("What should change?", { forceReply: true });
    else await reply.sendMessage(shown);
    return;
  }

  const message = update?.message;
  if (!message) return;
  if (!fromUs(message.chat)) return stranger(message.chat, message.date);
  if (typeof message.text !== "string" || !message.text.trim()) return;
  const pending = deps.store.load().pendingNote;
  if (!pending) return;
  const reply = replyTo(message.chat);
  if (!isClient(message.chat)) {
    const res = await takeNote({ text: message.text, deps });
    await reply.sendMessage(res.message);
    return;
  }

  const from = `a client note on ${pending} from chat ${message.chat.id}`;
  const screened = screenClientText(message.text);
  if (screened.held) {
    await toOwner(`Held ${from} (${screened.reason}). It didn't go to the build:\n\n${message.text}`);
    await reply.sendMessage("Thanks. That note needs a quick check by the team before it goes into the build; they'll follow up.");
    return;
  }
  if (!screened.ok) {
    await toOwner(`Refused ${from}: ${screened.reason}.`);
    await reply.sendMessage(`That note wasn't used: ${screened.reason}. Please send a shorter one.`);
    return;
  }
  const res = await takeNote({ text: fenceClientText(screened.text), deps });
  if (res.ok) await toOwner(`Client note on ${pending} from chat ${message.chat.id}, going into the build:\n\n${screened.text}`);
  await reply.sendMessage(res.message);
}

export async function poll({ deps }) {
  const file = path.join(deps.home, OFFSET_FILE);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")).offset : undefined;
  const updates = await deps.telegram.getUpdates({ offset: saved });
  const offset = await handleUpdates({ updates, offset: saved, deps });
  if (offset !== saved) {
    fs.mkdirSync(deps.home, { recursive: true });
    writeAtomic(file, JSON.stringify({ offset }) + "\n");
  }
  return offset;
}
