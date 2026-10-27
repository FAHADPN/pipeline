// The publisher's data dir and the owner's .env file in it. Both live outside the
// repo so no copy, re-clone or `git clean` can wipe them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function publisherHome(env = process.env) {
  return env.PIPELINE_HOME || path.join(os.homedir(), ".pipeline");
}

// One KEY=value per line, the value optionally in quotes. Other lines are ignored.
export function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
