// The automatic checks a built piece passes before it goes to Telegram, in order:
//   1. the posting checkItem, with no errors and no warnings (a long YouTube title
//      only warns when posting, but new pieces must get it right)
//   2. caption.py on the Instagram caption: no FAIL check (verdict READY, or REVIEW
//      for warnings only; FIX fails)
//   3. detect.py on the caption: verdict PASS
//   4. hookscore.py on the hook: anything but WEAK. The hook is the first on-screen
//      caption, or the Instagram caption's first line for a piece with none.
//   5. no guardrail word in the caption or in any cues.js string
//   6. ffprobe: 7-35 s, 1080x1920, with an audio stream
// The on-screen captions are the strings of `export const captions = [...]` in an
// optional cues.js in the piece folder. detect.py on them runs too, and so does
// hookscore.py on the caption's first line when cues.js gives the hook. Neither
// blocks (caption.py already judges the caption's first line); their JSON goes to
// the fresh-eyes review in `raw`.
//
// The campaign sets the rest (campaign.json's `checks`, `videoSpec` and guardrails file):
//   - `switches` turns checks off: captionPy, detect (detect.py on the caption and
//     the on-screen lines), hookscore, guardrails. A check that's off doesn't run and
//     is listed in `skipped`, which also goes to the reviewer as raw.skipped.
//     detectOnScreen on makes detect.py on the on-screen lines block; off keeps it
//     advisory, as above.
//   - `videoSpec` sets the size, the length, whether audio is needed, and whether a
//     YouTube title over 100 characters fails.
//   - `guardrails` is the campaign's word lists; every list in it is scanned.
// The defaults are campaign.json's defaults.
//
// The skill thresholds are the user's and are never softened. cues.js is read as
// text, never imported: it was written by the build session, and this process
// shouldn't run it.
//
// exec(cmd, args, { input, env }) resolves { code, stdout, stderr } and never
// rejects; a non-zero exit is normal (the scripts exit 1 on anything but a clean pass).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkItem } from "../../publishing/lib/content.mjs";

const PY_ENV = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

export const DURATION = { min: 7, max: 35 };
export const SIZE = { width: 1080, height: 1920 };
export const DEFAULT_SWITCHES = { captionPy: true, detect: true, detectOnScreen: true, hookscore: true, guardrails: true };
export const DEFAULT_VIDEO_SPEC = {
  width: SIZE.width,
  height: SIZE.height,
  minSeconds: DURATION.min,
  maxSeconds: DURATION.max,
  audioRequired: true,
  youtubeTitleRequired: true,
};

export function defaultExec(cmd, args, { input, env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (res) => {
      if (!done) {
        done = true;
        resolve(res);
      }
    };
    const child = spawn(cmd, args, { env, windowsHide: true, timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    child.on("error", (err) => finish({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "", "utf8");
  });
}

// ffprobe on PATH if it's there, else next to the ffmpeg in FFMPEG_BIN, else the bare
// name (a missing ffprobe then fails the check with the spawn error).
export function findFfprobe({ env = process.env, exists = fs.existsSync } = {}) {
  const exe = process.platform === "win32" || /\.exe$/i.test(env.FFMPEG_BIN ?? "") ? "ffprobe.exe" : "ffprobe";
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  return env.FFMPEG_BIN ? path.join(path.dirname(env.FFMPEG_BIN), exe) : exe;
}

// A campaign's guardrails file: { listName: [words] }.
export function loadGuardrails(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };

// String literals and [ ] brackets of a JS file, skipping comments. Enough for the
// data-only cues.js files; regex literals and nested template strings aren't handled.
function tokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          const e = src[j + 1];
          const hex = e === "u" && (src[j + 2] === "{" ? /^\{([0-9a-f]+)\}/i : /^([0-9a-f]{4})/i).exec(src.slice(j + 2));
          if (hex) {
            value += String.fromCodePoint(parseInt(hex[1], 16));
            j += 2 + hex[0].length;
          } else {
            value += ESCAPES[e] ?? (e === "\n" ? "" : e);
            j += 2;
          }
        } else {
          value += src[j++];
        }
      }
      out.push({ type: "string", value, at: i });
      i = j + 1;
    } else {
      if (c === "[" || c === "]") out.push({ type: c, at: i });
      i++;
    }
  }
  return out;
}

