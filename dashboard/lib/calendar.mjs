// The calendar: what posts on each day of a range of weeks, and which build-list pieces
// are due then. Built from the same Data the status and the library read (sources.mjs),
// with each piece's title, type and media from the library. Read-only.
//
// Calendar  = { from, days: Day[], runDry, projectedThrough }
// Day       = { date, posts: CalItem[], builds: BuildItem[] }
// CalItem   = { id, title, type, kind: "posted"|"scheduled"|"pinned"|"held"|"dropped", url, video, cover }
// BuildItem = { id, title, type, status: "todo"|"building"|"awaiting"|"failed"|"redo", reason }
//
// Posted and dropped items sit on their library date; pinned and held ones on their
// "on" date (a held item with no "on" is on no day); floating ones on the day the
// planner's projection gives them. Only Instagram, the platform that is always on.
// The projection covers today and the 41 days after it, through `projectedThrough`; a
// floating post due later is on no day yet.

import { addDays, istDate, istMinutes, isRealDate, weekday } from "../../publishing/lib/dates.mjs";
import { checkItem } from "../../publishing/lib/content.mjs";
import { projectRunDry } from "../../publishing/lib/planner.mjs";
import { buildLibrary } from "./library.mjs";
import { projectQueue } from "./status.mjs";
import { scrub } from "./sources.mjs";

const DEFAULT_DAYS = 35;
const MAX_DAYS = 42;
const PROJECTION_DAYS = 42;
const PLATFORM = "instagram";
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Build progress statuses as the calendar names them; an approved piece is in the schedule.
const BUILD_STATUS = { todo: "todo", building: "building", "awaiting-approval": "awaiting", failed: "failed", redo: "redo" };

// The Monday of the week holding `date`.
function monday(date) {
  return addDays(date, -WEEK.indexOf(weekday(date)));
}

// The ids the planner may post: those that pass their check and aren't held, the rule
// the library projects with.
function readyIds(data) {
  const ready = new Set();
  for (const item of data.items) {
    if (item.hold === true) continue;
    try {
      if (checkItem(data.root, item).ok) ready.add(item.id);
    } catch {
      // A folder that can't be checked isn't ready.
    }
  }
  return ready;
}

// The fields of a todo entry the Pipeline's Edit form starts from.
const IDEA_KEYS = ["premise", "format", "targetDate", "notBefore", "notAfter"];
const ideaFields = (entry) => Object.fromEntries(IDEA_KEYS.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]]));

// Every build-list entry that isn't in the schedule and isn't approved yet, in build-list
// order, as a BuildItem with the date it is planned for ("on", else targetDate; null
// when it has neither). The calendar places them by date; the pipeline lists them all.
export function buildEntries({ data }) {
  const scheduled = new Set(data.items.map((i) => i.id));
  const cstate = data.cstate.items ?? {};
  const out = [];
  for (const entry of data.backlog) {
    if (typeof entry?.id !== "string" || scheduled.has(entry.id)) continue;
    const progress = cstate[entry.id] ?? { status: "todo" };
    const status = BUILD_STATUS[progress.status];
    if (!status) continue;
    const date = [entry.on, entry.targetDate].find(isRealDate) ?? null;
    out.push({
      id: entry.id,
      title: entry.title ?? entry.id,
      type: entry.type ?? null,
      status,
      reason: status === "failed" || status === "redo" ? (progress.reason ?? progress.note ?? null) : null,
      date,
      // What the Pipeline's Edit form starts from (a todo entry only).
      ...(status === "todo" ? { idea: ideaFields(entry) } : {}),
    });
  }
  return scrub(out, data.secretValues);
}

// Throws a RangeError for a `from` that isn't a real date or `days` outside 1–42; either
// may be undefined. The server checks a request with it before reading anything.
export function checkCalendarQuery({ from, days }) {
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)) {
    throw new RangeError(`days must be a whole number from 1 to ${MAX_DAYS}`);
  }
  if (from !== undefined && !isRealDate(from)) throw new RangeError("from must be a real YYYY-MM-DD date");
}

// `from` defaults to the Monday of the week holding today, in the campaign's time zone,
// and `days` to 35.
export function buildCalendar({ data, from, days = DEFAULT_DAYS, now }) {
  checkCalendarQuery({ from, days });
  const { config, items, state } = data;
  const today = istDate(now, config.timeZone);
  const start = from ?? monday(today);

  const dates = Array.from({ length: days }, (_, n) => addDays(start, n));
  const byDate = new Map(dates.map((date) => [date, { date, posts: [], builds: [] }]));

  const ready = readyIds(data);
  const projected = new Map();
  const queue = projectQueue({ today, items, state, ready, config, days: PROJECTION_DAYS, minutesNow: istMinutes(now, config.timeZone) });
  for (const post of queue) {
    if (post.platform === PLATFORM && post.why === "queue" && !projected.has(post.id)) projected.set(post.id, post.date);
  }

  const pieces = new Map(buildLibrary({ data, now }).pieces.map((p) => [p.id, p]));
  for (const item of items) {
    const piece = pieces.get(item.id);
    let kind;
    let date;
    if (piece.status === "posted" || piece.status === "dropped") [kind, date] = [piece.status, piece.date];
    else if (piece.status === "held") [kind, date] = ["held", item.on];
    else if (item.on !== undefined) [kind, date] = ["pinned", item.on];
    else [kind, date] = ["scheduled", projected.get(item.id)];
    byDate.get(date)?.posts.push({
      id: piece.id,
      title: piece.title,
      type: piece.type,
      kind,
      url: kind === "posted" ? piece.url : null,
      video: piece.video,
      cover: piece.cover,
    });
  }

  for (const { date, idea, ...build } of buildEntries({ data })) byDate.get(date)?.builds.push(build);

  return scrub(
    {
      from: start,
      days: [...byDate.values()],
      runDry: projectRunDry({ today, items, state, ready, config }),
      projectedThrough: addDays(today, PROJECTION_DAYS - 1),
    },
    data.secretValues,
  );
}
