import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstagram } from "../lib/instagram.mjs";

const BASE = "https://graph.instagram.com/v24.0";
const VIDEO_URL = "https://ab12.ngrok-free.app/0123456789abcdef0123456789abcdef/video.mp4";
const COVER_URL = "https://ab12.ngrok-free.app/0123456789abcdef0123456789abcdef/cover.png";

// A fake fetch that answers from a queue of canned JSON responses and records
// every call it gets.
function fakeFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (!queue.length) throw new Error(`unexpected fetch: ${url}`);
    const { status = 200, body } = queue.shift();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

function client(replies, opts = {}) {
  const f = fakeFetch(replies);
  const ig = createInstagram({ token: "TOKEN", userId: "U1", graphVersion: "v24.0", fetch: f.fetch, sleep: async () => {}, ...opts });
  return { ig, calls: f.calls };
}

const form = (call) => new URLSearchParams(String(call.init.body));
const method = (call) => (call.init.method ?? "GET").toUpperCase();

test("creates a REELS container from video_url and cover_url", async () => {
  const { ig, calls } = client([
    { body: { id: "C1" } },
    { body: { status_code: "IN_PROGRESS", id: "C1" } },
    { body: { status_code: "FINISHED", id: "C1" } },
    { body: { id: "M1" } },
    { body: { permalink: "https://www.instagram.com/reel/abc/", id: "M1" } },
  ]);

  const result = await ig.publishReel({ videoUrl: VIDEO_URL, coverUrl: COVER_URL, caption: "Line one ✨\n\nMore “text”", thumbOffsetMs: 1500 });
  assert.deepEqual(result, { mediaId: "M1", url: "https://www.instagram.com/reel/abc/" });
  assert.equal(calls.length, 5);

  const [container, poll1, poll2, publish, permalink] = calls;

  assert.equal(method(container), "POST");
  assert.equal(container.url, `${BASE}/U1/media`);
  const c = form(container);
  assert.equal(c.get("media_type"), "REELS");
  assert.equal(c.get("video_url"), VIDEO_URL);
  assert.equal(c.get("cover_url"), COVER_URL);
  assert.equal(c.get("upload_type"), null);
  assert.equal(c.get("thumb_offset"), null);
  assert.equal(c.get("share_to_feed"), "true");
  assert.equal(c.get("caption"), "Line one ✨\n\nMore “text”");
  assert.equal(c.get("access_token"), "TOKEN");

  // No upload call.
  assert.ok(!calls.some((call) => call.url.includes("rupload")));

  for (const poll of [poll1, poll2]) {
    assert.equal(method(poll), "GET");
    const u = new URL(poll.url);
    assert.equal(u.origin + u.pathname, `${BASE}/C1`);
    assert.equal(u.searchParams.get("fields"), "status_code,status");
    assert.equal(u.searchParams.get("access_token"), "TOKEN");
  }

  assert.equal(method(publish), "POST");
  assert.equal(publish.url, `${BASE}/U1/media_publish`);
  assert.equal(form(publish).get("creation_id"), "C1");
  assert.equal(form(publish).get("access_token"), "TOKEN");

  assert.equal(method(permalink), "GET");
  const p = new URL(permalink.url);
  assert.equal(p.origin + p.pathname, `${BASE}/M1`);
  assert.equal(p.searchParams.get("fields"), "permalink");
});

test("without a cover_url the container uses thumb_offset", async () => {
  const { ig, calls } = client([
    { body: { id: "C2" } },
    { body: { status_code: "FINISHED" } },
    { body: { id: "M2" } },
    { body: { permalink: "https://www.instagram.com/reel/def/" } },
  ]);
  await ig.publishReel({ videoUrl: VIDEO_URL, caption: "x", thumbOffsetMs: 1500 });
  const c = form(calls[0]);
  assert.equal(c.get("video_url"), VIDEO_URL);
  assert.equal(c.get("cover_url"), null);
  assert.equal(c.get("thumb_offset"), "1500");
});

