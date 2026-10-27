// The Review screen. #/review lists every piece that waits for the owner: awaiting
// approval, failed, back for a redo or in the build queue, newest first. #/review/<id>
// shows one piece: its video (opening the player), the /ig skill checks, the reviewer's
// verdict, scores and must-fix list (or, for a piece reviewed before verdicts were kept,
// the last result), the caption and the YouTube title, and the actions its status allows.
// While it builds, its progress and log lines show; the app polls them. A queued piece
// shows "Queued #n", and Remove from queue in place of Build again now and Recheck.
//
// A failed or redo piece leads with why it stopped. Its checks and review may come from
// an earlier attempt than the one that stopped, so they show as "Last checks" and
// "Last review".
//
//   reviewScreen(ctx) -> Node, where ctx = { id, review, list, build, starting, canAct,
//                        today, play(piece), act(name, piece, args, el) }
//     id:       the piece shown, or null for the list
//     review:   { data: Review (/api/review?id=), error } for that piece; null while it loads
//     list:     { data: [...] (/api/review's pieces), error }; null while it loads
//     build:    /api/build's progress for the piece, or null
//     starting: "buildNow" or "recheck" when one was just started for the piece and
//               hasn't finished starting; Build again now and Recheck wait meanwhile
//     act:      runs "approve", "redo" ({ note }), "recheck", "buildNow" or "unqueue"; `el`
//               shows busy
//   redoForm({ id, onSend(note, button), onCancel }) -> Node
//     the redo note: at most 500 characters with a live counter; a blank one isn't sent.
//     The player uses it too.
//
// Every reviewer, caption and log text is a text node (dom.js), never markup.

import { fill, h, icon } from "../dom.js";
import { dayLabel, typeLabel } from "../lib/format.js";

const MAX_NOTE = 500;
const PLAY_ICON = "M8 5v14l11-7z";
const STATUS = {
  "awaiting-approval": ["Awaiting approval", "status-awaiting"],
  failed: ["Needs fixing", "status-fix"],
  redo: ["Back for a redo", "status-fix"],
  building: ["Building", "status-ready"],
  approved: ["Approved", "status-posted"],
  todo: ["Not built yet", ""],
};
// The skill scripts' results in <id>.checks.json, as tiles.
const TILES = [
  ["caption_py", "caption.py"],
  ["detect_caption", "AI-detect · caption"],
  ["detect_onscreen", "AI-detect · on-screen"],
  ["hook_caption", "Hook · caption"],
  ["hook_onscreen", "Hook · on-screen"],
];
const GOOD = new Set(["READY", "PASS", "STRONG", "OK"]);
const BAD = new Set(["FIX", "FAIL", "WEAK", "FLAGGED"]);
const SCORES = { director: "Director", copy_art_ui: "Copy, art and UI", brand: "Brand", forensics: "Forensics" };

function statusPill(status) {
  const [label, tone] = STATUS[status] ?? [status, ""];
  return h("span", { className: `pill ${tone}`.trim() }, label);
}

// "Queued #2" while the piece waits in the build queue, else null.
function queuedPill(queued) {
  return queued ? h("span", { className: "pill status-held" }, `Queued #${queued.position}`) : null;
}

// The library-style piece the player and the app's actions take. A piece awaiting
// approval gets the player's Approve and Redo.
function playerPiece(r) {
  const status = r.status === "awaiting-approval" ? "awaiting" : r.status === "failed" || r.status === "redo" ? "fix" : r.status;
  return { id: r.id, title: r.title, type: r.type, status, date: null, pinned: false, video: r.video, cover: r.cover, caption: r.caption, youtubeTitle: r.youtubeTitle, reason: r.reason };
}

// "45 s", "3 min", "1 h 05 min".
function duration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export function redoForm({ id = "redo-note", onSend, onCancel }) {
  const area = h("textarea", { id, className: "note-input", maxlength: MAX_NOTE, rows: 4, placeholder: "What should change?" });
  const counter = h("span", { className: "note-count muted small", "aria-live": "polite" }, `0 / ${MAX_NOTE}`);
  const send = h(
    "button",
    {
      type: "button",
      className: "btn btn-primary",
      disabled: true,
      onClick: () => {
        const note = (area.value ?? "").trim();
        if (note) onSend(note, send);
      },
    },
    "Send for redo",
  );
  area.addEventListener("input", () => {
    counter.textContent = `${area.value.length} / ${MAX_NOTE}`;
    send.disabled = !area.value.trim();
  });
  return h(
    "div",
    { className: "note-form" },
    h("label", { for: id }, "Redo with a note"),
    area,
    h("div", { className: "note-row" }, counter, h("button", { type: "button", className: "btn", onClick: () => onCancel() }, "Cancel"), send),
  );
}

