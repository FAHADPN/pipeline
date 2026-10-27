// The pipeline: every piece by where it is, from idea to posted, in six columns. Ideas and
// Building come from the build list (/api/pipeline); the rest from the library. A card
// with a video opens the player; one that needs fixing opens Review.
//
//   pipelineScreen(ctx) -> Node, where ctx = { status, library, libraryError, builds,
//                                              play(piece), reorder(piece, before, el),
//                                              addIdea(), editIdea(card), removeIdea(card, el),
//                                              unqueue(card, el) }
// library is /api/library's { pieces, counts } or null, with libraryError the reason its
// last load failed (or null); builds is null while it loads,
// else { data, error } with data /api/pipeline's { builds, queue }. A card whose piece is
// in the build queue shows "Queued #n", and Remove from queue when the owner can act.
//
// When the owner can act, the floating Ready pieces (the queue, in posting order) can be
// reordered: dragged with a mouse at 760 px and wider, or moved with Up and Down on a
// phone. Pinned and held pieces stay where their date puts them. The owner can also add an
// idea (+ Idea in the header) and edit or remove one still in Ideas.

import { h, icon } from "../dom.js";
import { draggable, dropIndex, reorderTarget } from "../lib/drag.js";
import { addDays, dayLabel, pieceWhen, typeLabel } from "../lib/format.js";

const POSTED_DAYS = 14;
const MAX_CARDS = 8;
const BUILD_TAGS = { failed: "Build failed", redo: "Redo asked" };
const UP_ICON = "M6 15l6-6 6 6";
const DOWN_ICON = "M6 9l6 6 6-6";

// Oldest date first, no date last: the order things post or get built.
function byDate(a, b) {
  if (a.date === b.date) return 0;
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  return a.date.localeCompare(b.date);
}

// Up and Down (phone) and dragging (desktop) for floating card `c`, shown as `cardEl` in
// `li`. Both send reorder with the target reorderTarget gives.
function reorderable(ctx, li, cardEl, c) {
  const { queue, index } = c;
  const send = (toIndex, el) => {
    const target = reorderTarget(queue, c.id, toIndex);
    if (target) ctx.reorder(c.piece, target.before, el);
  };
  const arrow = (label, path, toIndex, disabled) =>
    h(
      "button",
      { type: "button", className: "btn btn-icon", "aria-label": `${label}: ${c.title}`, disabled, onClick: (e) => send(toIndex, e.currentTarget) },
      icon([path], { size: 18 }),
    );
  li.classList.add("pipe-floating");
  li.append(h("div", { className: "pipe-move" }, arrow("Move up", UP_ICON, index - 1, index === 0), arrow("Move down", DOWN_ICON, index + 2, index === queue.length - 1)));

  // Where a drag at (x, y) lands, as an index into `queue`, or null outside the column.
  // The floating cards shown start the queue, so past the last one shown is before
  // the first one hidden. The list items are measured, not the card that moves.
  const floating = () => [...li.parentElement.querySelectorAll(".pipe-floating")];
  const landing = (x, y) => {
    const col = li.closest(".pipe-col").getBoundingClientRect();
    if (x < col.left || x > col.right || y < col.top || y > col.bottom) return null;
    return dropIndex(floating().map((el) => el.getBoundingClientRect()), y);
  };
  // A line above the card it would go before, or below the last one shown.
  let mark = null;
  const show = (at) => {
    mark?.el.classList.remove(mark.className);
    const shown = floating();
    const moves = at !== null && reorderTarget(queue, c.id, at);
    mark = !moves ? null : at < shown.length ? { el: shown[at], className: "drop-before" } : { el: shown.at(-1), className: "drop-after" };
    mark?.el.classList.add(mark.className);
  };
  draggable(cardEl, {
    onMove: (x, y) => show(landing(x, y)),
    onEnd: () => show(null),
    onDrop: (x, y) => {
      const at = landing(x, y);
      if (at !== null) send(at, cardEl);
    },
  });
}

// One card: { id, title, type, meta, tag?, reason?, piece? (a library Piece), fix?,
// queue?, index?, editable?, idea?, queued? }; a floating Ready card carries the floating
// ids (queue) and its index, an Ideas card the owner can change is editable, with its
// idea fields, and a piece in the build queue its place there (queued).
function card(ctx, c) {
  const content = [
    h("span", { className: "pipe-title" }, c.title),
    h(
      "span",
      { className: "pipe-row" },
      h("span", { className: `pill type-${c.type ?? "none"}` }, typeLabel(c.type)),
      c.tag ? h("span", { className: "pill status-held" }, c.tag) : null,
      c.queued ? h("span", { className: "pill status-held" }, `Queued #${c.queued}`) : null,
      h("span", { className: "muted small" }, c.meta),
    ),
    c.reason ? h("span", { className: "pipe-reason" }, c.reason) : null,
  ];
  let el;
  if (c.piece?.video) el = h("button", { type: "button", className: "card pipe-card", onClick: () => ctx.play(c.piece) }, content);
  else if (c.fix) el = h("a", { className: "card pipe-card", href: `#/review/${encodeURIComponent(c.id)}` }, content);
  else el = h("div", { className: "card pipe-card" }, content);
  const li = h("li", {}, el);
  if (c.queue) reorderable(ctx, li, el, c);
  if (c.queued && ctx.status.canAct) {
    li.append(
      h(
        "div",
        { className: "pipe-idea-actions" },
        h("button", { type: "button", className: "btn", "aria-label": `Remove from queue: ${c.title}`, onClick: (e) => ctx.unqueue(c, e.currentTarget) }, "Remove from queue"),
      ),
    );
  }
  if (c.editable) {
    li.append(
      h(
        "div",
        { className: "pipe-idea-actions" },
        h("button", { type: "button", className: "btn", "aria-label": `Edit: ${c.title}`, onClick: () => ctx.editIdea(c) }, "Edit"),
        h("button", { type: "button", className: "btn", "aria-label": `Remove: ${c.title}`, onClick: (e) => ctx.removeIdea(c, e.currentTarget) }, "Remove"),
      ),
    );
  }
  return li;
}

