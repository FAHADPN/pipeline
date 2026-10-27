// Which queued post the console's Post now posts: the next floating Instagram item, as
// the server's postNow picks it (a pinned item posts on its own date). Pure, so it is
// testable from node:test.

// True for a status.queue entry that is a floating (not pinned) Instagram post.
export function isFloatingInstagram(entry) {
  return entry?.platform === "instagram" && entry?.why === "queue";
}

// The first floating Instagram entry in status.queue, or null.
export function nextFloating(queue) {
  return (queue ?? []).find(isFloatingInstagram) ?? null;
}
