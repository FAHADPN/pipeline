import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SWITCHES, DEFAULT_VIDEO_SPEC, cuesText, defaultExec, findFfprobe, loadGuardrails, runChecks } from "../lib/checks.mjs";

const ID = "post-01-how-many";
const DIR = `pieces/${ID}`;
const SKILLS = "C:\\skills";
const ITEM = { id: ID, kind: "post", dir: DIR };

const CAPTION = [
  "Espresso at 6 AM or a flat white at noon: how many have you tried? 👀",
  "",
  "Six drinks, one menu. Comment your score.",
  "",
  "#coffee #morningshift",
].join("\n");
const TITLE = "How many of these coffees have you tried? #shorts #coffee";

const CUES = `// How many · Coffee. Pure data.
export const meta = { kind: "post", n: 1, slug: "${ID}", title: "How many · Coffee" };
/* the six */
export const ITEMS = ["Espresso at dawn ☕", 'Flat white', "cold brew float"];
export const captions = [
  [0, 2.4, "count with your barista 👇"],
  [2.4, 12.4, \`Ana & Ben: 4 / 6. you?\`],
];
export const post = { hook: "how many have you tried?" };
`;

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A finished piece folder: video, cover, caption file and cues.js.
function fixture(t, { caption = CAPTION, title = TITLE, cues = CUES } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "checks-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  write(repo, `${DIR}/out/acme-post-01.mp4`, "not really a video");
  write(repo, `${DIR}/out/acme-post-01-cover.png`, "png");
  write(repo, `${DIR}/out/acme-post-01-caption.txt`,
    ["INSTAGRAM / TIKTOK", "", caption, "", "YOUTUBE SHORTS TITLE", "", title, ""].join("\r\n"));
  write(repo, `${DIR}/cues.js`, cues);
  return repo;
}

const GOOD = {
  caption: { verdict: "READY", checks: [{ check: "LENGTH", status: "PASS", detail: "ok" }] },
  detect: { verdict: "PASS", human_score: 82.4, checks: {} },
  hook: { verdict: "STRONG", score: 78.1, weakest: "CURIOSITY", flags: [] },
  ffprobe: {
    streams: [
      { codec_type: "video", width: 1080, height: 1920, duration: "22.800000" },
      { codec_type: "audio", duration: "22.790000" },
    ],
  },
};

// Answers each script with canned JSON and records every call.
function fakeExec(over = {}) {
  const canned = { ...GOOD, ...over };
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    const script = args.find((a) => /\.py$/.test(a));
    const key = script ? { "caption.py": "caption", "detect.py": "detect", "hookscore.py": "hook" }[path.basename(script)] : "ffprobe";
    const answer = canned[key];
    if (typeof answer === "function") return answer({ cmd, args, opts });
    return { code: 0, stdout: JSON.stringify(answer), stderr: "" };
  };
  return { exec, calls };
}

const run = (repo, fake, extra = {}) =>
  runChecks({ repoRoot: repo, item: ITEM, exec: fake.exec, skillsDir: SKILLS, ffprobe: "ffprobe", ...extra });

