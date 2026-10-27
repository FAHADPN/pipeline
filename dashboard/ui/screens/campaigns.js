// Campaigns: every campaign with its health, whether it is paused and its next post, from
// /api/campaigns. When the owner can act, each has Pause or Resume and a settings form
// (the fields saveSettings takes), and New campaign creates one from the blank template.
// Names and ids are always text.
//
//   campaignsScreen(ctx) -> Node, where ctx = { campaigns, today, canAct,
//     act(name, args, campaignId, button) -> Promise<{ ok, ... }>, confirm(text) -> boolean }
//   (createCampaign is sent with a null campaignId)

import { h } from "../dom.js";
import { dayLabel } from "../lib/format.js";

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CHAT_ID = /^-?\d{1,20}$/;
const MAX_APPROVERS = 10;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CHECK_LABELS = {
  captionPy: "Caption check",
  detect: "AI-writing check on the caption",
  detectOnScreen: "AI-writing check on screen text",
  hookscore: "Hook score",
  guardrails: "Word lists",
};
const HEALTH = {
  ok: ["status-posted", "Healthy"],
  problems: ["status-fix", "Needs a look"],
  error: ["tag-red", "Can't read it"],
};

const line = (text) => h("p", { className: "muted connection-line" }, text);

// The refusal line under a form, and a way to show it.
function problemLine() {
  const el = h("p", { className: "banner banner-err conn-error", role: "alert", hidden: true });
  return {
    el,
    show(text) {
      el.textContent = text;
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
  };
}

function textField(id, label, value, props = {}) {
  const input = h("input", { id, type: "text", className: "conn-input", autocomplete: "off", ...props });
  input.value = value ?? "";
  return { input, el: h("div", { className: "idea-field" }, h("label", { for: id }, label), input) };
}

function checkbox(label, checked) {
  const input = h("input", { type: "checkbox" });
  input.checked = Boolean(checked);
  return { input, el: h("label", { className: "cmp-check" }, input, h("span", {}, label)) };
}

function checkGroup(legend, items) {
  return h("fieldset", { className: "cmp-checks" }, h("legend", {}, legend), items.map((i) => i.el));
}

// A whole number from a field, or NaN.
const whole = (input) => (/^\d+$/.test(input.value.trim()) ? Number(input.value.trim()) : NaN);

// What a change does that the form wouldn't otherwise show, for the owner to confirm:
// switching Instagram off, or moving the posting time. null when nothing needs asking.
function consequences(c, fields) {
  const out = [];
  if (fields["platforms.instagram.enabled"] === false && c.settings["platforms.instagram.enabled"] === true) {
    out.push(`Nothing will post to Instagram for ${c.name} until you switch it back on.`);
  }
  if ("slot" in fields) out.push(`${c.name} will post at ${fields.slot} instead of ${c.settings.slot}, starting with the next window.`);
  return out.length ? `${out.join(" ")} Save?` : null;
}

// The settings form of campaign `c`. Only the fields that changed are sent.
function settingsForm(c, act, confirm) {
  const s = c.settings;
  const key = (name) => `cmp-${c.id}-${name}`;
  const name = textField(key("name"), "Name", s.name, { maxlength: 80 });
  const slot = textField(key("slot"), "Posting time", s.slot, { type: "time" });
  const late = textField(key("late"), "Late limit (minutes)", String(s.lateLimitMinutes), { type: "number", min: 1 });
  const buffer = textField(key("buffer"), "Post daily from (ready pieces)", String(s.bufferMin), { type: "number", min: 0 });
  const days = DAYS.map((d) => ({ day: d, ...checkbox(d, s.fallbackDays.includes(d)) }));
  const instagram = checkbox("Instagram", s["platforms.instagram.enabled"]);
  const youtube = checkbox("YouTube", s["platforms.youtube.enabled"]);
  const approvers = textField(key("approvers"), "Approvers (Telegram chat ids, comma separated)", s.approvers.join(", "));
  const checks = Object.keys(s)
    .filter((k) => k.startsWith("checks."))
    .map((k) => ({ field: k, ...checkbox(CHECK_LABELS[k.slice(7)] ?? k.slice(7), s[k]) }));
  const problem = problemLine();
  const save = h("button", { type: "submit", className: "btn btn-primary" }, "Save settings");

  // The form's values by field name, or throws the first problem.
  const values = () => {
    const out = {
      name: name.input.value.trim(),
      slot: slot.input.value,
      lateLimitMinutes: whole(late.input),
      bufferMin: whole(buffer.input),
      fallbackDays: days.filter((d) => d.input.checked).map((d) => d.day),
      "platforms.instagram.enabled": instagram.input.checked,
      "platforms.youtube.enabled": youtube.input.checked,
      approvers: approvers.input.value.split(/[\s,]+/).filter(Boolean),
      ...Object.fromEntries(checks.map((ch) => [ch.field, ch.input.checked])),
    };
    if (!out.name) throw new Error("Give it a name.");
    if (!/^\d\d:\d\d$/.test(out.slot)) throw new Error("Pick a posting time.");
    if (!(out.lateLimitMinutes >= 1)) throw new Error("The late limit is a whole number of minutes, 1 or more.");
    if (Number.isNaN(out.bufferMin)) throw new Error("Post daily from is a whole number, 0 or more.");
    const bad = out.approvers.find((a) => !CHAT_ID.test(a));
    if (bad !== undefined) throw new Error(`${bad} isn't a Telegram chat id: digits, with a - in front for a group.`);
    out.approvers = [...new Set(out.approvers)];
    if (out.approvers.length > MAX_APPROVERS) throw new Error(`At most ${MAX_APPROVERS} approvers.`);
    return out;
  };

  return h(
    "details",
    { className: "cmp-settings" },
    h("summary", {}, "Settings"),
    h(
      "form",
      {
        className: "conn-form cmp-form",
        onSubmit: async (e) => {
          e.preventDefault();
          let all;
          try {
            all = values();
          } catch (err) {
            return problem.show(err.message);
          }
          // Fallback days in week order, so a file listing them otherwise isn't a change.
          const before = { ...s, fallbackDays: DAYS.filter((d) => s.fallbackDays.includes(d)) };
          const fields = Object.fromEntries(Object.entries(all).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
          if (!Object.keys(fields).length) return problem.show("Nothing changed.");
          const ask = consequences(c, fields);
          if (ask && !confirm(ask)) return;
          problem.hide();
          const out = await act("saveSettings", { fields }, c.id, save);
          if (!out?.ok) problem.show(out?.error ?? "Something went wrong.");
        },
      },
      name.el,
      h("div", { className: "cmp-grid" }, slot.el, late.el, buffer.el),
      checkGroup("Fallback days (below the daily level, post only on these)", days),
      checkGroup("Platforms", [instagram, youtube]),
      approvers.el,
      checkGroup("Automatic checks", checks),
      problem.el,
      h("div", { className: "conn-row" }, save),
    ),
  );
}

function campaignCard(c, { today, canAct, act, confirm }) {
  const [healthClass, healthText] = HEALTH[c.health] ?? HEALTH.error;
  const next = c.next ? `Next post ${dayLabel(c.next, today)}` : "Nothing queued";
  const pause = canAct
    ? h(
        "button",
        {
          type: "button",
          className: "btn",
          onClick: (e) => {
            const button = e.currentTarget;
            if (c.paused) return act("setPaused", { paused: false }, c.id, button);
            if (confirm(`Pause ${c.name}? It won't post or build until you resume it.`)) return act("setPaused", { paused: true }, c.id, button);
          },
        },
        c.paused ? "Resume" : "Pause",
      )
    : null;
  return h(
    "section",
    { className: "card connection", "aria-label": c.name },
    h(
      "div",
      { className: "connection-head" },
      h("h2", { className: "connection-name" }, c.name),
      h("span", { className: "pills" }, c.paused ? h("span", { className: "pill status-held" }, "Paused") : null, h("span", { className: `pill ${healthClass}` }, healthText)),
    ),
    line(`${c.id} · ${next}`),
    pause ? h("div", { className: "conn-row" }, pause) : null,
    canAct && c.settings ? settingsForm(c, act, confirm) : null,
  );
}

function newCampaignCard(act) {
  const id = textField("cmp-new-id", "Id (lowercase letters, digits and dashes)", "", { maxlength: 40, placeholder: "acme-studio" });
  const name = textField("cmp-new-name", "Name", "", { maxlength: 80 });
  const problem = problemLine();
  const create = h("button", { type: "submit", className: "btn btn-primary" }, "Create campaign");
  return h(
    "section",
    { className: "card connection", "aria-label": "New campaign" },
    h("div", { className: "connection-head" }, h("h2", { className: "connection-name" }, "New campaign")),
    line("It starts paused, in its own folder with an empty brief, voice and build list."),
    h(
      "form",
      {
        className: "conn-form cmp-form",
        onSubmit: async (e) => {
          e.preventDefault();
          const args = { id: id.input.value.trim(), name: name.input.value.trim(), template: "blank" };
          if (!ID.test(args.id)) return problem.show("The id is up to 40 lowercase letters, digits and dashes, starting with a letter or digit.");
          if (!args.name) return problem.show("Give it a name.");
          problem.hide();
          const out = await act("createCampaign", args, null, create);
          if (out?.ok) {
            id.input.value = "";
            name.input.value = "";
          } else {
            problem.show(out?.error ?? "Something went wrong.");
          }
        },
      },
      id.el,
      name.el,
      problem.el,
      h("div", { className: "conn-row" }, create),
    ),
  );
}

export function campaignsScreen({ campaigns = [], today, canAct = false, act = async () => ({ ok: false }), confirm = () => false }) {
  const ctx = { today, canAct, act, confirm };
  return h(
    "div",
    { className: "screen" },
    h("div", { className: "screen-head" }, h("h1", {}, "Campaigns")),
    canAct ? null : h("p", { className: "muted" }, "View only: open the console through Tailscale, signed in, to change these."),
    h("div", { className: "connections" }, campaigns.map((c) => campaignCard(c, ctx)), canAct ? newCampaignCard(act) : null),
  );
}
