// The campaign model. A campaign is a directory under the campaigns root
// (C:\Campaigns, or PIPELINE_CAMPAIGNS_ROOT) holding a campaign.json. This loads
// and checks those files and turns each into a campaign object: its config with
// defaults applied, absolute paths, its state home and its lock names.
// The fields are listed in campaigns/schema.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publisherHome } from "../../publishing/lib/env.mjs";
import { FORMATS } from "../../creation/lib/backlog.mjs";
import { PICKER_DEFAULTS } from "../../creation/lib/picker.mjs";

const ID_RE = /^[a-z0-9-]+$/;
const SLOT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CHAT_ID_RE = /^-?\d+$/;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PRIVACY = ["private", "unlisted", "public"];

// The posting defaults, and the creation picker's.
const DEFAULTS = {
  timezone: "Asia/Kolkata",
  paused: false,
  slot: "19:30",
  lateLimitMinutes: 120,
  bufferMin: 7,
  fallbackDays: ["Mon", "Wed", "Fri", "Sun"],
  retryDelaySeconds: 60,
  formats: PICKER_DEFAULTS.formats,
  maxBuilds: PICKER_DEFAULTS.maxBuilds,
  maxAwaiting: PICKER_DEFAULTS.maxAwaiting,
  approvers: [],
  extraAllowedTools: [],
};
const PLATFORM_DEFAULTS = {
  instagram: {
    enabled: true,
    graphVersion: "v24.0",
    useCover: true,
    thumbOffsetMs: 1500,
    tokenRefreshDays: 30,
    // Found on PATH when it's a bare name.
    ngrokBin: "ngrok",
  },
  youtube: { enabled: false, privacy: "private", categoryId: "22" },
};
const CHECK_DEFAULTS = { captionPy: true, detect: true, detectOnScreen: true, hookscore: true, guardrails: true };
const VIDEO_SPEC_DEFAULTS = {
  width: 1080,
  height: 1920,
  minSeconds: 7,
  maxSeconds: 35,
  audioRequired: true,
  youtubeTitleRequired: true,
};
const PATH_DEFAULTS = {
  schedule: "schedule.json",
  backlog: "backlog.json",
  brief: "brief.md",
  voice: "voice.md",
  references: "references.md",
  piecesDir: "pieces",
  guardrails: "guardrails.json",
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min) => Number.isInteger(v) && v >= min;
const isText = (v) => typeof v === "string" && v.trim() !== "";

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// `%USERPROFILE%` or `~` at the start means the user's home folder, so a
// checked-in campaign.json can point outside its root (a voice file kept in ~/.claude).
function expandHome(p) {
  const m = p.match(/^(%USERPROFILE%|~)(?=$|[\\/])/i);
  return m ? path.join(os.homedir(), p.slice(m[0].length)) : p;
}

function checkKeys(obj, allowed, where, problems) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) problems.push(`${where}.${k} is not a known field`);
}

function checkBooleans(obj, keys, where, problems) {
  for (const k of keys) {
    if (obj[k] !== undefined && typeof obj[k] !== "boolean") problems.push(`${where}${k} must be true or false`);
  }
}

