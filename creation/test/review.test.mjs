import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { REVIEW_ARGS, lastJsonObject, reviewPrompt, runReview } from "../lib/review.mjs";
import { SESSION_ENV } from "../lib/session.mjs";

const ID = "reel-01-launch";
const PROMPT_ARGS = {
  id: ID,
  name: "Acme Coffee",
  pieceDir: `pieces/${ID}`,
  brief: "C:\\Campaigns\\acme\\brief.md",
  voice: "C:\\Campaigns\\acme\\voice.md",
  checksFile: `C:\\Campaigns\\acme\\creation-out\\${ID}.checks.json`,
};
const PROMPT = reviewPrompt(PROMPT_ARGS);

const EXPECTED_ARGS = [
  "-p", "--output-format", "text", "--max-turns", "100",
  "--allowedTools", "Read", "Glob", "Grep", "Skill",
  "--disallowedTools", "WebFetch", "WebSearch", "Bash", "Edit", "Write", "NotebookEdit",
];

const RAW = {
  caption: { verdict: "READY", checks: [{ check: "hook", status: "PASS", detail: "😭 fine" }] },
  detect: { verdict: "PASS", human_score: 91, checks: [] },
  hookCaption: { verdict: "STRONG", score: 84, weakest: "specificity", flags: [] },
  detectOnScreen: { verdict: "PASS", human_score: 88, checks: [] },
  hookOnScreen: { verdict: "OK", score: 66, weakest: "curiosity", flags: [] },
};

const SHIP = {
  id: ID,
  verdict: "SHIP",
  scores: { director: 82, copy_art_ui: 78, brand: 90, forensics: 85 },
  skills: {
    caption_py: "READY",
    detect_caption: { verdict: "PASS", human_score: 91 },
    detect_onscreen: { verdict: "PASS", human_score: 88 },
    hook_caption: { verdict: "STRONG", score: 84, weakest: "specificity" },
    hook_onscreen: { verdict: "OK", score: 66, weakest: "curiosity" },
  },
  must_fix: [],
  nice_to_have: ["Hold the end card 0.3 s longer"],
  summary: "Launch reel lands; ship it.",
};

const temps = [];
after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  temps.push(dir);
  return dir;
}

// A child whose stdin is recorded; the test decides when it prints and exits.
function fakeSpawn(pid = 6160, onSpawn) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = "";
    child.stdin.on("data", (d) => { stdin += d; });
    child.stdinText = () => stdin;
    child.finish = (code, out = "", err = "") => {
      if (out) child.stdout.write(out);
      if (err) child.stderr.write(err);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => {
        child.emit("exit", code, code === null ? "SIGTERM" : null);
        child.emit("close", code, code === null ? "SIGTERM" : null);
      });
    };
    calls.push({ cmd, args, opts, child });
    onSpawn?.(child);
    return child;
  };
  return { spawn, calls };
}

test("passes the read-only tool list and the skill prompt", async () => {
  assert.deepEqual(REVIEW_ARGS, EXPECTED_ARGS);
  for (const tool of ["Bash", "Edit", "Write"]) assert.ok(!REVIEW_ARGS.slice(REVIEW_ARGS.indexOf("--allowedTools"), REVIEW_ARGS.indexOf("--disallowedTools")).some((a) => a.startsWith(tool)), `${tool} is not allowed`);
  assert.ok(!REVIEW_ARGS.includes("--permission-mode"), "default permissions: nothing is auto-accepted");
  const repo = tmpRepo();
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: repo, raw: RAW, spawn: fake.spawn, killTree: async () => assert.fail("no kill") });
  assert.equal(fake.calls.length, 1);
  const { cmd, args, opts, child } = fake.calls[0];
  assert.equal(cmd, "claude");
  assert.deepEqual(args, EXPECTED_ARGS);
  assert.equal(opts.cwd, repo);
  assert.ok(!opts.shell);
  for (const [k, v] of Object.entries(SESSION_ENV)) assert.equal(opts.env[k], v, k);
  assert.equal(opts.env.PYTHONUTF8, "1");
  assert.equal(opts.env.PYTHONIOENCODING, "utf-8");
  assert.equal(opts.env.PATH ?? opts.env.Path, process.env.PATH ?? process.env.Path, "the rest of the env is kept");
  child.finish(0, JSON.stringify(SHIP));
  await run;
  assert.equal(child.stdinText(), PROMPT);
  assert.ok(child.stdin.writableEnded);
});