test("all pass", async (t) => {
  const repo = fixture(t);
  const fake = fakeExec();
  const res = await run(repo, fake);
  assert.deepEqual(res.failures, []);
  assert.equal(res.ok, true);
  assert.deepEqual(res.scores, {
    caption: { verdict: "READY" },
    detect: { verdict: "PASS", human_score: 82.4 },
    hook: { verdict: "STRONG", score: 78.1, weakest: "CURIOSITY" },
  });

  const py = fake.calls.filter((c) => c.cmd === "python");
  const byScript = (name) => py.filter((c) => c.args.some((a) => a.endsWith(name)));
  for (const c of py) {
    assert.deepEqual(c.args.slice(0, 2), ["-X", "utf8"]);
    assert.equal(c.opts.env.PYTHONUTF8, "1");
    assert.equal(c.opts.env.PYTHONIOENCODING, "utf-8");
  }

  const [cap] = byScript("caption.py");
  assert.deepEqual(cap.args, ["-X", "utf8", path.join(SKILLS, "ig-caption", "caption.py"), "-", "--json"]);
  assert.equal(cap.opts.input, CAPTION, "the Instagram section, without the YouTube title");

  const [det, detScreen] = byScript("detect.py");
  assert.deepEqual(det.args, ["-X", "utf8", path.join(SKILLS, "ig-human", "detect.py"), "-", "--json"]);
  assert.equal(det.opts.input, CAPTION);
  assert.equal(detScreen.opts.input, "count with your barista 👇\nAna & Ben: 4 / 6. you?", "the on-screen lines");

  const [hookScreen, hookCaption] = byScript("hookscore.py");
  assert.deepEqual(hookScreen.args, [
    "-X", "utf8", path.join(SKILLS, "ig-reel", "hookscore.py"), "--hook=count with your barista 👇", "--json",
  ], "the hook is the first on-screen line");
  assert.ok(hookCaption.args.includes("--hook=Espresso at 6 AM or a flat white at noon: how many have you tried? 👀"),
    "the caption's first line, for the review");

  const probe = fake.calls.find((c) => c.cmd === "ffprobe");
  assert.deepEqual(probe.args, ["-v", "error", "-show_streams", "-of", "json", path.join(repo, DIR, "out", "acme-post-01.mp4")]);

  assert.deepEqual(res.raw, {
    caption: GOOD.caption,
    detect: GOOD.detect,
    detectOnScreen: GOOD.detect,
    hookOnScreen: GOOD.hook,
    hookCaption: GOOD.hook,
  });
});

test("caption.py FAIL fails", async (t) => {
  const repo = fixture(t);
  const res = await run(repo, fakeExec({
    caption: {
      verdict: "FIX",
      checks: [
        { check: "LENGTH", status: "PASS", detail: "ok" },
        { check: "HASHTAGS", status: "FAIL", detail: "6 tags, over Instagram's cap of 5" },
      ],
    },
  }));
  assert.equal(res.ok, false);
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0], /caption\.py/);
  assert.match(res.failures[0], /FIX/);
  assert.match(res.failures[0], /HASHTAGS: 6 tags/);
  assert.deepEqual(res.scores.caption, { verdict: "FIX" });
});

test("caption.py REVIEW (warnings, no FAIL) passes", async (t) => {
  const repo = fixture(t);
  const res = await run(repo, fakeExec({
    caption: { verdict: "REVIEW", checks: [{ check: "EMOJI", status: "WARN", detail: "decoration" }] },
  }));
  assert.equal(res.ok, true, res.failures.join("; "));
});

test("detect REVIEW fails, and so does FLAGGED", async (t) => {
  const repo = fixture(t);
  for (const verdict of ["REVIEW", "FLAGGED"]) {
    // The on-screen lines get the same answer here; only the caption's verdict counts.
    const res = await run(repo, fakeExec({ detect: { verdict, human_score: 61.2, checks: {} } }), { switches: { ...DEFAULT_SWITCHES, detectOnScreen: false } });
    assert.equal(res.ok, false, verdict);
    assert.equal(res.failures.length, 1, res.failures.join("; "));
    assert.match(res.failures[0], new RegExp(`detect\\.py.*${verdict}.*61\\.2`));
    assert.deepEqual(res.scores.detect, { verdict, human_score: 61.2 });
  }
});

test("with detectOnScreen off, detect on the on-screen lines is recorded but does not block", async (t) => {
  const repo = fixture(t);
  const detect = ({ opts }) => ({
    code: 0,
    stdout: JSON.stringify(opts.input === CAPTION ? GOOD.detect : { verdict: "FLAGGED", human_score: 40, checks: {} }),
    stderr: "",
  });
  const res = await run(repo, fakeExec({ detect }), { switches: { ...DEFAULT_SWITCHES, detectOnScreen: false } });
  assert.equal(res.ok, true, res.failures.join("; "));
  assert.equal(res.raw.detectOnScreen.verdict, "FLAGGED");
});

test("hook WEAK fails, OK passes", async (t) => {
  const repo = fixture(t);
  const weak = await run(repo, fakeExec({ hook: { verdict: "WEAK", score: 41, weakest: "SPECIFICITY", flags: ["generic"] } }));
  assert.equal(weak.ok, false);
  assert.equal(weak.failures.length, 1);
  assert.match(weak.failures[0], /hookscore\.py.*WEAK.*41.*SPECIFICITY/);

  const ok = await run(repo, fakeExec({ hook: { verdict: "OK", score: 64, weakest: "CURIOSITY", flags: [] } }));
  assert.equal(ok.ok, true, ok.failures.join("; "));
  assert.deepEqual(ok.scores.hook, { verdict: "OK", score: 64, weakest: "CURIOSITY" });
});

