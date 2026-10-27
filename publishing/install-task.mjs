// The Windows Task Scheduler helpers the installers share: buildTaskXml writes one
// task's XML and currentUserId names the account it runs as. The installers
// (campaigns/install-tasks.mjs, dashboard/install-task.mjs) register their tasks
// with them. Importing this file runs nothing, so tests never touch Task Scheduler.

import { execFileSync } from "node:child_process";
import os from "node:os";
import { isRealDate, parseSlot } from "./lib/dates.mjs";

const LOGON_TYPES = ["S4U", "InteractiveToken"];
// An ISO 8601 duration as Task Scheduler takes it, e.g. PT5M or P1D.
const DURATION = /^P(?=\d|T\d)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

// StartBoundary has no offset, so Task Scheduler reads it as the machine's local
// time: a daily `time` is the machine's clock, whatever a campaign's time zone.
//
// The defaults build a daily task at 19:30 that runs as S4U for up to an hour.
// The dashboard passes trigger: "logon" (fires when userId logs on), its own
// logonType, description and executionTimeLimit, and restartOnFailure:
// { interval, count }. The scheduler loops pass args (after the script path), their
// own logonType, and repetition: { interval, duration = "P1D" } to repeat a daily
// trigger all day.
export function buildTaskXml({
  nodePath,
  scriptPath,
  workDir,
  startDate,
  time = "19:30",
  userId,
  trigger = "daily",
  logonType = "S4U",
  description = "A Pipeline task.",
  executionTimeLimit = "PT1H",
  restartOnFailure,
  repetition,
  args = [],
}) {
  for (const [name, value] of Object.entries({ nodePath, scriptPath, workDir })) {
    if (typeof value !== "string" || !value) throw new Error(`buildTaskXml: ${name} is required`);
  }
  if (!LOGON_TYPES.includes(logonType)) throw new Error(`buildTaskXml: unknown logonType: ${logonType}`);
  if (repetition) {
    if (trigger !== "daily") throw new Error("buildTaskXml: repetition needs the daily trigger");
    const { interval, duration = "P1D" } = repetition;
    for (const value of [interval, duration]) {
      if (!DURATION.test(value ?? "")) throw new Error(`buildTaskXml: bad repetition duration: ${value}`);
    }
  }
  let triggerXml;
  if (trigger === "daily") {
    if (!isRealDate(startDate)) throw new Error(`buildTaskXml: bad startDate: ${startDate}`);
    parseSlot(time);
    const repeat = repetition
      ? `
      <Repetition>
        <Interval>${repetition.interval}</Interval>
        <Duration>${repetition.duration ?? "P1D"}</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>`
      : "";
    triggerXml = `    <CalendarTrigger>${repeat}
      <StartBoundary>${startDate}T${time}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>`;
  } else if (trigger === "logon") {
    if (!userId) throw new Error("buildTaskXml: a logon trigger needs a userId");
    triggerXml = `    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>`;
  } else {
    throw new Error(`buildTaskXml: unknown trigger: ${trigger}`);
  }
  const user = userId ? `\n      <UserId>${escapeXml(userId)}</UserId>` : "";
  const restart = restartOnFailure
    ? `\n    <RestartOnFailure>
      <Interval>${escapeXml(restartOnFailure.interval)}</Interval>
      <Count>${Number(restartOnFailure.count)}</Count>
    </RestartOnFailure>`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(description)}</Description>
  </RegistrationInfo>
  <Triggers>
${triggerXml}
  </Triggers>
  <Principals>
    <Principal id="Author">${user}
      <LogonType>${escapeXml(logonType)}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>${escapeXml(executionTimeLimit)}</ExecutionTimeLimit>${restart}
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(nodePath)}</Command>
      <Arguments>${escapeXml([`"${scriptPath}"`, ...args].join(" "))}</Arguments>
      <WorkingDirectory>${escapeXml(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// The account the task runs as, e.g. "PC\user". Prefers `whoami`; otherwise
// COMPUTERNAME (or the hostname). Never USERDOMAIN: over SSH it is "WORKGROUP",
// which schtasks cannot map to a SID.
export function currentUserId({
  execFileSync: exec = execFileSync,
  env = process.env,
  hostname = os.hostname,
  username = os.userInfo().username,
} = {}) {
  try {
    const out = String(exec("whoami", [], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim();
    if (out.includes("\\")) return out;
  } catch {
    // fall through
  }
  return `${env.COMPUTERNAME || hostname()}\\${username}`;
}
