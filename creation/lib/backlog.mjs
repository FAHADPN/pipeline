// A campaign's build list (campaign.json's paths.backlog), in calendar order; loaded
// and checked here.
// Entry = { id, kind, format, type, title, premise, targetDate, hook, reference, on?, notBefore?, notAfter? }
// reference is free text for the build session: what to start from, in the brief's
// terms (a finished piece, a template); hook is the ig-reel hook formula number (null
// for greetings).

import fs from "node:fs";
import { isRealDate } from "../../publishing/lib/dates.mjs";

export const FORMATS = ["episode", "this-or-that", "how-many", "two-phones", "greeting", "carousel", "hot-take"];
export const TYPES = ["story", "participation", "teach", "opinion", "offer", "greeting"];
const KINDS = ["ep", "post", "special"];
const ID_RE = /^[a-z0-9-]+$/;
const WINDOW_KEYS = ["on", "notBefore", "notAfter"];
const TEXT_KEYS = ["title", "premise", "reference"];

// Every problem with the entries, as "<id>: problem; problem" lines. [] means valid.
export function validateBacklog(entries) {
  if (!Array.isArray(entries)) return ["backlog must be a JSON array"];
  const errors = [];
  const seen = new Set();
  let lastDate;
  entries.forEach((e, i) => {
    const id = e?.id;
    const label = typeof id === "string" ? id : `entry ${i}`;
    const problems = [];
    if (typeof id !== "string" || !ID_RE.test(id)) problems.push("id must match /^[a-z0-9-]+$/");
    else if (seen.has(id)) problems.push("duplicate id");
    if (typeof id === "string") seen.add(id);
    if (!KINDS.includes(e?.kind)) problems.push(`kind must be one of ${KINDS.join(", ")}`);
    if (!FORMATS.includes(e?.format)) problems.push(`format must be one of ${FORMATS.join(", ")}`);
    if (!TYPES.includes(e?.type)) problems.push(`type must be one of ${TYPES.join(", ")}`);
    for (const key of TEXT_KEYS) {
      if (typeof e?.[key] !== "string" || !e[key].trim()) problems.push(`${key} is missing`);
    }
    if (e?.hook !== null && !(Number.isInteger(e?.hook) && e.hook > 0)) problems.push("hook must be a positive integer or null");
    if (!isRealDate(e?.targetDate)) problems.push(`targetDate is not a real YYYY-MM-DD date: ${e?.targetDate}`);
    else {
      if (lastDate && e.targetDate < lastDate) problems.push(`targetDate ${e.targetDate} is before the previous entry's ${lastDate}`);
      lastDate = e.targetDate;
    }
    for (const key of WINDOW_KEYS) {
      if (e?.[key] !== undefined && !isRealDate(e[key])) problems.push(`${key} is not a real YYYY-MM-DD date: ${e[key]}`);
    }
    if (e?.on !== undefined && (e.notBefore !== undefined || e.notAfter !== undefined)) {
      problems.push("on can't be combined with notBefore/notAfter");
    }
    if (isRealDate(e?.notBefore) && isRealDate(e?.notAfter) && e.notBefore > e.notAfter) {
      problems.push(`notBefore ${e.notBefore} is after notAfter ${e.notAfter}`);
    }
    if (problems.length) errors.push(`${label}: ${problems.join("; ")}`);
  });
  return errors;
}

// The file's layout: two-space JSON, one key per line. The editor keeps its line endings.
export function formatBacklog(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

// The build list in `file` (an absolute path), checked. Throws listing every problem.
export function loadBacklog(file) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`can't read backlog ${file}: ${err.message}`);
  }
  const errors = validateBacklog(entries);
  if (errors.length) throw new Error(`backlog ${file} has ${errors.length} problem(s):\n${errors.join("\n")}`);
  return entries;
}
