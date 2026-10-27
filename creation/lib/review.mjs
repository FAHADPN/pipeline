// The fresh-eyes review: a second, separate `claude -p` that runs the piece-review
// skill on a built piece and replies with a SHIP or FIX verdict as JSON.
//
// The reviewer is read-only. It gets Read, Glob, Grep and Skill and nothing else:
// no Bash, so it can't run the skill scripts itself. Their raw JSON from runChecks
// (already run with UTF-8) is written to creation-out/<id>.checks.json in the
// campaign's folder before it starts, and the skill reads that file. A reviewer with
// no shell and no such file reports NOT_RUN.
//
// Anything short of a clean verdict (a timeout, a non-zero exit, a spawn error,
// output with no SHIP/FIX JSON) is a FIX, never thrown, so the night moves on.
// A clean verdict is also written to <id>.review.json beside the checks, for the
// console's Review screen; a review that didn't complete leaves no such file.
//
// spawn is child_process.spawn. killTree(pid) kills the process and its children.

import { execFile, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { OUT_DIR } from "./constants.mjs";
import { SESSION_ENV, sessionEnv } from "./session.mjs";

// Default permission mode: in -p nothing outside the allowlist can be approved. Bash,
// Edit and Write are also denied outright, so an allow rule in the user's settings
// can't hand them back.
export const REVIEW_ARGS = [
  "-p", "--output-format", "text", "--max-turns", "100",
  "--allowedTools", "Read", "Glob", "Grep", "Skill",
  "--disallowedTools", "WebFetch", "WebSearch", "Bash", "Edit", "Write", "NotebookEdit",
];

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/i;

const execFileP = promisify(execFile);

async function defaultKillTree(pid) {
  await execFileP("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}

// The review prompt: the piece-review skill, pointed at the piece's folder (`pieceDir`,
// relative to the campaign folder the reviewer runs in), the campaign's own brief and
// voice and where the piece's checks file is. Those three paths are absolute.
export function reviewPrompt({ id, name, pieceDir, brief, voice, checksFile }) {
  return [
    `Use the piece-review skill to review piece \`${id}\` of the "${name}" campaign.`,
    `The piece is in \`${pieceDir.replace(/\/+$/, "")}/\` under the campaign folder.`,
    `Judge it against this campaign's brief, \`${brief}\`, and its brand voice, \`${voice}\`.`,
    `The skill scripts' JSON is in \`${checksFile}\`.`,
    "Reply with only its JSON.",
  ].join(" ");
}

// Where writeChecksFile puts a piece's checks, under the campaign folder `cwd`.
export const checksFilePath = (cwd, entryId) => path.join(cwd, OUT_DIR, `${entryId}.checks.json`);

// Where runReview keeps the last parsed verdict, beside the checks; the console reads it.
export const reviewFilePath = (cwd, entryId) => path.join(cwd, OUT_DIR, `${entryId}.review.json`);

// runChecks' `raw`, under the names the skill's reply uses. null: the script didn't
// run or printed no JSON. `skipped` lists the checks a campaign switched off.
export function writeChecksFile({ cwd, entryId, raw = {} }) {
  const file = checksFilePath(cwd, entryId);
  const body = {
    id: entryId,
    env: { PYTHONUTF8: SESSION_ENV.PYTHONUTF8, PYTHONIOENCODING: SESSION_ENV.PYTHONIOENCODING },
    caption_py: raw.caption ?? null,
    detect_caption: raw.detect ?? null,
    detect_onscreen: raw.detectOnScreen ?? null,
    hook_caption: raw.hookCaption ?? null,
    hook_onscreen: raw.hookOnScreen ?? null,
  };
  if (raw.skipped?.length) body.skipped = raw.skipped;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

// End of the balanced {...} starting at `start`, ignoring braces inside JSON strings;
// -1 if it never closes.
function closingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

// The last top-level JSON object in free text (prose, code fences and all), or null.
export function lastJsonObject(text) {
  let found = null;
  let i = text.indexOf("{");
  while (i >= 0) {
    const end = closingBrace(text, i);
    let parsed;
    if (end >= 0) {
      try {
        parsed = JSON.parse(text.slice(i, end + 1));
      } catch {
        parsed = undefined;
      }
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      found = parsed;
      i = text.indexOf("{", end + 1);
    } else {
      i = text.indexOf("{", i + 1);
    }
  }
  return found;
}

const lastLine = (s) => s.trim().split(/\r?\n/).pop() ?? "";

function incomplete(reason) {
  const line = `review did not complete: ${reason}`;
  return { verdict: "FIX", scores: null, skills: null, must_fix: [line], nice_to_have: [], summary: line };
}

function verdictFrom(json) {
  if (!json || (json.verdict !== "SHIP" && json.verdict !== "FIX")) return null;
  const must_fix = Array.isArray(json.must_fix) ? json.must_fix : [];
  return {
    // The skill ships only with no must-fix items; don't trust a reply that says otherwise.
    verdict: json.verdict === "SHIP" && must_fix.length === 0 ? "SHIP" : "FIX",
    scores: json.scores ?? null,
    skills: json.skills ?? null,
    must_fix,
    nice_to_have: Array.isArray(json.nice_to_have) ? json.nice_to_have : [],
    summary: typeof json.summary === "string" ? json.summary : "",
  };
}

// `prompt` is the piece's reviewPrompt (campaign-deps.mjs builds it); `cwd` is the
// campaign's folder.
export async function runReview({
  entryId,
  cwd,
  raw = {},
  timeoutMs = 1200000,
  graceMs = 30000,
  spawn = nodeSpawn,
  killTree = defaultKillTree,
  prompt,
  env = {},
}) {
  if (!SAFE_ID.test(entryId ?? "")) throw new Error(`bad piece id: ${entryId}`);
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`no review prompt for ${entryId}`);
  writeChecksFile({ cwd, entryId, raw });
  // A verdict from an earlier review must never sit beside these new checks.
  const reviewFile = reviewFilePath(cwd, entryId);
  fs.rmSync(reviewFile, { force: true });

  const { code, output, timedOut, error } = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    let timer;
    let grace;

    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, output: { stdout, stderr }, timedOut, error });
    };

    const child = spawn("claude", REVIEW_ARGS, {
      cwd,
      env: sessionEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(timedOut ? null : code));

    timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve()
        .then(() => killTree(child.pid))
        .catch(() => {});
      // A grandchild holding a pipe open can keep "close" from firing; don't wait on it forever.
      grace = setTimeout(() => finish(null), graceMs);
    }, timeoutMs);

    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });

  if (timedOut) return incomplete(`timed out after ${Math.round(timeoutMs / 1000)} s`);
  if (error) return incomplete(`could not start claude: ${error.message}`);
  if (code !== 0) return incomplete(`claude exited ${code}: ${lastLine(output.stderr) || lastLine(output.stdout) || "no output"}`);
  const review = verdictFrom(lastJsonObject(output.stdout));
  if (!review) return incomplete(`no JSON verdict in the output: ${lastLine(output.stdout).slice(0, 200) || "empty"}`);
  fs.writeFileSync(reviewFile, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return review;
}