// hookscore.py answers WEAK for the hook it's given, STRONG for anything else.
const weakFor = (text) => ({ args }) => ({
  code: 0,
  stdout: JSON.stringify(args.includes(`--hook=${text}`) ? { verdict: "WEAK", score: 48.1, weakest: "CURIOSITY", flags: [] } : GOOD.hook),
  stderr: "",
});

test("on-screen hook WEAK fails", async (t) => {
  const repo = fixture(t);
  const res = await run(repo, fakeExec({ hook: weakFor("count with your barista 👇") }));
  assert.equal(res.ok, false);
  assert.equal(res.failures.length, 1, res.failures.join("; "));
  assert.match(res.failures[0], /hookscore\.py on the on-screen hook "count with your barista 👇": WEAK \(score 48\.1, weakest CURIOSITY\)/);
  assert.deepEqual(res.scores.hook, { verdict: "WEAK", score: 48.1, weakest: "CURIOSITY" });
  assert.equal(res.raw.hookOnScreen.verdict, "WEAK");
  assert.equal(res.raw.hookCaption.verdict, "STRONG");
});

test("caption first-line hook WEAK alone does not fail when cues.js gives the hook", async (t) => {
  const repo = fixture(t);
  const res = await run(repo, fakeExec({ hook: weakFor(CAPTION.split("\n")[0]) }));
  assert.equal(res.ok, true, res.failures.join("; "));
  assert.deepEqual(res.scores.hook, { verdict: "STRONG", score: 78.1, weakest: "CURIOSITY" });
  assert.equal(res.raw.hookCaption.verdict, "WEAK", "kept for the review");
  assert.equal(res.raw.hookOnScreen.verdict, "STRONG");
});

test("cues.js with no on-screen captions fails: there is no hook to score", async (t) => {
  const repo = fixture(t, { cues: CUES.replace(/export const captions = \[[\s\S]*?\n\];\n/, "") });
  const fake = fakeExec();
  const res = await run(repo, fake);
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures, ["no on-screen captions in cues.js: the first one is the hook"]);
  assert.equal(res.scores.hook, null);
  assert.ok(fake.calls.some((c) => c.args.some((a) => a.endsWith("hookscore.py"))), "the caption's first line is still scored");
});

test("a script that crashes or prints no JSON fails with its error", async (t) => {
  const repo = fixture(t);
  const res = await run(repo, fakeExec({
    hook: () => ({ code: 1, stdout: "", stderr: "Traceback (most recent call last):\nUnicodeEncodeError: 'charmap' codec can't encode\n" }),
  }));
  assert.equal(res.ok, false);
  assert.match(res.failures.join("\n"), /hookscore\.py did not return JSON.*UnicodeEncodeError/);
  assert.equal(res.scores.hook, null);
});

test("a caption with emoji reaches the scripts intact and gets parsed scores", async (t) => {
  const caption = "the barista cried at the new machine 😭 one more shot 👉 espresso\n\nComment your score.\n\n#coffee #cafe";
  const repo = fixture(t, { caption });
  const fake = fakeExec();
  const res = await run(repo, fake);
  assert.equal(res.ok, true, res.failures.join("; "));
  const cap = fake.calls.find((c) => c.args.some((a) => a.endsWith("caption.py")));
  assert.equal(cap.opts.input, caption);
  const hooks = fake.calls.filter((c) => c.args.some((a) => a.endsWith("hookscore.py")));
  assert.ok(hooks.some((c) => c.args.includes("--hook=the barista cried at the new machine 😭 one more shot 👉 espresso")));
  assert.ok(hooks.some((c) => c.args.includes("--hook=count with your barista 👇")));
});

test("guardrail hit fails and names the word", async (t) => {
  const repo = fixture(t, {
    caption: "Ordered from Globex at 2 AM, again 👀\n\nComment your score.\n\n#coffee",
    cues: CUES.replace("cold brew float", "cold brew float, dude"),
  });
  const res = await run(repo, fakeExec(), { guardrails: { brands: ["globex"], slang: ["dude"] } });
  assert.equal(res.ok, false);
  const text = res.failures.join("\n");
  assert.match(text, /guardrail \(brands\): "globex" in the caption/i);
  assert.match(text, /guardrail \(slang\): "dude" in cues\.js/i);
});

