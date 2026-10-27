// The player: one component for every screen. On a desktop it's a modal with the
// video on the left and the details on the right; under 760 px it fills the screen
// and plays the 720p preview. The video is the browser's own <video controls>.
//
//   openPlayer(piece, { canAct, onAction, today }) -> { close }
//     piece:    a library Piece (/api/library)
//     canAct:   show the controls that change something
//     onAction: async (name, piece, args) for "postNow", "pin" ({ date }), "hold",
//               "release", "unpin", "drop", "approve" and "redo" ({ note }); the app
//               confirms what needs it, closes the player when the action worked and
//               reports either way
//     today:    the campaign's today, for "Today" labels and the earliest move date
//
// Buttons follow "Actions by status" in the console spec. Redo opens the note box
// (screens/review.js) above the buttons. While an action runs its button shows busy
// and every other control waits. Escape, the close button or a click outside closes
// it, and focus goes back to whatever opened it.

import { fill, h, icon, markBusy } from "./dom.js";
import { addQuery, pieceWhen, STATUS_LABELS, typeLabel } from "./lib/format.js";
import { redoForm } from "./screens/review.js";

const PHONE = "(max-width: 759px)";
const CLOSE_ICON = "M6 6l12 12M18 6L6 18";
const COPIED_MS = 2000;
// The controls that wait while an action runs.
const CONTROLS = ".player-move input, .player-move button, .player-note textarea, .player-note button, .player-actions button";

let open = null;

function button(label, { primary = false, onClick, disabled = false } = {}) {
  return h("button", { type: "button", className: primary ? "btn btn-primary" : "btn", onClick, disabled }, label);
}

// A button that runs action `name` with `args`, shown busy while it runs.
function actionButton(label, run, name, args, { primary = false } = {}) {
  const b = button(label, { primary, onClick: () => run(name, args, b) });
  return b;
}

// Move date: a date from today on, pinned with Save.
function moveRow(piece, today, run) {
  const input = h("input", {
    type: "date",
    id: "player-date",
    className: "player-date",
    min: today,
    value: piece.date && today && piece.date >= today ? piece.date : undefined,
  });
  const save = button("Save", {
    onClick: () => (input.value ? run("pin", { date: input.value }, save) : input.focus()),
  });
  return h("div", { className: "player-move" }, h("label", { for: "player-date" }, "Move date"), input, save);
}

// Approve, and Redo, which opens the note box in `slot`; Send runs "redo" with the note.
function approvalControls(run, slot) {
  const redo = button("Redo", {
    onClick: () => {
      const cancel = () => {
        fill(slot);
        redo.focus();
      };
      const form = redoForm({ id: "player-note", onSend: (note, send) => run("redo", { note }, send), onCancel: cancel });
      fill(slot, form);
      form.querySelector("textarea").focus();
    },
  });
  return [actionButton("Approve", run, "approve", undefined, { primary: true }), redo];
}

// The controls that change something, by status. Post now posts the next queued item
// as the scheduler would, and any other Ready piece right away (the app decides which).
// `move` is the row above the buttons: Move date, or the redo note's slot.
function changeControls(piece, { today, run }) {
  const unpin = piece.pinned ? [actionButton("Unpin", run, "unpin")] : [];
  const drop = actionButton("Drop", run, "drop");
  switch (piece.status) {
    case "ready":
      return {
        move: moveRow(piece, today, run),
        buttons: [actionButton("Post now", run, "postNow", undefined, { primary: true }), actionButton("Hold", run, "hold"), ...unpin, drop],
      };
    case "held":
      return { move: moveRow(piece, today, run), buttons: [actionButton("Release", run, "release"), ...unpin, drop] };
    case "awaiting": {
      const slot = h("div", { className: "player-note" });
      return { move: slot, buttons: approvalControls(run, slot) };
    }
    default:
      return { move: null, buttons: [] };
  }
}

function copyButton(caption) {
  const b = button("Copy caption", { disabled: !caption });
  if (!caption) {
    b.setAttribute("title", "No caption yet");
    return b;
  }
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(caption);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Couldn't copy";
    }
    setTimeout(() => (b.textContent = "Copy caption"), COPIED_MS);
  });
  return b;
}

