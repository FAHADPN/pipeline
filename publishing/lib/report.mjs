// The plain-text run report sent to Telegram after every run. One line per
// event, in a fixed order, so a glance at the phone says what happened.

import { parseSlot, weekday } from "./dates.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PLATFORMS = { instagram: "Instagram", youtube: "YouTube" };

// "2026-11-09" → "9 Nov"
function dayMonth(date) {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

const platformName = (p) => PLATFORMS[p] ?? p;

// When the posting window closes: slot + late limit, "HH:MM" on a 24-hour clock.
function windowEnd(slot, lateLimitMinutes) {
  const m = (parseSlot(slot) + lateLimitMinutes) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// `name` is the campaign's name, always passed. `slot` and `lateLimitMinutes` are
// the campaign's; left out, they are the campaign defaults.
export function formatReport(result, { name, slot = "19:30", lateLimitMinutes = 120 }) {
  const out = [];
  const header = `${name} · ${weekday(result.today)} ${dayMonth(result.today)}`;
  out.push(result.dryRun ? `DRY RUN · ${header}` : header);

  for (const p of result.posted) out.push(`✅ ${platformName(p.platform)}: ${p.id} ${p.url}`);
  for (const f of result.failed) out.push(`❌ ${platformName(f.platform)}: ${f.id}: ${f.error} (retries next posting day)`);
  for (const a of result.alreadyLive) out.push(`↩️ ${platformName(a.platform)}: ${a.id} was already live, recorded ${a.url}`);

  // A drop on both platforms is one line: the line names the item, not the platform.
  const drops = new Set(result.dropped.map((d) => `🗑️ Dropped: ${d.id} (${d.reason})`));
  out.push(...drops);

  for (const n of result.notReady) out.push(`⚠️ Not ready: ${n.id}: ${n.errors.join("; ")}`);

  if (result.window === "late") out.push(`⏰ Started after ${windowEnd(slot, lateLimitMinutes)}: nothing posted today.`);
  const nothingPosted = !result.posted.length && !result.failed.length && !result.alreadyLive.length;
  if (result.window === "open" && !result.postingDay && nothingPosted) out.push("😴 No post today (4-a-week rhythm).");

  for (const w of result.warnings) out.push(`⚠️ ${w}`);

  const runDry = result.runDry ? dayMonth(result.runDry) : "never";
  out.push(`Queue: ${result.readyCount} ready · ${result.rhythm} · runs dry ${runDry}`);
  return out.join("\n");
}