test("the review prompt names the piece-review skill, the piece's folder, the campaign's brief and voice, and the checks file", () => {
  assert.equal(PROMPT, [
    `Use the piece-review skill to review piece \`${ID}\` of the "Acme Coffee" campaign.`,
    `The piece is in \`pieces/${ID}/\` under the campaign folder.`,
    "Judge it against this campaign's brief, `C:\\Campaigns\\acme\\brief.md`, and its brand voice, `C:\\Campaigns\\acme\\voice.md`.",
    `The skill scripts' JSON is in \`C:\\Campaigns\\acme\\creation-out\\${ID}.checks.json\`.`,
    "Reply with only its JSON.",
  ].join(" "));
  const slashed = reviewPrompt({ ...PROMPT_ARGS, pieceDir: `content/reels/${ID}/` });
  assert.ok(slashed.includes(`The piece is in \`content/reels/${ID}/\` under`), "a folder given with its slash keeps one");
});

test("a review with no prompt is refused before anything is written or spawned", async () => {
  const repo = tmpRepo();
  const fake = fakeSpawn();
  await assert.rejects(runReview({ entryId: ID, cwd: repo, raw: RAW, spawn: fake.spawn, killTree: async () => {} }), /no review prompt/);
  assert.equal(fake.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(repo, "creation-out")));
});

test("writes the raw script JSON to creation-out/<id>.checks.json before spawning", async () => {
  const repo = tmpRepo();
  const file = path.join(repo, "creation-out", `${ID}.checks.json`);
  let seenAtSpawn;
  const fake = fakeSpawn(6161, () => { seenAtSpawn = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; });
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: repo, raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(0, JSON.stringify(SHIP));
  await run;
  assert.ok(seenAtSpawn, "the file exists when claude starts");
  assert.deepEqual(seenAtSpawn, {
    id: ID,
    env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    caption_py: RAW.caption,
    detect_caption: RAW.detect,
    detect_onscreen: RAW.detectOnScreen,
    hook_caption: RAW.hookCaption,
    hook_onscreen: RAW.hookOnScreen,
  });
  assert.match(fs.readFileSync(file, "utf8"), /😭/, "written as UTF-8");
});

test("a script that returned no JSON is written as null", async () => {
  const repo = tmpRepo();
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: repo, raw: { caption: RAW.caption, detect: null }, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(0, JSON.stringify(SHIP));
  await run;
  const written = JSON.parse(fs.readFileSync(path.join(repo, "creation-out", `${ID}.checks.json`), "utf8"));
  assert.equal(written.detect_caption, null);
  assert.equal(written.hook_onscreen, null);
  assert.deepEqual(written.caption_py, RAW.caption);
});

test("parses a SHIP verdict", async () => {
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  const chatter = `Reviewing {id} now.\n\n\`\`\`json\n${JSON.stringify({ verdict: "FIX", must_fix: ["draft"] })}\n\`\`\`\nFinal:\n\`\`\`json\n${JSON.stringify(SHIP, null, 2)}\n\`\`\`\n`;
  fake.calls[0].child.finish(0, chatter);
  const res = await run;
  assert.deepEqual(res, {
    verdict: "SHIP",
    scores: SHIP.scores,
    skills: SHIP.skills,
    must_fix: [],
    nice_to_have: SHIP.nice_to_have,
    summary: SHIP.summary,
  });
});

test("parses a FIX verdict with its must-fix items", async () => {
  const fix = { ...SHIP, verdict: "FIX", must_fix: ["Scene 3 at 7.2 s: caption overlaps the notch; move it up 80 px"], summary: "Caption clips." };
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(0, JSON.stringify(fix));
  const res = await run;
  assert.equal(res.verdict, "FIX");
  assert.deepEqual(res.must_fix, fix.must_fix);
});

test("SHIP with must-fix items is not softened: it becomes FIX", async () => {
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(0, JSON.stringify({ ...SHIP, must_fix: ["detect.py on screen: FLAGGED"] }));
  const res = await run;
  assert.equal(res.verdict, "FIX");
  assert.deepEqual(res.must_fix, ["detect.py on screen: FLAGGED"]);
});

