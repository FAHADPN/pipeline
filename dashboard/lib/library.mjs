// The library: every piece a campaign has built, scheduled or not, with the one status
// the console shows for it. Built from the same Data the status reads (sources.mjs),
// so every campaign is read the same way. Read-only.
//
// Library = { pieces: Piece[], counts: { all, ready, held, awaiting, posted, fix, dropped } }
// Piece   = { id, title, type, status, date, pinned, video, cover, caption, youtubeTitle, url, reason }
//
// Schedule items come first, and Instagram (the platform that is always on) decides their
// status. A build-list piece that is not in the schedule is listed only when it awaits
// approval or needs fixing; todo, building and approved ones are not pieces yet.

import fs from "node:fs";
import path from "node:path";
import { istDate, istMinutes } from "../../publishing/lib/dates.mjs";
import { checkItem, parseCaption } from "../../publishing/lib/content.mjs";
import { getEntry } from "../../publishing/lib/state.mjs";
import { projectQueue } from "./status.mjs";
import { scrub } from "./sources.mjs";

const PROJECTION_DAYS = 42;
const PLATFORM = "instagram";
const STATUSES = ["ready", "held", "awaiting", "posted", "fix", "dropped"];
const CHECK_ERROR_SEPARATOR = "; ";

// What the folder holds for a piece: the check result, its caption fields and the media
// URLs of the files that exist. Never throws.
export function inspect(data, item) {
  let checked;
  try {
    checked = checkItem(data.root, item);
  } catch (err) {
    checked = { ok: false, errors: [err.message] };
  }
  let caption = checked.caption ?? null;
  if (!caption && checked.assets) {
    try {
      caption = parseCaption(fs.readFileSync(checked.assets.caption, "utf8"));
    } catch {
      caption = null;
    }
  }
  const media = (file) => (file && fs.existsSync(file) ? data.mediaUrl(item.id, path.basename(file)) : null);
  return {
    ok: checked.ok,
    errors: checked.errors ?? [],
    caption: caption?.instagram ?? null,
    youtubeTitle: caption?.youtubeTitle ?? null,
    video: media(checked.assets?.video),
    cover: media(checked.assets?.cover),
  };
}

function piece(fields) {
  return { type: null, date: null, pinned: false, url: null, reason: null, ...fields };
}

// Newest date first, pieces with no date last, then by id.
function order(a, b) {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return b.date.localeCompare(a.date);
  }
  return a.id.localeCompare(b.id);
}

export function buildLibrary({ data, now }) {
  const { items, state, config } = data;
  const titles = new Map();
  const types = new Map();
  const targets = new Map();
  for (const entry of data.backlog) {
    titles.set(entry?.id, entry?.title);
    types.set(entry?.id, entry?.type);
    targets.set(entry?.id, entry?.targetDate);
  }
  const cstate = data.cstate.items ?? {};

  const inspected = new Map(items.map((item) => [item.id, inspect(data, item)]));
  // A held item is left out of the projection, so it takes no day from the ones behind it.
  const ready = new Set(items.filter((i) => inspected.get(i.id).ok && i.hold !== true).map((i) => i.id));
  const projected = new Map();
  const queue = projectQueue({
    today: istDate(now, config.timeZone),
    items,
    state,
    ready,
    config,
    days: PROJECTION_DAYS,
    minutesNow: istMinutes(now, config.timeZone),
  });
  for (const post of queue) if (post.platform === PLATFORM && !projected.has(post.id)) projected.set(post.id, post.date);

  const pieces = [];

  for (const item of items) {
    const found = inspected.get(item.id);
    const entry = getEntry(state, item.id, PLATFORM);
    const base = {
      id: item.id,
      title: item.title ?? titles.get(item.id) ?? item.id,
      type: item.type ?? types.get(item.id) ?? null,
      pinned: item.on !== undefined,
      video: found.video,
      cover: found.cover,
      caption: found.caption,
      youtubeTitle: found.youtubeTitle,
    };
    const planned = item.on ?? item.targetDate ?? null;
    if (entry?.status === "posted" || entry?.status === "manual") {
      pieces.push(piece({ ...base, status: "posted", date: entry.date ?? planned, url: entry.url ?? null }));
    } else if (entry?.status === "dropped") {
      pieces.push(piece({ ...base, status: "dropped", date: planned, reason: entry.reason ?? null }));
    } else if (entry?.status === "failed") {
      pieces.push(piece({ ...base, status: "fix", date: item.on ?? projected.get(item.id) ?? item.targetDate ?? null, reason: entry.error ?? null }));
    } else if (item.hold === true) {
      pieces.push(piece({ ...base, status: "held", date: planned }));
    } else if (found.ok) {
      pieces.push(piece({ ...base, status: "ready", date: item.on ?? projected.get(item.id) ?? item.targetDate ?? null }));
    } else {
      pieces.push(piece({ ...base, status: "fix", date: planned, reason: found.errors.join(CHECK_ERROR_SEPARATOR) }));
    }
  }

  const scheduled = new Set(items.map((i) => i.id));
  for (const [id, entry] of Object.entries(cstate)) {
    if (scheduled.has(id) || !entry) continue;
    const status = entry.status === "awaiting-approval" ? "awaiting" : entry.status === "failed" || entry.status === "redo" ? "fix" : null;
    if (!status) continue;
    const found = inspect(data, { id, dir: data.pieceDir(id) });
    pieces.push(
      piece({
        id,
        title: titles.get(id) ?? id,
        type: types.get(id) ?? null,
        status,
        date: targets.get(id) ?? null,
        video: found.video,
        cover: found.cover,
        caption: found.caption,
        youtubeTitle: found.youtubeTitle,
        reason: status === "fix" ? (entry.reason ?? entry.note ?? null) : null,
      }),
    );
  }

  pieces.sort(order);
  const counts = { all: pieces.length, ...Object.fromEntries(STATUSES.map((s) => [s, 0])) };
  for (const p of pieces) counts[p.status]++;
  return scrub({ pieces, counts }, data.secretValues);
}
