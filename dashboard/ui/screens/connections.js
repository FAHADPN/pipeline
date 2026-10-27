// Connections: Instagram, YouTube, Telegram and the campaign's Anthropic API key, from
// status.connections. Secrets are write-only: each shows "set, N days ago" or "not set",
// and a new value goes in through a password field that never starts filled and is
// cleared as soon as it is sent. The forms show only when the owner can act. YouTube is
// status only: a channel is connected from the command line (publish.mjs auth youtube).
//
//   connectionsScreen(ctx) -> Node, where ctx = { status, canAct,
//     act(name, args, button) -> Promise<{ ok, ... }>, confirm(text) -> boolean }

import { h } from "../dom.js";
import { days } from "../lib/format.js";

const DAY_MS = 86400000;
const CHAT_ID = /^-?\d{1,20}$/;
const MAX_APPROVERS = 10;
const SECRET_LABELS = {
  IG_ACCESS_TOKEN: "Instagram access token",
  IG_USER_ID: "Instagram account id",
  IG_USERNAME: "Instagram username",
  IG_ISSUED_AT: "Instagram token date",
  YT_REFRESH_TOKEN: "YouTube sign-in",
  YT_CHANNEL: "YouTube channel",
  TELEGRAM_BOT_TOKEN: "Telegram bot token",
  ANTHROPIC_API_KEY: "Anthropic API key",
};

// "today" or "3 days ago" for an ISO time, seen from `now`; null when either can't be read.
export function ago(iso, now) {
  const n = Math.floor((Date.parse(now) - Date.parse(iso)) / DAY_MS);
  if (Number.isNaN(n)) return null;
  return n <= 0 ? "today" : `${days(n)} ago`;
}

// "set, 3 days ago", "set today" or "not set", for a secret's { set, updatedAt }.
export function secretAge(entry, now) {
  if (!entry?.set) return "not set";
  const when = ago(entry.updatedAt, now);
  if (when === null) return "set";
  return when === "today" ? "set today" : `set, ${when}`;
}

function card(name, pill, ...body) {
  return h(
    "section",
    { className: "card connection", "aria-label": name },
    h("div", { className: "connection-head" }, h("h2", { className: "connection-name" }, name), pill),
    ...body,
  );
}

// A green pill when `ok`, else the `otherwise` colour (grey by default).
const pill = (ok, text, otherwise = "status-dropped") => h("span", { className: `pill ${ok ? "status-posted" : otherwise}` }, text);
const line = (text) => h("p", { className: "muted connection-line" }, text);

// A one-field form: `label` over the input and its button, the refusal under them.
// `send(value, button)` resolves the server's result (and shows the button busy); a
// secret field is cleared as soon as it is sent, whatever comes back.
function oneField({ id, label, button, secret, check, send }) {
  const input = h("input", {
    id,
    type: secret ? "password" : "text",
    className: "conn-input",
    autocomplete: "off",
    ...(secret ? {} : { maxlength: 21 }),
  });
  const submit = h("button", { type: "submit", className: "btn" }, button);
  const problem = h("p", { className: "banner banner-err conn-error", role: "alert", hidden: true });
  const fail = (text) => {
    problem.textContent = text;
    problem.hidden = false;
  };
  return h(
    "form",
    {
      className: "conn-form",
      onSubmit: async (e) => {
        e.preventDefault();
        const value = input.value.trim();
        const why = check(value);
        if (why) return fail(why);
        problem.hidden = true;
        if (secret) input.value = "";
        const out = await send(value, submit);
        if (out?.ok) input.value = "";
        else fail(out?.error ?? "Something went wrong.");
      },
    },
    h("label", { for: id }, label),
    h("div", { className: "conn-row" }, input, submit),
    problem,
  );
}

const pasted = (what) => (value) => (value ? null : `Paste the ${what} first.`);

function instagramCard({ c, now, canAct, act }) {
  const { username, tokenAgeDays } = c.instagram ?? {};
  const connected = Boolean(c.secrets?.IG_ACCESS_TOKEN?.set);
  const detail = username
    ? `@${username}${typeof tokenAgeDays === "number" ? ` · token ${days(tokenAgeDays)} old` : ""}`
    : "Nothing posts until it is connected.";
  return card(
    "Instagram",
    pill(connected, connected ? "Connected" : "Not connected"),
    line(detail),
    line(`Access token: ${secretAge(c.secrets?.IG_ACCESS_TOKEN, now)}`),
    canAct
      ? oneField({
          id: "conn-ig-token",
          label: connected ? "Replace the access token" : "Paste an access token",
          button: "Save token",
          secret: true,
          check: pasted("token"),
          send: (token, button) => act("setInstagramToken", { token }, button),
        })
      : null,
  );
}

function youtubeCard({ c }) {
  const { connected, channel } = c.youtube ?? {};
  return card(
    "YouTube",
    pill(Boolean(connected), connected ? "Connected" : "Not connected"),
    line(channel ? `Channel: ${channel}` : connected ? "Channel name not known yet." : "No channel connected."),
    line("Google keeps uploads private until your API project passes its audit. Connect a channel with node publishing/publish.mjs auth youtube --campaign <id>."),
  );
}

