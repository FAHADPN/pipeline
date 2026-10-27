// The console's server. It binds 127.0.0.1 only; `tailscale serve` publishes it
// inside the tailnet. It serves the console UI, the status JSON and the media of
// scheduled items and backlog pieces, and runs the buttons.
//
//   GET  /                   ui/index.html
//   GET  /ui/<file>          the console's scripts and styles, from UI_FILES only
//   GET  /api/campaigns      { campaigns: [{ id, name, paused, health, connected?, next?, problems?,
//                            settings? }] } (settings: lib/campaign-actions.mjs campaignSettings)
//   GET  /api/status         the status, plus { todos, canAct, csrf?, login? } (todos: lib/inbox.mjs)
//   GET  /api/health         { tasks, loops, tokens, clock, disk, actions } (lib/health.mjs)
//   GET  /api/library       { pieces, counts }: every piece the campaign has built (lib/library.mjs)
//   GET  /api/calendar       { from, days, runDry } for ?from=YYYY-MM-DD&days=1..42 (lib/calendar.mjs);
//                            a bad from or days is 400
//   GET  /api/pipeline       { builds, formats, types, queue }: the build list's entries not built or
//                            approved yet (a todo one with its editable fields as `idea`), the
//                            formats and types an idea can have, and the build queue as
//                            [{ id, kind, position }]
//   GET  /api/review         { pieces }: the pieces awaiting approval, failed, back for a
//                            redo or in the build queue, newest first; with ?id=<id>, that
//                            piece's Review (lib/review.mjs), or 404 when there is none
//   GET  /api/build          ?id=<id>: its build progress { status, since, elapsedSeconds,
//                            lines, queued } (lib/review.mjs), or 404
//   GET  /media/<id>/<file>  an .mp4 or .png directly inside that item's out/, with Range;
//                            ?variant=preview (.mp4 only) serves the cached phone copy,
//                            ?download=1 adds Content-Disposition: attachment
//   POST /api/action         { action, campaign?, csrf, ...its arguments } (ACTIONS below):
//                            postNow and retry, postItem (lib/actions.mjs), and the queue
//                            controls hold, release, pin, unpin, reorder and drop
//                            (lib/queue-actions.mjs), and approve, redo, recheck, buildNow
//                            and unqueue (lib/creation-actions.mjs), and saveIdea and removeIdea
//                            (lib/backlog-actions.mjs), and setInstagramToken, setTelegram,
//                            testTelegram and setSecret (lib/connection-actions.mjs), and
//                            setPaused, saveSettings and createCampaign
//                            (lib/campaign-actions.mjs). An unknown action or a bad argument
//                            is 400.
//
// Status, library, calendar, pipeline, review, build, media and actions take a campaign (?campaign=<id>,
// or "campaign" in the action body), defaulting to the first campaign in folder order; an unknown one
// is 404. createCampaign is the console's, not a campaign's, and ignores it. An action needs the
// tailnet login, this server start's CSRF token and an Origin matching Host;
// anything less is 403. Anything else is 404. Run it with `node dashboard/server.mjs`;
// DASHBOARD_PORT picks another port (8787 by default) for a test instance.
//
// Run directly, it also runs the build queue every minute (startQueueRunner).
//
// Campaigns come from the campaigns root (C:\Campaigns, or PIPELINE_CAMPAIGNS_ROOT),
// listed in folder order.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publisherHome, loadEnv } from "../publishing/lib/env.mjs";
import { isRealDate } from "../publishing/lib/dates.mjs";
import { getCampaign } from "../campaigns/lib/campaign.mjs";
import { createSecrets } from "../campaigns/lib/secrets.mjs";
import { buildStatus, healthSummary } from "./lib/status.mjs";
import { campaignDeps, createActions } from "./lib/actions.mjs";
import { createQueueActions, queueDeps } from "./lib/queue-actions.mjs";
import { createCreationActions, creationDeps } from "./lib/creation-actions.mjs";
import { backlogDeps, createBacklogActions, ideaFormats } from "./lib/backlog-actions.mjs";
import { connectionDeps, createConnectionActions } from "./lib/connection-actions.mjs";
import { campaignSettings, createCampaignActions } from "./lib/campaign-actions.mjs";
import { TYPES } from "../creation/lib/backlog.mjs";
import { readQueue, startNextQueued } from "../creation/lib/build-queue.mjs";
import { createLogger } from "../publishing/lib/log.mjs";
import { buildLibrary } from "./lib/library.mjs";
import { buildCalendar, buildEntries, checkCalendarQuery } from "./lib/calendar.mjs";
import { buildProgress, listReviews, loadReview } from "./lib/review.mjs";
import { needsYou } from "./lib/inbox.mjs";
import { buildHealth, createSystemCheck } from "./lib/health.mjs";
import { loadCampaignData, ownerSecretValues, scrub } from "./lib/sources.mjs";
import { createPreviews } from "./lib/preview.mjs";