// Every string in cues.js (the guardrail scan reads them all), and the on-screen
// lines: the strings inside `export const captions = [...]`.
export function cuesText(src) {
  const toks = tokens(src);
  const strings = toks.filter((t) => t.type === "string").map((t) => t.value);
  const onScreen = [];
  const m = /export\s+const\s+captions\s*=\s*\[/.exec(src);
  if (m) {
    const open = m.index + m[0].length - 1;
    let k = toks.findIndex((t) => t.type === "[" && t.at === open);
    if (k >= 0) {
      for (let depth = 0; k < toks.length; k++) {
        const t = toks[k];
        if (t.type === "[") depth++;
        else if (t.type === "]" && --depth === 0) break;
        else if (t.type === "string" && t.value.trim()) onScreen.push(t.value.trim());
      }
    }
  }
  return { strings, onScreen };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tidy = (s) => s.replace(/[‘’ʼ]/g, "'");

// Every list in the file (keys like "_about" that aren't lists are skipped).
// Case-insensitive, whole words: "gin" hits "gin-less" but not "ginger".
function guardrailHits(guardrails, sources) {
  const hits = [];
  for (const [list, words] of Object.entries(guardrails)) {
    if (!Array.isArray(words)) continue;
    for (const word of words) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(tidy(word)).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu");
      for (const [where, text] of sources) {
        if (re.test(tidy(text))) hits.push(`guardrail (${list}): "${word}" in ${where}`);
      }
    }
  }
  return hits;
}

const firstLine = (text) => text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

const lastLine = (s) => s.trim().split(/\r?\n/).pop() ?? "";

// `item` is the piece as the schedule will hold it: { id, kind, dir }, dir relative
// to repoRoot (campaign-deps.mjs passes it).
export async function runChecks({
  repoRoot,
  item,
  exec = defaultExec,
  skillsDir = path.join(os.homedir(), ".claude", "skills"),
  ffprobe = findFfprobe(),
  guardrails = {},
  switches = DEFAULT_SWITCHES,
  videoSpec = DEFAULT_VIDEO_SPEC,
}) {
  const on = { ...DEFAULT_SWITCHES, ...switches };
  const spec = { ...DEFAULT_VIDEO_SPEC, ...videoSpec };
  const failures = [];
  const skipped = [];
  const scores = { caption: null, detect: null, hook: null };
  const raw = {};
  const env = { ...process.env, ...PY_ENV };

  // 1. The posting contract. Without a parsed caption nothing else can be checked.
  // Its only warning is a YouTube title over 100 characters.
  const check = checkItem(repoRoot, item);
  const titleWarnings = spec.youtubeTitleRequired ? check.warnings : [];
  if (!check.ok) return { ok: false, failures: [...check.errors, ...titleWarnings], scores, raw, skipped };
  failures.push(...titleWarnings);
  const caption = check.caption.instagram;

  const python = async (name, script, args, input) => {
    const res = await exec("python", ["-X", "utf8", path.join(skillsDir, script), ...args], { input, env });
    const json = parseJson(res.stdout);
    if (!json) failures.push(`${name} did not return JSON (exit ${res.code}): ${lastLine(res.stderr) || "no output"}`);
    return json;
  };

  // 2. caption.py: READY, or REVIEW (warnings only). FIX means a FAIL check.
  if (on.captionPy) {
    raw.caption = await python("caption.py", "ig-caption/caption.py", ["-", "--json"], caption);
    if (raw.caption) {
      scores.caption = { verdict: raw.caption.verdict };
      const failed = (raw.caption.checks ?? []).filter((c) => c.status === "FAIL");
      if (raw.caption.verdict === "FIX" || failed.length) {
        failures.push(`caption.py: ${raw.caption.verdict}${failed.map((c) => `; ${c.check}: ${c.detail}`).join("")}`);
      }
    }
  } else {
    skipped.push("caption.py on the caption");
  }

  // 3. detect.py on the caption must PASS.
  if (on.detect) {
    raw.detect = await python("detect.py", "ig-human/detect.py", ["-", "--json"], caption);
    if (raw.detect) {
      scores.detect = { verdict: raw.detect.verdict, human_score: raw.detect.human_score };
      if (raw.detect.verdict !== "PASS") failures.push(`detect.py: ${raw.detect.verdict} (human score ${raw.detect.human_score}, needs PASS)`);
    }
  } else {
    skipped.push("detect.py on the caption");
  }

  let cues = { strings: [], onScreen: [] };
  const cuesFile = path.join(repoRoot, item.dir, "cues.js");
  const hasCues = fs.existsSync(cuesFile);
  if (hasCues) cues = cuesText(fs.readFileSync(cuesFile, "utf8"));
  // A piece with no cues.js: its caption's first line is the hook.
  const captionIsHook = !hasCues;

  // 4. hookscore.py on the first on-screen caption must not be WEAK. --hook=… keeps a
  // hook that starts with "-" from being read as an option.
  const hook = cues.onScreen[0];
  if (!on.hookscore) {
    skipped.push("hookscore.py on the hook");
  } else if (hook !== undefined) {
    raw.hookOnScreen = await python("hookscore.py", "ig-reel/hookscore.py", [`--hook=${hook}`, "--json"]);
    if (raw.hookOnScreen) {
      const { verdict, score, weakest } = raw.hookOnScreen;
      scores.hook = { verdict, score, weakest };
      if (verdict === "WEAK") failures.push(`hookscore.py on the on-screen hook "${hook}": WEAK (score ${score}, weakest ${weakest})`);
    }
  } else if (hasCues) {
    failures.push("no on-screen captions in cues.js: the first one is the hook");
  } else if (captionIsHook) {
    skipped.push("hookscore.py on the on-screen hook (no cues.js)");
  }

  // For the review only: the caption's first line, and the on-screen lines. The
  // caption's first line blocks when it's the hook; the on-screen lines block when
  // the detectOnScreen switch is on.
  const quiet = async (script, args, input) =>
    parseJson((await exec("python", ["-X", "utf8", path.join(skillsDir, script), ...args], { input, env })).stdout);
  if (on.hookscore && captionIsHook) {
    const first = firstLine(caption);
    raw.hookCaption = await python("hookscore.py", "ig-reel/hookscore.py", [`--hook=${first}`, "--json"]);
    if (raw.hookCaption) {
      const { verdict, score, weakest } = raw.hookCaption;
      scores.hook = { verdict, score, weakest };
      if (verdict === "WEAK") failures.push(`hookscore.py on the caption's first line "${first}": WEAK (score ${score}, weakest ${weakest})`);
    }
  } else if (on.hookscore) {
    raw.hookCaption = await quiet("ig-reel/hookscore.py", [`--hook=${firstLine(caption)}`, "--json"]);
  }
  if (!on.detect) {
    skipped.push("detect.py on the on-screen lines");
  } else if (cues.onScreen.length && on.detectOnScreen) {
    raw.detectOnScreen = await python("detect.py", "ig-human/detect.py", ["-", "--json"], cues.onScreen.join("\n"));
    const { verdict, human_score: human } = raw.detectOnScreen ?? {};
    if (raw.detectOnScreen && verdict !== "PASS") failures.push(`detect.py on the on-screen lines: ${verdict} (human score ${human}, needs PASS)`);
  } else if (cues.onScreen.length) {
    raw.detectOnScreen = await quiet("ig-human/detect.py", ["-", "--json"], cues.onScreen.join("\n"));
  } else if (captionIsHook) {
    skipped.push("detect.py on the on-screen lines (no cues.js)");
  }

  // 5. Guardrails.
  if (on.guardrails) failures.push(...guardrailHits(guardrails, [["the caption", caption], ["cues.js", cues.strings.join("\n")]]));
  else skipped.push("guardrail word lists");

  // 6. The video itself.
  const probe = await exec(ffprobe, ["-v", "error", "-show_streams", "-of", "json", check.assets.video], { env: process.env });
  const streams = parseJson(probe.stdout)?.streams;
  if (!streams) {
    failures.push(`ffprobe did not return JSON (exit ${probe.code}): ${lastLine(probe.stderr) || "no output"}`);
  } else {
    const video = streams.find((s) => s.codec_type === "video");
    if (!video) {
      failures.push("video has no video stream");
    } else {
      if (video.width !== spec.width || video.height !== spec.height) {
        failures.push(`video is ${video.width}x${video.height}, not ${spec.width}x${spec.height}`);
      }
      const duration = Number(video.duration ?? Math.max(...streams.map((s) => Number(s.duration) || 0)));
      if (!(duration >= spec.minSeconds && duration <= spec.maxSeconds)) {
        failures.push(`video is ${Number.isFinite(duration) ? +duration.toFixed(2) : "?"} s long (${spec.minSeconds} to ${spec.maxSeconds} s)`);
      }
    }
    if (spec.audioRequired && !streams.some((s) => s.codec_type === "audio")) failures.push("video has no audio stream");
  }

  if (skipped.length) raw.skipped = skipped;
  return { ok: failures.length === 0, failures, scores, raw, skipped };
}
