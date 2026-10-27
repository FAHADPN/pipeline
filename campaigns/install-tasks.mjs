// Registers the three scheduler loops (campaigns/pipeline.mjs) with Windows Task
// Scheduler:
//   "Pipeline Publisher": `pipeline.mjs publish-tick` every 15 minutes, all day, S4U,
//     so it runs whether or not anyone is logged on. `--shadow` registers it as
//     `publish-tick --shadow`: a dry run that only logs what it would post.
//   "Pipeline Creation": `pipeline.mjs create-nightly` daily at 02:00.
//     InteractiveToken, because renders and Claude Code run in the owner's
//     logged-in desktop session, so the machine must stay logged in overnight.
//   "Pipeline Telegram": `pipeline.mjs telegram-tick` every 5 minutes, all day, S4U.
//
// Run directly (`node campaigns/install-tasks.mjs [--shadow]`), it writes each
// task's XML as UTF-16LE with BOM to %TEMP% and runs
// `schtasks /Create /TN <name> /XML <file> /F`. Registering needs the owner's OK.
// Importing it does nothing, so tests never touch Task Scheduler.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { istDate } from "../publishing/lib/dates.mjs";
import { buildTaskXml, currentUserId } from "../publishing/install-task.mjs";

export const PUBLISH_TASK = "Pipeline Publisher";
export const CREATION_TASK = "Pipeline Creation";
export const TELEGRAM_TASK = "Pipeline Telegram";

// A publish tick can post for several campaigns, each with a retry, an Instagram
// processing wait and up to 2 minutes for a busy lock. A night is up to 3 pieces in
// all, each up to two rounds of a 60-minute session plus a 20-minute review.
export function buildPipelineTasks({ nodePath, repoRoot, userId, startDate, shadow = false }) {
  const common = {
    nodePath,
    scriptPath: path.join(repoRoot, "campaigns", "pipeline.mjs"),
    workDir: repoRoot,
    startDate,
    userId,
  };
  return {
    publisher: {
      name: PUBLISH_TASK,
      file: "pipeline-publisher-task.xml",
      xml: buildTaskXml({
        ...common,
        args: shadow ? ["publish-tick", "--shadow"] : ["publish-tick"],
        time: "00:00",
        logonType: "S4U",
        repetition: { interval: "PT15M" },
        description: shadow
          ? "Shadow run: logs what each campaign would post when its window opens, posts nothing. See campaigns/pipeline.mjs."
          : "Posts each campaign's item when its window opens in its own time zone. See campaigns/pipeline.mjs.",
        executionTimeLimit: "PT1H",
      }),
    },
    creation: {
      name: CREATION_TASK,
      file: "pipeline-creation-task.xml",
      xml: buildTaskXml({
        ...common,
        args: ["create-nightly"],
        time: "02:00",
        logonType: "InteractiveToken",
        description: "Builds tonight's pieces across the campaigns and sends them for approval. See campaigns/pipeline.mjs.",
        executionTimeLimit: "PT10H",
      }),
    },
    telegram: {
      name: TELEGRAM_TASK,
      file: "pipeline-telegram-task.xml",
      xml: buildTaskXml({
        ...common,
        args: ["telegram-tick"],
        time: "00:00",
        logonType: "S4U",
        repetition: { interval: "PT5M" },
        description: "Reads Approve and Redo taps from every campaign's Telegram bot. See campaigns/pipeline.mjs.",
        executionTimeLimit: "PT30M",
      }),
    },
  };
}

export function install({
  shadow = false,
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  nodePath = process.execPath,
  userId = currentUserId(),
  startDate = istDate(new Date()),
  tmpDir = os.tmpdir(),
  exec = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" }),
  log = console.log,
} = {}) {
  const tasks = buildPipelineTasks({ nodePath, repoRoot, userId, startDate, shadow });
  for (const task of [tasks.publisher, tasks.creation, tasks.telegram]) {
    const file = path.join(tmpDir, task.file);
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(task.xml, "utf16le")]));
    exec("schtasks.exe", ["/Create", "/TN", task.name, "/XML", file, "/F"]);
  }
  log(`Registered "${PUBLISH_TASK}" (every 15 minutes${shadow ? ", shadow: posts nothing" : ""}), "${CREATION_TASK}" (daily at 02:00) and "${TELEGRAM_TASK}" (every 5 minutes).`);
  log(`Check with: schtasks /Query /TN "${PUBLISH_TASK}" /V /FO LIST`);
}

const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (runDirectly) {
  try {
    const args = process.argv.slice(2);
    const unknown = args.find((a) => a !== "--shadow");
    if (unknown !== undefined) throw new Error(`unknown argument ${unknown}; the only option is --shadow`);
    install({ shadow: args.includes("--shadow") });
  } catch (err) {
    console.error(`install-tasks failed: ${err.message}`);
    process.exitCode = 1;
  }
}