const DEFAULT_PORT = 8787;
const UI_DIR = new URL("./ui/", import.meta.url);
const PAGE = fileURLToPath(new URL("index.html", UI_DIR));
// The only files /ui/ serves, by exact path. A new file under ui/ is added here and
// to the allowlist test in the same change.
const UI_FILES = new Map(
  [
    "app.js",
    "api.js",
    "dom.js",
    "player.js",
    "lib/format.js",
    "lib/queue.js",
    "lib/grid.js",
    "lib/drag.js",
    "screens/needs.js",
    "screens/pipeline.js",
    "screens/calendar.js",
    "screens/library.js",
    "screens/health.js",
    "screens/connections.js",
    "screens/review.js",
    "screens/idea-form.js",
    "screens/campaigns.js",
    "styles.css",
  ].map((name) => [`/ui/${name}`, { file: fileURLToPath(new URL(name, UI_DIR)), type: name.endsWith(".css") ? "text/css" : "text/javascript" }]),
);
const HOST = "127.0.0.1";
const IDENTITY_HEADER = "tailscale-user-login";
const ID_RE = /^[a-z0-9-]+$/;
const MEDIA_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(mp4|png)$/;
const MEDIA_TYPES = { ".mp4": "video/mp4", ".png": "image/png" };
const MAX_BODY = 16384;
const QUEUE_RUNNER_MS = 60000;
const PLATFORMS = ["instagram", "youtube"];

// Each action's arguments, by field: a check of the body's value, or "force", which is
// true only for a literal true. "id?" may be left out.
const isId = (v) => typeof v === "string" && ID_RE.test(v);
const FIELDS = {
  id: isId,
  "id?": (v) => v === undefined || isId(v),
  date: isRealDate,
  platform: (v) => PLATFORMS.includes(v),
  before: (v) => v === null || isId(v),
  // Its fields are the action's to judge, so a bad one gets a reason, not a 400.
  entry: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  // Its length is the redo's to judge, so a note that's too long gets a reason, not a 400.
  note: (v) => typeof v === "string",
  // Secret values and chat ids are the connection actions' to judge, with a reason.
  token: (v) => typeof v === "string",
  "botToken?": (v) => v === undefined || typeof v === "string",
  "approvers?": (v) => v === undefined || Array.isArray(v),
  name: (v) => typeof v === "string",
  value: (v) => typeof v === "string",
  paused: (v) => typeof v === "boolean",
  // Which fields may be set, and their values, are saveSettings' to judge, with a reason.
  fields: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  template: (v) => typeof v === "string",
};
const ACTIONS = new Map([
  ["postNow", ["id?", "force"]],
  ["postItem", ["id", "force"]],
  ["retry", ["id", "platform"]],
  ["hold", ["id"]],
  ["release", ["id"]],
  ["pin", ["id", "date"]],
  ["unpin", ["id"]],
  ["reorder", ["id", "before"]],
  ["drop", ["id", "platform"]],
  ["approve", ["id"]],
  ["redo", ["id", "note"]],
  ["recheck", ["id"]],
  ["buildNow", ["id"]],
  ["unqueue", ["id"]],
  ["saveIdea", ["entry"]],
  ["removeIdea", ["id"]],
  ["setInstagramToken", ["token"]],
  ["setTelegram", ["botToken?", "approvers?"]],
  ["testTelegram", []],
  ["setSecret", ["name", "value"]],
  ["setPaused", ["paused"]],
  ["saveSettings", ["fields"]],
  ["createCampaign", ["id", "name", "template"]],
]);
// The actions that aren't about one campaign: the source's own (createCampaign's id is
// the new campaign's).
const CONSOLE_ACTIONS = new Set(["createCampaign"]);

