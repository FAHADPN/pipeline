// Drag and drop for the calendar and the pipeline: where a drop lands (pure, so it is
// testable from node:test) and the pointer gesture itself.
//
//   dropDate(cells, x, y) -> string|null   the date of the cell under the pointer, where
//                                           cells = [{ date, rect }] and rect is a
//                                           getBoundingClientRect() result
//   dropIndex(rects, y) -> number           where a pointer at y lands in a vertical list
//   reorderTarget(list, fromId, toIndex)    the reorder action's { id, before } for moving
//                                           fromId before list[toIndex] (null past the
//                                           end); null when that moves nothing
//   draggable(el, { onMove, onDrop, onEnd }) lets a mouse or pen drag el at 760 px and wider

const DESKTOP = "(min-width: 760px)";
const DRAG_PX = 6;

const inside = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

export function dropDate(cells, x, y) {
  return cells.find((c) => inside(c.rect, x, y))?.date ?? null;
}

// The first item whose vertical middle is below y, or the list's length past the last.
export function dropIndex(rects, y) {
  const at = rects.findIndex((r) => y < (r.top + r.bottom) / 2);
  return at === -1 ? rects.length : at;
}

// `list` is the floating ids in queue order. Landing just before itself or just after
// itself leaves the order as it was.
export function reorderTarget(list, fromId, toIndex) {
  const from = list.indexOf(fromId);
  if (from === -1 || toIndex === from || toIndex === from + 1) return null;
  if (toIndex >= list.length) return from === list.length - 1 ? null : { id: fromId, before: null };
  return { id: fromId, before: list[toIndex] };
}

// Nothing happens until the pointer has moved DRAG_PX, so a plain click still clicks.
// Then el follows the pointer (class "dragging"), onMove(x, y) runs on every move, and
// a release calls onEnd() then onDrop(x, y). Escape or a lost pointer calls onEnd()
// alone. A touch never drags, so phones and tablets keep scrolling.
export function draggable(el, { onMove = () => {}, onDrop = () => {}, onEnd = () => {} }) {
  el.addEventListener("pointerdown", (down) => {
    if (down.button !== 0 || down.pointerType === "touch" || !matchMedia(DESKTOP).matches) return;
    let dragging = false;

    function move(e) {
      const dx = e.clientX - down.clientX;
      const dy = e.clientY - down.clientY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_PX) return;
        dragging = true;
        el.classList.add("dragging");
        document.body.classList.add("drag-active");
      }
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      onMove(e.clientX, e.clientY);
    }

    function finish(e, dropped) {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
      if (!dragging) return;
      el.classList.remove("dragging");
      document.body.classList.remove("drag-active");
      el.style.transform = "";
      // The release may also click el; that click isn't the owner's.
      const swallow = (c) => {
        c.preventDefault();
        c.stopImmediatePropagation();
      };
      el.addEventListener("click", swallow, true);
      setTimeout(() => el.removeEventListener("click", swallow, true), 0);
      onEnd();
      if (dropped) onDrop(e.clientX, e.clientY);
    }

    const up = (e) => finish(e, true);
    const cancel = (e) => finish(e, false);
    const key = (e) => e.key === "Escape" && finish(e, false);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
  });
}
