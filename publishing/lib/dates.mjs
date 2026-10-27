// Date helpers. Every date is a "YYYY-MM-DD" string in the posting time zone (a
// campaign's own, Asia/Kolkata by default), never the machine's local time.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parts(now, timeZone, options) {
  const out = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone, ...options }).formatToParts(now)) out[p.type] = p.value;
  return out;
}

export function istDate(now, timeZone = "Asia/Kolkata") {
  const p = parts(now, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

export function istMinutes(now, timeZone = "Asia/Kolkata") {
  const p = parts(now, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return Number(p.hour) * 60 + Number(p.minute);
}

// Midnight UTC of a date string, for weekday and day arithmetic.
function utc(date) {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`bad date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isRealDate(date) {
  if (typeof date !== "string" || !DATE_RE.test(date)) return false;
  return new Date(utc(date)).toISOString().slice(0, 10) === date;
}

export function weekday(date) {
  return WEEKDAYS[new Date(utc(date)).getUTCDay()];
}

export function addDays(date, n) {
  return new Date(utc(date) + n * 86400000).toISOString().slice(0, 10);
}

export function parseSlot(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`bad slot: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