test("guardrail scan is word-boundary and ignores cues.js comments", async (t) => {
  const repo = fixture(t, {
    caption: "Ginger chai at the gin-less wedding? No: ginger tea 👀\n\nComment your score.\n\n#tea",
    cues: CUES.replace("// How many · Coffee.", "// How many · Coffee, not a Globex ad."),
  });
  const res = await run(repo, fakeExec(), { guardrails: { alcohol: ["gin"], brands: ["globex"], people: [], slang: [] } });
  // "gin-less" is the word gin; "Ginger" and "ginger" are not.
  assert.deepEqual(res.failures, ['guardrail (alcohol): "gin" in the caption']);
});

test("no guardrail lists means no guardrail failures", async (t) => {
  const repo = fixture(t, { caption: "Ordered from Globex at 2 AM, again 👀\n\nComment your score.\n\n#coffee" });
  const res = await run(repo, fakeExec());
  assert.deepEqual(res.failures, []);
});

test("long YouTube title fails here even though posting only warns", async (t) => {
  const repo = fixture(t, { title: `${"a".repeat(93)} #shorts` });
  const res = await run(repo, fakeExec());
  assert.equal(res.ok, false);
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0], /YouTube title is 101 characters/);
});

test("a folder checkItem rejects fails before any script runs", async (t) => {
  const repo = fixture(t);
  fs.rmSync(path.join(repo, DIR, "out", "acme-post-01-cover.png"));
  const fake = fakeExec();
  const res = await run(repo, fake);
  assert.equal(res.ok, false);
  assert.match(res.failures[0], /cover missing/);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(res.scores, { caption: null, detect: null, hook: null });
});

test("wrong video size fails", async (t) => {
  const repo = fixture(t);
  const res = await run(repo, fakeExec({
    ffprobe: { streams: [{ codec_type: "video", width: 1920, height: 1080, duration: "22.8" }, { codec_type: "audio", duration: "22.8" }] },
  }));
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures, ["video is 1920x1080, not 1080x1920"]);
});

test("video too short, too long or silent fails", async (t) => {
  const repo = fixture(t);
  const video = (duration) => ({ codec_type: "video", width: 1080, height: 1920, duration });
  const short = await run(repo, fakeExec({ ffprobe: { streams: [video("6.5"), { codec_type: "audio" }] } }));
  assert.deepEqual(short.failures, ["video is 6.5 s long (7 to 35 s)"]);
  const long = await run(repo, fakeExec({ ffprobe: { streams: [video("35.4"), { codec_type: "audio" }] } }));
  assert.deepEqual(long.failures, ["video is 35.4 s long (7 to 35 s)"]);
  const silent = await run(repo, fakeExec({ ffprobe: { streams: [video("20")] } }));
  assert.deepEqual(silent.failures, ["video has no audio stream"]);
});

test("the defaults are campaign.json's: every switch on, 7-35 s 1080x1920 with audio", async (t) => {
  assert.deepEqual(DEFAULT_SWITCHES, { captionPy: true, detect: true, detectOnScreen: true, hookscore: true, guardrails: true });
  assert.deepEqual(DEFAULT_VIDEO_SPEC, { width: 1080, height: 1920, minSeconds: 7, maxSeconds: 35, audioRequired: true, youtubeTitleRequired: true });
  const repo = fixture(t);
  const res = await run(repo, fakeExec());
  assert.deepEqual(res.skipped, [], "nothing is skipped by default");
  assert.equal(res.raw.skipped, undefined, "the reviewer's file is unchanged");
});

