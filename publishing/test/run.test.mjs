import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDay, postNow } from "../lib/run.mjs";
import { CONFIG } from "./fixtures.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));

const TODAY = "2026-10-25"; // Sun
const AT_SLOT = new Date("2026-10-25T14:00:00Z"); // 19:30 IST
const FRESH = "2026-10-20T14:00:00.000Z"; // a token 5 days old

// Floating items F1..Fn.
function F(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}`, kind: "ep", dir: `x/F${i + 1}` }));
}

const captionOf = (id) => ({ instagram: `${id} first line\n\n#acmecoffee (link in bio)`, youtubeTitle: `${id} title #shorts` });

// check: ok for every id except those in `broken`.
function fakeCheck(broken = {}) {
  return (repoRoot, item) =>
    broken[item.id]
      ? { ok: false, errors: broken[item.id], warnings: [] }
      : { ok: true, assets: { video: `/videos/${item.id}.mp4`, cover: `/videos/${item.id}-cover.png` }, caption: captionOf(item.id), warnings: [] };
}

// A fake servePublicly: each call is one tunnel with its own public urls. `fail`
// makes the nth start throw, as a missing ngrok authtoken would.
function fakeServe(events, { fail } = {}) {
  const serve = async ({ files, ngrokBin }) => {
    const n = serve.starts.length + 1;
    serve.starts.push({ files, ngrokBin });
    events.push("tunnel open");
    if (fail?.(n)) throw new Error("ngrok failed to start: authentication failed: Usage of ngrok requires a verified account and authtoken.");
    const urls = Object.fromEntries(files.map((f) => [f.name, `https://t${n}.ngrok-free.app/secret${n}/${f.name}`]));
    return {
      urls,
      async close() {
        serve.closes.push(n);
        events.push("tunnel close");
      },
    };
  };
  serve.starts = [];
  serve.closes = [];
  return serve;
}

const videoUrl = (n) => `https://t${n}.ngrok-free.app/secret${n}/video.mp4`;
const coverUrl = (n) => `https://t${n}.ngrok-free.app/secret${n}/cover.png`;

function fakeStore(state, events) {
  return {
    state,
    saves: [],
    backups: [],
    load: () => state,
    save(s) {
      events.push("save");
      this.saves.push(structuredClone(s));
    },
    backup(s, now) {
      events.push("backup");
      this.backups.push({ state: structuredClone(s), now });
    },
  };
}

function fakeTokens(initial) {
  return {
    current: initial,
    saved: [],
    load() {
      return structuredClone(this.current);
    },
    save(t) {
      this.saved.push(structuredClone(t));
      this.current = t;
    },
  };
}

function fakeInstagram(events, { publish, media = [], refresh } = {}) {
  let n = 0;
  return {
    calls: [],
    async publishReel(args) {
      this.calls.push(["publishReel", args]);
      events.push("publishReel");
      n++;
      if (publish) return publish(n, args);
      return { mediaId: `M${n}`, url: `https://www.instagram.com/reel/r${n}/` };
    },
    async listMedia(args) {
      this.calls.push(["listMedia", args]);
      return media;
    },
    async refreshToken() {
      this.calls.push(["refreshToken"]);
      if (refresh) return refresh();
      return { token: "NEWTOKEN", expiresIn: 5184000 };
    },
  };
}

function fakeTelegram(events, { fail } = {}) {
  return {
    sent: [],
    async send(text) {
      events.push("send");
      if (fail) throw new Error("telegram: Bad Request");
      this.sent.push(text);
    },
  };
}

function fakeLog() {
  return {
    lines: [],
    info(msg, data) {
      this.lines.push(["info", msg, data]);
    },
    error(msg, data) {
      this.lines.push(["error", msg, data]);
    },
  };
}