// Every problem with one campaign.json, as readable lines. [] means valid.
export function validateCampaign(config) {
  if (!isObject(config)) return ["campaign.json must be a JSON object"];
  const c = config;
  const problems = [];

  if (typeof c.id !== "string" || !ID_RE.test(c.id)) problems.push("id must be lowercase letters, digits and dashes");
  if (!isText(c.name)) problems.push("name is required");
  if (!isText(c.root)) problems.push("root is required");
  else if (!path.isAbsolute(c.root)) problems.push("root must be an absolute path");
  if (c.timezone !== undefined && (typeof c.timezone !== "string" || !validTimezone(c.timezone))) {
    problems.push(`timezone ${JSON.stringify(c.timezone)} is not a known IANA time zone`);
  }
  checkBooleans(c, ["paused"], "", problems);

  if (c.slot !== undefined && !(typeof c.slot === "string" && SLOT_RE.test(c.slot))) problems.push("slot must be HH:MM");
  if (c.lateLimitMinutes !== undefined && !isInt(c.lateLimitMinutes, 1)) problems.push("lateLimitMinutes must be a whole number above 0");
  if (c.bufferMin !== undefined && !isInt(c.bufferMin, 0)) problems.push("bufferMin must be a whole number, 0 or more");
  if (c.retryDelaySeconds !== undefined && !isInt(c.retryDelaySeconds, 0)) problems.push("retryDelaySeconds must be a whole number, 0 or more");
  if (c.fallbackDays !== undefined && !(Array.isArray(c.fallbackDays) && c.fallbackDays.every((d) => DAYS.includes(d)))) {
    problems.push(`fallbackDays must list days from ${DAYS.join(", ")}`);
  }

  if (c.platforms !== undefined) {
    if (!isObject(c.platforms)) problems.push("platforms must be an object");
    else {
      checkKeys(c.platforms, Object.keys(PLATFORM_DEFAULTS), "platforms", problems);
      const ig = c.platforms.instagram;
      if (ig !== undefined) {
        if (!isObject(ig)) problems.push("platforms.instagram must be an object");
        else {
          checkKeys(ig, Object.keys(PLATFORM_DEFAULTS.instagram), "platforms.instagram", problems);
          checkBooleans(ig, ["enabled", "useCover"], "platforms.instagram.", problems);
          if (ig.graphVersion !== undefined && !isText(ig.graphVersion)) problems.push("platforms.instagram.graphVersion must be text");
          if (ig.thumbOffsetMs !== undefined && !isInt(ig.thumbOffsetMs, 0)) problems.push("platforms.instagram.thumbOffsetMs must be a whole number, 0 or more");
          if (ig.tokenRefreshDays !== undefined && !isInt(ig.tokenRefreshDays, 1)) problems.push("platforms.instagram.tokenRefreshDays must be a whole number above 0");
          if (ig.ngrokBin !== undefined && !isText(ig.ngrokBin)) problems.push("platforms.instagram.ngrokBin must be a path or a command name");
        }
      }
      const yt = c.platforms.youtube;
      if (yt !== undefined) {
        if (!isObject(yt)) problems.push("platforms.youtube must be an object");
        else {
          checkKeys(yt, Object.keys(PLATFORM_DEFAULTS.youtube), "platforms.youtube", problems);
          checkBooleans(yt, ["enabled"], "platforms.youtube.", problems);
          if (yt.privacy !== undefined && !PRIVACY.includes(yt.privacy)) problems.push(`platforms.youtube.privacy must be one of ${PRIVACY.join(", ")}`);
          if (yt.categoryId !== undefined && !(typeof yt.categoryId === "string" && /^\d+$/.test(yt.categoryId))) {
            problems.push("platforms.youtube.categoryId must be a number in a string");
          }
        }
      }
    }
  }

  if (c.formats !== undefined) {
    if (!Array.isArray(c.formats)) problems.push("formats must be a list");
    else for (const f of c.formats) if (!FORMATS.includes(f)) problems.push(`unknown format ${JSON.stringify(f)} (known: ${FORMATS.join(", ")})`);
  }
  if (c.maxBuilds !== undefined && !isInt(c.maxBuilds, 0)) problems.push("maxBuilds must be a whole number, 0 or more");
  if (c.maxAwaiting !== undefined && !isInt(c.maxAwaiting, 1)) problems.push("maxAwaiting must be a whole number above 0");
  if (c.approvers !== undefined && !(Array.isArray(c.approvers) && c.approvers.every((a) => typeof a === "string" && CHAT_ID_RE.test(a)))) {
    problems.push("approvers must be a list of Telegram chat ids as strings");
  }
  if (c.extraAllowedTools !== undefined && !(Array.isArray(c.extraAllowedTools) && c.extraAllowedTools.every(isText))) {
    problems.push("extraAllowedTools must be a list of tool names");
  }

  if (c.checks !== undefined) {
    if (!isObject(c.checks)) problems.push("checks must be an object");
    else {
      checkKeys(c.checks, Object.keys(CHECK_DEFAULTS), "checks", problems);
      checkBooleans(c.checks, Object.keys(CHECK_DEFAULTS), "checks.", problems);
    }
  }

  if (c.videoSpec !== undefined) {
    if (!isObject(c.videoSpec)) problems.push("videoSpec must be an object");
    else {
      const v = c.videoSpec;
      checkKeys(v, Object.keys(VIDEO_SPEC_DEFAULTS), "videoSpec", problems);
      for (const k of ["width", "height", "minSeconds", "maxSeconds"]) {
        if (v[k] !== undefined && !(typeof v[k] === "number" && v[k] > 0)) problems.push(`videoSpec.${k} must be a number above 0`);
      }
      checkBooleans(v, ["audioRequired", "youtubeTitleRequired"], "videoSpec.", problems);
      const min = v.minSeconds ?? VIDEO_SPEC_DEFAULTS.minSeconds;
      const max = v.maxSeconds ?? VIDEO_SPEC_DEFAULTS.maxSeconds;
      if (typeof min === "number" && typeof max === "number" && min >= max) problems.push("videoSpec.minSeconds must be below maxSeconds");
    }
  }

  if (c.paths !== undefined) {
    if (!isObject(c.paths)) problems.push("paths must be an object");
    else {
      checkKeys(c.paths, [...Object.keys(PATH_DEFAULTS), "verifyPrefix"], "paths", problems);
      for (const k of Object.keys(PATH_DEFAULTS)) {
        if (c.paths[k] !== undefined && !isText(c.paths[k])) problems.push(`paths.${k} must be a path`);
      }
      const vp = c.paths.verifyPrefix;
      if (vp !== undefined) {
        if (!isText(vp) || !vp.includes("<id>")) problems.push("paths.verifyPrefix must contain <id>");
        else if (path.isAbsolute(vp) || /^[\\/]/.test(vp) || vp.split(/[\\/]/).includes("..")) {
          problems.push("paths.verifyPrefix must be relative to root and stay inside it");
        }
      } else if (isText(c.paths.piecesDir) && path.isAbsolute(expandHome(c.paths.piecesDir))) {
        problems.push("paths.verifyPrefix is required when paths.piecesDir is an absolute path");
      }
    }
  }

  return problems;
}

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