test("check switches skip disabled checks and are reported as skipped", async (t) => {
  const repo = fixture(t, { caption: "Ordered from Globex at 2 AM, again 👀\n\nComment your score.\n\n#coffee" });
  const fake = fakeExec({
    caption: { verdict: "FIX", checks: [{ check: "HASHTAGS", status: "FAIL", detail: "x" }] },
    detect: { verdict: "FLAGGED", human_score: 12, checks: {} },
    hook: { verdict: "WEAK", score: 10, weakest: "CURIOSITY", flags: [] },
  });
  const res = await run(repo, fake, {
    switches: { captionPy: false, detect: false, detectOnScreen: true, hookscore: false, guardrails: false },
    guardrails: { brands: ["globex"] },
  });
  assert.deepEqual(res.failures, [], "nothing that was switched off can fail");
  assert.equal(res.ok, true);
  assert.deepEqual(fake.calls.filter((c) => c.cmd === "python"), [], "no skill script ran");
  assert.deepEqual(res.skipped, [
    "caption.py on the caption",
    "detect.py on the caption",
    "hookscore.py on the hook",
    "detect.py on the on-screen lines",
    "guardrail word lists",
  ]);
  assert.deepEqual(res.raw.skipped, res.skipped, "the reviewer is told what was skipped");
  assert.deepEqual(res.scores, { caption: null, detect: null, hook: null });
});

test("detectOnScreen on makes detect.py on the on-screen lines block", async (t) => {
  const repo = fixture(t);
  const detect = ({ opts }) => ({
    code: 0,
    stdout: JSON.stringify(opts.input === CAPTION ? GOOD.detect : { verdict: "FLAGGED", human_score: 40, checks: {} }),
    stderr: "",
  });
  const blocking = await run(repo, fakeExec({ detect }), { switches: { ...DEFAULT_SWITCHES, detectOnScreen: true } });
  assert.equal(blocking.ok, false);
  assert.deepEqual(blocking.failures, ["detect.py on the on-screen lines: FLAGGED (human score 40, needs PASS)"]);
  const advisory = await run(repo, fakeExec({ detect }), { switches: { ...DEFAULT_SWITCHES, detectOnScreen: false } });
  assert.equal(advisory.ok, true, advisory.failures.join("; "));
  assert.equal(advisory.raw.detectOnScreen.verdict, "FLAGGED", "still recorded for the reviewer");
});

test("videoSpec limits used", async (t) => {
  const repo = fixture(t);
  const square = { streams: [{ codec_type: "video", width: 1080, height: 1080, duration: "50" }] };
  const spec = { width: 1080, height: 1080, minSeconds: 10, maxSeconds: 60, audioRequired: false, youtubeTitleRequired: true };
  const ok = await run(repo, fakeExec({ ffprobe: square }), { videoSpec: spec });
  assert.deepEqual(ok.failures, [], "square, 50 s and silent fits this spec");
  const standard = await run(repo, fakeExec({ ffprobe: square }));
  assert.deepEqual(standard.failures, ["video is 1080x1080, not 1080x1920", "video is 50 s long (7 to 35 s)", "video has no audio stream"]);
  const short = await run(repo, fakeExec({ ffprobe: { streams: [{ ...square.streams[0], duration: "9" }] } }), { videoSpec: spec });
  assert.deepEqual(short.failures, ["video is 9 s long (10 to 60 s)"]);
});

test("youtubeTitleRequired off lets a long YouTube title through", async (t) => {
  const repo = fixture(t, { title: `${"a".repeat(93)} #shorts` });
  const res = await run(repo, fakeExec(), { videoSpec: { ...DEFAULT_VIDEO_SPEC, youtubeTitleRequired: false } });
  assert.deepEqual(res.failures, []);
});

test("without cues.js the caption's first line is the hook that must not be WEAK", async (t) => {
  const repo = fixture(t);
  fs.rmSync(path.join(repo, DIR, "cues.js"));
  const passing = await run(repo, fakeExec());
  assert.deepEqual(passing.failures, [], "a piece needs no cues.js");

  const res = await run(repo, fakeExec({ hook: weakFor(CAPTION.split("\n")[0]) }));
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures, [`hookscore.py on the caption's first line "${CAPTION.split("\n")[0]}": WEAK (score 48.1, weakest CURIOSITY)`]);
  assert.deepEqual(res.skipped, ["hookscore.py on the on-screen hook (no cues.js)", "detect.py on the on-screen lines (no cues.js)"]);
  assert.deepEqual(res.scores.hook, { verdict: "WEAK", score: 48.1, weakest: "CURIOSITY" });
});