function setup({
  items = F(7),
  state = { version: 1, items: {} },
  tokens = { instagram: { token: "TOKEN", userId: "1", username: "acme.coffee", issuedAt: FRESH } },
  ig = {},
  tg = {},
  broken,
  config = CONFIG,
  serve = {},
} = {}) {
  const events = [];
  const deps = {
    servePublicly: fakeServe(events, serve),
    repoRoot: "/repo",
    name: "Acme Coffee",
    items,
    config,
    store: fakeStore(state, events),
    tokens: fakeTokens(tokens),
    clients: { instagram: fakeInstagram(events, ig) },
    telegram: fakeTelegram(events, tg),
    log: fakeLog(),
    sleeps: [],
    check: fakeCheck(broken),
  };
  deps.sleep = async (ms) => deps.sleeps.push(ms);
  return { deps, events };
}

test("posts the planned item and saves state right away", async () => {
  const { deps, events } = setup();
  const result = await runDay({ now: AT_SLOT, deps });

  const publishes = deps.clients.instagram.calls.filter(([name]) => name === "publishReel");
  assert.equal(publishes.length, 1);
  assert.deepEqual(publishes[0][1], {
    videoUrl: videoUrl(1),
    coverUrl: coverUrl(1),
    caption: captionOf("F1").instagram,
    thumbOffsetMs: CONFIG.platforms.instagram.thumbOffsetMs,
  });

  const entry = deps.store.state.items.F1.instagram;
  assert.equal(entry.status, "posted");
  assert.equal(entry.url, "https://www.instagram.com/reel/r1/");
  assert.equal(entry.mediaId, "M1");
  assert.equal(entry.date, TODAY);
  assert.equal(deps.store.saves.at(-1).items.F1.instagram.status, "posted");

  // The post is saved before anything else happens, Telegram included.
  assert.equal(events.indexOf("save"), events.indexOf("tunnel close") + 1);
  assert.equal(events.indexOf("tunnel close"), events.indexOf("publishReel") + 1);
  assert.ok(events.indexOf("save") < events.indexOf("send"));
  assert.equal(deps.store.backups.length, 1);

  assert.deepEqual(result.posted, [{ id: "F1", platform: "instagram", url: "https://www.instagram.com/reel/r1/" }]);
  assert.equal(result.today, TODAY);
  assert.equal(result.window, "open");
  assert.equal(result.rhythm, "daily");
  assert.equal(result.readyCount, 7);
  assert.equal(result.dryRun, false);
  assert.equal(typeof result.runDry, "string");
  assert.deepEqual(result.failed, []);
  assert.equal(deps.telegram.sent.length, 1);
  assert.match(deps.telegram.sent[0], /✅ Instagram: F1 https:\/\/www\.instagram\.com\/reel\/r1\//);
});

test("retries once, then records failed and reports it", async () => {
  const { deps } = setup({
    ig: {
      publish: () => {
        throw new Error("processing failed: ERROR");
      },
    },
  });
  const result = await runDay({ now: AT_SLOT, deps });

  assert.equal(deps.clients.instagram.calls.filter(([name]) => name === "publishReel").length, 2);
  assert.deepEqual(deps.sleeps, [60000]);
  const entry = deps.store.state.items.F1.instagram;
  assert.equal(entry.status, "failed");
  assert.equal(entry.error, "processing failed: ERROR");
  assert.equal(entry.attempts, 2);
  assert.equal(deps.store.saves.at(-1).items.F1.instagram.status, "failed");
  assert.deepEqual(result.failed, [{ id: "F1", platform: "instagram", error: "processing failed: ERROR" }]);
  assert.deepEqual(result.posted, []);
  assert.match(deps.telegram.sent[0], /❌ Instagram: F1: processing failed: ERROR/);
});

test("a retry that succeeds records posted", async () => {
  const { deps } = setup({
    ig: {
      publish: (n) => {
        if (n === 1) throw new Error("fetch failed");
        return { mediaId: "M9", url: "https://www.instagram.com/reel/r9/" };
      },
    },
  });
  const result = await runDay({ now: AT_SLOT, deps });
  assert.deepEqual(deps.sleeps, [60000]);
  assert.equal(deps.store.state.items.F1.instagram.status, "posted");
  assert.deepEqual(result.posted, [{ id: "F1", platform: "instagram", url: "https://www.instagram.com/reel/r9/" }]);
});

test("instagram publish passes public urls and always closes the tunnel", async () => {
  const { deps } = setup({
    ig: {
      publish: (n) => {
        if (n === 1) throw new Error("processing failed: ERROR");
        return { mediaId: "M2", url: "https://www.instagram.com/reel/r2/" };
      },
    },
  });
  const result = await runDay({ now: AT_SLOT, deps });

  // A fresh tunnel per attempt, each serving the video and the cover.
  const serve = deps.servePublicly;
  assert.equal(serve.starts.length, 2);
  for (const start of serve.starts) {
    assert.equal(start.ngrokBin, CONFIG.platforms.instagram.ngrokBin);
    assert.deepEqual(start.files, [
      { path: "/videos/F1.mp4", name: "video.mp4" },
      { path: "/videos/F1-cover.png", name: "cover.png" },
    ]);
  }
  const publishes = deps.clients.instagram.calls.filter(([name]) => name === "publishReel").map(([, args]) => args);
  assert.deepEqual(publishes.map((a) => [a.videoUrl, a.coverUrl]), [
    [videoUrl(1), coverUrl(1)],
    [videoUrl(2), coverUrl(2)],
  ]);
  // Closed after the failed attempt too.
  assert.deepEqual(serve.closes, [1, 2]);
  assert.deepEqual(result.posted, [{ id: "F1", platform: "instagram", url: "https://www.instagram.com/reel/r2/" }]);

  // With the cover switched off, only the video is served and thumb_offset is used.
  const config = structuredClone(CONFIG);
  config.platforms.instagram.useCover = false;
  const noCover = setup({ config });
  await runDay({ now: AT_SLOT, deps: noCover.deps });
  assert.deepEqual(noCover.deps.servePublicly.starts[0].files, [{ path: "/videos/F1.mp4", name: "video.mp4" }]);
  const args = noCover.deps.clients.instagram.calls.find(([name]) => name === "publishReel")[1];
  assert.equal(args.coverUrl, undefined);
  assert.equal(args.thumbOffsetMs, CONFIG.platforms.instagram.thumbOffsetMs);
  assert.deepEqual(noCover.deps.servePublicly.closes, [1]);
});

test("tunnel start failure is a failed attempt with the ngrok error", async () => {
  const { deps } = setup({ serve: { fail: () => true } });
  const result = await runDay({ now: AT_SLOT, deps });

  assert.equal(deps.servePublicly.starts.length, 2);
  assert.equal(deps.clients.instagram.calls.filter(([name]) => name === "publishReel").length, 0);
  assert.deepEqual(deps.sleeps, [60000]);
  const entry = deps.store.state.items.F1.instagram;
  assert.equal(entry.status, "failed");
  assert.equal(entry.attempts, 2);
  assert.match(entry.error, /ngrok failed to start: authentication failed/);
  assert.match(result.failed[0].error, /authtoken/);

  // A tunnel that fails only the first time: the retry posts.
  const flaky = setup({ serve: { fail: (n) => n === 1 } });
  const ok = await runDay({ now: AT_SLOT, deps: flaky.deps });
  assert.equal(ok.posted.length, 1);
  assert.deepEqual(flaky.deps.servePublicly.closes, [2]);
});

test("already-live guard records instead of reposting", async () => {
  const live = {
    id: "M77",
    caption: "F1  First Line\r\n\r\n#acmecoffee",
    timestamp: "2026-10-25T12:00:00+0000", // 2 h before the run
    permalink: "https://www.instagram.com/reel/live/",
  };
  const { deps } = setup({ ig: { media: [live] } });
  const result = await runDay({ now: AT_SLOT, deps });

  const names = deps.clients.instagram.calls.map(([name]) => name);
  assert.ok(!names.includes("publishReel"));
  assert.deepEqual(deps.clients.instagram.calls.find(([name]) => name === "listMedia")[1], { limit: 10 });
  const entry = deps.store.state.items.F1.instagram;
  assert.equal(entry.status, "posted");
  assert.equal(entry.url, "https://www.instagram.com/reel/live/");
  assert.equal(entry.mediaId, "M77");
  assert.equal(entry.date, TODAY);
  assert.deepEqual(result.alreadyLive, [{ id: "F1", platform: "instagram", url: "https://www.instagram.com/reel/live/" }]);
  assert.deepEqual(result.posted, []);
});

test("already-live guard ignores a matching post older than 48 h", async () => {
  const old = { id: "M1", caption: "F1 first line", timestamp: "2026-10-23T12:00:00+0000", permalink: "https://www.instagram.com/reel/old/" };
  const { deps } = setup({ ig: { media: [old] } });
  const result = await runDay({ now: AT_SLOT, deps });
  assert.equal(deps.clients.instagram.calls.filter(([name]) => name === "publishReel").length, 1);
  assert.deepEqual(result.alreadyLive, []);
});

test("second runDay on the same day makes no client calls", async () => {
  const { deps } = setup();
  await runDay({ now: AT_SLOT, deps });
  assert.equal(deps.store.state.items.F1.instagram.status, "posted");

  deps.clients.instagram.calls.length = 0;
  const later = new Date("2026-10-25T14:20:00Z"); // 19:50 IST, "run when available" firing again
  const result = await runDay({ now: later, deps });
  assert.deepEqual(deps.clients.instagram.calls, []);
  assert.deepEqual(result.posted, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.alreadyLive, []);
  assert.equal(Object.keys(deps.store.state.items).length, 1);
});

test("dry run touches nothing", async () => {
  const { deps } = setup({
    items: [...F(7), { id: "P", kind: "special", dir: "x/P", on: "2026-10-11" }],
    tokens: { instagram: { token: "TOKEN", userId: "1", username: "acme.coffee", issuedAt: "2026-08-01T00:00:00.000Z" } },
  });
  const before = structuredClone(deps.store.state);
  const result = await runDay({ now: AT_SLOT, dryRun: true, deps });

  assert.equal(result.dryRun, true);
  assert.deepEqual(deps.clients.instagram.calls, []);
  assert.deepEqual(deps.store.saves, []);
  assert.deepEqual(deps.store.backups, []);
  assert.deepEqual(deps.tokens.saved, []);
  assert.deepEqual(deps.telegram.sent, []);
  assert.deepEqual(deps.store.state, before);
  assert.deepEqual(result.posted, []);
  assert.deepEqual(result.dropped, [{ id: "P", platform: "instagram", reason: "pinned date passed" }]);
  assert.deepEqual(result.plan.posts, [{ id: "F1", platform: "instagram", why: "queue" }]);
});

test("drops are recorded", async () => {
  const { deps } = setup({ items: [{ id: "P", kind: "special", dir: "x/P", on: "2026-10-11" }, ...F(7)] });
  const result = await runDay({ now: AT_SLOT, deps });

  const entry = deps.store.state.items.P.instagram;
  assert.equal(entry.status, "dropped");
  assert.equal(entry.reason, "pinned date passed");
  assert.equal(entry.at, AT_SLOT.toISOString());
  assert.equal(deps.store.saves[0].items.P.instagram.status, "dropped");
  assert.deepEqual(result.dropped, [{ id: "P", platform: "instagram", reason: "pinned date passed" }]);
  assert.match(deps.telegram.sent[0], /🗑️ Dropped: P \(pinned date passed\)/);
});

test("not-ready items carry their check errors", async () => {
  const { deps } = setup({ broken: { F1: ["video missing: x/F1/out/f1.mp4"] } });
  const result = await runDay({ now: AT_SLOT, deps });
  assert.deepEqual(result.notReady, [{ id: "F1", errors: ["video missing: x/F1/out/f1.mp4"] }]);
  assert.deepEqual(result.posted.map((p) => p.id), ["F2"]);
  assert.match(deps.telegram.sent[0], /⚠️ Not ready: F1: video missing/);
});

test("refreshes an old Instagram token", async () => {
  const { deps } = setup({
    tokens: { instagram: { token: "TOKEN", userId: "1", username: "acme.coffee", issuedAt: "2026-09-20T14:00:00.000Z" } },
  });
  await runDay({ now: AT_SLOT, deps });
  assert.equal(deps.clients.instagram.calls.filter(([name]) => name === "refreshToken").length, 1);
  assert.equal(deps.tokens.saved.length, 1);
  assert.deepEqual(deps.tokens.saved[0].instagram, {
    token: "NEWTOKEN",
    userId: "1",
    username: "acme.coffee",
    issuedAt: AT_SLOT.toISOString(),
  });
});

test("a fresh Instagram token is left alone", async () => {
  const { deps } = setup();
  await runDay({ now: AT_SLOT, deps });
  assert.ok(!deps.clients.instagram.calls.some(([name]) => name === "refreshToken"));
  assert.deepEqual(deps.tokens.saved, []);
});

test("refresh failure becomes a warning", async () => {
  const { deps } = setup({
    tokens: { instagram: { token: "TOKEN", userId: "1", username: "acme.coffee", issuedAt: "2026-09-20T14:00:00.000Z" } },
    ig: {
      refresh: () => {
        throw new Error("Session has expired");
      },
    },
  });
  const result = await runDay({ now: AT_SLOT, deps });
  assert.deepEqual(deps.tokens.saved, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Instagram token refresh failed: Session has expired/);
  assert.equal(result.posted.length, 1);
  assert.match(deps.telegram.sent[0], /⚠️ Instagram token refresh failed/);
});

test("telegram failure does not throw", async () => {
  const { deps } = setup({ tg: { fail: true } });
  const result = await runDay({ now: AT_SLOT, deps });
  assert.equal(result.posted.length, 1);
  assert.ok(deps.log.lines.some(([level, msg]) => level === "error" && /telegram/i.test(msg)));
});

test("late start posts nothing but reports; early start posts nothing and stays silent", async () => {
  const late = setup();
  const lateResult = await runDay({ now: new Date("2026-10-25T16:30:00Z"), deps: late.deps }); // 22:00 IST
  assert.equal(lateResult.window, "late");
  assert.ok(!late.deps.clients.instagram.calls.some(([name]) => name === "publishReel" || name === "listMedia"));
  assert.deepEqual(lateResult.posted, []);
  assert.equal(late.deps.telegram.sent.length, 1);
  assert.match(late.deps.telegram.sent[0], /⏰ Started after 21:30/);

  const early = setup();
  const earlyResult = await runDay({ now: new Date("2026-10-25T13:30:00Z"), deps: early.deps }); // 19:00 IST
  assert.equal(earlyResult.window, "early");
  assert.ok(!early.deps.clients.instagram.calls.some(([name]) => name === "publishReel" || name === "listMedia"));
  assert.deepEqual(earlyResult.posted, []);
  assert.deepEqual(early.deps.telegram.sent, []);
});

test("youtube posts its own item with the youtube title and description", async () => {
  const config = structuredClone(CONFIG);
  config.platforms.youtube.enabled = true;
  const { deps } = setup({
    config,
    state: { version: 1, items: { F1: { instagram: { status: "posted", date: "2026-10-24", at: "2026-10-24T14:00:00.000Z" } } } },
  });
  const ytCalls = [];
  deps.clients.youtube = {
    async uploadShort(args) {
      ytCalls.push(["uploadShort", args]);
      return { videoId: "V1", url: "https://youtube.com/shorts/V1" };
    },
    async listUploads() {
      ytCalls.push(["listUploads"]);
      return [];
    },
  };
  const result = await runDay({ now: AT_SLOT, deps });

  assert.deepEqual(ytCalls.find(([name]) => name === "uploadShort")[1], {
    videoPath: "/videos/F1.mp4",
    title: "F1 title #shorts",
    description: "F1 first line\n\n#acmecoffee",
    privacy: "private",
    categoryId: "22",
  });
  assert.equal(deps.store.state.items.F1.youtube.status, "posted");
  assert.equal(deps.store.state.items.F1.youtube.mediaId, "V1");
  // Only Instagram's post opened a tunnel.
  assert.equal(deps.servePublicly.starts.length, 1);
  assert.equal(deps.servePublicly.starts[0].files[0].path, "/videos/F2.mp4");
  assert.deepEqual(result.posted, [
    { id: "F2", platform: "instagram", url: "https://www.instagram.com/reel/r1/" },
    { id: "F1", platform: "youtube", url: "https://youtube.com/shorts/V1" },
  ]);
});

test("postNow posts one item outside the planner and records it", async () => {
  const { deps } = setup();
  const morning = new Date("2026-10-25T04:30:00Z"); // 10:00 IST, outside the window
  const result = await postNow({ item: deps.items[3], platform: "instagram", now: morning, deps });

  assert.deepEqual(result, {
    id: "F4",
    platform: "instagram",
    outcome: "posted",
    url: "https://www.instagram.com/reel/r1/",
    warnings: [],
  });
  const publishes = deps.clients.instagram.calls.filter(([name]) => name === "publishReel");
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0][1].videoUrl, videoUrl(1));
  assert.deepEqual(deps.servePublicly.starts[0].files, [
    { path: "/videos/F4.mp4", name: "video.mp4" },
    { path: "/videos/F4-cover.png", name: "cover.png" },
  ]);
  assert.deepEqual(deps.servePublicly.closes, [1]);
  const entry = deps.store.state.items.F4.instagram;
  assert.equal(entry.status, "posted");
  assert.equal(entry.date, TODAY);
  assert.equal(deps.store.saves.at(-1).items.F4.instagram.status, "posted");
  assert.equal(deps.store.backups.length, 1);
  assert.deepEqual(deps.telegram.sent, []);
});

