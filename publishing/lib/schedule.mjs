// The posting queue: a campaign's schedule.json, an ordered list of items.
// Item = { id, kind: "ep"|"post"|"special", dir, on?, notBefore?, notAfter?, targetDate?, thumbOffsetMs?,
//          title?, type?, hold? }
// title and type (1-80 and 1-40 characters) label the piece in the console; hold: true
// keeps it from posting (the planner skips it, see isHeld). Here they are only checked
// for shape.
// targetDate is the calendar day a built piece was planned for. It's only checked
// as a date here; the planner ignores it.

import fs from "node:fs";
import path from "node:path";
import { isRealDate } from "./dates.mjs";

const ID_RE = /^[a-z0-9-]+$/;
const KINDS = ["ep", "post", "special"];
const TITLE_MAX = 80;
const TYPE_MAX = 40;
const DATE_KEYS = ["on", "notBefore", "notAfter", "targetDate"];

export function validateSchedule(items, repoRoot) {
  if (!Array.isArray(items)) return ["schedule must be a JSON array"];
  const errors = [];
  const seen = new Set();
  items.forEach((item, i) => {
    const id = item?.id;
    const label = typeof id === "string" ? id : `item ${i}`;
    const problems = [];
    if (typeof id !== "string" || !ID_RE.test(id)) problems.push("id must match /^[a-z0-9-]+$/");
    else if (seen.has(id)) problems.push("duplicate id");
    if (typeof id === "string") seen.add(id);
    if (!KINDS.includes(item?.kind)) problems.push(`kind must be one of ${KINDS.join(", ")}`);
    if (typeof item?.dir !== "string" || !item.dir) problems.push("dir is missing");
    else if (!fs.statSync(path.join(repoRoot, item.dir), { throwIfNoEntry: false })?.isDirectory()) {
      problems.push(`dir not found: ${item.dir}`);
    }
    for (const key of DATE_KEYS) {
      if (item?.[key] !== undefined && !isRealDate(item[key])) problems.push(`${key} is not a real YYYY-MM-DD date: ${item[key]}`);
    }
    if (item?.on !== undefined && (item.notBefore !== undefined || item.notAfter !== undefined)) {
      problems.push("on can't be combined with notBefore/notAfter");
    }
    if (isRealDate(item?.notBefore) && isRealDate(item?.notAfter) && item.notBefore > item.notAfter) {
      problems.push(`notBefore ${item.notBefore} is after notAfter ${item.notAfter}`);
    }
    if (item?.thumbOffsetMs !== undefined && !(Number.isInteger(item.thumbOffsetMs) && item.thumbOffsetMs >= 0)) {
      problems.push("thumbOffsetMs must be a non-negative integer");
    }
    for (const [key, max] of [["title", TITLE_MAX], ["type", TYPE_MAX]]) {
      const v = item?.[key];
      if (v !== undefined && !(typeof v === "string" && v.length >= 1 && v.length <= max)) {
        problems.push(`${key} must be a string of 1-${max} characters`);
      }
    }
    if (item?.hold !== undefined && typeof item.hold !== "boolean") problems.push("hold must be true or false");
    if (problems.length) errors.push(`${label}: ${problems.join("; ")}`);
  });
  return errors;
}

export function loadSchedule(file, repoRoot) {
  const full = path.resolve(repoRoot, file);
  let items;
  try {
    items = JSON.parse(fs.readFileSync(full, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`can't read schedule ${full}: ${err.message}`);
  }
  const errors = validateSchedule(items, repoRoot);
  if (errors.length) throw new Error(`schedule ${full} has ${errors.length} problem(s):\n${errors.join("\n")}`);
  return items;
}

export function isFloating(item) {
  return item.on === undefined;
}

// A held item never posts and isn't counted ready. A held pinned item whose date
// passes is still dropped.
export function isHeld(item) {
  return item.hold === true;
}

export function inWindow(item, today) {
  if (item.notBefore !== undefined && today < item.notBefore) return false;
  if (item.notAfter !== undefined && today > item.notAfter) return false;
  return true;
}