// The arguments `fields` take from `body`, or { bad: field } for the first one that fails.
function actionArgs(fields, body) {
  const args = {};
  for (const field of fields) {
    const key = field.replace("?", "");
    if (field === "force") args.force = body.force === true;
    else if (FIELDS[field](body[key])) args[key] = body[key];
    else return { bad: key };
  }
  return { args };
}
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

// The item folder for an id in a campaign's schedule or its build list (pieces in
// its verify folder), or null. Read on every request, so a newly approved piece is
// servable without a restart.
function itemDir(campaign, id) {
  try {
    const item = readJson(campaign.paths.schedule).find((i) => i?.id === id);
    if (typeof item?.dir === "string" && item.dir) return item.dir;
  } catch {
    // No readable schedule: try the backlog.
  }
  try {
    if (readJson(campaign.paths.backlog).some((e) => e?.id === id)) return campaign.paths.verifyPrefix(id).replace(/\/+$/, "");
  } catch {
    // No backlog yet.
  }
  return null;
}

// The file a /media path names, or null. Works on the raw path, segment by segment,
// so "..", encoded slashes and backslashes can never leave the item's out/ folder.
// `media` = { root, itemDir(id) } for the campaign asked for.
function mediaFile(media, rawPath) {
  const repoRoot = media.root;
  const parts = rawPath.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "media") return null;
  let id, name;
  try {
    id = decodeURIComponent(parts[2]);
    name = decodeURIComponent(parts[3]);
  } catch {
    return null;
  }
  if (!ID_RE.test(id) || !MEDIA_FILE.test(name) || name.includes("..")) return null;
  const dir = media.itemDir(id);
  if (!dir) return null;
  const out = path.resolve(repoRoot, dir, "out");
  const file = path.join(out, name);
  try {
    if (!fs.statSync(file).isFile()) return null;
    if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(out)) return null;
  } catch {
    return null;
  }
  return file;
}

// One "bytes=" range: { start, end }, "unsatisfiable", or null to send the whole file.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : "unsatisfiable";
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start < size && start <= end ? { start, end } : "unsatisfiable";
}

// `downloadAs` is the file name to offer as a download, when the request asked for one.
function sendMedia(req, res, file, downloadAs) {
  const { size } = fs.statSync(file);
  const headers = {
    "Content-Type": MEDIA_TYPES[path.extname(file)],
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  if (downloadAs) headers["Content-Disposition"] = `attachment; filename="${downloadAs}"`;
  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
    return res.end();
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, { ...headers, "Content-Length": size ? end - start + 1 : 0 });
  if (!size) return res.end();
  fs.createReadStream(file, { start, end })
    .on("error", () => res.destroy())
    .pipe(res);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

// True when the browser says the request came from a page on this same host. Every
// browser sends Origin on a POST; a request without one is refused.
function sameOrigin(req) {
  const { origin, host } = req.headers;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The request body as JSON, or { status } for one that's too big or isn't JSON.
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        finish({ status: 413 });
        req.resume();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(body && typeof body === "object" && !Array.isArray(body) ? { body } : { status: 400 });
      } catch {
        finish({ status: 400 });
      }
    });
    req.on("error", () => finish({ status: 400 }));
  });
}

