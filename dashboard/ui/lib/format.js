// Pure formatting helpers for the console, importable from node:test. Dates are the
// campaign's calendar days ("YYYY-MM-DD"), read as UTC so the browser's own time zone
// never shifts them.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parseDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return typeof iso === "string" && !Number.isNaN(d.getTime()) ? d : null;
}

// "Today" for `today`, else "Mon 26 Oct".
export function dayLabel(iso, today) {
  if (iso && iso === today) return "Today";
  const d = parseDay(iso);
  if (!d) return "No date";
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// "Sun 25", for a row in a week list.
export function shortDay(iso) {
  const d = parseDay(iso);
  return d ? `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}` : "";
}

// "Sunday 25 October".
export function longDate(iso) {
  const d = parseDay(iso);
  return d ? `${WEEKDAYS_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]}` : "";
}

// The day `n` days after `iso`.
export function addDays(iso, n) {
  const d = parseDay(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// `url` with `params` added to whatever query it already has.
export function addQuery(url, params) {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

// "Participation" for "participation"; "Piece" when there's no type.
export function typeLabel(type) {
  if (typeof type !== "string" || !type) return "Piece";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export const STATUS_LABELS = {
  ready: "Ready",
  held: "Held",
  awaiting: "Awaiting approval",
  posted: "Posted",
  fix: "Needs fixing",
  dropped: "Dropped",
};

// When a library Piece posts or posted: "Posted Sat 24 Oct", "Pinned · Sun 1 Nov",
// "Mon 26 Oct", or its status when it has no date.
export function pieceWhen(piece, today) {
  const day = dayLabel(piece.date, today);
  if (piece.status === "posted") return piece.date ? `Posted ${day}` : "Posted";
  if (!piece.date) return STATUS_LABELS[piece.status] ?? "";
  return piece.pinned ? `Pinned · ${day}` : day;
}

export const PLATFORMS = { instagram: "Instagram", youtube: "YouTube" };

// "daily" -> "Daily", "4-a-week" -> "4 a week".
export function rhythmLabel(rhythm) {
  if (typeof rhythm !== "string" || !rhythm) return "None";
  const words = rhythm.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "1 day", "12 days".
export function days(n) {
  return `${n} day${n === 1 ? "" : "s"}`;
}
