import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegram } from "../lib/telegram.mjs";
import { formatReport } from "../lib/report.mjs";

// A fake fetch that records every call and answers with one canned reply.
function fakeFetch(reply = { status: 200, body: { ok: true, result: {} } }) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

// A RunResult with nothing in it; tests override the fields they care about.
function R(overrides = {}) {
  return {
    today: "2026-10-25",
    window: "open",
    rhythm: "daily",
    readyCount: 13,
    runDry: "2026-11-09",
    dryRun: false,
    posted: [],
    failed: [],
    dropped: [],
    notReady: [],
    alreadyLive: [],
    warnings: [],
    postingDay: true,
    ...overrides,
  };
}

const lines = (text) => text.split("\n");

// Acme Coffee's report, with any other options.
const report = (result, options) => formatReport(result, { name: "Acme Coffee", ...options });

test("telegram sends JSON to the bot URL and truncates", async () => {
  const { fetch, calls } = fakeFetch();
  const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

  await tg.send("x".repeat(5000));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botBOT:TOKEN/sendMessage");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, "42");
  assert.equal(body.disable_web_page_preview, true);
  assert.ok(body.text.length <= 4000, `sent ${body.text.length} chars`);
});

test("telegram does not cut an emoji in half", async () => {
  const { fetch, calls } = fakeFetch();
  const tg = createTelegram({ token: "T", chatId: "42", fetch });

  await tg.send("a" + "✅🎉".repeat(3000));

  const { text } = JSON.parse(calls[0].init.body);
  assert.ok(text.length <= 4000);
  assert.ok(!/[\uD800-\uDBFF]$/.test(text), "ends on a lone high surrogate");
});

test("telegram error surfaces the description without the token", async () => {
  const { fetch } = fakeFetch({ status: 400, body: { ok: false, description: "Bad Request: chat not found" } });
  const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

  await assert.rejects(tg.send("hi"), (err) => {
    assert.match(err.message, /chat not found/);
    assert.ok(!err.message.includes("BOT:TOKEN"));
    return true;
  });
});

test("telegram network error does not leak the token", async () => {
  const fetch = async (url) => {
    throw new Error(`connect failed for ${url}`);
  };
  const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

  await assert.rejects(tg.send("hi"), (err) => {
    assert.ok(!err.message.includes("BOT:TOKEN"));
    return true;
  });
});

test("report: success", () => {
  const text = report(
    R({
      today: "2026-10-24",
      posted: [{ id: "reel-04-new-blend", platform: "instagram", url: "https://www.instagram.com/reel/x/" }],
    }),
  );

  assert.deepEqual(lines(text), [
    "Acme Coffee · Sat 24 Oct",
    "✅ Instagram: reel-04-new-blend https://www.instagram.com/reel/x/",
    "Queue: 13 ready · daily · runs dry 9 Nov",
  ]);
});

test("report: failure, drop and not-ready lines", () => {
  const text = report(
    R({
      posted: [{ id: "F2", platform: "youtube", url: "https://youtube.com/shorts/V1" }],
      failed: [{ id: "F1", platform: "instagram", error: "processing failed: ERROR" }],
      alreadyLive: [{ id: "F3", platform: "instagram", url: "https://www.instagram.com/reel/y/" }],
      dropped: [
        { id: "special-holiday", platform: "instagram", reason: "pinned date passed" },
        { id: "special-holiday", platform: "youtube", reason: "pinned date passed" },
        { id: "reel-12-rainy-day", platform: "instagram", reason: "past notAfter" },
      ],
      notReady: [{ id: "reel-09", errors: ["missing out/reel-09.mp4", "caption has no YOUTUBE SHORTS TITLE"] }],
      warnings: ["Instagram token refresh failed: boom"],
      readyCount: 4,
      rhythm: "4-a-week",
      runDry: null,
    }),
  );

  assert.deepEqual(lines(text), [
    "Acme Coffee · Sun 25 Oct",
    "✅ YouTube: F2 https://youtube.com/shorts/V1",
    "❌ Instagram: F1: processing failed: ERROR (retries next posting day)",
    "↩️ Instagram: F3 was already live, recorded https://www.instagram.com/reel/y/",
    "🗑️ Dropped: special-holiday (pinned date passed)",
    "🗑️ Dropped: reel-12-rainy-day (past notAfter)",
    "⚠️ Not ready: reel-09: missing out/reel-09.mp4; caption has no YOUTUBE SHORTS TITLE",
    "⚠️ Instagram token refresh failed: boom",
    "Queue: 4 ready · 4-a-week · runs dry never",
  ]);
});

test("report: late", () => {
  const text = report(
    R({ window: "late", dropped: [{ id: "P", platform: "instagram", reason: "pinned date passed" }] }),
  );

  assert.deepEqual(lines(text), [
    "Acme Coffee · Sun 25 Oct",
    "🗑️ Dropped: P (pinned date passed)",
    "⏰ Started after 21:30: nothing posted today.",
    "Queue: 13 ready · daily · runs dry 9 Nov",
  ]);
  assert.ok(!text.includes("No post today"));
});

test("report: the late line uses the campaign's own slot and late limit", () => {
  const late = (options) => lines(report(R({ window: "late" }), options))[1];
  assert.equal(late({ slot: "19:30", lateLimitMinutes: 120 }), "⏰ Started after 21:30: nothing posted today.");
  assert.equal(late({ name: "Globex", slot: "17:00", lateLimitMinutes: 60 }), "⏰ Started after 18:00: nothing posted today.");
  assert.equal(late({ slot: "08:45", lateLimitMinutes: 30 }), "⏰ Started after 09:15: nothing posted today.");
  assert.equal(late({ slot: "23:00", lateLimitMinutes: 90 }), "⏰ Started after 00:30: nothing posted today.");
  assert.equal(late({ name: "Globex" }), "⏰ Started after 21:30: nothing posted today.");
});

test("report: off day", () => {
  const text = report(R({ today: "2026-10-27", postingDay: false, rhythm: "4-a-week", readyCount: 3 }));

  assert.deepEqual(lines(text), [
    "Acme Coffee · Tue 27 Oct",
    "😴 No post today (4-a-week rhythm).",
    "Queue: 3 ready · 4-a-week · runs dry 9 Nov",
  ]);
});

test("report: off day with a pinned post shows the post, not the off-day line", () => {
  const text = report(
    R({ postingDay: false, posted: [{ id: "P", platform: "instagram", url: "https://www.instagram.com/reel/p/" }] }),
  );

  assert.ok(text.includes("✅ Instagram: P https://www.instagram.com/reel/p/"));
  assert.ok(!text.includes("No post today"));
});

test("report: dry run prefix", () => {
  const text = report(R({ dryRun: true }));

  assert.equal(lines(text)[0], "DRY RUN · Acme Coffee · Sun 25 Oct");
});

test("report: the header names the campaign", () => {
  assert.equal(lines(formatReport(R(), { name: "Acme Coffee" }))[0], "Acme Coffee · Sun 25 Oct");
  assert.equal(lines(formatReport(R(), { name: "Globex" }))[0], "Globex · Sun 25 Oct");
  assert.equal(lines(formatReport(R({ dryRun: true }), { name: "Globex" }))[0], "DRY RUN · Globex · Sun 25 Oct");
});