// `campaigns` = { list(), get(id) -> { getStatus, actions, media } | null } (see
// createCampaignSource).
export function createServer({ campaigns: source, login, port = DEFAULT_PORT }) {
  if (!source) throw new Error("createServer needs a campaign source");
  const csrf = crypto.randomBytes(32).toString("base64url");
  // Only the configured tailnet login may act. With no DASHBOARD_LOGIN set, nobody can.
  const canAct = (req) => Boolean(login) && req.headers[IDENTITY_HEADER] === login;

  // The campaign a request names (?campaign=, or the action body's), as { entry } for a
  // known campaign, { status: 404 } for an unknown one or a name that can't be one, or
  // { status: 500, error } for one whose campaign.json is broken. None named means the
  // first campaign in folder order.
  async function lookup(value) {
    try {
      const id = value === undefined ? (await source.list())[0]?.id : value;
      if (!isId(id)) return { status: 404 };
      const entry = await source.get(id);
      return entry ? { entry } : { status: 404 };
    } catch (err) {
      return { status: 500, error: err.message };
    }
  }

  // Every check passes before an action runs; any failure is 403 and nothing posts.
  async function handleAction(req, res) {
    const refuse = (status, error) => sendJson(res, status, { ok: false, error });
    if (!canAct(req)) return refuse(403, "not allowed");
    if (!sameOrigin(req)) return refuse(403, "not allowed");
    if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(415, "send JSON");
    const { body, status } = await readBody(req);
    if (status) return refuse(status, status === 413 ? "request too large" : "bad request");
    if (!safeEqual(body.csrf, csrf)) return refuse(403, "not allowed");

    let acts = source.actions;
    if (!CONSOLE_ACTIONS.has(body.action)) {
      const found = await lookup(body.campaign);
      if (!found.entry) return refuse(found.status, found.error ?? "unknown campaign");
      acts = found.entry.actions;
    }
    const fields = ACTIONS.get(body.action);
    if (!fields || typeof acts?.[body.action] !== "function") return refuse(400, "unknown action");
    const { args, bad } = actionArgs(fields, body);
    if (bad) return refuse(400, `bad ${bad}`);
    try {
      return sendJson(res, 200, await acts[body.action](args));
    } catch (err) {
      return refuse(500, err.message);
    }
  }

  // Answers one read of the campaign `value` names with `read(entry)`'s result: 404 for
  // an unknown campaign or a null result, 500 with the (scrubbed) message when the read
  // throws.
  async function sendRead(res, value, read) {
    const found = await lookup(value);
    if (!found.entry) return sendJson(res, found.status, { error: found.error ?? "unknown campaign" });
    let body;
    try {
      body = await read(found.entry);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
    return body === null ? sendJson(res, 404, { error: "not found" }) : sendJson(res, 200, body);
  }

  // Every campaign with a health summary from its status, and its settings. A campaign
  // whose campaign.json or status is broken is listed as "error", without the reason.
  async function listCampaigns() {
    const list = await source.list();
    return Promise.all(
      list.map(async ({ id, name, paused, error }) => {
        const base = { id, name, paused: paused === true };
        if (error) return { ...base, health: "error" };
        let entry;
        try {
          entry = await source.get(id);
          return { ...base, ...healthSummary(await entry.getStatus()), settings: entry.settings };
        } catch {
          return { ...base, health: "error", settings: entry?.settings };
        }
      }),
    );
  }

  // The machine's cached checks { tasks, clock, disk } for the to-dos, or null when the
  // source has none or they fail. Status reads only this, never the log reads of health().
  async function readSystem() {
    try {
      const system = await source.system?.();
      return system?.tasks ? system : null;
    } catch {
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    const [rawPath, rawQuery = ""] = (req.url ?? "").split(/\?(.*)/s);
    if (req.method === "POST" && rawPath === "/api/action") return handleAction(req, res);
    if (req.method !== "GET") return notFound(res);
    const params = new URLSearchParams(rawQuery);
    const query = { campaign: params.has("campaign") ? params.get("campaign") : undefined };

    if (rawPath === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": PAGE_CSP,
      });
      return res.end(fs.readFileSync(PAGE));
    }

    const asset = UI_FILES.get(rawPath);
    if (asset) {
      res.writeHead(200, { "Content-Type": `${asset.type}; charset=utf-8`, "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(asset.file));
    }

    if (rawPath === "/api/campaigns") {
      try {
        return sendJson(res, 200, { campaigns: await listCampaigns() });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (rawPath === "/api/status") {
      const found = await lookup(query.campaign);
      if (!found.entry) return sendJson(res, found.status, { error: found.error ?? "unknown campaign" });
      let status;
      try {
        status = await found.entry.getStatus();
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
      const act = canAct(req);
      // The machine's checks add their to-dos; if they can't be read the rest still shows.
      const system = await readSystem();
      const todos = needsYou(system ? { ...status, system } : status, { now: new Date() });
      // `login` is the tailnet header, sent back only when it is the configured login.
      return sendJson(res, 200, { ...status, todos, canAct: act, ...(act ? { csrf, login: req.headers[IDENTITY_HEADER] } : {}) });
    }

    if (rawPath === "/api/health") {
      try {
        return sendJson(res, 200, (await source.health?.()) ?? { tasks: [], loops: [], tokens: [], clock: null, disk: null, actions: [] });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (rawPath === "/api/library") return sendRead(res, query.campaign, (entry) => entry.getLibrary());
    if (rawPath === "/api/pipeline") return sendRead(res, query.campaign, (entry) => entry.getPipeline());
    if (rawPath === "/api/review" && !params.has("id")) {
      return sendRead(res, query.campaign, async (entry) => ({ pieces: await entry.getReviews() }));
    }
    if (rawPath === "/api/review" || rawPath === "/api/build") {
      const id = params.get("id");
      const read = rawPath === "/api/review" ? "getReview" : "getBuild";
      return sendRead(res, query.campaign, (entry) => (isId(id) ? entry[read](id) : null));
    }

    if (rawPath === "/api/calendar") {
      const days = params.get("days");
      const range = { from: params.get("from") ?? undefined, days: days === null ? undefined : /^\d+$/.test(days) ? Number(days) : NaN };
      try {
        checkCalendarQuery(range);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendRead(res, query.campaign, (entry) => entry.getCalendar(range));
    }

    if (rawPath.startsWith("/media/")) {
      const found = await lookup(query.campaign);
      const file = found.entry && mediaFile(found.entry.media, rawPath);
      const variant = params.get("variant");
      if (!file || (variant !== null && (variant !== "preview" || path.extname(file) !== ".mp4"))) return notFound(res);
      let served = file;
      if (variant) {
        // No ffmpeg, or ffmpeg failing, falls back to the original.
        served = (await found.entry.media.previews?.get(file).catch(() => null)) ?? file;
      }
      return sendMedia(req, res, served, params.get("download") === "1" ? path.basename(file) : undefined);
    }

    return notFound(res);
  });

  // Every listen binds the loopback address, whatever host a caller passes, so the
  // dashboard is never reachable from the network except through `tailscale serve`.
  const listen = server.listen;
  server.listen = (...args) => {
    const p = typeof args[0] === "number" ? args[0] : port;
    const cb = args.find((a) => typeof a === "function");
    return listen.call(server, { port: p, host: HOST }, cb);
  };
  return server;
}

// The build queue's safety net (creation/lib/build-queue.mjs): every `intervalMs` it
// calls startNext for each unpaused campaign that campaigns() lists as { campaign, deps },
// one after the other, so a queued build starts once the posting window has passed, or
// after a build that crashed before it could start the next. It runs in the dashboard
// server because that runs in the owner's session, where renders and Claude Code run; a
// build started from the S4U Telegram task would fail. A campaign's failure goes to its
// own log and never stops the others; a tick still running when the next is due is let
// finish. Returns { tick, stop }.
export function startQueueRunner({
  campaigns,
  startNext = startNextQueued,
  intervalMs = QUEUE_RUNNER_MS,
  log,
  timers = { setInterval, clearInterval },
}) {
  let running = false;
  // A logger that throws (a full disk) must not stop the other campaigns.
  const note = (to, msg, data) => {
    try {
      to?.error(msg, data);
    } catch {
      // Nowhere left to say it.
    }
  };
  async function tick() {
    if (running) return;
    running = true;
    try {
      let list;
      try {
        list = await campaigns();
      } catch (err) {
        note(log, "queue runner: campaigns not read", { error: err.message });
        return;
      }
      for (const { campaign, deps } of list) {
        if (campaign.paused) continue;
        try {
          await startNext({ campaign, deps });
        } catch (err) {
          note(deps?.log ?? log, "queue runner: queued build not started", { error: err.message });
        }
      }
    } finally {
      running = false;
    }
  }
  // Nothing a tick does may become an unhandled rejection: that would end the server.
  const timer = timers.setInterval(() => tick().catch(() => {}), intervalMs);
  return { tick, stop: () => timers.clearInterval(timer) };
}

// The ffmpeg that makes previews: FFMPEG_BIN. null when it isn't set or the file isn't
// on disk, so previews fall back to the original.
function defaultFfmpeg() {
  const bin = process.env.FFMPEG_BIN;
  return bin && fs.existsSync(bin) ? bin : null;
}

// The real campaigns: every campaign under `root`, in folder order, read afresh on each
// request so a new or edited campaign.json shows up without a restart. A broken
// campaign.json lists that campaign as an error and leaves the rest alone. Nothing here
// writes to `root`.
export function createCampaignSource({
  home,
  env = {}, // the owner's .env: its bot and Google client, and its credentials to scrub
  root = process.env.PIPELINE_CAMPAIGNS_ROOT ?? "C:\\Campaigns",
  exec,
  fetch, // the clock check's; the global fetch when omitted
  taskTimeoutMs, // how long a schtasks query may take; 10 s when omitted
  now = () => new Date(),
  ffmpeg = defaultFfmpeg(),
  previewExec, // what previews run ffmpeg with; the real execFile when omitted
}) {
  const secrets = createSecrets(home);
  const systemCheck = createSystemCheck({ exec, fetch, now, taskTimeoutMs });
  const campaignActions = () => createCampaignActions({ root, home, deps: { secrets, env } });
  // One cache object per campaign for the source's life: campaigns are read afresh on
  // each request, and requests must share one in-flight map or ffmpeg runs twice.
  const previewCaches = new Map();
  const previewsFor = (id) => {
    if (!previewCaches.has(id)) {
      previewCaches.set(id, createPreviews({ cacheDir: path.join(home, "previews", id), ffmpeg, exec: previewExec, now }));
    }
    return previewCaches.get(id);
  };

  function dirs() {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && ID_RE.test(d.name))
        .filter((d) => fs.existsSync(path.join(root, d.name, "campaign.json")))
        .map((d) => d.name)
        .sort();
    } catch {
      return []; // No campaigns root yet.
    }
  }

  // Every campaign folder as { name, lockName }, for the build check. One whose
  // campaign.json broke during a build still holds its lock, so it is named by folder.
  const lockOwners = () =>
    dirs().map((dir) => {
      try {
        return getCampaign(dir, { root, home });
      } catch {
        return { name: dir, lockName: (name) => `${dir}:${name}` };
      }
    });

  // Actions are built per call, so each sees the campaign's current files and tokens.
  const actionsFor = (campaign) => {
    const fresh = () => createActions({ deps: campaignDeps({ campaign, secrets, ownerEnv: env }) });
    const queue = () => createQueueActions({ campaign, deps: queueDeps({ campaign, secrets, env }) });
    const backlog = () => createBacklogActions({ campaign, deps: backlogDeps({ campaign, secrets, env }) });
    const creation = () => createCreationActions({ campaign, deps: creationDeps({ campaign, secrets, env }) });
    const connections = () => {
      const deps = connectionDeps({ campaign, secrets, env, campaignFile: path.join(root, campaign.id, "campaign.json"), campaigns: lockOwners() });
      return createConnectionActions({ campaign, secrets, deps });
    };
    const settings = (name) => (args) => campaignActions()[name]({ ...args, id: campaign.id });
    return {
      postNow: (args) => fresh().postNow(args),
      postItem: (args) => fresh().postItem(args),
      retry: (args) => fresh().retry(args),
      ...Object.fromEntries(["hold", "release", "pin", "unpin", "reorder", "drop"].map((name) => [name, (args) => queue()[name](args)])),
      ...Object.fromEntries(["approve", "redo", "recheck", "buildNow", "unqueue"].map((name) => [name, (args) => creation()[name](args)])),
      ...Object.fromEntries(["saveIdea", "removeIdea"].map((name) => [name, (args) => backlog()[name](args)])),
      ...Object.fromEntries(["setInstagramToken", "setTelegram", "testTelegram", "setSecret"].map((name) => [name, (args) => connections()[name](args)])),
      setPaused: settings("setPaused"),
      saveSettings: settings("saveSettings"),
    };
  };

  return {
    // The console's own actions. A new campaign is in list() at once: it reads the root afresh.
    actions: { createCampaign: (args) => campaignActions().createCampaign(args) },
    async list() {
      const out = [];
      for (const dir of dirs()) {
        try {
          const c = getCampaign(dir, { root, home });
          out.push({ id: c.id, name: c.name, paused: c.paused });
        } catch {
          out.push({ id: dir, name: dir, paused: false, error: true });
        }
      }
      return out;
    },
    // Throws for a campaign whose campaign.json is broken.
    get(id) {
      if (typeof id !== "string" || !ID_RE.test(id) || !fs.existsSync(path.join(root, id, "campaign.json"))) return null;
      const campaign = getCampaign(id, { root, home });
      // `build(data)` on the campaign's data. Errors are scrubbed too: a broken file's
      // message can quote a token.
      const read = (build) => {
        const data = loadCampaignData({ campaign, secrets, env });
        try {
          return build(data);
        } catch (err) {
          throw new Error(scrub(err.message, data.secretValues));
        }
      };
      // The campaign's build queue, read without its lock: a read never changes it.
      const queue = () => readQueue(campaign.home);
      return {
        getStatus: async () => {
          // The posting task's state comes from the cached checks: unknown counts as there.
          const publisher = (await systemCheck.get()).tasks.find((t) => t.name === "Pipeline Publisher");
          return buildStatus({ now: now(), campaign, secrets, env, exec, taskRegistered: publisher?.registered !== false });
        },
        getLibrary: () => read((data) => buildLibrary({ data, now: now() })),
        getCalendar: ({ from, days }) => read((data) => buildCalendar({ data, from, days, now: now() })),
        getPipeline: () => read((data) => ({
          builds: buildEntries({ data }),
          formats: ideaFormats(campaign),
          types: TYPES,
          queue: queue().map(({ id: pieceId, kind }, i) => ({ id: pieceId, kind, position: i + 1 })),
        })),
        getReviews: () => read((data) => listReviews({ data, queue: queue() })),
        getReview: (pieceId) => read((data) => loadReview({ data, id: pieceId, queue: queue() })),
        getBuild: (pieceId) => read((data) => buildProgress({ data, id: pieceId, now: now(), queue: queue() })),
        actions: actionsFor(campaign),
        settings: campaignSettings(campaign),
        media: { root: campaign.root, itemDir: (pieceId) => itemDir(campaign, pieceId), previews: previewsFor(id) },
      };
    },
    // The machine's checks, cached for a minute and shared by concurrent callers.
    system: () => systemCheck.get(),
    // The Health screen's data for every campaign, scrubbed of every campaign's secret
    // values and the owner's like the rest of what leaves the dashboard.
    async health() {
      const campaigns = [];
      const secretValues = ownerSecretValues(env);
      for (const dir of dirs()) {
        try {
          const campaign = getCampaign(dir, { root, home });
          const data = loadCampaignData({ campaign, secrets, env });
          secretValues.push(...data.secretValues);
          campaigns.push({ id: campaign.id, name: campaign.name, home: campaign.home, instagramIssuedAt: data.tokens.instagram?.issuedAt });
        } catch {
          campaigns.push({ id: dir, name: dir });
        }
      }
      return scrub(await buildHealth({ campaigns, system: await systemCheck.get(), now: now(), home }), secretValues);
    },
    // Every campaign that loads, as { campaign, deps } with the same creation deps the
    // console's Build now uses, for the queue runner. A broken campaign.json is skipped.
    queueTargets() {
      const out = [];
      for (const dir of dirs()) {
        try {
          const campaign = getCampaign(dir, { root, home });
          out.push({ campaign, deps: creationDeps({ campaign, secrets, env }) });
        } catch {
          // Listed as an error elsewhere; nothing of its can start.
        }
      }
      return out;
    },
    // Drops old previews from every campaign's cache; run once at server start.
    prunePreviews() {
      let ids;
      try {
        ids = fs.readdirSync(path.join(home, "previews"));
      } catch {
        return; // No previews yet.
      }
      for (const id of ids.filter((n) => ID_RE.test(n))) previewsFor(id).prune();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = publisherHome();
  const env = loadEnv(path.join(home, ".env"));
  const campaigns = createCampaignSource({ home, env });
  campaigns.prunePreviews();
  const port = Number(process.env.DASHBOARD_PORT) || DEFAULT_PORT;
  const server = createServer({ campaigns, login: env.DASHBOARD_LOGIN, port });
  server.listen(() => console.log(`dashboard on http://${HOST}:${server.address().port}/`));
  startQueueRunner({ campaigns: () => campaigns.queueTargets(), log: createLogger(home) });
}