test("garbage output becomes FIX with a reason", async () => {
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(0, "I looked at it and it seems { fine, mostly\n");
  const res = await run;
  assert.equal(res.verdict, "FIX");
  assert.equal(res.must_fix.length, 1);
  assert.match(res.must_fix[0], /^review did not complete: /);
  assert.match(res.must_fix[0], /no JSON verdict/);
  assert.deepEqual(res.nice_to_have, []);
  assert.match(res.summary, /review did not complete/);
});

test("JSON without a SHIP or FIX verdict becomes FIX", async () => {
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(0, JSON.stringify({ ...SHIP, verdict: "SHIP | FIX" }));
  const res = await run;
  assert.equal(res.verdict, "FIX");
  assert.match(res.must_fix[0], /^review did not complete: /);
});

test("non-zero exit becomes FIX with the exit code and last line", async () => {
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(1, "", "usage limit reached\n");
  const res = await run;
  assert.equal(res.verdict, "FIX");
  assert.match(res.must_fix[0], /^review did not complete: claude exited 1: usage limit reached$/);
});

test("a spawn error becomes FIX", async () => {
  const fake = fakeSpawn();
  const run = runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
  const res = await run;
  assert.equal(res.verdict, "FIX");
  assert.match(res.must_fix[0], /ENOENT/);
});

test("timeout kills the tree and becomes FIX", async () => {
  const killed = [];
  const fake = fakeSpawn(888);
  const killTree = async (pid) => {
    killed.push(pid);
    fake.calls[0].child.finish(null, JSON.stringify(SHIP));
  };
  const res = await runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, timeoutMs: 30, spawn: fake.spawn, killTree });
  assert.deepEqual(killed, [888]);
  assert.equal(res.verdict, "FIX", "a timed-out review never ships, whatever it printed");
  assert.match(res.must_fix[0], /^review did not complete: timed out/);
});

test("timeout still returns when the killed child never closes", async () => {
  const killed = [];
  const fake = fakeSpawn(889);
  const res = await runReview({ entryId: ID, prompt: PROMPT, cwd: tmpRepo(), raw: RAW, timeoutMs: 20, graceMs: 20, spawn: fake.spawn, killTree: async (pid) => { killed.push(pid); } });
  assert.deepEqual(killed, [889]);
  assert.equal(res.verdict, "FIX");
});

test("an unsafe id is refused before anything is written or spawned", async () => {
  const repo = tmpRepo();
  const fake = fakeSpawn();
  await assert.rejects(runReview({ entryId: "../../evil", cwd: repo, raw: RAW, spawn: fake.spawn, killTree: async () => {} }), /bad piece id/);
  assert.equal(fake.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(repo, "creation-out")));
});

test("lastJsonObject takes the last parseable object and skips braces in prose and strings", () => {
  assert.deepEqual(lastJsonObject('a {x} b {"a":1} c {"b":"}{"} d'), { b: "}{" });
  assert.deepEqual(lastJsonObject('{"outer":{"inner":2}}'), { outer: { inner: 2 } });
  assert.equal(lastJsonObject("no json here { at all"), null);
  assert.equal(lastJsonObject('["array", "only"]'), null);
});

test("a parsed review is written to creation-out/<id>.review.json beside the checks; one that didn't complete removes the old file", async () => {
  const repo = tmpRepo();
  const file = path.join(repo, "creation-out", `${ID}.review.json`);
  const fix = { ...SHIP, verdict: "FIX", must_fix: ["<img src=x onerror=alert(1)>"], summary: "Caption clips." };
  let fake = fakeSpawn();
  let run = runReview({ entryId: ID, prompt: PROMPT, cwd: repo, raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(0, JSON.stringify(fix));
  const res = await run;
  assert.ok(fs.existsSync(path.join(repo, "creation-out", `${ID}.checks.json`)));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), res);
  assert.deepEqual(Object.keys(res), ["verdict", "scores", "skills", "must_fix", "nice_to_have", "summary"]);

  fake = fakeSpawn();
  run = runReview({ entryId: ID, prompt: PROMPT, cwd: repo, raw: RAW, spawn: fake.spawn, killTree: async () => {} });
  fake.calls[0].child.finish(1, "", "usage limit\n");
  assert.match((await run).must_fix[0], /review did not complete/);
  assert.equal(fs.existsSync(file), false, "no stale verdict is left beside the new checks");
});
