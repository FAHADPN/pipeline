// The Review screen's data: the pieces that wait for the owner (awaiting approval,
// failed or back for a redo), one piece in full, and a build's progress. Built from
// the same Data the status reads (sources.mjs). Read-only; every result is scrubbed.
//
// Review = { id, title, type, status, reason, note, attempts, canBuild, checks, review,
//            caption, youtubeTitle, video, cover, queued }
//   status   the build progress status (creation/lib/cstate.mjs)
//   canBuild whether a build by hand (nightly --now --id) would build it now
//   checks   <outDir>/<id>.checks.json, the /ig skill scripts' raw JSON, or null
//   review   <outDir>/<id>.review.json, the reviewer's last parsed verdict, or null.
//            Pieces reviewed before that file existed have none; their reason says why.
//   queued   { position } (from 1) while it waits in the build queue, else null
// Progress = { status, since, elapsedSeconds, lines, queued }
//   lines    the last 30 lines of the campaign's newest monthly log that mention the
//            piece, since the latest "nightly start" that could build it
//
// `queue` is the campaign's build queue (creation/lib/build-queue.mjs readQueue); the
// list holds every queued piece too, built before or not.

import fs from "node:fs";
import path from "node:path";
import { queuePosition } from "../../creation/lib/build-queue.mjs";
import { pickWork } from "../../creation/lib/picker.mjs";
import { inspect } from "./library.mjs";
import { scrub } from "./sources.mjs";

const REVIEWABLE = ["awaiting-approval", "failed", "redo"];
const MAX_LINES = 30;
const LOG_FILE = /^\d{4}-\d{2}\.log$/;
const NIGHTLY_START = /^\S+ \S+ nightly start(?: (.*))?$/;

// The parsed JSON in `file`, or null when it's missing or unreadable.
function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// The verdict fields the screen shows, with lists that are always lists.
function verdictFields(json) {
  if (!json) return null;
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    verdict: json.verdict ?? null,
    scores: json.scores ?? null,
    skills: json.skills ?? null,
    must_fix: list(json.must_fix),
    nice_to_have: list(json.nice_to_have),
    summary: typeof json.summary === "string" ? json.summary : "",
  };
}

// A piece's build progress entry, or null for an id in neither the build list nor
// the build progress.
function stateOf(data, id) {
  const state = data.cstate.items?.[id];
  if (state) return state;
  return data.backlog.some((e) => e?.id === id) ? { status: "todo", attempts: 0 } : null;
}

const queuedAt = (queue, id) => {
  const position = queuePosition(queue, id);
  return position === null ? null : { position };
};

export function listReviews({ data, queue = [] }) {
  const titles = new Map(data.backlog.map((e) => [e?.id, e]));
  const items = data.cstate.items ?? {};
  const ids = Object.keys(items).filter((id) => REVIEWABLE.includes(items[id]?.status));
  for (const { id } of queue) if (!ids.includes(id) && stateOf(data, id)) ids.push(id);
  const pieces = ids
    .map((id) => {
      const s = stateOf(data, id);
      return {
        id,
        title: titles.get(id)?.title ?? id,
        type: titles.get(id)?.type ?? null,
        status: s.status,
        reason: s.reason ?? s.note ?? null,
        at: s.at ?? null,
        cover: inspect(data, { id, dir: data.pieceDir(id) }).cover,
        queued: queuedAt(queue, id),
      };
    })
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
  return scrub(pieces, data.secretValues);
}

export function loadReview({ data, id, queue = [] }) {
  const state = stateOf(data, id);
  if (!state) return null;
  const entry = data.backlog.find((e) => e?.id === id);
  const found = inspect(data, { id, dir: data.pieceDir(id) });
  return scrub(
    {
      id,
      title: entry?.title ?? id,
      type: entry?.type ?? null,
      status: state.status,
      reason: state.reason ?? null,
      note: state.note ?? null,
      attempts: state.attempts ?? 0,
      canBuild: pickWork({ backlog: data.backlog, cstate: data.cstate, onlyId: id }).length > 0,
      checks: readJson(path.join(data.outDir, `${id}.checks.json`)),
      review: verdictFields(readJson(path.join(data.outDir, `${id}.review.json`))),
      caption: found.caption,
      youtubeTitle: found.youtubeTitle,
      video: found.video,
      cover: found.cover,
      queued: queuedAt(queue, id),
    },
    data.secretValues,
  );
}

// True for a "nightly start" line of a run that could build `id`: a night run (no
// onlyId) or a build by hand of that piece.
function startsBuildOf(line, id) {
  const m = NIGHTLY_START.exec(line);
  if (!m) return false;
  let onlyId;
  try {
    onlyId = m[1] ? JSON.parse(m[1]).onlyId : undefined;
  } catch {
    return false;
  }
  return onlyId === undefined || onlyId === id;
}

// The lines of log `text` that mention `id`, from its latest nightly start on; the last 30.
export function buildLines(text, id) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentions = new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`);
  const start = lines.findLastIndex((line) => startsBuildOf(line, id));
  if (start < 0) return [];
  return lines.slice(start).filter((line) => mentions.test(line)).slice(-MAX_LINES);
}

// The campaign's newest monthly log, or "" when it has none.
function newestLog(home) {
  try {
    const name = fs.readdirSync(path.join(home, "logs")).filter((n) => LOG_FILE.test(n)).sort().at(-1);
    return name ? fs.readFileSync(path.join(home, "logs", name), "utf8") : "";
  } catch {
    return "";
  }
}

export function buildProgress({ data, id, now, queue = [] }) {
  const state = stateOf(data, id);
  if (!state) return null;
  const since = state.at ?? null;
  const started = since === null ? NaN : Date.parse(since);
  return scrub(
    {
      status: state.status,
      since,
      elapsedSeconds: Number.isNaN(started) ? null : Math.max(0, Math.round((+now - started) / 1000)),
      lines: buildLines(newestLog(data.home), id),
      queued: queuedAt(queue, id),
    },
    data.secretValues,
  );
}
