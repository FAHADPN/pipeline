import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelegram } from "../lib/telegram.mjs";

// A fake fetch that records every call and answers with one canned reply.
function fakeFetch(reply = { status: 200, body: { ok: true, result: {} } }) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const keyboard = [[{ text: "Approve", callback_data: "approve:x" }, { text: "Redo", callback_data: "redo:x" }]];

function tempVideo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-test-"));
  const file = path.join(dir, "piece.mp4");
  fs.writeFileSync(file, Buffer.from("not really a video"));
  return { dir, file };
}

test("sendVideo posts multipart with chat_id, caption and reply_markup", async () => {
  const { dir, file } = tempVideo();
  try {
    const { fetch, calls } = fakeFetch();
    const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

    await tg.sendVideo({ path: file, caption: "c".repeat(2000), keyboard });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.telegram.org/botBOT:TOKEN/sendVideo");
    assert.equal(calls[0].init.method, "POST");
    const form = calls[0].init.body;
    assert.ok(form instanceof FormData, "body is FormData");
    assert.equal(form.get("chat_id"), "42");
    assert.equal(form.get("caption").length, 1024);
    assert.deepEqual(JSON.parse(form.get("reply_markup")), { inline_keyboard: keyboard });
    const video = form.get("video");
    assert.ok(video instanceof Blob, "video is a file part");
    assert.equal(video.name, "piece.mp4");
    assert.equal(await video.text(), "not really a video");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sendVideo does not cut an emoji in half", async () => {
  const { dir, file } = tempVideo();
  try {
    const { fetch, calls } = fakeFetch();
    const tg = createTelegram({ token: "T", chatId: "42", fetch });

    await tg.sendVideo({ path: file, caption: "a" + "🎉".repeat(600) });

    const caption = calls[0].init.body.get("caption");
    assert.ok(caption.length <= 1024);
    assert.ok(!/[\uD800-\uDBFF]$/.test(caption), "ends on a lone high surrogate");
    assert.equal(calls[0].init.body.get("reply_markup"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sendVideo error does not leak the token", async () => {
  const { dir, file } = tempVideo();
  try {
    const { fetch } = fakeFetch({ status: 400, body: { ok: false, description: "Bad Request: file too big" } });
    const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

    await assert.rejects(tg.sendVideo({ path: file, caption: "hi", keyboard }), (err) => {
      assert.match(err.message, /file too big/);
      assert.ok(!err.message.includes("BOT:TOKEN"));
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sendMessage sends a keyboard or a force reply", async () => {
  const { fetch, calls } = fakeFetch({ status: 200, body: { ok: true, result: { message_id: 7 } } });
  const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

  const sent = await tg.sendMessage("pick one", { keyboard });
  await tg.sendMessage("What should change?", { forceReply: true });
  await tg.sendMessage("plain");

  assert.deepEqual(sent, { message_id: 7 });
  assert.equal(calls[0].url, "https://api.telegram.org/botBOT:TOKEN/sendMessage");
  const first = JSON.parse(calls[0].init.body);
  assert.equal(first.chat_id, "42");
  assert.equal(first.text, "pick one");
  assert.deepEqual(first.reply_markup, { inline_keyboard: keyboard });
  assert.deepEqual(JSON.parse(calls[1].init.body).reply_markup, { force_reply: true });
  assert.equal(JSON.parse(calls[2].init.body).reply_markup, undefined);
});

test("getUpdates passes offset and returns result[]", async () => {
  const updates = [{ update_id: 5, message: { text: "hi" } }];
  const { fetch, calls } = fakeFetch({ status: 200, body: { ok: true, result: updates } });
  const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

  const got = await tg.getUpdates({ offset: 5 });

  assert.deepEqual(got, updates);
  assert.equal(calls[0].url, "https://api.telegram.org/botBOT:TOKEN/getUpdates");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.offset, 5);
  assert.equal(body.timeout, 0);
});

test("getUpdates error does not leak the token", async () => {
  const fetch = async (url) => {
    throw new Error(`connect failed for ${url}`);
  };
  const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

  await assert.rejects(tg.getUpdates({ offset: 1 }), (err) => {
    assert.ok(!err.message.includes("BOT:TOKEN"));
    return true;
  });
});

test("answerCallbackQuery", async () => {
  const { fetch, calls } = fakeFetch({ status: 200, body: { ok: true, result: true } });
  const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

  await tg.answerCallbackQuery("cbq-1", "Approved");

  assert.equal(calls[0].url, "https://api.telegram.org/botBOT:TOKEN/answerCallbackQuery");
  assert.deepEqual(JSON.parse(calls[0].init.body), { callback_query_id: "cbq-1", text: "Approved" });
});

test("existing send unchanged", async () => {
  const { fetch, calls } = fakeFetch();
  const tg = createTelegram({ token: "BOT:TOKEN", chatId: "42", fetch });

  const result = await tg.send("hello");

  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botBOT:TOKEN/sendMessage");
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: "42", text: "hello", disable_web_page_preview: true });
});
