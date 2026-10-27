import { test } from "node:test";
import assert from "node:assert/strict";
import { agenda, weekGrid } from "../ui/lib/grid.js";
import { addDays } from "../ui/lib/format.js";

// A calendar Day with one scheduled post.
const busy = (date) => ({ date, posts: [{ id: `p-${date}`, title: date, type: "story", kind: "scheduled", url: null, video: null, cover: null }], builds: [] });
const range = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

test("grid: weekGrid(\"2026-10-19\", 35)[0] is 2026-10-19..2026-10-25, and it has 5 rows", () => {
  const rows = weekGrid("2026-10-19", 35);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], range("2026-10-19", "2026-10-25"));
  assert.deepEqual(rows[4], range("2026-11-16", "2026-11-22"));
  assert.ok(rows.every((r) => r.length === 7));
  // A start that isn't a Monday still lays out whole Monday-first weeks.
  assert.deepEqual(weekGrid("2026-10-21", 7).map((r) => [r[0], r[6]]), [
    ["2026-10-19", "2026-10-25"],
    ["2026-10-26", "2026-11-01"],
  ]);
});

test("grid: agenda groups 2026-10-25..2026-11-13 into This week, Next week, 9 – 15 Nov", () => {
  const days = range("2026-10-19", "2026-11-13").map(busy);
  const rows = agenda(days, "2026-10-25");
  assert.deepEqual(rows.filter((r) => r.header).map((r) => r.header), ["This week", "Next week", "9 – 15 Nov"]);
  const under = (header) => {
    const at = rows.findIndex((r) => r.header === header);
    const next = rows.findIndex((r, i) => i > at && r.header);
    return rows.slice(at + 1, next === -1 ? undefined : next).map((r) => r.day.date);
  };
  // Today, a Sunday, leads the coming week; the days before it are past and left out.
  assert.deepEqual(under("This week"), range("2026-10-25", "2026-11-01"));
  assert.deepEqual(under("Next week"), range("2026-11-02", "2026-11-08"));
  assert.deepEqual(under("9 – 15 Nov"), range("2026-11-09", "2026-11-13"));
});

test("grid: agenda skips empty days, and a week across two months names both", () => {
  const empty = (date) => ({ date, posts: [], builds: [] });
  const days = [busy("2026-10-21"), empty("2026-10-22"), busy("2026-11-30"), busy("2026-12-02")];
  assert.deepEqual(agenda(days, "2026-10-21"), [
    { header: "This week" },
    { day: days[0] },
    { header: "30 Nov – 6 Dec" },
    { day: days[2] },
    { day: days[3] },
  ]);
  assert.deepEqual(agenda([empty("2026-10-21")], "2026-10-21"), []);
});
