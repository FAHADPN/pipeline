import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHealth, parseTaskCsv } from "../lib/health.mjs";

const NOW = new Date("2026-10-26T10:00:00Z");

// schtasks /Query /V /FO CSV on this machine: DD-MM-YYYY dates, 12-hour clock.
const HEADER = '"HostName","TaskName","Next Run Time","Status","Logon Mode","Last Run Time","Last Result","Author","Task To Run"';
const csv = (name, next, last, result, status = "Ready") =>
  `${HEADER}\r\n"PC","\\${name}","${next}","${status}","Interactive/Background","${last}","${result}","PC\\user","node.exe ""C:\\x\\pipeline.mjs"" publish-tick"\r\n`;
const PUBLISHER = csv("Pipeline Publisher", "26-10-2026 12:30:00 AM", "25-10-2026 11:45:00 PM", "0");

function fakeExec(outputs) {
  return async (file, args) => {
    const name = args[args.indexOf("/TN") + 1];
    if (!(name in outputs)) throw notFound();
    return { stdout: outputs[name] };
  };
}

// What execFile rejects with for `schtasks /Query` of a task that doesn't exist (captured on this machine).
function notFound() {
  return Object.assign(new Error("Command failed: schtasks /Query /TN x\nERROR: The system cannot find the file specified.\r\r\n"), {
    code: 1,
    stderr: "ERROR: The system cannot find the file specified.\r\r\n",
  });
}

// Each test gets its own fetch function: the clock check is cached per function.
const okFetch = (date) => async () => ({ headers: new Headers({ date }) });
const statfs = async () => ({ bavail: (20n * 2n ** 30n) / 4096n, bsize: 4096 });

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
}

function writeLog(home, id, month, lines) {
  const dir = path.join(home, "campaigns", id, "logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${month}.log`), lines.join("\n") + "\n");
}

const base = (extra = {}) => ({ campaigns: [], exec: fakeExec({}), fetch: okFetch(NOW.toUTCString()), now: NOW, home: tempHome(), statfs, ...extra });

test("health: parses a schtasks CSV fixture into lastRun, lastResult and nextRun", async () => {
  const h = await buildHealth(base({ exec: fakeExec({ "Pipeline Publisher": PUBLISHER }) }));
  const t = h.tasks.find((x) => x.name === "Pipeline Publisher");
  assert.equal(t.registered, true);
  assert.equal(t.lastRun, new Date(2026, 9, 25, 23, 45, 0).toISOString());
  assert.equal(t.nextRun, new Date(2026, 9, 26, 0, 30, 0).toISOString());
  assert.equal(t.lastResult, 0);
  assert.equal(t.status, "Ready");
  assert.deepEqual(
    h.tasks.map((x) => x.name),
    ["Pipeline Publisher", "Pipeline Creation", "Pipeline Telegram", "Pipeline Dashboard"],
  );
});

test("health: localized headers are read by name, and N/A dates are null", () => {
  const out = '"Hostname","Nom de la tâche","Prochaine exécution","Statut","Mode","Dernière exécution","Dernier résultat"\r\n"PC","\\X","N/A","Running","x","N/A","267009"\r\n';
  assert.deepEqual(parseTaskCsv(out), { lastRun: null, lastResult: 267009, nextRun: null, status: "Running" });
  const en = parseTaskCsv(csv("X", "26-10-2026 02:00:00 AM", "30-11-1999 12:00:00 AM", "267011"));
  assert.equal(en.lastRun, null);
  assert.equal(en.nextRun, new Date(2026, 9, 26, 2, 0, 0).toISOString());
});

test("health: an unregistered task (exec rejects) is registered false", async () => {
  const h = await buildHealth(base({ exec: fakeExec({ "Pipeline Publisher": PUBLISHER }) }));
  const t = h.tasks.find((x) => x.name === "Pipeline Telegram");
  assert.deepEqual(t, { name: "Pipeline Telegram", registered: false, lastRun: null, lastResult: null, nextRun: null, status: null });
});

test("health: any other schtasks failure (no schtasks, access denied, a hang) is registered null, not false", async () => {
  const fails = {
    enoent: () => Object.assign(new Error("spawn schtasks ENOENT"), { code: "ENOENT" }),
    denied: () => Object.assign(new Error("Command failed\nERROR: Access is denied.\r\n"), { code: 1, stderr: "ERROR: Access is denied.\r\n" }),
    timeout: () => Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null }),
  };
  for (const make of Object.values(fails)) {
    const h = await buildHealth(base({ exec: async () => { throw make(); } }));
    assert.deepEqual(h.tasks.map((t) => t.registered), [null, null, null, null]);
  }
  // A fake that never answers is cut off by the buildHealth timeout.
  const hung = await buildHealth(base({ exec: () => new Promise(() => {}), taskTimeoutMs: 30 }));
  assert.deepEqual(hung.tasks.map((t) => t.registered), [null, null, null, null]);
});

