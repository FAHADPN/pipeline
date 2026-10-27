import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchPosts, applyMatches } from "../lib/sync.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));

const items = [
  { id: "reel-01-launch", kind: "ep", dir: "x/reel-01-launch" },
  { id: "reel-02-oat-latte", kind: "ep", dir: "x/reel-02-oat-latte" },
  { id: "special-holiday-hours", kind: "special", dir: "x/special-holiday-hours", on: "2026-10-11" },
];

const captions = new Map([
  ["reel-01-launch", {
    instagram: "POV: You’ve said “one more coffee” for 3 years ☕ every morning\n\nFresh beans every Monday.\n#coffee #acmecoffee",
    youtubeTitle: "POV: You’ve said “one more coffee” ☕ #shorts #coffee",
  }],
  ["reel-02-oat-latte", {
    instagram: "Try the new oat latte 🥛\n\n#acmecoffee",
    youtubeTitle: "Try the new oat latte #shorts",
  }],
  ["special-holiday-hours", {
    instagram: "Holiday hours are here 🎄\n\n#acmecoffee",
    youtubeTitle: "Holiday hours #shorts",
  }],
]);

const ig = (id, caption, timestamp = "2026-10-06T14:00:00+0000") =>
  ({ id, caption, timestamp, permalink: `https://www.instagram.com/reel/${id}/` });

test("matches despite CRLF, case and spacing", () => {
  const posts = [
    ig("M1", "\uFEFFpov:  you’ve said “ONE MORE COFFEE” for 3 years ☕   every morning\r\n\r\nFresh beans every Monday.\r\n#coffee #acmecoffee"),
    ig("M2", "\r\n  TRY the new   oat latte 🥛\r\n#acmecoffee"),
  ];
  const { matches, unmatched } = matchPosts({ items, captions, posts, platform: "instagram" });
  assert.deepEqual(matches.map((m) => [m.id, m.post.id]), [["reel-01-launch", "M1"], ["reel-02-oat-latte", "M2"]]);
  assert.deepEqual(unmatched, []);
});

test("youtube matches on the title", () => {
  const posts = [{ videoId: "V1", title: "POV: You’ve said “one more coffee” ☕ #shorts #coffee", publishedAt: "2026-10-06T14:00:00Z" }];
  const { matches, unmatched } = matchPosts({ items, captions, posts, platform: "youtube" });
  assert.deepEqual(matches, [{ id: "reel-01-launch", post: posts[0] }]);
  assert.deepEqual(unmatched, []);
});

test("unmatched posts are returned", () => {
  const tutorial = ig("T1", "How to order ahead in the Acme app (tutorial 1)\n#acmecoffee");
  const empty = ig("T2", undefined);
  const { matches, unmatched } = matchPosts({
    items,
    captions,
    posts: [tutorial, ig("M2", "Try the new oat latte 🥛"), empty],
    platform: "instagram",
  });
  assert.deepEqual(matches.map((m) => m.id), ["reel-02-oat-latte"]);
  assert.deepEqual(unmatched, [tutorial, empty]);
});

test("an item matches at most one post", () => {
  const first = ig("M2", "Try the new oat latte 🥛");
  const repost = ig("M3", "Try the new oat latte 🥛");
  const { matches, unmatched } = matchPosts({ items, captions, posts: [first, repost], platform: "instagram" });
  assert.deepEqual(matches, [{ id: "reel-02-oat-latte", post: first }]);
  assert.deepEqual(unmatched, [repost]);
});

test("applyMatches marks manual and keeps existing posted entries", () => {
  const posted = { status: "posted", mediaId: "OLD", url: "https://www.instagram.com/reel/OLD/", date: "2026-10-05", at: "2026-10-05T14:00:00.000Z" };
  const dropped = { status: "dropped", reason: "pinned date passed", at: "2026-10-24T14:00:00.000Z" };
  const state = {
    version: 1,
    items: {
      "reel-01-launch": { instagram: posted },
      "special-holiday-hours": { instagram: dropped },
      "reel-02-oat-latte": { instagram: { status: "failed", error: "boom", attempts: 2, at: "2026-10-05T14:00:00.000Z" } },
    },
  };
  const matches = [
    { id: "reel-01-launch", post: ig("M1", "x") },
    { id: "reel-02-oat-latte", post: ig("M2", "x") },
    { id: "special-holiday-hours", post: ig("M9", "x") },
  ];
  const n = applyMatches(state, matches, "instagram", "Asia/Kolkata");
  assert.equal(n, 1);
  assert.deepEqual(state.items["reel-01-launch"].instagram, posted);
  assert.deepEqual(state.items["special-holiday-hours"].instagram, dropped);
  assert.deepEqual(state.items["reel-02-oat-latte"].instagram, {
    status: "manual",
    mediaId: "M2",
    url: "https://www.instagram.com/reel/M2/",
    date: "2026-10-06",
    at: "2026-10-06T14:00:00.000Z",
  });
});

test("applyMatches on youtube uses the Shorts url and keeps the other platform", () => {
  const igEntry = { status: "manual", mediaId: "M1", url: "u", date: "2026-10-06", at: "2026-10-06T14:00:00.000Z" };
  const state = { version: 1, items: { "reel-01-launch": { instagram: igEntry } } };
  const post = { videoId: "V1", title: "t", publishedAt: "2026-10-07T03:00:00Z" };
  assert.equal(applyMatches(state, [{ id: "reel-01-launch", post }], "youtube", "Asia/Kolkata"), 1);
  assert.deepEqual(state.items["reel-01-launch"], {
    instagram: igEntry,
    youtube: { status: "manual", mediaId: "V1", url: "https://youtube.com/shorts/V1", date: "2026-10-07", at: "2026-10-07T03:00:00.000Z" },
  });
});

test("post dates are IST", () => {
  const state = { version: 1, items: {} };
  applyMatches(state, [
    { id: "reel-01-launch", post: ig("M1", "x", "2026-10-06T18:00:00+0000") },
    { id: "reel-02-oat-latte", post: ig("M2", "x", "2026-10-06T19:00:00+0000") },
  ], "instagram", "Asia/Kolkata");
  assert.equal(state.items["reel-01-launch"].instagram.date, "2026-10-06");
  assert.equal(state.items["reel-02-oat-latte"].instagram.date, "2026-10-07");
});
