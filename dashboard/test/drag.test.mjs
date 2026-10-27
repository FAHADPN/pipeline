import { test } from "node:test";
import assert from "node:assert/strict";
import { dropDate, dropIndex, reorderTarget } from "../ui/lib/drag.js";

// Two day cells side by side, 100 × 80 px each, as getBoundingClientRect gives them.
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });
const CELLS = [
  { date: "2026-10-26", rect: rect(0, 0, 100, 80) },
  { date: "2026-10-27", rect: rect(100, 0, 100, 80) },
];

test("drag: dropDate returns the date of the cell containing the point, null outside", () => {
  assert.equal(dropDate(CELLS, 50, 40), "2026-10-26");
  assert.equal(dropDate(CELLS, 150, 10), "2026-10-27");
  assert.equal(dropDate(CELLS, 0, 0), "2026-10-26", "an edge is inside");
  assert.equal(dropDate(CELLS, 250, 40), null, "right of every cell");
  assert.equal(dropDate(CELLS, 50, 120), null, "below every cell");
  assert.equal(dropDate(CELLS, -1, 40), null);
  assert.equal(dropDate([], 50, 40), null);
});

test("drag: reorderTarget maps an index to before the item at that index, null at the end", () => {
  const list = ["f1", "f2", "f3", "f4"];
  assert.deepEqual(reorderTarget(list, "f3", 0), { id: "f3", before: "f1" });
  assert.deepEqual(reorderTarget(list, "f3", 1), { id: "f3", before: "f2" }, "up one");
  assert.deepEqual(reorderTarget(list, "f1", 3), { id: "f1", before: "f4" });
  assert.deepEqual(reorderTarget(list, "f1", 4), { id: "f1", before: null }, "past the last item");
  assert.deepEqual(reorderTarget(list, "f3", 4), { id: "f3", before: null }, "down past the last item");
  assert.deepEqual(reorderTarget(list, "f2", 9), { id: "f2", before: null });
  // Landing where it already is moves nothing.
  assert.equal(reorderTarget(list, "f2", 1), null, "before itself");
  assert.equal(reorderTarget(list, "f2", 2), null, "before the item after it");
  assert.equal(reorderTarget(list, "f4", 4), null, "the last item to the end");
  assert.equal(reorderTarget(list, "nope", 0), null);
});

test("drag: dropIndex is the first item whose middle is below the pointer, the length past the last", () => {
  const rows = [rect(0, 0, 200, 40), rect(0, 50, 200, 40), rect(0, 100, 200, 40)];
  assert.equal(dropIndex(rows, -10), 0);
  assert.equal(dropIndex(rows, 19), 0);
  assert.equal(dropIndex(rows, 21), 1);
  assert.equal(dropIndex(rows, 75), 2);
  assert.equal(dropIndex(rows, 121), 3);
  assert.equal(dropIndex([], 10), 0);
});
