// After every build session: did it touch only its own piece? A session runs as the
// user's Windows account, so the tool allowlist alone isn't a hard wall.
//
// snapshot() is taken before the session: HEAD, SHA-256 hashes of the publisher
// home's secrets, and the hash of every path that was already dirty (like an
// untracked "drafts/notes/"), so those don't count against the session unless it
// changes them. verifySession() lists what the session changed and every rule it
// broke. revertSession() resets to the old HEAD and deletes untracked files in the
// piece folder only; it never cleans the whole repo.
//
// git(args, cwd) returns stdout and throws on a non-zero exit, like execFileSync.
//
// The campaign passes its rules (campaign-deps.mjs): `prefix` is the piece folder
// (relative to the repo, with a trailing slash), `ownFile` the session's report file
// (creation-out/<id>.json when left out), and `homeFiles` the files outside the repo
// no session may change, as { label: absolute path } (HOME_FILES in `home` when left
// out).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OUT_DIR } from "./constants.mjs";

// The owner's .env in the publisher home.
export const HOME_FILES = [".env"];
export const ATTRIBUTION = /co-authored-by|generated with|🤖/i;

const defaultGit = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

// Ids are folder names like reel-01-launch; anything else could point outside the piece.
const ID = /^[a-z0-9][a-z0-9-]*$/i;

function pieceDir(entryId, prefix) {
  if (typeof entryId !== "string" || !ID.test(entryId)) throw new Error(`bad entry id ${JSON.stringify(entryId)}`);
  const bad = typeof prefix !== "string" || !prefix.includes(entryId) || !prefix.endsWith("/")
    || path.isAbsolute(prefix) || /^[\\/]/.test(prefix) || prefix.split(/[\\/]/).includes("..");
  if (bad) {
    throw new Error(`bad piece folder ${JSON.stringify(prefix)} for ${entryId}`);
  }
  return prefix;
}

const defaultHomeFiles = (home) => Object.fromEntries(HOME_FILES.map((f) => [f, path.join(home, f)]));

function hashFile(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null; // missing, or a directory
  }
}

// `git status --porcelain -z`: "XY path\0", with the old path as an extra entry after
// renames and copies. -z leaves paths unquoted, so spaces come through as they are.
function dirtyPaths(git, repoRoot) {
  const parts = git(["status", "--porcelain", "-z", "--untracked-files=all"], repoRoot).split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(parts[++i]);
  }
  return paths;
}

const lines = (out) => out.split(/\r?\n/).filter(Boolean);

export function snapshot({ repoRoot, home, git = defaultGit, homeFiles = defaultHomeFiles(home) }) {
  const head = git(["rev-parse", "HEAD"], repoRoot).trim();
  const homeHashes = Object.fromEntries(Object.entries(homeFiles).map(([label, file]) => [label, hashFile(file)]));
  const dirty = Object.fromEntries(dirtyPaths(git, repoRoot).map((p) => [p, hashFile(path.join(repoRoot, p))]));
  return { head, homeHashes, dirty };
}

export function verifySession({
  repoRoot,
  home,
  before,
  entryId,
  git = defaultGit,
  prefix,
  ownFile = `${OUT_DIR}/${entryId}.json`,
  homeFiles = defaultHomeFiles(home),
}) {
  const dir = pieceDir(entryId, prefix);
  const own = ownFile;
  const violations = [];

  const committed = lines(git(["diff", "--name-only", before.head, "HEAD"], repoRoot));
  const dirty = dirtyPaths(git, repoRoot).filter(
    (p) => !(p in (before.dirty ?? {})) || before.dirty[p] !== hashFile(path.join(repoRoot, p)),
  );
  const changed = [...new Set([...committed, ...dirty])];

  for (const p of changed) {
    if (!p.startsWith(dir) && p !== own) violations.push(`changed outside ${dir}: ${p}`);
  }

  for (const [label, file] of Object.entries(homeFiles)) {
    if (hashFile(file) !== before.homeHashes[label]) violations.push(`publisher home file changed: ${label}`);
  }

  // %x1e ends each commit, so a message with blank lines stays in one piece.
  const log = git(["log", "--format=%h%n%B%x1e", `${before.head}..HEAD`], repoRoot);
  for (const commit of log.split("\x1e")) {
    const [hash, ...body] = commit.trim().split("\n");
    if (hash && ATTRIBUTION.test(body.join("\n"))) violations.push(`commit ${hash} has an AI attribution line`);
  }

  return { ok: violations.length === 0, violations, changed };
}

export function revertSession({ repoRoot, before, entryId, git = defaultGit, prefix }) {
  const dir = pieceDir(entryId, prefix);
  git(["reset", "-q", "--hard", before.head], repoRoot);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", dir], repoRoot).split("\0").filter(Boolean);
  for (const rel of untracked) {
    if (rel.startsWith(dir)) fs.rmSync(path.join(repoRoot, rel), { force: true });
  }
  removeEmptyDirs(path.join(repoRoot, dir));
}

// Bottom-up, so a folder left with only empty subfolders goes too.
function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