function telegramCard({ c, now, canAct, act, confirm }) {
  const tg = c.telegram ?? { approvers: [], seenChats: [], ownBot: false };
  const approvers = tg.approvers ?? [];
  const full = approvers.length >= MAX_APPROVERS;
  const save = (list, button) => act("setTelegram", { approvers: list }, button);
  const ready = tg.ownBot && approvers.length > 0;

  const approverRows = approvers.map((chatId) =>
    h(
      "li",
      { className: "conn-item" },
      h("span", { className: "conn-chat" }, chatId),
      canAct
        ? h(
            "button",
            {
              type: "button",
              className: "btn",
              "aria-label": `Remove approver ${chatId}`,
              onClick: (e) => {
                if (confirm(`Remove ${chatId}? It won't get approval requests any more.`)) save(approvers.filter((a) => a !== chatId), e.currentTarget);
              },
            },
            "Remove",
          )
        : null,
    ),
  );

  const seenRows = (tg.seenChats ?? []).map((chat) =>
    h(
      "li",
      { className: "conn-item" },
      h(
        "span",
        { className: "conn-seen" },
        h("span", { className: "conn-seen-name" }, chat.name ?? "No name"),
        h("span", { className: "muted small" }, [chat.chatId, ago(chat.at, now)].filter(Boolean).join(" · ")),
      ),
      canAct
        ? h(
            "button",
            { type: "button", className: "btn", disabled: full, "aria-label": `Add ${chat.chatId} as an approver`, onClick: (e) => save([...approvers, chat.chatId], e.currentTarget) },
            "Add as approver",
          )
        : null,
    ),
  );

  const sendTest = canAct
    ? h(
        "button",
        { type: "button", className: "btn", disabled: !ready, onClick: (e) => act("testTelegram", {}, e.currentTarget) },
        "Send test",
      )
    : null;

  return card(
    "Telegram",
    pill(ready, ready ? "Connected" : "Needs setup", "status-fix"),
    line(`Bot token: ${secretAge(c.secrets?.TELEGRAM_BOT_TOKEN, now)}${tg.ownBot ? "" : " (approval messages go through the owner's bot)"}`),
    canAct
      ? oneField({
          id: "conn-tg-bot",
          label: tg.ownBot ? "Replace the bot token" : "Paste the bot token from BotFather",
          button: "Save token",
          secret: true,
          check: pasted("bot token"),
          send: (botToken, button) => act("setTelegram", { botToken }, button),
        })
      : null,
    h("h3", { className: "conn-sub" }, `Approvers (${approvers.length})`),
    approvers.length ? h("ul", { className: "conn-list" }, approverRows) : line("No approvers yet: nobody gets the videos to approve."),
    canAct && !full
      ? oneField({
          id: "conn-tg-approver",
          label: "Add an approver by chat id",
          button: "Add",
          secret: false,
          check: (v) => (CHAT_ID.test(v) ? (approvers.includes(v) ? `${v} is already an approver.` : null) : "A chat id is digits, with a - in front for a group."),
          send: (chatId, button) => save([...approvers, chatId], button),
        })
      : null,
    sendTest ? h("div", { className: "conn-row" }, sendTest) : null,
    h("h3", { className: "conn-sub" }, "Recent chats"),
    seenRows.length
      ? h("ul", { className: "conn-list" }, seenRows)
      : line("Nobody else has messaged the bot lately. Ask an approver to send it /start, then reload."),
  );
}

function claudeCard({ c, now, canAct, act, confirm }) {
  const key = c.secrets?.ANTHROPIC_API_KEY;
  const send = (value, button) => act("setSecret", { name: "ANTHROPIC_API_KEY", value }, button);
  return card(
    "Claude usage",
    pill(Boolean(key?.set), key?.set ? "API key" : "Subscription", "status-ready"),
    line(key?.set ? "Builds and reviews for this campaign bill its own API key." : "No API key: builds use the owner's subscription. Add one to bill this campaign separately."),
    line(`API key: ${secretAge(key, now)}`),
    canAct
      ? oneField({
          id: "conn-api-key",
          label: key?.set ? "Replace the API key" : "Paste an API key",
          button: "Save key",
          secret: true,
          check: pasted("key"),
          send,
        })
      : null,
    canAct && key?.set
      ? h(
          "div",
          { className: "conn-row" },
          h(
            "button",
            {
              type: "button",
              className: "btn",
              onClick: (e) => {
                if (confirm("Remove the API key? Builds go back to the owner's subscription.")) send("", e.currentTarget);
              },
            },
            "Remove key",
          ),
        )
      : null,
  );
}

function secretsCard({ c, now }) {
  const rows = Object.entries(c.secrets ?? {}).map(([name, entry]) =>
    h("li", { className: "conn-item" }, h("span", {}, SECRET_LABELS[name] ?? name), h("span", { className: "muted" }, secretAge(entry, now))),
  );
  return card("Stored secrets", null, rows.length ? h("ul", { className: "conn-list" }, rows) : line("None yet."));
}

export function connectionsScreen({ status, canAct = false, act = async () => ({ ok: false }), confirm = () => false }) {
  const c = status.connections ?? {};
  const ctx = { c, now: status.generatedAt, canAct, act, confirm };
  return h(
    "div",
    { className: "screen" },
    h("div", { className: "screen-head" }, h("h1", {}, "Connections")),
    canAct ? null : h("p", { className: "muted" }, "View only: open the console through Tailscale, signed in, to change these."),
    h("div", { className: "connections" }, instagramCard(ctx), youtubeCard(ctx), telegramCard(ctx), claudeCard(ctx), secretsCard(ctx)),
    h("p", { className: "muted small" }, "Tokens are write-only here: you can replace one, never read it back."),
  );
}
