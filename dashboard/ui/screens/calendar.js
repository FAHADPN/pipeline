// The calendar: five weeks from a Monday, as a grid at 760 px and wider and as an agenda
// below that (both are drawn; styles.css shows one). Each day shows what posts and which
// builds are due. A post with a video opens the player; a build that failed or needs a
// redo opens Review, and anything else the pipeline.
//
//   calendarScreen(ctx) -> Node, where ctx = { status, calendar, pieceById(id), play(piece),
//                                              showWeeks(from), pin(piece, date, el) }
// calendar is null while it loads, else { data, error } with data from /api/calendar.
// showWeeks(from) loads the weeks from `from`; null goes back to the ones holding today.
// Days after data.projectedThrough are muted: the queue isn't projected that far yet, so
// they show pinned posts and builds only.
//
// When the owner can act, a Ready post's chip in the grid can be dragged with a mouse
// onto another day from today on, which pins it there (lib/drag.js); a past day or
// anywhere outside a day cancels. Keyboard and phone users have Move date in the player.

import { h, icon } from "../dom.js";
import { dropDate, draggable } from "../lib/drag.js";
import { addDays, dayLabel, shortDay, typeLabel } from "../lib/format.js";
import { agenda, weekGrid } from "../lib/grid.js";

const STEP_DAYS = 35;
const PREV_ICON = "M15 6l-6 6 6 6";
const NEXT_ICON = "M9 6l6 6-6 6";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const KIND_LABELS = { posted: "Posted", pinned: "Pinned", held: "Held", dropped: "Dropped" };
const BUILD_LABELS = { todo: "Not built yet", building: "Building", awaiting: "Awaiting approval", failed: "Needs fixing", redo: "Redo asked" };
const LEGEND = [
  ["chip type-story", "Scheduled"],
  ["chip chip-pinned", "Pinned"],
  ["chip chip-posted", "Posted"],
  ["chip chip-held", "Held or dropped"],
  ["chip build-failed", "Needs fixing"],
  ["chip build-todo", "Not built yet"],
];

// "19 Oct – 22 Nov".
function rangeLabel(from, to) {
  const short = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  };
  return `${short(from)} – ${short(to)}`;
}

// The route for something with no video to play: Review for a build that failed or
// needs a redo, else the pipeline.
function routeFor(build) {
  return build && (build.status === "failed" || build.status === "redo") ? `#/review/${encodeURIComponent(build.id)}` : "#/pipeline";
}

// "Mon 7 Dec, not projected yet" past the projection's last day.
function dayAria(date, today, data) {
  return date > data.projectedThrough ? `${dayLabel(date, today)}, not projected yet` : dayLabel(date, today);
}

// The hint's run-dry sentence, and its own line when the weeks shown pass the projection's
// last day; a run-dry date past that day always says where the chips stop.
function horizonNotes(data, today) {
  const through = dayLabel(data.projectedThrough, today);
  const passes = data.days.at(-1).date > data.projectedThrough;
  const lateRunDry = Boolean(data.runDry) && data.runDry > data.projectedThrough;
  const runDry = data.runDry
    ? ` Ready posts last until ${dayLabel(data.runDry, today)}${lateRunDry && !passes ? `; projected posts shown up to ${through}` : ""}.`
    : "";
  const line = passes ? `Projected posts shown up to ${through}; later days show pinned posts and builds only.` : null;
  return { runDry, line };
}

function chip(className, title, meta, { onClick, href } = {}) {
  const content = [h("span", { className: "chip-title" }, title), h("span", { className: "chip-meta" }, meta)];
  if (onClick) return h("button", { type: "button", className, onClick }, content);
  return h("a", { className, href }, content);
}

// Every day cell in the grid holding `el`, as dropDate takes them.
function dayCells(el) {
  return [...(el.closest(".cal-grid")?.querySelectorAll(".cal-cell") ?? [])].map((c) => ({ date: c.dataset.date, rect: c.getBoundingClientRect(), el: c }));
}

// Lets `el`, the chip of Ready `piece` on `from`, be dropped on another day from today on;
// the day under the pointer is highlighted while it would take the drop.
function dragToPin(ctx, el, piece, from, today) {
  let target = null;
  const show = (cell) => {
    target?.el.classList.remove("cal-drop");
    target = cell;
    target?.el.classList.add("cal-drop");
  };
  const cellAt = (x, y) => {
    const cells = dayCells(el);
    const date = dropDate(cells, x, y);
    return date && date >= today && date !== from ? cells.find((c) => c.date === date) : null;
  };
  draggable(el, {
    onMove: (x, y) => show(cellAt(x, y)),
    onEnd: () => show(null),
    onDrop: (x, y) => {
      const cell = cellAt(x, y);
      if (cell) ctx.pin(piece, cell.date, el);
    },
  });
}