test("a campaign's own guardrail lists are all scanned", async (t) => {
  const repo = fixture(t, { caption: "Win big at the casino tonight 👀\n\nComment your score.\n\n#x" });
  const res = await run(repo, fakeExec(), { guardrails: { _about: "not a list", gambling: ["casino"] } });
  assert.deepEqual(res.failures, ['guardrail (gambling): "casino" in the caption']);
});

test("loadGuardrails reads a campaign's word lists", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrails-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "guardrails.json");
  fs.writeFileSync(file, JSON.stringify({ _about: "words the brand never uses", brands: ["globex"], slang: ["dude"] }));
  assert.deepEqual(loadGuardrails(file), { _about: "words the brand never uses", brands: ["globex"], slang: ["dude"] });
  assert.throws(() => loadGuardrails(path.join(dir, "missing.json")), /ENOENT/);
});

test("cuesText reads string literals without running the file", () => {
  const { strings, onScreen } = cuesText(CUES);
  assert.ok(strings.includes("Espresso at dawn ☕"));
  assert.ok(strings.includes("Flat white"));
  assert.ok(strings.includes("Ana & Ben: 4 / 6. you?"));
  assert.ok(!strings.some((s) => s.includes("the six")), "comments are skipped");
  assert.deepEqual(onScreen, ["count with your barista 👇", "Ana & Ben: 4 / 6. you?"]);
  assert.deepEqual(cuesText('export const captions = [[0, 1, "it\\u2019s \\"done\\""]];').onScreen, ["it’s \"done\""]);
});

test("ffprobe comes from PATH, else from next to FFMPEG_BIN, else by its bare name", () => {
  const sep = path.delimiter;
  const onPath = findFfprobe({
    env: { PATH: `C:\\a${sep}C:\\tools`, FFMPEG_BIN: "C:\\ff\\bin\\ffmpeg.exe" },
    exists: (p) => p === path.join("C:\\tools", "ffprobe.exe"),
  });
  assert.equal(onPath, path.join("C:\\tools", "ffprobe.exe"));
  const beside = findFfprobe({ env: { PATH: "C:\\a", FFMPEG_BIN: "C:\\ff\\bin\\ffmpeg.exe" }, exists: () => false });
  assert.equal(beside, path.join("C:\\ff\\bin", "ffprobe.exe"));
  const bare = findFfprobe({ env: { PATH: "C:\\a" }, exists: () => false });
  assert.equal(bare, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
});

// The real ig skill scripts, if python and the skills are here. A known-good caption
// passes caption.py, and emoji don't crash any of the three.
const REAL_SKILLS = path.join(os.homedir(), ".claude", "skills");
const hasPython = (() => {
  try {
    execFileSync("python", ["--version"], { windowsHide: true, stdio: "ignore" });
    return fs.existsSync(path.join(REAL_SKILLS, "ig-caption", "caption.py"));
  } catch {
    return false;
  }
})();

test("real caption.py passes a known-good caption, and emoji don't crash the scripts", { skip: !hasPython && "python or the ig skills are missing" }, async (t) => {
  const caption = [
    "Espresso at 6 AM or a flat white at noon 😭 how many of these 6 have you tried? 👉",
    "",
    "Six drinks on one menu, made for the morning shift. Comment your score below.",
    "",
    "#coffee #morningshift #cafe",
  ].join("\n");
  const repo = fixture(t, { caption });
  const res = await runChecks({
    repoRoot: repo, item: ITEM, skillsDir: REAL_SKILLS,
    exec: async (cmd, args, opts) => (cmd === "ffprobe" ? { code: 0, stdout: JSON.stringify(GOOD.ffprobe), stderr: "" } : defaultExec(cmd, args, opts)),
    ffprobe: "ffprobe",
  });
  assert.notEqual(res.scores.caption, null, res.failures.join("; "));
  assert.notEqual(res.scores.caption.verdict, "FIX", JSON.stringify(res.raw.caption?.checks));
  assert.equal(typeof res.scores.detect.human_score, "number");
  assert.equal(typeof res.scores.hook.score, "number");
  assert.ok(res.raw.hookOnScreen && typeof res.raw.hookOnScreen.score === "number");
  assert.ok(res.raw.hookCaption && typeof res.raw.hookCaption.score === "number");
  assert.ok(!res.failures.some((f) => /did not return JSON|caption\.py/.test(f)), res.failures.join("; "));
});
