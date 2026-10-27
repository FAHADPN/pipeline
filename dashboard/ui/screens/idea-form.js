// The build-list idea form: "+ Idea" and a card's Edit open it. A dialog on a desktop and a
// full-screen sheet on a phone (styles.css), with a label on every field and a live
// counter on the premise.
//
//   openIdeaForm({ idea?, formats, types, today, onSave(entry, button) -> result, onClose })
//     idea:   { id, title, type, idea: { premise, format, targetDate, notBefore?, notAfter? } }
//             (a Pipeline card), or none for a new idea
//     onSave: sends the fields ({ id? } plus the form's) and resolves { ok, error? }; the
//             form closes on ok and shows the error under the fields otherwise
//   -> { close }

import { h, markBusy } from "../dom.js";
import { typeLabel } from "../lib/format.js";

export const MAX_TITLE = 80;
export const MAX_PREMISE = 1000;

const formatLabel = (f) => f.charAt(0).toUpperCase() + f.slice(1).replaceAll("-", " ");

let open = null;

export function openIdeaForm({ idea = null, formats, types, today, onSave, onClose = () => {} }) {
  open?.close();
  const opener = document.activeElement;
  const start = idea?.idea ?? {};

  const field = (id, label, control, hint) =>
    h("div", { className: "idea-field" }, h("label", { for: id }, label), control, hint ?? null);
  const select = (id, values, label, current) => {
    const el = h("select", { id, className: "idea-input" }, values.map((v) => h("option", { value: v }, label(v))));
    if (current !== undefined && values.includes(current)) el.value = current;
    return el;
  };
  const input = (id, type, value, props = {}) => {
    const el = h("input", { id, type, className: "idea-input", ...props });
    el.value = value ?? "";
    return el;
  };
  const date = (id, value, min) => input(id, "date", value, { min });

  const title = input("idea-title", "text", idea?.title, { maxlength: MAX_TITLE });
  const premise = h("textarea", { id: "idea-premise", className: "idea-input idea-premise", maxlength: MAX_PREMISE, rows: 6 });
  premise.value = start.premise ?? "";
  const count = h("span", { className: "note-count muted small", "aria-live": "polite" });
  const showCount = () => {
    count.textContent = `${premise.value.length} / ${MAX_PREMISE}`;
  };
  premise.addEventListener("input", showCount);
  showCount();
  const format = select("idea-format", formats, formatLabel, start.format);
  const type = select("idea-type", types, typeLabel, idea?.type);
  // Only a new idea must aim at today or later: an edit keeps whatever date it has.
  const targetDate = date("idea-date", start.targetDate, idea ? undefined : today);
  const notBefore = date("idea-not-before", start.notBefore);
  const notAfter = date("idea-not-after", start.notAfter);
  const problem = h("p", { className: "banner banner-err idea-error", role: "alert", hidden: true });

  const fail = (text) => {
    problem.textContent = text;
    problem.hidden = false;
  };
  const save = h("button", { type: "submit", className: "btn btn-primary" }, idea ? "Save" : "Add idea");
  const cancel = h("button", { type: "button", className: "btn", onClick: () => close() }, "Cancel");

  const form = h(
    "form",
    {
      className: "idea-form",
      onSubmit: async (e) => {
        e.preventDefault();
        const text = title.value.trim();
        const body = premise.value.trim();
        if (!text) return fail("Give it a title.");
        if (!body) return fail("Write a premise.");
        if (!targetDate.value) return fail("Pick a target date.");
        problem.hidden = true;
        const entry = {
          ...(idea ? { id: idea.id } : {}),
          title: text,
          premise: body,
          format: format.value,
          type: type.value,
          targetDate: targetDate.value,
          ...(notBefore.value ? { notBefore: notBefore.value } : {}),
          ...(notAfter.value ? { notAfter: notAfter.value } : {}),
        };
        const done = markBusy(save);
        let out;
        try {
          out = await onSave(entry, save);
        } finally {
          done();
        }
        if (out?.ok) close();
        else fail(out?.error ?? "Something went wrong.");
      },
    },
    field("idea-title", "Title", title, h("span", { className: "muted small" }, `Up to ${MAX_TITLE} characters`)),
    field("idea-premise", "Premise", premise, h("div", { className: "note-row" }, count)),
    h("div", { className: "idea-pair" }, field("idea-format", "Format", format), field("idea-type", "Type", type)),
    field("idea-date", "Target date", targetDate),
    h("div", { className: "idea-pair" }, field("idea-not-before", "Not before (optional)", notBefore), field("idea-not-after", "Not after (optional)", notAfter)),
    problem,
    h("div", { className: "note-row idea-buttons" }, cancel, save),
  );
  const dialog = h("div", { className: "idea-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "idea-heading" }, h("h2", { id: "idea-heading" }, idea ? "Edit idea" : "New idea"), form);
  const backdrop = h("div", { className: "idea-backdrop", onClick: (e) => e.target === backdrop && close() }, dialog);

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog while it is open.
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])")];
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
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    document.body.classList.remove("player-open");
    if (opener && document.contains(opener)) opener.focus();
    else document.getElementById("main")?.focus();
    onClose();
  }

  const handle = { close };
  open = handle;
  document.addEventListener("keydown", onKey);
  document.body.classList.add("player-open");
  document.body.append(backdrop);
  title.focus();
  return handle;
}

// Closes the form if one is open.
export function closeIdeaForm() {
  open?.close();
}
