// Tonight's builds, from the backlog and creation-state.json. Pure.
// Order: redo items, then failed items with attempts left, then todo items,
// each in backlog (calendar) order, capped at maxBuilds. Nothing is picked
// while maxAwaiting or more pieces wait for the user's approval.

import { FORMATS } from "./backlog.mjs";
import { MAX_ATTEMPTS, itemState } from "./cstate.mjs";

// Carousels need their own plan (slide contract, publishing) before they can be built.
export const SUPPORTED_FORMATS = FORMATS.filter((f) => f !== "carousel");
// hot-take is left out of the default nightly formats: a campaign that wants it every
// night lists it in its formats, and any campaign can build one by hand (onlyId).
export const DEFAULT_FORMATS = SUPPORTED_FORMATS.filter((f) => f !== "hot-take");
export const PICKER_DEFAULTS = { maxBuilds: 2, maxAwaiting: 6, formats: DEFAULT_FORMATS };

function rank(item) {
  if (item.status === "redo") return 0;
  if (item.status === "failed" && (item.attempts ?? 0) < MAX_ATTEMPTS) return 1;
  if (item.status === "todo") return 2;
  return -1;
}

// onlyId is a build started by hand: it ignores the caps and the nightly
// formats (so a hot-take can be built), but not the status rules or
// unsupported formats.
export function pickWork({
  backlog,
  cstate,
  maxBuilds = PICKER_DEFAULTS.maxBuilds,
  maxAwaiting = PICKER_DEFAULTS.maxAwaiting,
  formats = PICKER_DEFAULTS.formats,
  onlyId,
}) {
  if (onlyId !== undefined) {
    const e = backlog.find((x) => x.id === onlyId);
    const allowed = e && (formats.includes(e.format) || SUPPORTED_FORMATS.includes(e.format));
    return allowed && rank(itemState(cstate, e.id)) >= 0 ? [e.id] : [];
  }
  const awaiting = Object.values(cstate.items).filter((i) => i.status === "awaiting-approval").length;
  if (awaiting >= maxAwaiting) return [];
  const buckets = [[], [], []];
  for (const e of backlog) {
    if (!formats.includes(e.format)) continue;
    const r = rank(itemState(cstate, e.id));
    if (r >= 0) buckets[r].push(e.id);
  }
  return buckets.flat().slice(0, maxBuilds);
}