test("health: every schtasks call is given a timeout", async () => {
  const seen = [];
  await buildHealth(base({ exec: async (file, args, opts) => { seen.push(opts?.timeout); throw notFound(); } }));
  assert.deepEqual(seen, [10000, 10000, 10000, 10000]);
});

test("health: skew from a Date header 11 h 47 m behind is -42420 s", async () => {
  const server = new Date(NOW.getTime() + 42420 * 1000).toUTCString();
  const h = await buildHealth(base({ fetch: okFetch(server) }));
  assert.equal(h.clock.skewSeconds, -42420);
  assert.equal(h.clock.checkedAt, NOW.toISOString());
});

test("health: a failed fetch gives clock null and no todo", async () => {
  const h = await buildHealth(
    base({
      fetch: async () => {
        throw new Error("offline");
      },
    }),
  );
  assert.equal(h.clock, null);
});

test("health: the clock check is sent as a HEAD and cached for 10 minutes", async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, method: opts.method, signal: Boolean(opts.signal) });
    return { headers: new Headers({ date: NOW.toUTCString() }) };
  };
  await buildHealth(base({ fetch }));
  await buildHealth(base({ fetch, now: new Date(NOW.getTime() + 9 * 60 * 1000) }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: "https://www.google.com", method: "HEAD", signal: true });
  await buildHealth(base({ fetch, now: new Date(NOW.getTime() + 11 * 60 * 1000) }));
  assert.equal(calls.length, 2);
});

test("health: free disk in GB, and null when it can't be read", async () => {
  assert.equal((await buildHealth(base())).disk.freeGb, 20);
  const broken = async () => {
    throw new Error("no");
  };
  assert.equal((await buildHealth(base({ statfs: broken }))).disk, null);
});

test("health: Instagram token age warns at 50 days", async () => {
  const day = 24 * 60 * 60 * 1000;
  const campaigns = [
    { id: "a", instagramIssuedAt: new Date(NOW.getTime() - 49 * day).toISOString() },
    { id: "b", instagramIssuedAt: new Date(NOW.getTime() - 50 * day).toISOString() },
    { id: "c" },
  ];
  const h = await buildHealth(base({ campaigns }));
  assert.deepEqual(h.tokens, [
    { campaign: "a", instagramAgeDays: 49, warn: false },
    { campaign: "b", instagramAgeDays: 50, warn: true },
    { campaign: "c", instagramAgeDays: null, warn: false },
  ]);
});

test("health: actions are newest first, at most 20, from the last two monthly logs", async () => {
  const home = tempHome();
  const line = (at, msg) => `${at} INFO ${msg} {"id":"x"}`;
  const oct = Array.from({ length: 15 }, (_, i) => line(`2026-10-${String(10 + i).padStart(2, "0")}T08:00:00.000Z`, "dashboard hold"));
  writeLog(home, "acme", "2026-10", [...oct, line("2026-10-26T09:00:00.000Z", "run")]);
  writeLog(home, "acme", "2026-09", Array.from({ length: 10 }, (_, i) => line(`2026-09-${10 + i}T08:00:00.000Z`, "dashboard pin")));
  writeLog(home, "acme", "2026-08", [line("2026-08-01T08:00:00.000Z", "dashboard drop")]);
  writeLog(home, "beta", "2026-10", ['2026-10-30T08:00:00.000Z ERROR dashboard retry {"ok":false}']);
  const h = await buildHealth(base({ home, campaigns: [{ id: "acme" }, { id: "beta" }] }));
  assert.equal(h.actions.length, 20);
  assert.deepEqual(h.actions[0], { campaign: "beta", at: "2026-10-30T08:00:00.000Z", level: "ERROR", message: "dashboard retry", detail: '{"ok":false}' });
  const ats = h.actions.map((a) => a.at);
  assert.deepEqual(ats, [...ats].sort().reverse());
  assert.ok(h.actions.every((a) => a.message.startsWith("dashboard ")));
  assert.ok(!h.actions.some((a) => a.message === "dashboard drop"), "the third-newest month isn't read");
});

test("health: loops are the last line of each loop per campaign", async () => {
  const home = tempHome();
  writeLog(home, "acme", "2026-10", [
    '2026-10-26T01:00:00.000Z INFO run {"posted":[]}',
    '2026-10-26T01:15:00.000Z ERROR publish tick crashed {"error":"boom"}',
    "2026-10-26T02:00:00.000Z INFO nightly deferred",
    "2026-10-26T02:05:00.000Z ERROR telegram tick failed",
    "2026-10-26T02:10:00.000Z INFO dashboard hold",
  ]);
  const h = await buildHealth(base({ home, campaigns: [{ id: "acme" }, { id: "quiet" }] }));
  const [a, q] = h.loops;
  assert.equal(a.publish.message, "publish tick crashed");
  assert.equal(a.publish.level, "ERROR");
  assert.equal(a.create.message, "nightly deferred");
  assert.equal(a.telegram.message, "telegram tick failed");
  assert.deepEqual(q, { campaign: "quiet", publish: null, create: null, telegram: null });
});