function column(ctx, name, list, note) {
  const cards = list == null ? null : list.map((c) => ({ ...c, queued: ctx.queued.get(c.id) ?? null }));
  const more = (cards?.length ?? 0) - MAX_CARDS;
  return h(
    "section",
    { className: "pipe-col", "aria-label": name },
    h("div", { className: "pipe-head" }, h("h2", {}, name), h("span", { className: "mono muted small" }, cards == null ? "…" : String(cards.length))),
    note ? h("p", { className: "muted small pipe-note" }, note) : null,
    cards?.length ? h("ul", { className: "pipe-list" }, cards.slice(0, MAX_CARDS).map((c) => card(ctx, c))) : null,
    more > 0 ? h("p", { className: "muted small pipe-note" }, `+ ${more} more`) : null,
  );
}

const fromPiece = (today) => (p) => ({ id: p.id, title: p.title, type: p.type, meta: pieceWhen(p, today), piece: p });
const fromBuild = (today) => (b) => ({ id: b.id, title: b.title, type: b.type, meta: b.date ? dayLabel(b.date, today) : "No date", idea: b.idea });

export function pipelineScreen(given) {
  // Each queued piece's place in the build queue, by id.
  const ctx = { ...given, queued: new Map((given.builds?.data?.queue ?? []).map((q) => [q.id, q.position])) };
  const { status, library, builds } = ctx;
  const today = status.today;
  const pieces = library?.pieces ?? null;
  const entries = builds?.data?.builds ?? null;
  const ofStatus = (...statuses) => (pieces ?? []).filter((p) => statuses.includes(p.status));

  const fixIds = new Set(ofStatus("fix").map((p) => p.id));
  const fixing = [
    ...ofStatus("fix").map((p) => ({ ...fromPiece(today)(p), fix: true, reason: p.reason })),
    ...(entries ?? [])
      .filter((b) => (b.status === "failed" || b.status === "redo") && !fixIds.has(b.id))
      .map((b) => ({ ...fromBuild(today)(b), tag: BUILD_TAGS[b.status], fix: true, reason: b.reason })),
  ];
  const ready = ofStatus("ready", "held")
    .sort(byDate)
    .map((p) => ({ ...fromPiece(today)(p), tag: p.status === "held" ? "Held" : null }));
  // The floating Ready pieces, in the order they post: the queue Up, Down and dragging move.
  const queue = ready.filter((c) => c.piece.status === "ready" && !c.piece.pinned).map((c) => c.id);
  if (status.canAct) {
    for (const c of ready) if (queue.includes(c.id)) Object.assign(c, { queue, index: queue.indexOf(c.id) });
  }
  const since = addDays(today, -(POSTED_DAYS - 1));
  const posted = ofStatus("posted")
    .filter((p) => p.date && p.date >= since && p.date <= today)
    .sort((a, b) => byDate(b, a))
    .map(fromPiece(today));
  const ofBuild = (s) => (entries === null ? null : entries.filter((b) => b.status === s).map(fromBuild(today)));
  const ideas = entries === null ? null : ofBuild("todo").map((c) => ({ ...c, editable: status.canAct && c.idea !== undefined }));
  const libNote = pieces ? null : ctx.libraryError ? `Can't load the library: ${ctx.libraryError}` : "Loading…";
  const buildNote = builds?.error ? `Can't load the build list: ${builds.error}` : entries === null ? "Loading…" : null;

  return h(
    "div",
    { className: "screen" },
    h(
      "div",
      { className: "screen-head" },
      h("h1", {}, "Pipeline"),
      h("span", { className: "muted" }, "Every piece, from idea to posted"),
      status.canAct && entries !== null ? h("button", { type: "button", className: "btn btn-primary idea-add", onClick: () => ctx.addIdea() }, "+ Idea") : null,
    ),
    h(
      "div",
      { className: "pipe-wrap" },
      h(
        "div",
        { className: "pipe-board" },
        column(ctx, "Ideas", ideas, buildNote),
        column(ctx, "Building", ofBuild("building"), buildNote),
        column(ctx, "Needs fixing", fixing, libNote),
        column(ctx, "Awaiting approval", ofStatus("awaiting").map(fromPiece(today)), libNote),
        column(ctx, "Ready", ready, libNote),
        column(ctx, "Posted", posted, libNote ?? "The last 14 days"),
      ),
    ),
  );
}
