// The Health screen's data: the scheduled tasks, each campaign's loops and Instagram
// token age, the machine's clock and free disk, and the console's recent actions.
//
// buildHealth({ campaigns, exec, fetch, now, home, statfs }) ->
//   { tasks, loops, tokens, clock, disk, actions }
//
//   campaigns   [{ id, name, home?, instagramIssuedAt? }]; home is the campaign's state
//               folder (its logs/ live there), by default <home>/campaigns/<id>
//   exec        promisified execFile: exec(file, args) -> { stdout }
//   fetch       fetch-shaped, for the clock check
//
// Read-only. A task, log or the network that can't be read is null, never a throw.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const defaultExec = promisify(execFile);

// The names the installers register (campaigns/install-tasks.mjs, dashboard/install-task.mjs).
export const TASK_NAMES = ["Pipeline Publisher", "Pipeline Creation", "Pipeline Telegram", "Pipeline Dashboard"];
const TOKEN_WARN_DAYS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTION_LIMIT = 20;
const LOG_MONTHS = 2;
const DETAIL_MAX = 300;
const LOG_LINE = /^(\S+) (INFO|ERROR) (.*?)(?: (\{.*\}))?$/;

const CLOCK_URL = "https://www.google.com";
const CLOCK_TIMEOUT_MS = 5000;
const CLOCK_CACHE_MS = 10 * 60 * 1000;
// A failed check is retried sooner, but not on every status poll.
const CLOCK_RETRY_MS = 60 * 1000;

// --- Scheduled tasks ---------------------------------------------------------------

// The rows of one CSV document: fields in double quotes, "" for a quote inside.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

// schtasks writes the machine's locale: here "DD-MM-YYYY hh:mm:ss AM/PM". An ISO
// string in the machine's own zone, or null for "N/A", a task that never ran (the
// 1999 placeholder) or a format this doesn't know.
function parseTaskDate(text) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?: (AM|PM))?$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let hour = Number(m[4]);
  if (m[7]) hour = (hour % 12) + (m[7].toUpperCase() === "PM" ? 12 : 0);
  if (year < 2000 || month < 1 || month > 12) return null;
  const date = new Date(year, month - 1, day, hour, Number(m[5]), Number(m[6]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The column named by `pattern` in the header row (the headers are localized), else the
// one schtasks /V puts at `fallback`: HostName, TaskName, Next Run Time, Status, Logon
// Mode, Last Run Time, Last Result.
function column(headers, pattern, fallback) {
  const i = headers.findIndex((h) => pattern.test(h));
  return i >= 0 ? i : fallback;
}

// { lastRun, lastResult, nextRun, status } from `schtasks /Query /V /FO CSV` output.
export function parseTaskCsv(stdout) {
  const [headers, ...rows] = parseCsv(String(stdout ?? "").replace(/^﻿/, ""));
  const row = rows.find((r) => r.length === headers?.length);
  if (!row) return { lastRun: null, lastResult: null, nextRun: null, status: null };
  const cell = (pattern, fallback) => row[column(headers, pattern, fallback)] ?? "";
  const result = cell(/last result/i, 6).trim();
  return {
    lastRun: parseTaskDate(cell(/last run/i, 5)),
    lastResult: /^-?\d+$/.test(result) ? Number(result) : result || null,
    nextRun: parseTaskDate(cell(/next run/i, 2)),
    status: cell(/^status$/i, 3).trim() || null,
  };
}

const NO_TASK = { lastRun: null, lastResult: null, nextRun: null, status: null };
const TASK_TIMEOUT_MS = 10000;

// schtasks' answer for a task that doesn't exist: exit code 1 and "ERROR: The system
// cannot find the file specified." Any other failure (no schtasks, access denied, a
// timeout) says nothing about whether the task exists.
function isNotFound(err) {
  return err?.code === 1 && /cannot find the (file|path) specified/i.test(`${err.stderr ?? ""}${err.message ?? ""}`);
}

// registered: true, false (schtasks says it doesn't exist) or null (unknown).
async function readTask(name, exec, timeoutMs) {
  let timer;
  const hung = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("schtasks timed out")), timeoutMs);
  });
  try {
    const { stdout } = await Promise.race([exec("schtasks", ["/Query", "/TN", name, "/V", "/FO", "CSV"], { timeout: timeoutMs }), hung]);
    return { name, registered: true, ...parseTaskCsv(stdout) };
  } catch (err) {
    return { name, registered: isNotFound(err) ? false : null, ...NO_TASK };
  } finally {
    clearTimeout(timer);
  }
}

// --- Logs: loops and console actions -------------------------------------------------

