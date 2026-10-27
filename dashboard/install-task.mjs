// Registers the dashboard with Windows Task Scheduler as "Pipeline Dashboard": it
// starts `node dashboard/server.mjs` when the user logs on, restarts it every
// minute (up to 3 times) if it dies, and never times it out.
//
// Run directly (`node dashboard/install-task.mjs`), it writes the task XML as
// UTF-16LE with BOM to %TEMP%\pipeline-dashboard-task.xml and runs
// `schtasks /Create /TN "Pipeline Dashboard" /XML <file> /F`. Importing it does
// nothing, so tests never touch Task Scheduler.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskXml, currentUserId } from "../publishing/install-task.mjs";

const TASK_NAME = "Pipeline Dashboard";

export function buildDashboardTaskXml({ nodePath, repoRoot, userId }) {
  return buildTaskXml({
    nodePath,
    scriptPath: path.join(repoRoot, "dashboard", "server.mjs"),
    workDir: repoRoot,
    userId,
    trigger: "logon",
    logonType: "InteractiveToken",
    description: "Serves the Pipeline console on 127.0.0.1:8787. See docs/console.md.",
    executionTimeLimit: "PT0S",
    restartOnFailure: { interval: "PT1M", count: 3 },
  });
}

export function install({
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  nodePath = process.execPath,
  userId = currentUserId(),
  tmpDir = os.tmpdir(),
  exec = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" }),
  log = console.log,
} = {}) {
  const xml = buildDashboardTaskXml({ nodePath, repoRoot, userId });
  const file = path.join(tmpDir, "pipeline-dashboard-task.xml");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  exec("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", file, "/F"]);
  log(`Registered "${TASK_NAME}": starts at logon. Start it now with: schtasks /Run /TN "${TASK_NAME}"`);
}

const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (runDirectly) {
  try {
    install();
  } catch (err) {
    console.error(`install-task failed: ${err.message}`);
    process.exitCode = 1;
  }
}