function media(piece, phone) {
  if (!piece.video) {
    return h(
      "div",
      { className: "player-novideo" },
      piece.cover ? h("img", { src: piece.cover, alt: "" }) : null,
      h("span", {}, "No video yet"),
    );
  }
  return h("video", {
    className: "player-video",
    controls: true,
    playsinline: true,
    preload: "metadata",
    poster: piece.cover ?? undefined,
    src: phone ? addQuery(piece.video, { variant: "preview" }) : piece.video,
    "aria-label": piece.title,
  });
}

export function openPlayer(piece, { canAct = false, onAction = async () => {}, today } = {}) {
  open?.close();
  const opener = document.activeElement;
  const phone = matchMedia(PHONE).matches;

  const actionRow = h("div", { className: "player-actions" });
  // One action at a time: the button that started it shows busy and the rest wait.
  let running = false;
  async function run(name, args, from) {
    if (running) return;
    running = true;
    const done = markBusy(from);
    const others = [...dialog.querySelectorAll(CONTROLS)].filter((el) => el !== from);
    const was = others.map((el) => el.disabled);
    for (const el of others) el.disabled = true;
    try {
      await onAction(name, piece, args);
    } finally {
      others.forEach((el, i) => (el.disabled = was[i]));
      done();
      running = false;
    }
  }

  const links = [];
  if (piece.status === "posted" && /^https:\/\//i.test(piece.url ?? "")) {
    links.push(h("a", { className: "btn btn-primary", href: piece.url, target: "_blank", rel: "noopener noreferrer" }, "Open on Instagram"));
  }
  const change = canAct ? changeControls(piece, { today, run }) : { move: null, buttons: [] };
  actionRow.append(
    ...change.buttons,
    ...links,
    copyButton(piece.caption),
    ...(piece.video ? [h("a", { className: "btn", href: addQuery(piece.video, { download: "1" }), download: true }, "Download")] : []),
  );

  const closeButton = h(
    "button",
    { type: "button", className: "player-close", "aria-label": "Close player", onClick: () => close() },
    icon([CLOSE_ICON], { size: 18 }),
  );
  const video = media(piece, phone);
  const dialog = h(
    "div",
    { className: "player", role: "dialog", "aria-modal": "true", "aria-labelledby": "player-title" },
    h("div", { className: "player-media" }, video),
    h(
      "div",
      { className: "player-info" },
      h(
        "div",
        { className: "player-top" },
        h(
          "div",
          { className: "pills" },
          h("span", { className: `pill status-${piece.status}` }, STATUS_LABELS[piece.status] ?? piece.status),
          piece.type ? h("span", { className: `pill type-${piece.type}` }, typeLabel(piece.type)) : null,
        ),
        closeButton,
      ),
      h("h2", { id: "player-title", className: "player-title" }, piece.title),
      h("p", { className: "muted" }, pieceWhen(piece, today)),
      piece.reason ? h("p", { className: "player-reason" }, piece.reason) : null,
      h("div", { className: "player-caption" }, piece.caption ?? "No caption yet."),
      h("p", { className: "mono muted small" }, phone ? "Playing the 720p preview" : "1080×1920 MP4 · phones play a 720p preview"),
      change.move,
      actionRow,
    ),
  );
  const backdrop = h("div", { className: "player-backdrop", onClick: (e) => e.target === backdrop && close() }, dialog);

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog while it is open.
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], video")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function close() {
    if (open !== handle) return;
    open = null;
    if (video.pause) video.pause();
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    document.body.classList.remove("player-open");
    // A refresh may have redrawn the opener while the player was open.
    if (opener && document.contains(opener)) opener.focus();
    else document.getElementById("main")?.focus();
  }

  const handle = { close };
  open = handle;
  document.addEventListener("keydown", onKey);
  document.body.classList.add("player-open");
  document.body.append(backdrop);
  closeButton.focus();
  return handle;
}

// Closes the player if one is open.
export function closePlayer() {
  open?.close();
}
