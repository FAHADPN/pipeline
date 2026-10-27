import { test } from "node:test";
import assert from "node:assert/strict";
import { istDate, istMinutes, weekday, addDays, parseSlot } from "../lib/dates.mjs";

test("istDate crosses midnight in IST, not UTC", () => {
  assert.equal(istDate(new Date("2026-10-24T18:29:00Z")), "2026-10-24"); // 23:59 IST
  assert.equal(istDate(new Date("2026-10-24T18:30:00Z")), "2026-10-25"); // 00:00 IST
});
test("istMinutes", () => assert.equal(istMinutes(new Date("2026-10-24T14:00:00Z")), 1170)); // 19:30 IST
test("istMinutes is 0 at IST midnight", () => assert.equal(istMinutes(new Date("2026-10-24T18:30:00Z")), 0));
test("weekday", () => { assert.equal(weekday("2026-10-24"), "Sat"); assert.equal(weekday("2026-10-26"), "Mon"); });
test("addDays crosses months", () => assert.equal(addDays("2026-10-31", 1), "2026-11-01"));
test("addDays goes backwards and across years", () => {
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
});
test("parseSlot", () => assert.equal(parseSlot("19:30"), 1170));
test("parseSlot rejects bad input", () => {
  assert.throws(() => parseSlot("7:30pm"));
  assert.throws(() => parseSlot("24:00"));
});
