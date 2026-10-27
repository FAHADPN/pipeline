// "Needs you": the campaign's stats, its to-dos (each with one action), the next post
// and this week's queue.
//
//   needsScreen(ctx) -> Node, where ctx = { status, campaignName, pieceById(id),
//                                           play(piece), postNow(target), runTodo(todo),
//                                           hold(piece, el) }
// pieceById finds a library Piece; it is null while the library loads or when it
// failed, and titles then fall back to ids. postNow's target is { id, title, platform }.
//
// The card shows status.next. Its Post now works only when that is the next floating
// Instagram item, the one the server's postNow posts; a pinned item posts on its date.
// Hold holds whichever it is.

import { h, icon } from "../dom.js";
import { addDays, dayLabel, longDate, PLATFORMS, rhythmLabel, shortDay, STATUS_LABELS, typeLabel } from "../lib/format.js";
import { isFloatingInstagram } from "../lib/queue.js";

const PLAY_ICON = "M8 5v14l11-7z";
const WEEK_DAYS = 7;
const TAGS = {
  postFailed: "Post failed",
  notReady: "Not ready",
  task: "Scheduler",
  dropping: "Dropping",
  buildFailed: "Build failed",
  redo: "Redo",
  token: "Token",
  buildStatus: "Build status",
  awaiting: "Review",
};

function stat(label, value, sub) {
  return h("div", { className: "stat" }, h("span", { className: "stat-label" }, label), h("span", { className: "stat-value mono" }, value), h("span", { className: "stat-sub" }, sub));
}

function stats(status, nextPiece) {
  const { health = {}, next, posted = [], today } = status;
  return h(
    "div",
    { className: "stats" },
    stat("Ready to post", String(health.readyCount ?? 0), health.runDry ? `runs dry ${dayLabel(health.runDry, today)}` : "nothing floating ready"),
    stat("Rhythm", rhythmLabel(health.rhythm), health.rhythm === "daily" ? "one post a day" : "four posts a week"),
    stat("Next post", next ? dayLabel(next.date, today) : "None", next ? (nextPiece?.title ?? next.id) : "nothing queued"),
    stat("Posted", String(posted.length), "last 14 days"),
  );
}

function todoCard(todo, ctx) {
  let action = null;
  if (todo.action.route) {
    action = h("a", { className: "btn", href: todo.action.route }, todo.action.label);
  } else if (ctx.status.canAct) {
    action = h("button", { type: "button", className: "btn", onClick: () => ctx.runTodo(todo) }, todo.action.label);
  }
  return h(
    "li",
    { className: "card todo" },
    h("span", { className: `dot sev-${todo.severity}`, "aria-hidden": "true" }),
    h(
      "div",
      { className: "todo-body" },
      h("div", { className: "todo-head" }, h("span", { className: "todo-title" }, todo.title), h("span", { className: `pill tag-${todo.severity}` }, TAGS[todo.kind] ?? "To do")),
      h("span", { className: "todo-detail" }, todo.detail),
    ),
    action,
  );
}

function todoList(ctx) {
  const todos = ctx.status.todos ?? [];
  return h(
    "section",
    { className: "col-todo", "aria-labelledby": "todo-h" },
    h("h2", { id: "todo-h" }, "To do ", h("span", { className: "muted" }, `· ${todos.length}`)),
    todos.length
      ? h("ul", { className: "todo-list" }, todos.map((t) => todoCard(t, ctx)))
      : h("p", { className: "card empty" }, "Nothing needs you right now. New videos land here and on Telegram."),
  );
}

function nextCard(ctx, piece) {
  const { status } = ctx;
  const next = status.next;
  if (!next) return h("p", { className: "card empty" }, "Nothing is queued to post.");
  const title = piece?.title ?? next.id;
  const playable = Boolean(piece?.video);
  const art = [
    piece?.cover ? h("img", { src: piece.cover, alt: "" }) : null,
    playable ? h("span", { className: "playdot", "aria-hidden": "true" }, icon([PLAY_ICON], { fill: true, size: 14 })) : null,
  ];
  const cover = playable
    ? h("button", { type: "button", className: "next-thumb", "aria-label": `Play ${title}`, onClick: () => ctx.play(piece) }, art)
    : h("div", { className: "next-thumb" }, art);
  const buttons = [];
  if (playable) buttons.push(h("button", { type: "button", className: "btn btn-primary", onClick: () => ctx.play(piece) }, "Play"));
  if (status.canAct) {
    const postable = isFloatingInstagram(next);
    buttons.push(
      h(
        "button",
        {
          type: "button",
          className: "btn",
          disabled: !postable,
          title: postable ? undefined : next.why === "pinned" ? "Posts on its pinned date" : "Only the next queued Instagram post can be posted now",
          onClick: () => ctx.postNow({ id: next.id, title, platform: next.platform }),
        },
        "Post now",
      ),
    );
    buttons.push(h("button", { type: "button", className: "btn", onClick: (e) => ctx.hold(piece ?? { id: next.id, title }, e.currentTarget) }, "Hold"));
  }
  return h(
    "div",
    { className: "card next-card" },
    h(
      "div",
      { className: "next-main" },
      cover,
      h(
        "div",
        { className: "next-info" },
        h("span", { className: "muted small" }, `${dayLabel(next.date, status.today)} · ${PLATFORMS[next.platform] ?? next.platform}`),
        h("span", { className: "next-title" }, title),
        piece?.type ? h("span", { className: "muted small" }, typeLabel(piece.type)) : null,
        piece ? h("div", { className: "pills" }, h("span", { className: `pill status-${piece.status}` }, STATUS_LABELS[piece.status] ?? piece.status)) : null,
      ),
    ),
    buttons.length ? h("div", { className: "next-actions" }, buttons) : null,
  );
}

function week(ctx) {
  const { status } = ctx;
  const end = addDays(status.today, WEEK_DAYS);
  const rows = (status.queue ?? []).filter((q) => q.platform === "instagram" && q.date < end);
  if (!rows.length) return h("p", { className: "card empty" }, "Nothing is scheduled this week.");
  return h(
    "ul",
    { className: "card week" },
    rows.map((q) => {
      const piece = ctx.pieceById(q.id);
      const content = [
        h("span", { className: "week-day mono" }, shortDay(q.date)),
        h("span", { className: `pill type-${piece?.type ?? "none"}` }, typeLabel(piece?.type)),
        h("span", { className: "week-title" }, piece?.title ?? q.id),
      ];
      return h(
        "li",
        {},
        piece?.video
          ? h("button", { type: "button", className: "week-row", "aria-label": `Play ${piece.title}`, onClick: () => ctx.play(piece) }, content)
          : h("div", { className: "week-row" }, content),
      );
    }),
  );
}

export function needsScreen(ctx) {
  const { status } = ctx;
  const nextPiece = status.next ? ctx.pieceById(status.next.id) : null;
  return h(
    "div",
    { className: "screen" },
    h("div", { className: "screen-head" }, h("h1", {}, "Needs you"), h("span", { className: "muted" }, `${longDate(status.today)} · ${ctx.campaignName}`)),
    status.connected === false ? h("p", { className: "banner banner-warn" }, "Instagram is not connected yet. Nothing will post until it is.") : null,
    stats(status, nextPiece),
    h(
      "div",
      { className: "columns" },
      todoList(ctx),
      h(
        "section",
        { className: "col-next", "aria-labelledby": "next-h" },
        h("h2", { id: "next-h" }, "Next post"),
        nextCard(ctx, nextPiece),
        h("h2", {}, "This week"),
        week(ctx),
      ),
    ),
  );
}
