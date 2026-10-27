// The nightly build run, under the campaign's "creation" lock. It picks tonight's
// pieces, and for each piece runs a fenced build session, checks the session touched
// only the piece's folder (reverting and alerting if not), runs the automatic checks,
// then the fresh-eyes review. A SHIP goes to the approvers on Telegram with Approve
// and Redo buttons and waits for them. A FIX gets one automatic fix round with the
// review's must-fix list as the note; a second FIX fails the piece. Each piece is
// wrapped on its own, so one crash never stops the next. The night ends with a
// summary to the owner chat.
//
// The session and its verify also hold the "schedule" lock: an approval committed
// mid-session would otherwise show up in the session's diff as a change outside its
// folder, and be reverted with it. creation-state.json is changed under the same
// short "creation-state" lock the approval handler uses. A piece moved to building is
// taken out of the campaign's build queue (build-queue.mjs), so it never builds twice.
//
// deps (campaign-deps.mjs) = { name, home, repoRoot, store (createCreationStore),
//          telegram (the approvers), alerts (the owner chat), backlog, brief,
//          references, pieceDir(id), withLock?(name, fn, options), lock? (withLock
//          options), log?, rm? (fs.rmSync), and the steps: snapshot, buildPrompt,
//          runSession, verifySession, revertSession, runChecks, runReview, checkItem? }
// checkItem left out is the posting check (publishing/lib/content.mjs). The violation
// alerts and the summary, with their failure reasons, go to the owner chat only.
//
// runRecheck re-runs the checks and the review on a piece that is already built, with
// no build session, under the same locks.

import fs from "node:fs";
import path from "node:path";
import { checkItem } from "../../publishing/lib/content.mjs";
import { istDate, weekday } from "../../publishing/lib/dates.mjs";
import { withLock } from "../../publishing/lib/lock.mjs";
import { dropQueued } from "./build-queue.mjs";
import { CREATION_STALE_MS } from "./constants.mjs";
import { itemState, transition } from "./cstate.mjs";
import { PICKER_DEFAULTS, pickWork } from "./picker.mjs";
import { checksFilePath, reviewFilePath } from "./review.mjs";

export { CREATION_STALE_MS };
const MAX_CAPTION = 1024;
const INTERRUPTED = "interrupted: the run building it stopped before it finished";

