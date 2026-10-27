// Build progress: creation-state.json in the campaign's home
// (<publisher home>/campaigns/<id>/), written atomically.
// CState = { items: { [id]: { status, attempts, note?, reason?, at } } }
// An id with no entry is "todo" with 0 attempts. attempts counts failed builds.

import fs from "node:fs";
import path from "node:path";

export const STATUSES = ["todo", "building", "awaiting-approval", "failed", "approved", "redo"];
export const MAX_ATTEMPTS = 2;

// Any status can also go back to "todo" (a manual reset). A failed piece goes to
// "redo" when the owner sends it back with a note from the console.
const MOVES = {
  todo: ["building"],
  building: ["awaiting-approval", "failed"],
  failed: ["building", "redo"],
  "awaiting-approval": ["approved", "redo"],
  redo: ["building"],
  approved: [],
};

export function createCreationStore(home) {
  const file = path.join(home, "creation-state.json");
  return {
    load() {
      if (!fs.existsSync(file)) return { items: {} };
      try {
        return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
      } catch (err) {
        // Never fall back to empty here: that would rebuild every piece.
        throw new Error(`can't read ${file}: ${err.message}`);
      }
    },
    save(cstate) {
      fs.mkdirSync(home, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cstate, null, 2) + "\n");
      fs.renameSync(tmp, file);
    },
  };
}

export function itemState(cstate, id) {
  return cstate.items[id] ?? { status: "todo", attempts: 0 };
}

// Returns a new CState; the input is left alone. extra: { at?, note?, reason? }.
// The redo note is kept through the rebuild, until the piece is approved or reset.
export function transition(cstate, id, to, extra = {}) {
  const prev = itemState(cstate, id);
  if (!STATUSES.includes(to)) throw new Error(`${id}: unknown status ${to}`);
  if (to !== "todo" && !MOVES[prev.status]?.includes(to)) throw new Error(`${id}: can't go from ${prev.status} to ${to}`);
  if (prev.status === "failed" && to === "building" && prev.attempts >= MAX_ATTEMPTS) {
    throw new Error(`${id}: failed ${prev.attempts} attempts, reset it to todo to try again`);
  }
  const { at = new Date().toISOString(), note, reason } = extra;
  const next = { status: to, attempts: to === "todo" ? 0 : prev.attempts ?? 0 };
  if (to === "failed") {
    next.attempts += 1;
    next.reason = reason;
  }
  if (to === "redo") next.note = note;
  else if (prev.note !== undefined && to !== "todo" && to !== "approved") next.note = prev.note;
  next.at = at;
  return { ...cstate, items: { ...cstate.items, [id]: next } };
}