test("status ERROR throws processing failed with the status text", async () => {
  const { ig, calls } = client([
    { body: { id: "C1" } },
    { body: { status_code: "ERROR", status: "Error: Media download has failed. The media URI doesn't meet our requirements." } },
  ]);
  await assert.rejects(
    ig.publishReel({ videoUrl: VIDEO_URL, coverUrl: COVER_URL, caption: "x", thumbOffsetMs: 1500 }),
    /processing failed: ERROR \(Error: Media download has failed/,
  );
  assert.equal(calls.length, 2);

  const expired = client([{ body: { id: "C1" } }, { body: { status_code: "EXPIRED" } }]);
  await assert.rejects(expired.ig.publishReel({ videoUrl: VIDEO_URL, caption: "x", thumbOffsetMs: 1500 }), /^Error: processing failed: EXPIRED$/);
});

test("createReelContainer and waitForContainer stop short of publishing", async () => {
  const { ig, calls } = client([
    { body: { id: "C3" } },
    { body: { status_code: "IN_PROGRESS" } },
    { body: { status_code: "FINISHED" } },
  ]);
  const id = await ig.createReelContainer({ videoUrl: VIDEO_URL, coverUrl: COVER_URL, caption: "x" });
  assert.equal(id, "C3");
  assert.equal(await ig.waitForContainer(id), "FINISHED");
  assert.equal(calls.length, 3);
  assert.ok(!calls.some((call) => call.url.endsWith("/media_publish")));
});

test("poll timeout throws timed out", async () => {
  const { ig } = client([
    { body: { id: "C1" } },
    { body: { status_code: "IN_PROGRESS" } },
  ], { pollTimeoutMs: 0 });
  await assert.rejects(ig.publishReel({ videoUrl: VIDEO_URL, caption: "x", thumbOffsetMs: 1500 }), /timed out/);
});

test("graph error surfaces the message without the token", async () => {
  const { ig } = client([
    { status: 400, body: { error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } } },
  ]);
  const err = await ig.publishReel({ videoUrl: VIDEO_URL, caption: "x", thumbOffsetMs: 1500 }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /Invalid OAuth/);
  assert.ok(!err.message.includes("TOKEN"));
});

test("me returns user id and username", async () => {
  const { ig, calls } = client([{ body: { user_id: "U1", username: "acme.coffee", id: "X" } }]);
  assert.deepEqual(await ig.me(), { userId: "U1", username: "acme.coffee" });
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, `${BASE}/me`);
  assert.equal(u.searchParams.get("fields"), "user_id,username");
  assert.equal(u.searchParams.get("access_token"), "TOKEN");
});

test("listMedia follows paging.next and honours limit", async () => {
  const post = (n) => ({ id: `P${n}`, caption: `cap ${n}`, timestamp: `2026-10-${10 + n}T14:00:00+0000`, permalink: `https://www.instagram.com/reel/p${n}/` });
  const { ig, calls } = client([
    { body: { data: [post(1), post(2)], paging: { next: `${BASE}/U1/media?after=A&access_token=TOKEN` } } },
    { body: { data: [post(3), post(4)], paging: { next: `${BASE}/U1/media?after=B&access_token=TOKEN` } } },
    { body: { data: [post(5)] } },
  ]);
  const media = await ig.listMedia({ limit: 3 });
  assert.deepEqual(media, [post(1), post(2), post(3)]);
  assert.equal(calls.length, 2);
  const first = new URL(calls[0].url);
  assert.equal(first.origin + first.pathname, `${BASE}/U1/media`);
  assert.equal(first.searchParams.get("fields"), "id,caption,timestamp,permalink");
  assert.equal(calls[1].url, `${BASE}/U1/media?after=A&access_token=TOKEN`);
});

test("listMedia without a limit reads every page", async () => {
  const { ig, calls } = client([
    { body: { data: [{ id: "P1" }], paging: { next: `${BASE}/U1/media?after=A` } } },
    { body: { data: [{ id: "P2" }], paging: {} } },
  ]);
  const media = await ig.listMedia();
  assert.deepEqual(media.map((m) => m.id), ["P1", "P2"]);
  assert.equal(calls.length, 2);
});

test("refreshToken parses access_token and expires_in", async () => {
  const { ig, calls } = client([{ body: { access_token: "NEWTOKEN", token_type: "bearer", expires_in: 5183944 } }]);
  assert.deepEqual(await ig.refreshToken(), { token: "NEWTOKEN", expiresIn: 5183944 });
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://graph.instagram.com/refresh_access_token");
  assert.equal(u.searchParams.get("grant_type"), "ig_refresh_token");
  assert.equal(u.searchParams.get("access_token"), "TOKEN");
});
