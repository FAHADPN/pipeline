// One fenced headless Claude Code session: `claude -p` in the campaign's folder with a
// fixed tool allowlist, the prompt on stdin and a wall-clock limit. On timeout the
// whole process tree is killed. A non-zero exit, a kill or a spawn error is returned,
// never thrown, so the night moves on to the next piece.
//
// spawn is child_process.spawn. killTree(pid) kills the process and its children.
// claude is a native claude.exe, so it runs without a shell and every argument
// (parens and stars included) reaches it as written.

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { promisify } from "node:util";

export const CLAUDE_ARGS = [
  "-p", "--permission-mode", "acceptEdits", "--output-format", "text", "--max-turns", "200",
  "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Skill",
  "Bash(node:*)", "Bash(python:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)",
  "Bash(git diff:*)", "Bash(ls:*)", "Bash(mkdir:*)",
  "--disallowedTools", "WebFetch", "WebSearch", "Bash(git push:*)", "Bash(curl:*)", "Bash(schtasks:*)",
];

// Python skill scripts crash on emoji under cp1252 without these. Everything else
// (FFMPEG_BIN, an image API key) comes from this process's own environment.
export const SESSION_ENV = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};

const execFileP = promisify(execFile);

async function defaultKillTree(pid) {
  await execFileP("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}

// A campaign's extra tools (campaign.json's extraAllowedTools) join the allowlist;
// the denied tools stay denied.
export function sessionArgs(extraAllowedTools = []) {
  const at = CLAUDE_ARGS.indexOf("--disallowedTools");
  return [...CLAUDE_ARGS.slice(0, at), ...extraAllowedTools, ...CLAUDE_ARGS.slice(at)];
}

// The session's environment: this process's, SESSION_ENV, then `extra`. A key
// whose value is undefined in `extra` is removed, so a campaign without its own
// ANTHROPIC_API_KEY never inherits one.
export function sessionEnv(extra = {}) {
  const env = { ...process.env, ...SESSION_ENV };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function runSession({
  prompt,
  cwd,
  timeoutMs = 3600000,
  graceMs = 30000,
  spawn = nodeSpawn,
  killTree = defaultKillTree,
  extraAllowedTools = [],
  env = {},
}) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let done = false;
    let timer;
    let grace;

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, output, timedOut });
    };

    const child = spawn("claude", sessionArgs(extraAllowedTools), {
      cwd,
      env: sessionEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (d) => { output += d; });
    child.stderr?.on("data", (d) => { output += d; });
    child.on("error", (err) => {
      output += `${output && !output.endsWith("\n") ? "\n" : ""}${err.message}\n`;
      finish(null);
    });
    child.on("close", (code) => finish(timedOut ? null : code));

    timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve()
        .then(() => killTree(child.pid))
        .catch((err) => { output += `\nkillTree failed: ${err.message}\n`; });
      // A grandchild holding a pipe open can keep "close" from firing; don't wait on it forever.
      grace = setTimeout(() => finish(null), graceMs);
    }, timeoutMs);

    // The child can die before reading its prompt; that shows up as its exit, not here.
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
}
