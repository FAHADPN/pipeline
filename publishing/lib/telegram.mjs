// Telegram Bot API client: the run report, plus the video, buttons and updates
// the approval flow needs. The bot token sits in the URL, so it is scrubbed from
// every error message.

import fs from "node:fs";
import path from "node:path";

const MAX_TEXT = 4000;
const MAX_CAPTION = 1024;

// Cut to max UTF-16 units without leaving half an emoji at the end.
function truncate(text, max = MAX_TEXT) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// keyboard is [[{ text, callback_data }]].
function replyMarkup({ keyboard, forceReply } = {}) {
  if (keyboard) return { inline_keyboard: keyboard };
  if (forceReply) return { force_reply: true };
  return undefined;
}

export function createTelegram({ token, chatId, fetch = globalThis.fetch }) {
  const scrub = (msg) => (token ? String(msg).split(String(token)).join("[redacted]") : String(msg));
  const urlFor = (method) => `https://api.telegram.org/bot${token}/${method}`;

  // POST to one Bot API method and return its `result`.
  async function call(method, init) {
    let res;
    try {
      res = await fetch(urlFor(method), { method: "POST", ...init });
    } catch (err) {
      throw new Error(scrub(`telegram request failed: ${err.message}`));
    }
    let body = {};
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = {};
    }
    if (!res.ok || body.ok === false) throw new Error(scrub(`telegram: ${body.description ?? res.status}`));
    return body.result;
  }

  const callJson = (method, payload) =>
    call(method, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

  return {
    async send(text) {
      await callJson("sendMessage", { chat_id: chatId, text: truncate(String(text)), disable_web_page_preview: true });
    },

    async sendMessage(text, options = {}) {
      return callJson("sendMessage", {
        chat_id: chatId,
        text: truncate(String(text)),
        disable_web_page_preview: true,
        reply_markup: replyMarkup(options),
      });
    },

    async sendVideo({ path: file, caption, keyboard }) {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (caption != null) form.append("caption", truncate(String(caption), MAX_CAPTION));
      const markup = replyMarkup({ keyboard });
      if (markup) form.append("reply_markup", JSON.stringify(markup));
      form.append("video", await fs.openAsBlob(file, { type: "video/mp4" }), path.basename(file));
      return call("sendVideo", { body: form });
    },

    async getUpdates({ offset, timeoutSec = 0 } = {}) {
      const result = await callJson("getUpdates", { offset, timeout: timeoutSec });
      return Array.isArray(result) ? result : [];
    },

    async answerCallbackQuery(id, text) {
      return callJson("answerCallbackQuery", { callback_query_id: id, text });
    },
  };
}