// `date` is the day the chip is on in the grid, where a Ready post can be dragged.
function postChip(ctx, post, date) {
  const piece = post.video ? ctx.pieceById(post.id) : null;
  const scheduled = post.kind === "scheduled";
  const className = scheduled && post.type ? `chip type-${post.type}` : `chip chip-${post.kind}`;
  const meta = scheduled ? typeLabel(post.type) : KIND_LABELS[post.kind];
  if (!piece) return chip(className, post.title, meta, { href: routeFor(null) });
  const movable = date && ctx.status.canAct && piece.status === "ready" && (scheduled || post.kind === "pinned");
  const el = chip(movable ? `${className} chip-movable` : className, post.title, meta, { onClick: () => ctx.play(piece) });
  if (movable) dragToPin(ctx, el, piece, date, ctx.status.today);
  return el;
}

function buildChip(build) {
  return chip(`chip build-${build.status}`, build.title, BUILD_LABELS[build.status] ?? build.status, { href: routeFor(build) });
}

// The grid passes `inGrid`, so its Ready posts can be dragged; the agenda's can't.
function chips(ctx, day, inGrid = false) {
  return [...day.posts.map((p) => postChip(ctx, p, inGrid ? day.date : null)), ...day.builds.map(buildChip)];
}

function grid(ctx, data, today) {
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  const cells = weekGrid(data.from, data.days.length).flatMap((week, row) =>
    week.map((date, col) => {
      const day = byDate.get(date);
      const d = new Date(`${date}T00:00:00Z`);
      const label = (row === 0 && col === 0) || d.getUTCDate() === 1 ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : String(d.getUTCDate());
      const state = date === today ? " cal-today" : date < today ? " cal-past" : date > data.projectedThrough ? " cal-unprojected" : "";
      const cell = h(
        "div",
        { className: `cal-cell${state}${day ? "" : " cal-out"}`, role: "group", "aria-label": dayAria(date, today, data) },
        h("span", { className: "cal-date mono", "aria-hidden": "true" }, label),
        day ? chips(ctx, day, true) : null,
      );
      cell.dataset.date = date;
      return cell;
    }),
  );
  return h(
    "div",
    { className: "cal-grid-wrap" },
    h("div", { className: "cal-grid" }, WEEKDAYS.map((w) => h("span", { className: "cal-dow", "aria-hidden": "true" }, w)), cells),
  );
}

function agendaList(ctx, data, today) {
  const rows = agenda(data.days, today);
  if (!rows.length) return h("p", { className: "card empty cal-agenda" }, "Nothing planned from today in these weeks.");
  return h(
    "div",
    { className: "cal-agenda" },
    rows.map((row) => {
      if (row.header) return h("h2", { className: "agenda-head" }, row.header);
      const [dow, num] = shortDay(row.day.date).split(" ");
      const unprojected = row.day.date > data.projectedThrough;
      return h(
        "div",
        { className: unprojected ? "agenda-row agenda-unprojected" : "agenda-row", role: "group", "aria-label": dayAria(row.day.date, today, data) },
        h(
          "div",
          { className: "agenda-day", "aria-hidden": "true" },
          h("span", { className: "small muted" }, dow),
          h("span", { className: row.day.date === today ? "agenda-num mono agenda-today" : "agenda-num mono" }, num),
        ),
        h("div", { className: "agenda-chips" }, chips(ctx, row.day)),
      );
    }),
  );
}

function controls(ctx, data) {
  const step = (n) => () => ctx.showWeeks(addDays(data.from, n));
  return h(
    "div",
    { className: "cal-controls" },
    h("button", { type: "button", className: "btn btn-icon", "aria-label": "Previous weeks", disabled: !data, onClick: data ? step(-STEP_DAYS) : undefined }, icon([PREV_ICON], { size: 14 })),
    h("button", { type: "button", className: "btn", onClick: () => ctx.showWeeks(null) }, "Today"),
    h("button", { type: "button", className: "btn btn-icon", "aria-label": "Next weeks", disabled: !data, onClick: data ? step(STEP_DAYS) : undefined }, icon([NEXT_ICON], { size: 14 })),
  );
}

export function calendarScreen(ctx) {
  const { status, calendar } = ctx;
  const data = calendar?.data ?? null;
  const today = status.today;
  const notes = data ? horizonNotes(data, today) : { runDry: "", line: null };
  let body;
  if (calendar?.error) body = h("p", { className: "banner banner-err" }, `Can't load the calendar: ${calendar.error}`);
  else if (!data) body = h("p", { className: "muted" }, "Loading…");
  else {
    body = [
      grid(ctx, data, today),
      agendaList(ctx, data, today),
      h("div", { className: "legend" }, LEGEND.map(([className, label]) => h("span", { className: "legend-item" }, h("span", { className: `swatch ${className}`, "aria-hidden": "true" }), label))),
    ];
  }
  return h(
    "div",
    { className: "screen" },
    h(
      "div",
      { className: "screen-head" },
      h("div", { className: "cal-title" }, h("h1", {}, "Calendar"), data ? h("span", { className: "cal-range" }, rangeLabel(data.from, data.days.at(-1).date)) : null),
      controls(ctx, data),
    ),
    h(
      "p",
      { className: "muted small cal-hint" },
      "Click a post to play it. Builds open the pipeline, or Review when they need fixing.",
      status.canAct ? h("span", { className: "cal-drag-hint" }, " Drag a ready post to another day to pin it there.") : null,
      notes.runDry,
    ),
    notes.line ? h("p", { className: "muted small cal-hint cal-horizon" }, notes.line) : null,
    body,
  );
}
