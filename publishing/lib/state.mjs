// What has been posted where: state.json in the campaign home, written atomically,
// with dated backups. The platform tokens live in the campaign's secrets.
// State = { version: 1, items: { [id]: { instagram?: Entry, youtube?: Entry } } }
// Entry = { status: "posted"|"manual"|"dropped"|"failed", at, date?, mediaId?, url?, error?, attempts?, reason? }

import fs from "node:fs";
import path from "node:path";
import { isFloating } from "./schedule.mjs";

const DONE = new Set(["posted", "manual", "dropped"]);
const BACKUPS_KEPT = 30;

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    // Never fall back to empty here: an empty state would re-post everything.
    throw new Error(`can't read ${file}: ${err.message}`);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// "YYYYMMDD-HHmmss" in the posting time zone.
function stamp(now, timeZone = "Asia/Kolkata") {
  const p = {};
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

// `timeZone` names the backups; a campaign passes its own.
export function createStateStore(home, { timeZone } = {}) {
  const file = path.join(home, "state.json");
  const backups = path.join(home, "backups");
  return {
    load: () => readJson(file, { version: 1, items: {} }),
    save: (state) => writeJsonAtomic(file, state),
    backup(state, now) {
      const out = path.join(backups, `state-${stamp(now, timeZone)}.json`);
      writeJsonAtomic(out, state);
      const old = fs.readdirSync(backups).filter((f) => /^state-\d{8}-\d{6}\.json$/.test(f)).sort();
      for (const f of old.slice(0, -BACKUPS_KEPT)) fs.rmSync(path.join(backups, f));
      return out;
    },
  };
}

// A campaign's platform tokens, kept in its secrets (campaigns/lib/secrets.mjs).
// Tokens = { instagram?: { token, userId, username, issuedAt }, youtube?: { refreshToken, obtainedAt } }
// The YouTube token's age is when its secret was last set. save() writes only the
// values that changed.
const SECRET_TOKENS = [
  ["IG_ACCESS_TOKEN", "instagram", "token"],
  ["IG_USER_ID", "instagram", "userId"],
  ["IG_USERNAME", "instagram", "username"],
  ["IG_ISSUED_AT", "instagram", "issuedAt"],
  ["YT_REFRESH_TOKEN", "youtube", "refreshToken"],
];

export function createSecretTokenStore(secrets, id) {
  return {
    load() {
      const tokens = {};
      for (const [name, platform, key] of SECRET_TOKENS) {
        const value = secrets.get(id, name);
        if (value !== undefined) tokens[platform] = { ...tokens[platform], [key]: value };
      }
      if (tokens.youtube) tokens.youtube.obtainedAt = secrets.status(id).YT_REFRESH_TOKEN?.updatedAt;
      return tokens;
    },
    save(tokens) {
      for (const [name, platform, key] of SECRET_TOKENS) {
        const raw = tokens[platform]?.[key];
        if (raw == null || raw === "") continue;
        const value = String(raw);
        if (secrets.get(id, name) !== value) secrets.set(id, name, value);
      }
    },
  };
}

export function getEntry(state, id, platform) {
  return state.items[id]?.[platform];
}

// Mutates state in place and returns it.
export function setEntry(state, id, platform, entry) {
  state.items[id] = { ...state.items[id], [platform]: entry };
  return state;
}

export function isDone(state, id, platform) {
  return DONE.has(getEntry(state, id, platform)?.status);
}

// True if `item` is pinned to `date` and holds that day on this platform: it isn't done
// there yet, or it was done on that very day (so a re-run adds nothing). One posted
// early or dropped leaves the day free. The planner and the console's pin share this.
export function holdsDate(state, item, platform, date) {
  if (item.on !== date) return false;
  return !isDone(state, item.id, platform) || getEntry(state, item.id, platform).date === date;
}

// True if item `id` went out on this platform on `date`, posted by us or by hand.
export function postedOn(state, id, platform, date) {
  const entry = getEntry(state, id, platform);
  return (entry?.status === "posted" || entry?.status === "manual") && entry.date === date;
}

// True if a floating item went out on this platform on `date`, posted by us or by hand.
export function postedFloatingOn(state, items, platform, date) {
  return items.some((item) => isFloating(item) && postedOn(state, item.id, platform, date));
}