function media(r, ctx) {
  const art = [
    r.cover ? h("img", { src: r.cover, alt: "" }) : null,
    r.video ? h("span", { className: "playdot", "aria-hidden": "true" }, icon([PLAY_ICON], { fill: true, size: 16 })) : h("span", { className: "review-novideo" }, "No video yet"),
  ];
  if (!r.video) return h("div", { className: "review-thumb" }, art);
  return h("button", { type: "button", className: "review-thumb", "aria-label": `Play ${r.title}`, onClick: () => ctx.play(playerPiece(r)) }, art);
}

// The checks as tiles: each script's verdict and score, or "Not run".
export function checkTiles(checks) {
  return TILES.map(([key, name]) => {
    const raw = checks?.[key];
    if (raw === null || raw === undefined) return { name, value: "Not run", tone: "none" };
    const verdict = typeof raw === "object" ? raw.verdict : raw;
    const score = typeof raw === "object" ? (raw.human_score ?? raw.score) : undefined;
    const value = [verdict, score].filter((v) => v !== null && v !== undefined).map(String).join(" ") || "?";
    return { name, value, tone: GOOD.has(verdict) ? "ok" : BAD.has(verdict) ? "bad" : "warn" };
  });
}

// True for a piece whose build stopped: its checks and review may be an earlier attempt's.
const stopped = (r) => r.status === "failed" || r.status === "redo";

function whyCard(r) {
  const reason = r.reason ?? (r.status === "redo" ? "You sent it back for a redo." : "No reason was recorded.");
  return h("section", { className: "card review-card review-why" }, h("h2", {}, "Why it stopped"), h("p", {}, reason));
}

function checksCard(r) {
  const { checks } = r;
  const body = checks
    ? [
        h(
          "div",
          { className: "review-tiles" },
          checkTiles(checks).map((t) => h("div", { className: "review-tile" }, h("span", { className: "muted small" }, t.name), h("span", { className: `review-tile-value tone-${t.tone}` }, t.value))),
        ),
        Array.isArray(checks.skipped) && checks.skipped.length ? h("p", { className: "muted small" }, `Skipped: ${checks.skipped.join("; ")}`) : null,
      ]
    : h("p", { className: "muted small" }, "No checks recorded for this piece yet.");
  return h("section", { className: "card review-card" }, h("h2", {}, stopped(r) ? "Last checks" : "Your /ig skill checks"), body);
}

// The reviewer's verdict, scores, must-fix and nice-to-have lists, in one card. A
// failed or redo piece's reason is already in Why it stopped, so a missing review
// shows nothing more there; any other piece without one shows its Last result.
function verdictCard(r) {
  const v = r.review;
  if (!v) {
    if (stopped(r)) return null;
    return h("section", { className: "card review-card review-last" }, h("h2", {}, "Last result"), h("p", {}, r.reason ?? "No result recorded yet."));
  }
  const scores = Object.entries(v.scores ?? {});
  return h(
    "section",
    { className: "card review-card review-verdict" },
    h("h2", {}, stopped(r) ? "Last review" : "Reviewer"),
    v.summary ? h("p", {}, v.summary) : null,
    scores.length
      ? h("dl", { className: "review-scores" }, scores.map(([k, n]) => h("div", {}, h("dt", { className: "muted small" }, SCORES[k] ?? k), h("dd", {}, String(n ?? "?")))))
      : null,
    v.must_fix.length ? [h("h3", {}, "Must fix"), h("ol", { className: "review-mustfix" }, v.must_fix.map((item) => h("li", {}, String(item))))] : null,
    v.nice_to_have.length ? [h("h3", {}, "Nice to have"), h("ul", { className: "review-nice" }, v.nice_to_have.map((item) => h("li", {}, String(item))))] : null,
  );
}

function progressCard(r, ctx) {
  if (r.status !== "building" && !ctx.starting) return null;
  const elapsed = ctx.build?.elapsedSeconds;
  const lines = ctx.build?.lines ?? [];
  let title = ctx.starting === "recheck" ? "Rechecking…" : "Starting the build…";
  if (r.status === "building") title = `Building${elapsed === null || elapsed === undefined ? "" : ` for ${duration(elapsed)}`}`;
  return h(
    "section",
    { className: "card review-card review-progress", "aria-live": "polite" },
    h("h2", {}, title),
    h("p", { className: "muted small" }, "The build prints its log when each step ends. This page checks every 5 seconds."),
    lines.length ? h("ol", { className: "build-lines mono small" }, lines.map((line) => h("li", {}, line))) : h("p", { className: "muted small" }, "No log lines yet."),
  );
}