const STEP_NAMES = ["snapshot", "buildPrompt", "runSession", "verifySession", "revertSession", "runChecks", "runReview", "checkItem"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-12" → "Thu 12 Nov"
function dayName(date) {
  const [, m, d] = date.split("-").map(Number);
  return `${weekday(date)} ${d} ${MONTHS[m - 1]}`;
}

const lastLine = (s) => String(s ?? "").trim().split(/\r?\n/).pop() ?? "";
const firstLine = (s) => String(s ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";

// Cut to max UTF-16 units without leaving half an emoji at the end.
function cut(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.max(0, max - 1));
  return `${/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head}…`;
}

const lockOf = (deps) => deps.withLock ?? ((name, fn, options) => withLock(deps.home, name, fn, options));
// The "creation" lock of a build that crashed is taken over as soon as its process is
// gone, so it never blocks the next run (the console and the build queue read it the
// same way). Every other lock keeps the age rule.
const creationLockOptions = (deps) => ({ staleMs: CREATION_STALE_MS, ...deps.lock, takeoverDeadPid: true, log: deps.log });

// Load, change and save creation-state.json under its lock. fn returns the new
// CState, or the same object for no change.
function updateCState(deps, fn) {
  return lockOf(deps)("creation-state", () => {
    const cstate = deps.store.load();
    const next = fn(cstate);
    if (next !== cstate) deps.store.save(next);
    return next;
  }, deps.lock);
}

const verdictOf = (x) => (typeof x === "string" ? x : x?.verdict ?? "?");
const withNumber = (x, key) => (x && typeof x === "object" && x[key] != null ? `${verdictOf(x)} ${x[key]}` : verdictOf(x));

function lensLine(scores) {
  const s = scores ?? {};
  const n = (v) => v ?? "?";
  return `Lenses: director ${n(s.director)} · copy/art/UI ${n(s.copy_art_ui)} · brand ${n(s.brand)} · forensics ${n(s.forensics)}`;
}

function skillsLine(skills) {
  const s = skills ?? {};
  return `Skills: caption.py ${verdictOf(s.caption_py)} · detect ${withNumber(s.detect_caption, "human_score")}`
    + ` (on screen ${withNumber(s.detect_onscreen, "human_score")}) · hook ${withNumber(s.hook_caption, "score")}`
    + ` (on screen ${withNumber(s.hook_onscreen, "score")})`;
}

// The sendVideo caption (≤ 1024 characters): title, planned date, the review's
// summary, lens scores and skill verdicts, then the caption and YouTube title. When
// the caption doesn't fit, only its first line is shown and the whole caption goes in
// followUp. A long review summary is cut before the caption's first line ever is.
export function approvalCaption({ entry, review, caption }) {
  const ig = caption.instagram ?? "";
  const title = `YouTube: ${caption.youtubeTitle ?? ""}`;
  const compose = (summary, body) =>
    [entry.title, `Planned: ${dayName(entry.targetDate)} · ${entry.id}`, summary, lensLine(review.scores), skillsLine(review.skills)]
      .filter(Boolean).join("\n") + `\n\n${body}`;

  const summary = review.summary ?? "";
  let body = `${ig}\n\n${title}`;
  let followUp;
  if (compose(summary, body).length > MAX_CAPTION) {
    body = `${firstLine(ig)}\n(full caption below)`;
    followUp = `Caption for ${entry.id}:\n\n${ig}\n\n${title}`;
  }
  let text = compose(summary, body);
  if (text.length > MAX_CAPTION) {
    const room = summary.length - (text.length - MAX_CAPTION);
    text = compose(room > 1 ? cut(summary, room) : "", body);
  }
  return followUp ? { caption: text, followUp } : { caption: text };
}

function fixNote(review, userNote) {
  const items = review.must_fix?.length ? review.must_fix : [review.summary || "the review gave no details; recheck the piece against its rules"];
  const out = ["The fresh-eyes review sent this build back. Fix every item:", ...items.map((m) => `- ${m}`)];
  if (userNote?.trim()) out.push("", "The user's note on this piece still applies:", userNote.trim());
  return out.join("\n");
}

// The night's summary for the owner chat, headed with the campaign's name.
export function formatSummary({ today, built, failed, notes = [], skipped, backlog, cstate, name }) {
  const out = [`${name} builds · ${dayName(today)}`];
  if (skipped) out.push(`Nothing to build tonight: ${skipped}.`);
  for (const id of built) out.push(`✅ Sent for approval: ${id}`);
  for (const { id, reason } of failed) {
    const needsYou = itemState(cstate, id).status === "failed" && itemState(cstate, id).attempts >= 2 ? " (needs you now)" : "";
    out.push(`❌ ${id}: ${reason}${needsYou}`);
  }
  for (const n of notes) out.push(`⚠️ ${n}`);
  const statuses = backlog.map((e) => itemState(cstate, e.id).status);
  const awaiting = statuses.filter((s) => s === "awaiting-approval").length;
  const left = statuses.filter((s) => s !== "awaiting-approval" && s !== "approved").length;
  out.push(`Awaiting approval: ${awaiting} · Left to build: ${left}`);
  return out.join("\n");
}

// One session plus its verify. Returns { ok: false, reason } or { ok: true, review }.
async function buildRound(entry, note, ctx) {
  const { deps, steps } = ctx;
  const { repoRoot, home } = deps;
  const id = entry.id;

  const { before, session, sessionError, verdict } = await lockOf(deps)("schedule", async () => {
    const before = steps.snapshot({ repoRoot, home });
    const prompt = steps.buildPrompt({ entry, brief: ctx.brief, references: ctx.references, redoNote: note });
    let session;
    let sessionError;
    try {
      session = await steps.runSession({ prompt, cwd: repoRoot });
    } catch (err) {
      sessionError = err;
    }
    // Verified even when the session failed: it may have changed things before it stopped.
    const verdict = steps.verifySession({ repoRoot, home, before, entryId: id });
    if (!verdict.ok) steps.revertSession({ repoRoot, before, entryId: id });
    return { before, session, sessionError, verdict };
  }, deps.lock);

  if (!verdict.ok) {
    const alert = [`⚠️ ${id}: the build session changed what it must not. Reverted to ${String(before.head).slice(0, 7)} and failed the piece:`,
      ...verdict.violations.map((v) => `- ${v}`)].join("\n");
    try {
      await deps.alerts.sendMessage(alert);
    } catch (err) {
      deps.log?.error("violation alert failed", { id, error: err.message });
    }
    return { ok: false, reason: `session broke the rules, reverted: ${verdict.violations.join("; ")}` };
  }
  if (sessionError) return { ok: false, reason: `session did not run: ${sessionError.message}` };
  if (session.timedOut) return { ok: false, reason: "session timed out and was killed" };
  if (session.code !== 0) {
    return { ok: false, reason: `session exited ${session.code}: ${cut(lastLine(session.output), 200) || "no output"}` };
  }

  const checks = await steps.runChecks({ repoRoot, entry });
  if (!checks.ok) return { ok: false, reason: `checks failed: ${checks.failures.join("; ")}` };
  const review = await steps.runReview({ entryId: id, cwd: repoRoot, raw: checks.raw });
  return { ok: true, review };
}

async function sendForApproval(entry, review, ctx) {
  const { deps, steps } = ctx;
  const checked = steps.checkItem(deps.repoRoot, { id: entry.id, kind: entry.kind, dir: deps.pieceDir(entry.id) });
  if (!checked.ok) throw new Error(`can't send for approval: ${checked.errors.join("; ")}`);
  const { caption, followUp } = approvalCaption({ entry, review, caption: checked.caption });
  await deps.telegram.sendVideo({
    path: checked.assets.video,
    caption,
    keyboard: [[
      { text: "Approve", callback_data: `approve:${entry.id}` },
      { text: "Redo", callback_data: `redo:${entry.id}` },
    ]],
  });
  if (followUp) {
    try {
      await deps.telegram.sendMessage(followUp);
    } catch (err) {
      // The video and its buttons went out; the piece still waits for the user.
      deps.log?.error("caption follow-up failed", { id: entry.id, error: err.message });
    }
  }
}

// A retry of a failed piece starts from why it failed, so the session changes the
// build its folder holds instead of repeating it. A redo gets the user's note as is.
function firstNote(prev, userNote) {
  if (prev.status !== "failed" || !prev.reason?.trim()) return userNote;
  const out = [`Previous attempt failed automatic checks or review: ${prev.reason.trim()}`];
  if (userNote?.trim()) out.push("", "The user's note on this piece still applies:", userNote.trim());
  return out.join("\n");
}

// The reviewer's files (<id>.checks.json, <id>.review.json) belong to one attempt: once
// a new build starts, an earlier attempt's checks and verdict must not look current if
// this one stops before its review. A file that can't be removed (an antivirus or the
// indexer holding it) is logged and left: this attempt's review overwrites it.
function clearReviewFiles(deps, id) {
  const rm = deps.rm ?? fs.rmSync;
  for (const file of [checksFilePath(deps.repoRoot, id), reviewFilePath(deps.repoRoot, id)]) {
    try {
      rm(file, { force: true });
    } catch (err) {
      deps.log?.error("review file not removed", { id, file, error: err.message });
    }
  }
}

// Returns { ok: true } once the piece is on Telegram, else { ok: false, reason }.
async function buildPiece(entry, ctx) {
  let prev;
  const cstate = await updateCState(ctx.deps, (c) => {
    prev = itemState(c, entry.id);
    return transition(c, entry.id, "building");
  });
  // Queued by hand too: this build is that one, so the queue mustn't start it again.
  try {
    await dropQueued({ ...ctx.deps, withLock: lockOf(ctx.deps) }, entry.id);
  } catch (err) {
    ctx.deps.log?.error("build queue: not updated", { id: entry.id, error: err.message });
  }
  clearReviewFiles(ctx.deps, entry.id);
  const userNote = itemState(cstate, entry.id).note;

  let round = await buildRound(entry, firstNote(prev, userNote), ctx);
  if (!round.ok) return round;
  if (round.review.verdict !== "SHIP") {
    round = await buildRound(entry, fixNote(round.review, userNote), ctx);
    if (!round.ok) return { ok: false, reason: `fix round: ${round.reason}` };
    if (round.review.verdict !== "SHIP") {
      return { ok: false, reason: `review said FIX twice. Must fix: ${round.review.must_fix.join("; ")}` };
    }
  }
  await sendForApproval(entry, round.review, ctx);
  return { ok: true };
}

export async function runNightly({
  now = new Date(),
  onlyId,
  maxBuilds = PICKER_DEFAULTS.maxBuilds,
  maxAwaiting = PICKER_DEFAULTS.maxAwaiting,
  formats = PICKER_DEFAULTS.formats,
  deps,
}) {
  let entered = false;
  try {
    return await lockOf(deps)("creation", () => {
      entered = true;
      return night({ now, onlyId, maxBuilds, maxAwaiting, formats, deps });
    }, creationLockOptions(deps));
  } catch (err) {
    if (entered) throw err;
    if (err.code !== "ELOCKBUSY") {
      // A lock file that can't be used is no other run: nothing to re-queue behind.
      deps.log?.error("nightly skipped", { error: err.message });
      return { built: [], failed: [], skipped: `the creation lock couldn't be taken (${err.message})` };
    }
    deps.log?.info("nightly skipped", { error: err.message });
    // lockBusy: a run by hand re-queues its piece (create.mjs).
    return { built: [], failed: [], skipped: `another build run holds the creation lock (${err.message})`, lockBusy: true };
  }
}

function stepsFrom(deps) {
  const steps = { checkItem };
  for (const name of STEP_NAMES) if (deps[name]) steps[name] = deps[name];
  return steps;
}

async function night({ now, onlyId, maxBuilds, maxAwaiting, formats, deps }) {
  const steps = stepsFrom(deps);
  const { backlog } = deps;
  const today = istDate(now);
  const built = [];
  const failed = [];
  const notes = [];

  const summarize = async (skipped) => {
    const text = formatSummary({ today, built, failed, notes, skipped, backlog, cstate: deps.store.load(), name: deps.name });
    try {
      await deps.alerts.sendMessage(text);
    } catch (err) {
      deps.log?.error("nightly: summary not sent", { error: err.message });
    }
  };

  // Only one run builds at a time, so anything still "building" was left by a crash.
  let interrupted = [];
  const cstate = await updateCState(deps, (c) => {
    interrupted = Object.keys(c.items).filter((id) => c.items[id].status === "building");
    return interrupted.reduce((acc, id) => transition(acc, id, "failed", { reason: INTERRUPTED }), c);
  });
  for (const id of interrupted) notes.push(`${id} was left building by a run that stopped; marked failed`);

  const ids = pickWork({ backlog, cstate, maxBuilds, maxAwaiting, formats, onlyId });
  if (!ids.length) {
    const awaiting = Object.values(cstate.items).filter((i) => i.status === "awaiting-approval").length;
    let skipped;
    if (onlyId !== undefined) skipped = `${onlyId} can't be built now (${itemState(cstate, onlyId).status})`;
    else if (awaiting >= maxAwaiting) skipped = `${awaiting} await approval`;
    else skipped = "nothing left that the nightly run can build";
    await summarize(skipped);
    return { built, failed, skipped };
  }

  const ctx = { deps, steps, brief: deps.brief, references: deps.references };
  for (const id of ids) {
    const entry = backlog.find((e) => e.id === id);
    let result;
    try {
      result = await buildPiece(entry, ctx);
      if (result.ok) await updateCState(deps, (c) => transition(c, id, "awaiting-approval"));
    } catch (err) {
      result = { ok: false, reason: `crashed: ${err.message}` };
    }
    if (result.ok) {
      built.push(id);
      deps.log?.info("nightly: sent for approval", { id });
      continue;
    }
    failed.push({ id, reason: result.reason });
    deps.log?.error("nightly: piece failed", { id, reason: result.reason });
    try {
      await updateCState(deps, (c) => transition(c, id, "failed", { reason: result.reason }));
    } catch (err) {
      deps.log?.error("nightly: couldn't mark failed", { id, error: err.message });
    }
  }

  await summarize();
  return { built, failed };
}

const RECHECKABLE = ["failed", "awaiting-approval"];

// A recheck builds nothing, so it moves the status without counting an attempt.
function setStatus(cstate, id, status, reason) {
  const prev = itemState(cstate, id);
  const next = { status, attempts: prev.attempts ?? 0 };
  if (reason !== undefined) next.reason = reason;
  if (prev.note !== undefined) next.note = prev.note;
  next.at = new Date().toISOString();
  return { ...cstate, items: { ...cstate.items, [id]: next } };
}

function hasVideo(repoRoot, dir) {
  try {
    return fs.readdirSync(path.join(repoRoot, dir, "out")).some((f) => f.endsWith(".mp4"));
  } catch {
    return false;
  }
}

// Checks and reviews a failed or awaiting piece again, as it is in its out/ folder.
// A SHIP is sent for approval; a check failure or a FIX marks it failed. Neither
// changes its attempts. Returns { id, ok, reason? }; throws for a piece it can't
// recheck, or when a step crashes (the state is then left as it was).
export async function runRecheck({ id, deps }) {
  let entered = false;
  try {
    return await lockOf(deps)("creation", () => {
      entered = true;
      return recheck(id, deps);
    }, creationLockOptions(deps));
  } catch (err) {
    if (entered) throw err;
    if (err.code !== "ELOCKBUSY") throw new Error(`the creation lock couldn't be taken (${err.message})`);
    const busy = new Error(`another build run holds the creation lock (${err.message})`);
    busy.lockBusy = true;
    throw busy;
  }
}

async function recheck(id, deps) {
  const { repoRoot } = deps;
  const steps = stepsFrom(deps);
  const entry = deps.backlog.find((e) => e.id === id);
  if (!entry) throw new Error(`${id} is not in the backlog`);
  const { status } = itemState(deps.store.load(), id);
  if (!RECHECKABLE.includes(status)) throw new Error(`${id} is ${status}: only a failed piece or one awaiting approval can be rechecked`);
  if (!hasVideo(repoRoot, deps.pieceDir(id))) throw new Error(`${id} has no out/ video to recheck; build it first`);

  let result = { ok: true };
  const checks = await steps.runChecks({ repoRoot, entry });
  if (!checks.ok) {
    result = { ok: false, reason: `recheck: checks failed: ${checks.failures.join("; ")}` };
  } else {
    const review = await steps.runReview({ entryId: id, cwd: repoRoot, raw: checks.raw });
    if (review.verdict === "SHIP") {
      await sendForApproval(entry, review, { deps, steps });
    } else {
      const mustFix = review.must_fix?.length ? review.must_fix.join("; ") : review.summary || "no details given";
      result = { ok: false, reason: `recheck: review said FIX. Must fix: ${mustFix}` };
    }
  }

  await updateCState(deps, (c) => {
    // The poller may have approved or redone it meanwhile; that wins.
    const current = itemState(c, id).status;
    if (current !== status) throw new Error(`${id} went from ${status} to ${current} during the recheck; left as ${current}`);
    return setStatus(c, id, result.ok ? "awaiting-approval" : "failed", result.reason);
  });
  return { id, ...result };
}
