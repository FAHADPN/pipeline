// How the calendar lays out its days: whole Monday-first weeks for the desktop grid, and
// a week-by-week agenda for the phone. Pure, so it is testable from node:test. Dates are
// "YYYY-MM-DD" calendar days, read as UTC (see format.js).
//
//   weekGrid(from, days) -> string[][]   rows of 7 dates, Monday first
//   agenda(days, today)  -> ({ header } | { day })[]
//     days: calendar Days ({ date, posts, builds }); today: the campaign's today

import { addDays } from "./format.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return { weekday: (d.getUTCDay() + 6) % 7, date: d.getUTCDate(), month: MONTHS[d.getUTCMonth()] };
}

// The Monday of the week holding `iso`.
export function mondayOf(iso) {
  return addDays(iso, -parts(iso).weekday);
}

// Every week touching from .. from + days - 1, each a row of 7 dates from its Monday.
export function weekGrid(from, days) {
  const last = addDays(from, days - 1);
  const rows = [];
  for (let start = mondayOf(from); start <= last; start = addDays(start, 7)) {
    rows.push(Array.from({ length: 7 }, (_, n) => addDays(start, n)));
  }
  return rows;
}

// "9 – 15 Nov", or "30 Nov – 6 Dec" across a month end.
function weekLabel(start) {
  const a = parts(start);
  const b = parts(addDays(start, 6));
  return a.month === b.month ? `${a.date} – ${b.date} ${b.month}` : `${a.date} ${a.month} – ${b.date} ${b.month}`;
}

// The days from today on that have something on them, each week under a header. The
// first week is the one holding tomorrow, so on a Sunday today leads the coming week
// instead of sitting alone under "This week".
export function agenda(days, today) {
  const thisWeek = mondayOf(addDays(today, 1));
  const nextWeek = addDays(thisWeek, 7);
  const rows = [];
  let current = null;
  for (const day of days) {
    if (day.date < today || (!day.posts.length && !day.builds.length)) continue;
    const start = day.date < thisWeek ? thisWeek : mondayOf(day.date);
    if (start !== current) {
      current = start;
      rows.push({ header: start === thisWeek ? "This week" : start === nextWeek ? "Next week" : weekLabel(start) });
    }
    rows.push({ day });
  }
  return rows;
}