// What each loop writes to a campaign's log.
const LOOPS = {
  publish: (msg) => msg === "run" || msg === "run crashed" || msg.startsWith("publish tick") || msg.startsWith("shadow run"),
  create: (msg) => msg.startsWith("nightly") || msg.startsWith("create nightly"),
  telegram: (msg) => msg.startsWith("telegram tick") || msg.startsWith("telegram-tick"),
};

// The lines of the newest monthly logs in `dir`, oldest first, as { at, level, message, detail }.
function readLogLines(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.log$/.test(f)).sort().slice(-LOG_MONTHS);
  } catch {
    return [];
  }
  const lines = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = LOG_LINE.exec(line);
      if (m) lines.push({ at: m[1], level: m[2], message: m[3], detail: m[4] ? m[4].slice(0, DETAIL_MAX) : null });
    }
  }
  return lines;
}

function lastMatching(lines, test) {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i].message)) return lines[i];
  return null;
}

// --- Tokens, clock, disk --------------------------------------------------------------

function tokenEntry(campaign, now) {
  const issued = Date.parse(campaign.instagramIssuedAt ?? "");
  const age = Number.isNaN(issued) ? null : Math.max(0, Math.floor((now.getTime() - issued) / DAY_MS));
  return { campaign: campaign.id, instagramAgeDays: age, warn: age !== null && age >= TOKEN_WARN_DAYS };
}

// One cached clock result per fetch function, for the life of the process.
const clockCache = new WeakMap();

// { skewSeconds, checkedAt }: this machine's clock minus the Date header of a HEAD to
// Google (negative: this machine is behind). null when the check fails.
async function checkClock({ fetch, now }) {
  const cached = clockCache.get(fetch);
  if (cached && now.getTime() < cached.until) return cached.value;
  let value = null;
  try {
    const res = await fetch(CLOCK_URL, { method: "HEAD", signal: AbortSignal.timeout(CLOCK_TIMEOUT_MS) });
    const server = Date.parse(res.headers.get("date") ?? "");
    if (!Number.isNaN(server)) value = { skewSeconds: Math.round((now.getTime() - server) / 1000), checkedAt: now.toISOString() };
  } catch {
    value = null;
  }
  clockCache.set(fetch, { value, until: now.getTime() + (value ? CLOCK_CACHE_MS : CLOCK_RETRY_MS) });
  return value;
}

async function checkDisk(statfs) {
  try {
    const s = await statfs("C:\\");
    return { freeGb: Math.round(((Number(s.bavail) * Number(s.bsize)) / 2 ** 30) * 10) / 10 };
  } catch {
    return null;
  }
}

// --- Everything -----------------------------------------------------------------------

// The machine's checks: { tasks, clock, disk }. Never throws, and never waits longer
// than a task timeout (plus the clock's own 5 s).
export async function checkSystem({
  exec = defaultExec,
  fetch = globalThis.fetch,
  now = new Date(),
  statfs = fs.promises.statfs,
  taskTimeoutMs = TASK_TIMEOUT_MS,
} = {}) {
  const [tasks, clock, disk] = await Promise.all([
    Promise.all(TASK_NAMES.map((n) => readTask(n, exec, taskTimeoutMs))),
    checkClock({ fetch, now }),
    checkDisk(statfs),
  ]);
  return { tasks, clock, disk };
}

// checkSystem's result kept for `ttlMs`, one run shared by concurrent callers. This is
// what every status poll reads, so the console doesn't spawn schtasks per request.
export function createSystemCheck({ ttlMs = 60000, now = () => new Date(), ...deps } = {}) {
  let cached = null; // { at, promise }
  return {
    get() {
      const t = now().getTime();
      if (!cached || t - cached.at >= ttlMs) cached = { at: t, promise: checkSystem({ ...deps, now: now() }) };
      return cached.promise;
    },
  };
}

// `system` is a checkSystem result to reuse; without it the checks run here.
export async function buildHealth({ campaigns, now = new Date(), home, system, ...deps }) {
  const { tasks, clock, disk } = system ?? (await checkSystem({ ...deps, now }));

  const loops = [];
  const actions = [];
  for (const c of campaigns) {
    const lines = readLogLines(path.join(c.home ?? path.join(home, "campaigns", c.id), "logs"));
    loops.push({ campaign: c.id, ...Object.fromEntries(Object.entries(LOOPS).map(([name, test]) => [name, lastMatching(lines, test)])) });
    for (const line of lines) if (line.message.startsWith("dashboard ")) actions.push({ campaign: c.id, ...line });
  }
  // Newest first; lines with the same timestamp keep the later one first.
  const ranked = actions.map((a, i) => ({ a, i })).sort((x, y) => y.a.at.localeCompare(x.a.at) || y.i - x.i);

  return {
    tasks,
    loops,
    tokens: campaigns.map((c) => tokenEntry(c, now)),
    clock,
    disk,
    actions: ranked.slice(0, ACTION_LIMIT).map(({ a }) => a),
  };
}