// The buttons the piece's status allows, and the slot the redo note opens in.
function actions(r, ctx) {
  if (!ctx.canAct) return null;
  const piece = playerPiece(r);
  const slot = h("div", { className: "review-note" });
  const button = (label, name, { primary = false, disabled = false } = {}) => {
    const b = h("button", { type: "button", className: primary ? "btn btn-primary" : "btn", disabled, onClick: () => ctx.act(name, piece, {}, b) }, label);
    return b;
  };
  // Once a build or recheck is starting, a second one must wait: it could start before
  // the first takes the creation lock.
  const starting = Boolean(ctx.starting);
  // A queued piece starts on its own; its way out takes Build again's and Recheck's place.
  const remove = r.queued ? button("Remove from queue", "unqueue") : null;
  const buildNow = () => remove ?? button("Build again now", "buildNow", { primary: true, disabled: starting });
  const recheck = () => remove ?? (r.video ? button("Recheck", "recheck", { disabled: starting }) : null);
  const redo = h(
    "button",
    {
      type: "button",
      className: "btn",
      onClick: () => {
        const form = redoForm({ onSend: (note, el) => ctx.act("redo", piece, { note }, el), onCancel: () => fill(slot) });
        fill(slot, form);
        form.querySelector("textarea").focus();
      },
    },
    "Redo with a note",
  );
  const parked = h("a", { className: "btn", href: "#/review" }, "Keep parked");

  let buttons = [];
  if (r.status === "awaiting-approval") buttons = [button("Approve", "approve", { primary: true }), redo, remove];
  else if (r.status === "failed") buttons = [r.canBuild ? buildNow() : redo, recheck(), parked];
  else if (r.status === "redo") buttons = [r.canBuild ? buildNow() : remove, parked];
  else if (r.status !== "building") buttons = [remove];
  // Remove from queue once, where Build again and Recheck both were.
  buttons = [...new Set(buttons.filter(Boolean))];
  if (!buttons.length) return null;
  return [h("div", { className: "review-actions" }, buttons), slot];
}

function pieceScreen(ctx) {
  const head = (detail) => h("div", { className: "screen-head" }, h("h1", {}, "Review"), detail ? h("span", { className: "muted" }, detail) : null);
  if (!ctx.review) return h("div", { className: "screen" }, head(null), h("p", { className: "muted" }, "Loading…"));
  if (ctx.review.error) {
    return h("div", { className: "screen" }, head(null), h("p", { className: "banner banner-err" }, `Can't load ${ctx.id}: ${ctx.review.error}`), h("a", { href: "#/review" }, "Back to the list"));
  }
  const r = ctx.review.data;
  const v = r.review;
  return h(
    "div",
    { className: "screen" },
    head(r.title),
    h(
      "div",
      { className: "review" },
      h("div", { className: "review-media" }, media(r, ctx)),
      h(
        "div",
        { className: "review-info" },
        h(
          "div",
          { className: "pills review-pills" },
          statusPill(r.status),
          queuedPill(r.queued),
          v ? h("span", { className: `pill ${v.verdict === "SHIP" ? "status-posted" : "status-fix"}` }, `${stopped(r) ? "Last review" : "Reviewer"}: ${v.verdict ?? "?"}`) : null,
          h("span", { className: "muted small" }, [typeLabel(r.type), r.id, r.attempts ? `${r.attempts} failed build${r.attempts === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")),
        ),
        progressCard(r, ctx),
        stopped(r) ? whyCard(r) : null,
        r.note ? h("section", { className: "card review-card" }, h("h2", {}, "Your note"), h("p", {}, r.note)) : null,
        checksCard(r),
        verdictCard(r),
        h(
          "section",
          { className: "card review-card" },
          h("h2", {}, "Caption"),
          h("p", { className: "review-caption" }, r.caption ?? "No caption yet."),
          h("p", { className: "muted small" }, `YouTube title: ${r.youtubeTitle ?? "none yet"}`),
        ),
        actions(r, ctx),
      ),
    ),
  );
}

function listScreen(ctx) {
  const head = h("div", { className: "screen-head" }, h("h1", {}, "Review"), h("span", { className: "muted" }, "Pieces waiting for you"));
  if (!ctx.list) return h("div", { className: "screen" }, head, h("p", { className: "muted" }, "Loading…"));
  if (ctx.list.error) return h("div", { className: "screen" }, head, h("p", { className: "banner banner-err" }, `Can't load the pieces to review: ${ctx.list.error}`));
  if (!ctx.list.data.length) return h("div", { className: "screen" }, head, h("p", { className: "card empty" }, "Nothing waits for review."));
  return h(
    "div",
    { className: "screen" },
    head,
    h(
      "ul",
      { className: "review-list" },
      ctx.list.data.map((p) =>
        h(
          "li",
          {},
          h(
            "a",
            { className: "card review-row", href: `#/review/${encodeURIComponent(p.id)}` },
            h("span", { className: "review-row-thumb" }, p.cover ? h("img", { src: p.cover, alt: "", loading: "lazy" }) : null),
            h(
              "span",
              { className: "review-row-body" },
              h("span", { className: "review-row-head" }, h("span", { className: "review-row-title" }, p.title), statusPill(p.status), queuedPill(p.queued)),
              p.reason ? h("span", { className: "review-row-reason muted small" }, p.reason) : null,
              h("span", { className: "muted small" }, [typeLabel(p.type), p.at ? dayLabel(p.at.slice(0, 10), ctx.today) : null].filter(Boolean).join(" · ")),
            ),
          ),
        ),
      ),
    ),
  );
}

export function reviewScreen(ctx) {
  return ctx.id ? pieceScreen(ctx) : listScreen(ctx);
}
