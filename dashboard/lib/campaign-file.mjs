// The console's edits of a campaign's campaign.json (Connections' approvers, the
// Campaigns screen's pause and settings). The caller holds the campaign's "schedule" lock.
//
//   checkApprovers(value) -> the list with duplicates removed, or throws the refusal:
//     Telegram chat ids (digits, with a leading - for a group), at most 10. Both
//     writers of approvers use it.
//
//   updateCampaignFile({ file, campaignHome, now?, change })
//     reads the file, takes change(config) as the new config and checks it with
//     validateCampaign; then keeps the old copy in <campaign home>/backups/campaign-<time>.json
//     and replaces the file atomically. Throws the refusal and leaves the file alone on any
//     problem. Returns false when the new config is what the file already says (no backup).
//
// The file keeps its own layout and line endings: a changed value is rewritten where it
// is (a list or an object on one line), a new top-level field goes last, and a nested
// field the file doesn't have yet rewrites the object it goes in. Only when that edit
// wouldn't read back as the new config is the file written as plain 2-space JSON. The
// campaign folder may not be a git repo, so nothing is committed.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateCampaign } from "../../campaigns/lib/campaign.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const BOM = /^﻿/;
const CHAT_ID = /^-?\d{1,20}$/;
export const MAX_APPROVERS = 10;

export function checkApprovers(value) {
  if (!Array.isArray(value)) throw new Error("approvers must be a list of chat ids");
  // Not quoted back: a token pasted into the wrong field would be.
  const bad = value.findIndex((a) => typeof a !== "string" || !CHAT_ID.test(a));
  if (bad !== -1) throw new Error(`approver ${bad + 1} isn't a Telegram chat id: digits only, with a leading - for a group`);
  const list = [...new Set(value)];
  if (list.length > MAX_APPROVERS) throw new Error(`at most ${MAX_APPROVERS} approvers`);
  return list;
}

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

// A value on one line: ["a", "b"] or { "a": true }.
function inline(value) {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (isObject(value)) {
    const fields = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
    return fields.length ? `{ ${fields.join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

// Where each object field's value is in a valid JSON text: { start, end } by its path
// of keys joined with "\0". A list is one value; its items aren't indexed.
function valueSpans(text) {
  const spans = new Map();
  let i = 0;
  const space = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  const string = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = (keys) => {
    space();
    const start = i;
    if (text[i] === "{" || text[i] === "[") {
      const object = text[i] === "{";
      i++;
      space();
      while (text[i] !== (object ? "}" : "]")) {
        if (object) {
          const key = string();
          space();
          i++; // the colon
          value(keys && [...keys, key]);
        } else {
          value(null);
        }
        space();
        if (text[i] === ",") i++;
        space();
      }
      i++;
    } else if (text[i] === '"') {
      string();
    } else {
      while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    }
    if (keys?.length) spans.set(keys.join("\0"), { start, end: i });
  };
  value([]);
  return spans;
}

// The paths whose values differ, going into the objects both configs have.
function changedPaths(before, after, at = []) {
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isObject(before[k]) && isObject(after[k])) out.push(...changedPaths(before[k], after[k], [...at, k]));
    else if (!isDeepStrictEqual(before[k], after[k])) out.push([...at, k]);
  }
  return out;
}

const valueAt = (obj, keys) => keys.reduce((o, k) => o?.[k], obj);

// `original` edited to say `after`, or null when a field was removed.
function editInPlace(original, before, after) {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? "  ";
  const spans = valueSpans(original);
  const edits = new Map();
  let added = "";
  for (const keys of changedPaths(before, after)) {
    if (valueAt(after, keys) === undefined) return null;
    // The value itself, else the nearest object it goes in that the text has.
    let depth = keys.length;
    while (depth > 0 && !spans.has(keys.slice(0, depth).join("\0"))) depth--;
    if (depth === 0) {
      added += `,${eol}${indent}${JSON.stringify(keys[0])}: ${inline(after[keys[0]])}`;
      continue;
    }
    const target = keys.slice(0, depth);
    edits.set(target.join("\0"), { ...spans.get(target.join("\0")), text: inline(valueAt(after, target)) });
  }
  // An edit inside another one is already part of it.
  const all = [...edits.values()];
  const outer = all.filter((e) => !all.some((o) => o !== e && o.start <= e.start && e.end <= o.end));
  let text = original;
  for (const e of outer.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return added ? text.replace(/\s*\}\s*$/, (end) => `${added}${end}`) : text;
}

// campaign.json's text for `after`, in the layout of `original` (which says `before`).
function campaignText(original, before, after) {
  try {
    const edited = editInPlace(original, before, after);
    if (edited !== null && isDeepStrictEqual(JSON.parse(edited.replace(BOM, "")), after)) return edited;
  } catch {
    // Fall through to the plain layout.
  }
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  return JSON.stringify(after, null, 2).replace(/\n/g, eol) + eol;
}

export function updateCampaignFile({ file, campaignHome, now = () => new Date(), change }) {
  const original = fs.readFileSync(file, "utf8");
  let config;
  try {
    config = JSON.parse(original.replace(BOM, ""));
  } catch {
    throw new Error("campaign.json isn't valid JSON; fix it by hand first");
  }
  const next = change(structuredClone(config));
  const problems = validateCampaign(next);
  if (problems.length) throw new Error(`campaign.json would be invalid: ${problems.join("; ")}`);
  const updated = campaignText(original, config, next);
  if (updated === original) return false;
  const backups = path.join(campaignHome, "backups");
  fs.mkdirSync(backups, { recursive: true });
  // Two saves within a millisecond keep both copies.
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  let backup = path.join(backups, `campaign-${stamp}.json`);
  for (let n = 2; fs.existsSync(backup); n++) backup = path.join(backups, `campaign-${stamp}-${n}.json`);
  fs.writeFileSync(backup, original);
  writeAtomic(file, updated);
  return true;
}