test("postNow uses the already-live guard", async () => {
  const live = { id: "M5", caption: "F1 first line", timestamp: "2026-10-25T12:00:00+0000", permalink: "https://www.instagram.com/reel/live/" };
  const { deps } = setup({ ig: { media: [live] } });
  const result = await postNow({ item: deps.items[0], platform: "instagram", now: AT_SLOT, deps });
  assert.equal(result.outcome, "alreadyLive");
  assert.equal(result.url, "https://www.instagram.com/reel/live/");
  assert.ok(!deps.clients.instagram.calls.some(([name]) => name === "publishReel"));
  assert.equal(deps.store.state.items.F1.instagram.mediaId, "M5");
});

test("postNow retries once, then records failed", async () => {
  const { deps } = setup({
    ig: {
      publish: () => {
        throw new Error("processing failed: ERROR");
      },
    },
  });
  const result = await postNow({ item: deps.items[0], platform: "instagram", now: AT_SLOT, deps });
  assert.deepEqual(result, { id: "F1", platform: "instagram", outcome: "failed", error: "processing failed: ERROR", warnings: [] });
  assert.deepEqual(deps.sleeps, [60000]);
  assert.equal(deps.store.state.items.F1.instagram.status, "failed");
  assert.equal(deps.store.state.items.F1.instagram.attempts, 2);
});

