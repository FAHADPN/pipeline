// The library: every piece the campaign has built, as 3:4 cover cards. Status filters
// with their counts, a search over titles and captions, and a sort, all on this page;
// they last until the page reloads. A card with a video opens the player; one without
// shows "No video yet" and opens Review when it needs fixing, else the pipeline.
//
//   libraryScreen(ctx) -> Node, where ctx = { status, library, libraryError, play(piece), retry() }
// library is /api/library's { pieces, counts } as last loaded, or null before the first
// load. libraryError is why the last load failed (the server's scrubbed message), or null;
// it shows above the pieces, with a Retry.

import { h, icon } from "../dom.js";
import { pieceWhen, STATUS_LABELS, typeLabel } from "../lib/format.js";

const PLAY_ICON = "M8 5v14l11-7z";
const SEARCH_ICON = ["M11 4a7 7 0 100 14 7 7 0 000-14z", "M20 20l-3.5-3.5"];
const FILTERS = [["all", "All"], ...Object.entries(STATUS_LABELS)];
const SORTS = [
  ["newest", "Newest first"],
  ["date", "By date"],
];

const view = { filter: "all", query: "", sort: "newest" };

// By date, newest or oldest first; pieces with no date last, then by id.
function compare(sort) {
  return (a, b) => {
    if (a.date !== b.date) {
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return sort === "newest" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
    }
    return a.id.localeCompare(b.id);
  };
}

function shown(pieces) {
  const q = view.query.trim().toLowerCase();
  return pieces
    .filter((p) => view.filter === "all" || p.status === view.filter)
    .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.caption ?? "").toLowerCase().includes(q))
    .sort(compare(view.sort));
}

function card(ctx, piece) {
  const art = [
    piece.cover ? h("img", { src: piece.cover, alt: "", loading: "lazy" }) : null,
    h("span", { className: `pill lib-status status-${piece.status}` }, STATUS_LABELS[piece.status] ?? piece.status),
    h("span", { className: "lib-title" }, piece.title),
    piece.video
      ? h("span", { className: "lib-play", "aria-hidden": "true" }, icon([PLAY_ICON], { fill: true, size: 12 }))
      : h("span", { className: "lib-novideo" }, "No video yet"),
  ];
  const thumb = piece.video
    ? h("button", { type: "button", className: "lib-thumb", "aria-label": `Play ${piece.title}`, onClick: () => ctx.play(piece) }, art)
    : h("a", { className: "lib-thumb", href: piece.status === "fix" ? `#/review/${encodeURIComponent(piece.id)}` : "#/pipeline", "aria-label": `${piece.title}, no video yet` }, art);
  return h(
    "li",
    { className: "card lib-card" },
    thumb,
    h("div", { className: "lib-meta" }, h("span", { className: `pill type-${piece.type ?? "none"}` }, typeLabel(piece.type)), h("span", { className: "muted small" }, pieceWhen(piece, ctx.status.today))),
  );
}

function loadError(ctx) {
  const retry = h("button", { type: "button", className: "btn" }, "Retry");
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    retry.textContent = "Retrying…";
    try {
      await ctx.retry();
    } finally {
      // Still here when the retry brought nothing new to draw.
      retry.disabled = false;
      retry.textContent = "Retry";
    }
  });
  return h("div", { className: "banner banner-err banner-row", role: "alert" }, h("span", {}, `Can't load the library: ${ctx.libraryError}`), retry);
}

export function libraryScreen(ctx) {
  const { library, libraryError } = ctx;
  if (libraryError && !library) {
    return h("div", { className: "screen" }, h("div", { className: "screen-head" }, h("h1", {}, "Library")), loadError(ctx));
  }
  const counts = library?.counts ?? {};
  const grid = h("ul", { className: "lib-grid" });
  const drawGrid = () => {
    if (!library) return grid.replaceChildren(h("li", { className: "card empty" }, "Loading the library…"));
    const pieces = shown(library.pieces);
    grid.replaceChildren(...(pieces.length ? pieces.map((p) => card(ctx, p)) : [h("li", { className: "card empty" }, "No pieces match.")]));
  };

  const filters = FILTERS.map(([id, label]) =>
    h("button", { type: "button", className: "filter", "aria-pressed": String(view.filter === id), onClick: () => pick(id) }, `${label} · ${counts[id] ?? 0}`),
  );
  function pick(id) {
    view.filter = id;
    filters.forEach((b, i) => b.setAttribute("aria-pressed", String(FILTERS[i][0] === id)));
    drawGrid();
  }

  const search = h("input", { type: "search", "aria-label": "Search titles and captions", placeholder: "Search titles and captions", value: view.query });
  search.addEventListener("input", () => {
    view.query = search.value;
    drawGrid();
  });
  const sort = h(
    "select",
    { className: "lib-sort", "aria-label": "Sort" },
    SORTS.map(([id, label]) => h("option", { value: id, selected: view.sort === id }, label)),
  );
  sort.addEventListener("change", () => {
    view.sort = sort.value;
    drawGrid();
  });

  drawGrid();
  return h(
    "div",
    { className: "screen" },
    h(
      "div",
      { className: "screen-head" },
      h("h1", {}, "Library"),
      h("div", { className: "lib-tools" }, h("label", { className: "lib-search" }, icon(SEARCH_ICON, { size: 15 }), search), sort),
    ),
    libraryError ? loadError(ctx) : null,
    h("div", { className: "filters", role: "group", "aria-label": "Filter by status" }, filters),
    grid,
    h("p", { className: "muted small" }, "Every finished piece for this campaign: video, cover and caption. Files stay on this computer; nothing here is public."),
  );
}
