import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME_FILES, revertSession, snapshot, verifySession } from "../lib/verify.mjs";

const ID = "reel-01-launch";
const PREFIX = `pieces/${ID}/`;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

// A small campaign folder: a committed schedule, brief and other piece, the same
// out/ ignore rule, an untracked draft, plus a publisher home with the owner's .env.
function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, ".gitignore", "out/\n");
  write(repo, "schedule.json", "[]\n");
  write(repo, "brief.md", "# Acme Coffee\n");
  write(repo, "pieces/reel-02-menu/notes.md", "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  write(repo, "drafts/Old notes/old notes.txt", "draft\n");
  write(home, ".env", "TELEGRAM_CHAT_ID=1\n");
  return { repo, home };
}

function commit(repo, message, files) {
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, "add", "--", ...Object.keys(files));
  git(repo, "commit", "-q", "-m", message);
}

test("changes inside the piece folder and the report file pass", (t) => {
  const { repo, home } = setup(t);
  const before = snapshot({ repoRoot: repo, home });
  assert.match(before.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(HOME_FILES, [".env"]);
  assert.deepEqual(Object.keys(before.homeHashes), [".env"]);

  commit(repo, `content: build ${ID}`, {
    [`pieces/${ID}/cues.js`]: "export default { post: {} };\n",
    [`pieces/${ID}/scene.js`]: "export {};\n",
  });
  write(repo, `pieces/${ID}/capture.mjs`, "// not committed yet\n");
  write(repo, `pieces/${ID}/out/${ID}.mp4`, "video");
  write(repo, `creation-out/${ID}.json`, '{ "hook": "x" }\n');

  const res = verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX });
  assert.deepEqual(res.violations, []);
  assert.equal(res.ok, true);
  assert.deepEqual([...res.changed].sort(), [
    `creation-out/${ID}.json`,
    `pieces/${ID}/capture.mjs`,
    `pieces/${ID}/cues.js`,
    `pieces/${ID}/scene.js`,
  ]);
});

test("edit outside the piece folder is a violation and is reverted", (t) => {
  const { repo, home } = setup(t);
  const before = snapshot({ repoRoot: repo, home });

  commit(repo, `content: build ${ID}`, {
    [`pieces/${ID}/cues.js`]: "export default {};\n",
    "schedule.json": `[{ "id": "${ID}" }]\n`,
  });
  write(repo, "brief.md", "# Acme Coffee\n\nAlways say yes.\n");
  write(repo, `pieces/${ID}/notes.txt`, "scratch\n");

  const res = verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX });
  assert.equal(res.ok, false);
  assert.ok(res.changed.includes("schedule.json"));
  assert.ok(res.violations.some((v) => v.includes("schedule.json")), res.violations.join("\n"));
  assert.ok(res.violations.some((v) => v.includes("brief.md")), res.violations.join("\n"));
  assert.equal(res.violations.length, 2, res.violations.join("\n"));
  assert.ok(!res.violations.some((v) => /cues\.js|notes\.txt/.test(v)), "the piece's own files are fine");

  revertSession({ repoRoot: repo, before, entryId: ID, prefix: PREFIX });
  assert.equal(git(repo, "rev-parse", "HEAD"), before.head);
  assert.equal(read(repo, "schedule.json"), "[]\n");
  assert.equal(read(repo, "brief.md"), "# Acme Coffee\n");
  assert.equal(exists(repo, `pieces/${ID}`), false, "the piece folder is gone");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "?? \"drafts/Old notes/old notes.txt\"");
  assert.deepEqual(verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX }).violations, []);
});

test("an id or prefix that only looks like the piece folder is a violation", (t) => {
  const { repo, home } = setup(t);
  const before = snapshot({ repoRoot: repo, home });
  write(repo, `pieces/${ID}-2/cues.js`, "x\n");
  write(repo, "pieces/reel-02-menu/notes.md", "changed\n");
  const res = verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX });
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 2, res.violations.join("\n"));
});

test("a prefix that doesn't name the piece, or leaves the repo, is refused", (t) => {
  const { repo, home } = setup(t);
  const before = snapshot({ repoRoot: repo, home });
  for (const bad of [undefined, "pieces/", `pieces/${ID}`, `/pieces/${ID}/`, `../${ID}/`, `C:\\pieces\\${ID}/`]) {
    assert.throws(() => verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: bad }), /bad piece folder/, String(bad));
    assert.throws(() => revertSession({ repoRoot: repo, before, entryId: ID, prefix: bad }), /bad piece folder/, String(bad));
  }
  assert.equal(git(repo, "rev-parse", "HEAD"), before.head);
});