test("postNow refuses a done item, a broken item or a missing client, and touches nothing", async () => {
  const state = { version: 1, items: { F1: { instagram: { status: "dropped", reason: "past notAfter", at: FRESH } } } };
  const { deps } = setup({ state, broken: { F2: ["cover missing: x/F2/out/f2-cover.png"] } });
  await assert.rejects(postNow({ item: deps.items[0], platform: "instagram", now: AT_SLOT, deps }), /F1 is already dropped on instagram/);
  await assert.rejects(postNow({ item: deps.items[1], platform: "instagram", now: AT_SLOT, deps }), /F2 fails check: cover missing/);
  await assert.rejects(postNow({ item: deps.items[2], platform: "youtube", now: AT_SLOT, deps }), /no youtube client/);
  assert.deepEqual(deps.clients.instagram.calls, []);
  assert.deepEqual(deps.store.saves, []);
  assert.deepEqual(deps.store.backups, []);
});

test("the report names the campaign", async () => {
  const acme = setup();
  await runDay({ now: AT_SLOT, deps: acme.deps });
  assert.match(acme.deps.telegram.sent[0], /^Acme Coffee · Sun 25 Oct/);

  const globex = setup();
  await runDay({ now: AT_SLOT, deps: { ...globex.deps, name: "Globex" } });
  assert.match(globex.deps.telegram.sent[0], /^Globex · Sun 25 Oct/);
});
