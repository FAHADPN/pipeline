import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskXml, currentUserId } from "../install-task.mjs";

const ARGS = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  scriptPath: "C:\\Pipeline\\campaigns\\pipeline.mjs",
  workDir: "C:\\Pipeline",
  startDate: "2026-10-25",
};

const one = (xml, tag) => {
  const found = [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
  assert.equal(found.length, 1, `expected exactly one <${tag}>`);
  return found[0];
};

test("buildTaskXml contains every required setting", () => {
  const xml = buildTaskXml(ARGS);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  assert.match(xml, /<CalendarTrigger>[\s\S]*<ScheduleByDay>\s*<DaysInterval>1<\/DaysInterval>\s*<\/ScheduleByDay>[\s\S]*<\/CalendarTrigger>/);
  assert.equal(one(xml, "StartBoundary"), "2026-10-25T19:30:00");
  assert.equal(one(xml, "WakeToRun"), "true");
  assert.equal(one(xml, "StartWhenAvailable"), "true");
  assert.equal(one(xml, "ExecutionTimeLimit"), "PT1H");
  assert.equal(one(xml, "MultipleInstancesPolicy"), "IgnoreNew");
  assert.equal(one(xml, "LogonType"), "S4U");
  assert.match(xml, /<Exec>[\s\S]*<Command>[\s\S]*<Arguments>[\s\S]*<WorkingDirectory>[\s\S]*<\/Exec>/);
  assert.equal(one(xml, "Command"), "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(one(xml, "Arguments"), "&quot;C:\\Pipeline\\campaigns\\pipeline.mjs&quot;");
  assert.equal(one(xml, "WorkingDirectory"), "C:\\Pipeline");
});

test("buildTaskXml honours a custom time", () => {
  assert.equal(one(buildTaskXml({ ...ARGS, time: "07:05" }), "StartBoundary"), "2026-10-25T07:05:00");
});

test("buildTaskXml XML-escapes the paths", () => {
  const xml = buildTaskXml({
    nodePath: "C:\\A&B\\<node>.exe",
    scriptPath: "C:\\R&D's\\publish.mjs",
    workDir: "C:\\R&D's",
    startDate: "2026-10-25",
  });
  assert.equal(one(xml, "Command"), "C:\\A&amp;B\\&lt;node&gt;.exe");
  assert.equal(one(xml, "Arguments"), "&quot;C:\\R&amp;D&apos;s\\publish.mjs&quot;");
  assert.equal(one(xml, "WorkingDirectory"), "C:\\R&amp;D&apos;s");
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;)/);
});

test("buildTaskXml puts the user in the principal only when given", () => {
  assert.equal(one(buildTaskXml({ ...ARGS, userId: "PC\\user" }), "UserId"), "PC\\user");
  assert.doesNotMatch(buildTaskXml(ARGS), /<UserId>/);
});

test("buildTaskXml with repetition and InteractiveToken", () => {
  const xml = buildTaskXml({
    ...ARGS,
    time: "00:00",
    userId: "PC\\user",
    logonType: "InteractiveToken",
    repetition: { interval: "PT5M" },
    args: ["poll"],
  });
  assert.match(
    xml,
    /<CalendarTrigger>\s*<Repetition>\s*<Interval>PT5M<\/Interval>\s*<Duration>P1D<\/Duration>\s*<StopAtDurationEnd>false<\/StopAtDurationEnd>\s*<\/Repetition>\s*<StartBoundary>/,
  );
  assert.equal(one(xml, "LogonType"), "InteractiveToken");
  assert.equal(one(xml, "Arguments"), "&quot;C:\\Pipeline\\campaigns\\pipeline.mjs&quot; poll");
  assert.equal(one(buildTaskXml({ ...ARGS, repetition: { interval: "PT1H", duration: "PT12H" } }), "Duration"), "PT12H");
  // Without them nothing changes.
  const plain = buildTaskXml(ARGS);
  assert.doesNotMatch(plain, /<Repetition>/);
  assert.equal(one(plain, "LogonType"), "S4U");
  assert.throws(() => buildTaskXml({ ...ARGS, repetition: { interval: "5 minutes" } }), /repetition/);
  assert.throws(() => buildTaskXml({ ...ARGS, logonType: "Password" }), /logonType/);
  assert.throws(() => buildTaskXml({ ...ARGS, trigger: "logon", userId: "x\\y", repetition: { interval: "PT5M" } }), /repetition/);
});

test("currentUserId prefers whoami", () => {
  const calls = [];
  const execFileSync = (cmd, args) => {
    calls.push(cmd);
    return "pc\\user\r\n";
  };
  const id = currentUserId({
    execFileSync,
    env: { USERDOMAIN: "WORKGROUP", COMPUTERNAME: "PC" },
    hostname: () => "pc-host",
    username: "user",
  });
  assert.equal(id, "pc\\user");
  assert.deepEqual(calls, ["whoami"]);
});

test("currentUserId ignores USERDOMAIN=WORKGROUP and falls back to COMPUTERNAME when whoami fails", () => {
  const deps = { env: { USERDOMAIN: "WORKGROUP", COMPUTERNAME: "PC" }, hostname: () => "pc-host", username: "user" };
  const failing = () => {
    throw new Error("whoami not found");
  };
  assert.equal(currentUserId({ ...deps, execFileSync: failing }), "PC\\user");
  assert.equal(currentUserId({ ...deps, execFileSync: () => "user\n" }), "PC\\user");
  assert.equal(currentUserId({ ...deps, env: { USERDOMAIN: "WORKGROUP" }, execFileSync: failing }), "pc-host\\user");
});

test("buildTaskXml rejects a bad date or time", () => {
  assert.throws(() => buildTaskXml({ ...ARGS, startDate: "2026-02-30" }));
  assert.throws(() => buildTaskXml({ ...ARGS, time: "7:30pm" }));
  assert.throws(() => buildTaskXml({ ...ARGS, nodePath: "" }));
});