// The campaign object for a config that validateCampaign passed.
function makeCampaign(raw, home) {
  const platforms = raw.platforms ?? {};
  // Cloned so no two campaigns share a default list (approvers, formats).
  const config = {
    ...structuredClone(DEFAULTS),
    ...raw,
    platforms: {
      instagram: { ...PLATFORM_DEFAULTS.instagram, ...platforms.instagram },
      youtube: { ...PLATFORM_DEFAULTS.youtube, ...platforms.youtube },
    },
    checks: { ...CHECK_DEFAULTS, ...raw.checks },
    videoSpec: { ...VIDEO_SPEC_DEFAULTS, ...raw.videoSpec },
    paths: { ...PATH_DEFAULTS, ...raw.paths },
  };
  const root = path.resolve(config.root);
  const paths = {};
  for (const k of Object.keys(PATH_DEFAULTS)) paths[k] = path.resolve(root, expandHome(config.paths[k]));
  // The verifier's allowed folder, relative to root with forward slashes (git's form).
  const prefixTemplate = config.paths.verifyPrefix ?? `${toPosix(config.paths.piecesDir).replace(/\/+$/, "")}/<id>/`;
  config.paths.verifyPrefix = prefixTemplate;
  paths.verifyPrefix = (pieceId) => {
    if (typeof pieceId !== "string" || !ID_RE.test(pieceId)) throw new Error(`bad piece id ${JSON.stringify(pieceId)}`);
    return toPosix(prefixTemplate.replaceAll("<id>", pieceId));
  };

  return {
    id: config.id,
    name: config.name,
    root,
    paused: config.paused,
    config,
    paths,
    home: path.join(home, "campaigns", config.id),
    lockName: (name) => `${config.id}:${name}`,
  };
}

// The campaigns root: PIPELINE_CAMPAIGNS_ROOT, or C:\Campaigns.
export function campaignsRoot() {
  return process.env.PIPELINE_CAMPAIGNS_ROOT ?? "C:\\Campaigns";
}

// The folders under the root that hold a campaign.json, in folder order, valid or
// not. A missing root has none.
export function campaignIds({ root = campaignsRoot() } = {}) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "campaign.json")))
    .map((d) => d.name)
    .sort();
}

// The campaign a command works on: `flagValue` (--campaign's) when given, else the
// only campaign under the root. None or several throws an error with usage: true,
// whose message lists the ids found, for the command to show with its usage.
export function pickCampaignId(flagValue, { root = campaignsRoot() } = {}) {
  if (flagValue !== undefined) return flagValue;
  const ids = campaignIds({ root });
  if (ids.length === 1) return ids[0];
  const message = ids.length
    ? `several campaigns under ${root} (${ids.join(", ")}); pick one with --campaign <id>`
    : `no campaign found under ${root}; make one there, or point PIPELINE_CAMPAIGNS_ROOT at yours`;
  throw Object.assign(new Error(message), { usage: true });
}

// Reads <root>/<dir>/campaign.json. Returns { config } or { problems }.
function readCampaignFile(root, dir) {
  const file = path.join(root, dir, "campaign.json");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { file, problems: [`can't read it: ${err.message}`] };
  }
  const problems = validateCampaign(config);
  if (problems.length === 0 && config.id !== dir) problems.push(`id "${config.id}" must match its folder "${dir}"`);
  return { file, config, problems };
}

function fail(results) {
  const lines = results.flatMap((r) => r.problems.map((p) => `${r.file}: ${p}`));
  const err = new Error(`Invalid campaign config:\n${lines.join("\n")}`);
  err.problems = lines;
  return err;
}

// Every campaign under the root, in folder order. Folders without a
// campaign.json are skipped; any invalid file fails the whole load, with one
// error listing every problem in every file.
export function loadCampaigns({ root = campaignsRoot(), home = publisherHome() } = {}) {
  const results = campaignIds({ root }).map((dir) => readCampaignFile(root, dir));
  const bad = results.filter((r) => r.problems.length > 0);
  if (bad.length > 0) throw fail(bad);
  return results.map((r) => makeCampaign(r.config, home));
}

// One campaign by id. Reads only that campaign's file, so a broken
// neighbour doesn't stop it.
export function getCampaign(id, { root = campaignsRoot(), home = publisherHome() } = {}) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`bad campaign id ${JSON.stringify(id)}`);
  if (!fs.existsSync(path.join(root, id, "campaign.json"))) throw new Error(`unknown campaign ${id}`);
  const r = readCampaignFile(root, id);
  if (r.problems.length > 0) throw fail([r]);
  return makeCampaign(r.config, home);
}