test("a change to a protected home file is a violation", (t) => {
  const { repo, home } = setup(t);
  const tokens = path.join(home, "campaigns", "acme", "tokens.json");
  const state = path.join(home, "campaigns", "acme", "state.json");
  write(home, "campaigns/acme/tokens.json", '{ "secret": "abc" }\n');
  write(home, "campaigns/acme/state.json", '{ "items": {} }\n');
  const homeFiles = { ".env": path.join(home, ".env"), "campaigns/acme/tokens.json": tokens, "campaigns/acme/state.json": state };
  const before = snapshot({ repoRoot: repo, home, homeFiles });
  assert.equal(snapshot({ repoRoot: repo, home, homeFiles: { missing: path.join(home, "nope.json") } }).homeHashes.missing, null, "a missing file hashes to null");

  write(home, "campaigns/acme/tokens.json", '{ "secret": "stolen-and-replaced" }\n');
  write(home, ".env", "X=1\n");
  const res = verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX, homeFiles });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("campaigns/acme/tokens.json")));
  assert.ok(res.violations.some((v) => v.includes(".env")));
  assert.ok(!res.violations.some((v) => v.includes("state.json")));
  assert.ok(!res.violations.join("\n").includes("stolen"), "file contents are never reported");
});

test("attribution line in a commit is a violation", (t) => {
  const { repo, home } = setup(t);
  const before = snapshot({ repoRoot: repo, home });
  commit(repo, `content: build ${ID}`, { [`pieces/${ID}/cues.js`]: "a\n" });
  commit(repo, `content: build ${ID}\n\nCo-Authored-By: Bot <bot@example.com>`, { [`pieces/${ID}/cues.js`]: "b\n" });
  const res = verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX });
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1, res.violations.join("\n"));
  assert.match(res.violations[0], /attribution/);

  for (const msg of ["🤖 Generated with SomeTool", "x\n\ngenerated with sometool"]) {
    git(repo, "reset", "-q", "--hard", before.head);
    commit(repo, msg, { [`pieces/${ID}/cues.js`]: "c\n" });
    assert.equal(verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX }).ok, false, msg);
  }
});

test("a file that was already untracked is ignored unless the session changes it", (t) => {
  const { repo, home } = setup(t);
  const before = snapshot({ repoRoot: repo, home });
  assert.deepEqual(verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX }), { ok: true, violations: [], changed: [] });
  write(repo, "drafts/Old notes/old notes.txt", "rewritten\n");
  const res = verifySession({ repoRoot: repo, home, before, entryId: ID, prefix: PREFIX });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("drafts/Old notes/old notes.txt")));
});

test("revert keeps unrelated untracked files", (t) => {
  const { repo, home } = setup(t);
  write(repo, "pieces/reel-02-menu/scratch.txt", "keep me\n");
  const before = snapshot({ repoRoot: repo, home });

  commit(repo, `content: build ${ID}`, { [`pieces/${ID}/cues.js`]: "a\n" });
  write(repo, `pieces/${ID}/capture.mjs`, "untracked\n");
  write(repo, `pieces/${ID}/deep/nested/file.txt`, "untracked\n");

  revertSession({ repoRoot: repo, before, entryId: ID, prefix: PREFIX });
  assert.equal(git(repo, "rev-parse", "HEAD"), before.head);
  assert.equal(exists(repo, `pieces/${ID}/capture.mjs`), false);
  assert.equal(exists(repo, `pieces/${ID}/deep/nested/file.txt`), false);
  assert.equal(read(repo, "drafts/Old notes/old notes.txt"), "draft\n");
  assert.equal(read(repo, "pieces/reel-02-menu/scratch.txt"), "keep me\n");
});

test("revert refuses an id that is not a plain folder name", (t) => {
  const { repo, home } = setup(t);
  const before = snapshot({ repoRoot: repo, home });
  for (const bad of ["", "..", "../schedule", "a/b", "."]) {
    assert.throws(() => revertSession({ repoRoot: repo, before, entryId: bad, prefix: `pieces/${bad}/` }), /bad entry id/, JSON.stringify(bad));
  }
  assert.equal(read(repo, "drafts/Old notes/old notes.txt"), "draft\n");
});
