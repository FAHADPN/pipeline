import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { YT_SCOPES, REDIRECT_URI, buildAuthUrl, exchangeCode, createYouTube } from "../lib/youtube.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";

// A fake fetch that answers from a queue of canned responses and records every
// call it gets. A reply may carry headers (e.g. Location) and a JSON body.
function fakeFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (!queue.length) throw new Error(`unexpected fetch: ${url}`);
    const { status = 200, body, headers = {} } = queue.shift();
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { fetch, calls };
}

function client(replies) {
  const f = fakeFetch(replies);
  const yt = createYouTube({ clientId: "CID", clientSecret: "SECRET", refreshToken: "REFRESH", fetch: f.fetch });
  return { yt, calls: f.calls };
}

function tempVideo(bytes = 1234) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-yt-"));
  const file = path.join(dir, "video.mp4");
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

const form = (call) => new URLSearchParams(String(call.init.body));
const method = (call) => (call.init.method ?? "GET").toUpperCase();
const tokenReply = { body: { access_token: "ACCESS", expires_in: 3599, token_type: "Bearer" } };

test("uploadShort refreshes, inits, then PUTs", async () => {
  const videoPath = tempVideo(1234);
  const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=XYZ";
  const { yt, calls } = client([
    tokenReply,
    { headers: { location: session } },
    { body: { id: "V1", kind: "youtube#video" } },
  ]);

  const result = await yt.uploadShort({
    videoPath,
    title: "POV: the new oat latte ✨ #shorts #coffee",
    description: "Fresh beans every Monday\nacme.example",
    privacy: "private",
    categoryId: "22",
  });
  assert.deepEqual(result, { videoId: "V1", url: "https://youtube.com/shorts/V1" });
  assert.equal(calls.length, 3);

  const [token, init, put] = calls;

  assert.equal(method(token), "POST");
  assert.equal(token.url, TOKEN_URL);
  const t = form(token);
  assert.equal(t.get("grant_type"), "refresh_token");
  assert.equal(t.get("refresh_token"), "REFRESH");
  assert.equal(t.get("client_id"), "CID");
  assert.equal(t.get("client_secret"), "SECRET");

  assert.equal(method(init), "POST");
  const u = new URL(init.url);
  assert.equal(u.origin + u.pathname, "https://www.googleapis.com/upload/youtube/v3/videos");
  assert.equal(u.searchParams.get("uploadType"), "resumable");
  assert.equal(u.searchParams.get("part"), "snippet,status");
  const h = new Headers(init.init.headers);
  assert.equal(h.get("authorization"), "Bearer ACCESS");
  assert.equal(h.get("content-type"), "application/json; charset=UTF-8");
  assert.equal(h.get("x-upload-content-type"), "video/mp4");
  assert.equal(h.get("x-upload-content-length"), "1234");
  assert.deepEqual(JSON.parse(init.init.body), {
    snippet: { title: "POV: the new oat latte ✨ #shorts #coffee", description: "Fresh beans every Monday\nacme.example", categoryId: "22" },
    status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
  });

  assert.equal(method(put), "PUT");
  assert.equal(put.url, session);
  const ph = new Headers(put.init.headers);
  assert.equal(ph.get("content-type"), "video/mp4");
  assert.equal(Buffer.from(put.init.body).length, 1234);
});

test("title over 100 chars throws before any fetch", async () => {
  const { yt, calls } = client([]);
  await assert.rejects(
    yt.uploadShort({ videoPath: tempVideo(10), title: "x".repeat(101), description: "", privacy: "private", categoryId: "22" }),
    /title/i,
  );
  assert.equal(calls.length, 0);
});

test("init without a Location header throws", async () => {
  const { yt } = client([tokenReply, { body: {} }]);
  await assert.rejects(
    yt.uploadShort({ videoPath: tempVideo(10), title: "t", description: "", privacy: "private", categoryId: "22" }),
    /Location/,
  );
});

