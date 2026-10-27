// sync-state: record posts that are already live (made by hand, or by a run whose
// state write was lost) by matching each one to a queued item on the caption's
// first line (Instagram) or the title's first line (YouTube).
//
// Instagram posts are { id, caption, timestamp, permalink } (instagram.mjs listMedia).
// YouTube posts are { videoId, title, publishedAt } (youtube.mjs listUploads).
//
// syncState is the whole step, as `publish.mjs sync-state` and the console's
// Instagram connect run it, under the campaign's "publish" lock.

import fs from "node:fs";
import { istDate } from "./dates.mjs";
import { findAssets, firstLine, parseCaption } from "./content.mjs";
import { isDone, setEntry } from "./state.mjs";

const postText = (post, platform) => (platform === "instagram" ? post.caption : post.title) ?? "";
const itemText = (caption, platform) => (platform === "instagram" ? caption.instagram : caption.youtubeTitle) ?? "";

// Each item matches at most one post, and each post at most one item (first in list order).
export function matchPosts({ items, captions, posts, platform }) {
  const wanted = [];
  for (const item of items) {
    const caption = captions.get(item.id);
    const line = caption && firstLine(itemText(caption, platform));
    if (line) wanted.push({ id: item.id, line });
  }

  const taken = new Set();
  const matches = [];
  const unmatched = [];
  for (const post of posts) {
    const line = firstLine(postText(post, platform));
    const hit = line && wanted.find((w) => !taken.has(w.id) && w.line === line);
    if (hit) {
      taken.add(hit.id);
      matches.push({ id: hit.id, post });
    } else {
      unmatched.push(post);
    }
  }
  return { matches, unmatched };
}

// Marks each match "manual" unless the item is already done there. `at` is when
// the post went live, so a re-sync writes the same entry. Mutates state in place.
export function applyMatches(state, matches, platform, timeZone) {
  let marked = 0;
  for (const { id, post } of matches) {
    if (isDone(state, id, platform)) continue;
    const live = new Date(platform === "instagram" ? post.timestamp : post.publishedAt);
    const entry = platform === "instagram"
      ? { mediaId: post.id, url: post.permalink }
      : { mediaId: post.videoId, url: `https://youtube.com/shorts/${post.videoId}` };
    setEntry(state, id, platform, { status: "manual", ...entry, date: istDate(live, timeZone), at: live.toISOString() });
    marked++;
  }
  return marked;
}

// The caption is read straight from the folder, so an item whose video is broken
// still matches the post that's already live.
function readCaption(repoRoot, item) {
  try {
    return parseCaption(fs.readFileSync(findAssets(repoRoot, item).caption, "utf8"));
  } catch {
    return undefined;
  }
}

// Fetches the platform's posts with `client`, matches them to `items` and records the
// new matches in `store` (backed up when anything changed).
// Returns { matches, unmatched, marked }.
export async function syncState({ client, items, repoRoot, store, platform, timeZone, now = new Date() }) {
  const posts = platform === "instagram" ? await client.listMedia() : await client.listUploads();
  const captions = new Map();
  for (const item of items) {
    const caption = readCaption(repoRoot, item);
    if (caption) captions.set(item.id, caption);
  }
  const { matches, unmatched } = matchPosts({ items, captions, posts, platform });

  const state = store.load();
  const marked = applyMatches(state, matches, platform, timeZone);
  if (marked) {
    store.save(state);
    store.backup(state, now);
  }
  return { matches, unmatched, marked };
}
