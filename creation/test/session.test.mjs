import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CLAUDE_ARGS, SESSION_ENV, runSession } from "../lib/session.mjs";

const EXPECTED_ARGS = [
  "-p", "--permission-mode", "acceptEdits", "--output-format", "text", "--max-turns", "200",
  "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Skill",
  "Bash(node:*)", "Bash(python:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)",
  "Bash(git diff:*)", "Bash(ls:*)", "Bash(mkdir:*)",
  "--disallowedTools", "WebFetch", "WebSearch", "Bash(git push:*)", "Bash(curl:*)", "Bash(schtasks:*)",
];

// A child whose stdin is recorded; the test decides when it prints and exits.
function fakeSpawn(pid = 5150) {
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
    return child;
  };
  return { spawn, calls };
}

test("passes the exact argument list and stdin", async () => {
  assert.deepEqual(CLAUDE_ARGS, EXPECTED_ARGS);
  const fake = fakeSpawn();
  const killed = [];
  const run = runSession({ prompt: "Build reel-09.\nWork only in pieces/reel-09/.", cwd: "C:\\repo", spawn: fake.spawn, killTree: async (pid) => killed.push(pid) });
  assert.equal(fake.calls.length, 1);
  const { cmd, args, opts, child } = fake.calls[0];
  assert.equal(cmd, "claude");
  assert.deepEqual(args, EXPECTED_ARGS);
  assert.equal(opts.cwd, "C:\\repo");
  assert.ok(!opts.shell, "no shell, so Bash(node:*) and the rest reach claude as written");
  child.finish(0, "built reel-09\n");
  const res = await run;
  assert.equal(child.stdinText(), "Build reel-09.\nWork only in pieces/reel-09/.");
  assert.ok(child.stdin.writableEnded, "stdin is closed after the prompt");
  assert.deepEqual(res, { code: 0, output: "built reel-09\n", timedOut: false });
  assert.deepEqual(killed, []);
});

test("session env adds UTF-8 python and keeps the rest of this process's env", async (t) => {
  assert.deepEqual(SESSION_ENV, { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  // The user's own settings, like the ffmpeg the renders use, pass through.
  const saved = process.env.FFMPEG_BIN;
  process.env.FFMPEG_BIN = "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe";
  t.after(() => {
    if (saved === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = saved;
  });
  const fake = fakeSpawn();
  const run = runSession({ prompt: "p", cwd: "C:\\repo", spawn: fake.spawn, killTree: async () => {} });
  const { env } = fake.calls[0].opts;
  assert.ok(env, "claude gets an env");
  for (const [k, v] of Object.entries(SESSION_ENV)) assert.equal(env[k], v, k);
  assert.equal(env.FFMPEG_BIN, "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe");
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path, "the rest of the env is kept");
  fake.calls[0].child.finish(0);
  await run;
});

test("timeout kills the process tree", async () => {
  const fake = fakeSpawn(777);
  const killed = [];
  const killTree = async (pid) => {
    killed.push(pid);
    fake.calls[0].child.finish(null, "", "killed\n");
  };
  const res = await runSession({ prompt: "p", cwd: "C:\\repo", timeoutMs: 30, spawn: fake.spawn, killTree });
  assert.deepEqual(killed, [777]);
  assert.equal(res.timedOut, true);
  assert.equal(res.code, null);
  assert.match(res.output, /killed/);
});

test("timeout still returns when the killed child never closes", async () => {
  const fake = fakeSpawn(778);
  const killed = [];
  const res = await runSession({ prompt: "p", cwd: "C:\\repo", timeoutMs: 20, graceMs: 20, spawn: fake.spawn, killTree: async (pid) => { killed.push(pid); } });
  assert.deepEqual(killed, [778]);
  assert.equal(res.timedOut, true);
  assert.equal(res.code, null);
});

test("a failing killTree does not throw", async () => {
  const fake = fakeSpawn(779);
  const res = await runSession({
    prompt: "p", cwd: "C:\\repo", timeoutMs: 20, graceMs: 20, spawn: fake.spawn,
    killTree: async () => { throw new Error("taskkill failed"); },
  });
  assert.equal(res.timedOut, true);
});

test("non-zero exit is returned, not thrown", async () => {
  const fake = fakeSpawn();
  const run = runSession({ prompt: "p", cwd: "C:\\repo", spawn: fake.spawn, killTree: async () => assert.fail("no kill") });
  fake.calls[0].child.finish(1, "usage limit reached\n", "error: limit\n");
  const res = await run;
  assert.equal(res.code, 1);
  assert.equal(res.timedOut, false);
  assert.match(res.output, /usage limit reached/);
  assert.match(res.output, /error: limit/);
});

test("a spawn error is returned, not thrown", async () => {
  const fake = fakeSpawn();
  const run = runSession({ prompt: "p", cwd: "C:\\repo", spawn: fake.spawn, killTree: async () => {} });
  const { child } = fake.calls[0];
  child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
  const res = await run;
  assert.equal(res.code, null);
  assert.equal(res.timedOut, false);
  assert.match(res.output, /ENOENT/);
});