test("API errors surface the message without secrets", async () => {
  const { yt } = client([
    tokenReply,
    { status: 403, body: { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota." } } },
  ]);
  const err = await yt
    .uploadShort({ videoPath: tempVideo(10), title: "t", description: "", privacy: "private", categoryId: "22" })
    .catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /quota/);
  for (const secret of ["ACCESS", "REFRESH", "SECRET"]) assert.ok(!err.message.includes(secret));
});

test("token endpoint errors surface error and description without secrets", async () => {
  const { yt } = client([{ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }]);
  const err = await yt.listUploads().catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /invalid_grant/);
  assert.match(err.message, /expired or revoked/);
  for (const secret of ["REFRESH", "SECRET"]) assert.ok(!err.message.includes(secret));
});

test("listUploads pages through playlistItems", async () => {
  const item = (n) => ({
    snippet: { title: `Title ${n}`, publishedAt: `2026-10-1${n}T14:00:00Z`, resourceId: { kind: "youtube#video", videoId: `V${n}` } },
  });
  const { yt, calls } = client([
    tokenReply,
    { body: { items: [{ id: "UC1", contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] } },
    { body: { items: [item(1), item(2)], nextPageToken: "P2" } },
    { body: { items: [item(3)] } },
  ]);

  const uploads = await yt.listUploads();
  assert.deepEqual(uploads, [
    { videoId: "V1", title: "Title 1", publishedAt: "2026-10-11T14:00:00Z" },
    { videoId: "V2", title: "Title 2", publishedAt: "2026-10-12T14:00:00Z" },
    { videoId: "V3", title: "Title 3", publishedAt: "2026-10-13T14:00:00Z" },
  ]);
  assert.equal(calls.length, 4);

  const [, channels, page1, page2] = calls;
  const c = new URL(channels.url);
  assert.equal(c.origin + c.pathname, `${API}/channels`);
  assert.equal(c.searchParams.get("part"), "contentDetails");
  assert.equal(c.searchParams.get("mine"), "true");
  assert.equal(new Headers(channels.init.headers).get("authorization"), "Bearer ACCESS");

  const p1 = new URL(page1.url);
  assert.equal(p1.origin + p1.pathname, `${API}/playlistItems`);
  assert.equal(p1.searchParams.get("part"), "snippet");
  assert.equal(p1.searchParams.get("maxResults"), "50");
  assert.equal(p1.searchParams.get("playlistId"), "UU1");
  assert.equal(p1.searchParams.get("pageToken"), null);

  const p2 = new URL(page2.url);
  assert.equal(p2.searchParams.get("playlistId"), "UU1");
  assert.equal(p2.searchParams.get("pageToken"), "P2");
});

test("listUploads with no channel returns nothing", async () => {
  const { yt, calls } = client([tokenReply, { body: { items: [] } }]);
  assert.deepEqual(await yt.listUploads(), []);
  assert.equal(calls.length, 2);
});

test("buildAuthUrl has offline access, consent and both scopes", () => {
  const u = new URL(buildAuthUrl({ clientId: "CID" }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), "CID");
  assert.equal(u.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.deepEqual(u.searchParams.get("scope").split(" ").sort(), [...YT_SCOPES].sort());
  assert.deepEqual(YT_SCOPES, [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ]);
  assert.equal(REDIRECT_URI, "http://127.0.0.1:8765/callback");
});

test("exchangeCode posts the code and returns the refresh token", async () => {
  const { fetch, calls } = fakeFetch([{ body: { access_token: "ACCESS", refresh_token: "NEWREFRESH", expires_in: 3599 } }]);
  assert.deepEqual(await exchangeCode({ clientId: "CID", clientSecret: "SECRET", code: "CODE", fetch }), { refreshToken: "NEWREFRESH" });
  assert.equal(method(calls[0]), "POST");
  assert.equal(calls[0].url, TOKEN_URL);
  const f = form(calls[0]);
  assert.equal(f.get("grant_type"), "authorization_code");
  assert.equal(f.get("code"), "CODE");
  assert.equal(f.get("client_id"), "CID");
  assert.equal(f.get("client_secret"), "SECRET");
  assert.equal(f.get("redirect_uri"), REDIRECT_URI);
});

test("exchangeCode throws without refresh_token", async () => {
  const { fetch } = fakeFetch([{ body: { access_token: "ACCESS", expires_in: 3599 } }]);
  const err = await exchangeCode({ clientId: "CID", clientSecret: "SECRET", code: "CODE", fetch }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /refresh_token/);
  for (const secret of ["ACCESS", "SECRET", "CODE"]) assert.ok(!err.message.includes(secret));
});
