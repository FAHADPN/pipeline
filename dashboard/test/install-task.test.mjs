import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDashboardTaskXml, install } from "../install-task.mjs";
import { buildTaskXml } from "../../publishing/install-task.mjs";

const ARGS = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  repoRoot: "C:\\Code\\pipeline",
  userId: "PC\\user",
};

const one = (xml, tag) => {
  const found = [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
  assert.equal(found.length, 1, `expected exactly one <${tag}>`);
  return found[0];
};

test("dashboard task starts at the user's logon, interactively", () => {
  const xml = buildDashboardTaskXml(ARGS);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\user<\/UserId>\s*<\/LogonTrigger>/);
  assert.doesNotMatch(xml, /<CalendarTrigger>|<StartBoundary>/);
  assert.equal(one(xml, "LogonType"), "InteractiveToken");
  assert.match(xml, /<Principal id="Author">\s*<UserId>PC\\user<\/UserId>/);
  assert.equal(one(xml, "Description"), "Serves the Pipeline console on 127.0.0.1:8787. See docs/console.md.");
});

test("dashboard task restarts on failure every minute, 3 times, with no time limit", () => {
  const xml = buildDashboardTaskXml(ARGS);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>\s*<\/RestartOnFailure>/);
  assert.equal(one(xml, "ExecutionTimeLimit"), "PT0S");
  assert.equal(one(xml, "MultipleInstancesPolicy"), "IgnoreNew");
});

test("dashboard task runs node dashboard/server.mjs in the repo root", () => {
  const xml = buildDashboardTaskXml(ARGS);
  assert.equal(one(xml, "Command"), "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(one(xml, "Arguments"), "&quot;C:\\Code\\pipeline\\dashboard\\server.mjs&quot;");
  assert.equal(one(xml, "WorkingDirectory"), "C:\\Code\\pipeline");
});

test("buildTaskXml logon trigger needs a user; the daily default is unchanged", () => {
  const base = { nodePath: ARGS.nodePath, scriptPath: "C:\\x\\s.mjs", workDir: "C:\\x" };
  assert.throws(() => buildTaskXml({ ...base, trigger: "logon" }), /userId/);
  assert.throws(() => buildTaskXml({ ...base, trigger: "hourly", startDate: "2026-10-25" }), /trigger/);
  const daily = buildTaskXml({ ...base, startDate: "2026-10-25" });
  assert.match(daily, /<CalendarTrigger>/);
  assert.doesNotMatch(daily, /<LogonTrigger>|<RestartOnFailure>/);
  assert.equal(one(daily, "LogonType"), "S4U");
  assert.equal(one(daily, "ExecutionTimeLimit"), "PT1H");
});

test("install writes UTF-16LE XML and registers \"Pipeline Dashboard\" through the injected exec", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-install-"));
  try {
    const calls = [];
    install({
      repoRoot: ARGS.repoRoot,
      nodePath: ARGS.nodePath,
      userId: ARGS.userId,
      tmpDir: dir,
      exec: (cmd, args) => calls.push([cmd, args]),
      log: () => {},
    });
    assert.equal(calls.length, 1);
    const [cmd, args] = calls[0];
    assert.equal(cmd, "schtasks.exe");
    assert.deepEqual(args.slice(0, 3), ["/Create", "/TN", "Pipeline Dashboard"]);
    assert.equal(args[3], "/XML");
    assert.equal(args[5], "/F");
    const buf = fs.readFileSync(args[4]);
    assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
    assert.equal(buf.subarray(2).toString("utf16le"), buildDashboardTaskXml(ARGS));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
