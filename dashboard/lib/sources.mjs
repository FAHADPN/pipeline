// One campaign's data, as the dashboard reads it: its settings, schedule, publishing
// state, tokens, build list and build progress, and where its pieces, media and
// reviewer reports are. Every campaign is read this way, from a campaign object
// (campaigns/lib/campaign.mjs) and the secrets store. Read-only.
//
// Data = { campaign, root, home, config, items, state, tokens, secretValues,
//          backlog, cstate, pieceDir(id), mediaUrl(id, file), outDir }
//
// Each file is read the first time its field is asked for, then kept, so an action
// that only needs the schedule never reads the build list or the build progress.

import fs from "node:fs";
import path from "node:path";
import { loadSchedule } from "../../publishing/lib/schedule.mjs";
import { createSecretTokenStore, createStateStore } from "../../publishing/lib/state.mjs";
import { publishConfig } from "../../publishing/lib/campaign-deps.mjs";
import { createCreationStore } from "../../creation/lib/cstate.mjs";
import { OUT_DIR } from "../../creation/lib/constants.mjs";

const SECRET_KEY = /token|secret/i;
// A campaign's secrets that are credentials, as opposed to ids and dates.
const SECRET_VALUES = ["IG_ACCESS_TOKEN", "YT_REFRESH_TOKEN", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY"];
// The owner's .env credentials: the owner bot posts every campaign's notices and the
// Google client refreshes every campaign's YouTube token, so any log can quote them.
const OWNER_SECRETS = ["TELEGRAM_BOT_TOKEN", "YT_CLIENT_SECRET", "IG_ACCESS_TOKEN"];
// Shorter values aren't credentials, and replacing them would garble ordinary text.
const OWNER_MIN_LENGTH = 8;

// The owner's credential values from the publisher's .env (`env`, as loadEnv reads it).
export function ownerSecretValues(env = {}) {
  return OWNER_SECRETS.map((name) => env[name]).filter((v) => typeof v === "string" && v.length >= OWNER_MIN_LENGTH);
}

// Every string value under a token-like key, however deep.
function secretsOf(value, out = []) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && typeof v === "string" && v) out.push(v);
      else secretsOf(v, out);
    }
  }
  return out;
}

// A last guard: any token value that slipped into a string (an error message in the
// log, say) is replaced before a result leaves the dashboard, as typed and URL-encoded
// (a request URL quoted in an error carries it encoded). `value` may be a string or any
// JSON-able structure.
export function scrub(value, secrets) {
  if (!secrets.length) return value;
  // Longest first, so no form is left half-replaced by a shorter one inside it.
  const forms = [...new Set(secrets.flatMap((s) => [s, encodeURIComponent(s)]))].sort((a, b) => b.length - a.length);
  return JSON.parse(JSON.stringify(value), (key, v) =>
    typeof v === "string" ? forms.reduce((s, secret) => s.replaceAll(secret, "[redacted]"), v) : v,
  );
}

// The build list, or [] when the campaign has none yet.
function readBacklog(file) {
  if (!fs.existsSync(file)) return [];
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`can't read build list ${file}: ${err.message}`);
  }
  if (!Array.isArray(entries)) throw new Error(`build list ${file} must be a list`);
  return entries;
}

// `read`, called once on first use.
function once(read) {
  let done = false;
  let value;
  return () => {
    if (!done) {
      value = read();
      done = true;
    }
    return value;
  };
}

// `env` is the owner's .env: its credentials are scrubbed with the campaign's own.
export function loadCampaignData({ campaign, secrets, env = {} }) {
  if (!secrets) throw new Error("loadCampaignData needs the secrets store");
  const { id, root, home } = campaign;
  const config = once(() => publishConfig(campaign));
  const items = once(() => loadSchedule(campaign.paths.schedule, root));
  const state = once(() => createStateStore(home).load());
  const tokens = once(() => createSecretTokenStore(secrets, id).load());
  const secretValues = once(() => {
    const values = SECRET_VALUES.map((name) => secrets.get(id, name)).filter(Boolean);
    return [...new Set([...secretsOf(tokens()), ...values, ...ownerSecretValues(env)])];
  });
  const backlog = once(() => readBacklog(campaign.paths.backlog));
  const cstate = once(() => createCreationStore(home).load());

  return {
    campaign,
    root,
    home,
    get config() {
      return config();
    },
    get items() {
      return items();
    },
    get state() {
      return state();
    },
    get tokens() {
      return tokens();
    },
    get secretValues() {
      return secretValues();
    },
    get backlog() {
      return backlog();
    },
    get cstate() {
      return cstate();
    },
    // A piece's folder, relative to root.
    pieceDir: (pieceId) => campaign.paths.verifyPrefix(pieceId).replace(/\/+$/, ""),
    // Always names the campaign: the server's default, the first in folder order, can change.
    mediaUrl: (pieceId, file) => `/media/${pieceId}/${file}?campaign=${id}`,
    outDir: path.join(root, OUT_DIR),
  };
}
