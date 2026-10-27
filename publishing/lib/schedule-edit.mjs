// One committed edit of a campaign's JSON list, the way an approval writes one
// (creation/lib/approval.mjs): read the file, apply `change`, check the result with
// `validate`, write it atomically keeping its line endings, then
// `git add` and `git commit -q -m <message> -- <file>`. Any failure puts the file and
// the index back as they were. The caller holds the campaign's "schedule" lock.
// editSchedule is that for schedule.json; the build list's editor
// (dashboard/lib/backlog-actions.mjs) uses editJsonFile with its own validator and layout.
//
// change(items) returns the new items, or throws an Error whose message is the refusal.
// validate(items) returns a list of problems, `what` names the file in the refusals.
// Returns { ok: true } or { ok: false, error }; a change that leaves the file as it was
// is ok and commits nothing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateSchedule } from "./schedule.mjs";
import { formatSchedule } from "../../creation/lib/insert.mjs";

// A git that hangs (a credential prompt, a stuck index lock) fails instead of holding the lock.
const GIT_TIMEOUT_MS = 30000;
const defaultGit = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: GIT_TIMEOUT_MS });

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function editJsonFile({ root, file: relFile, git = defaultGit, message, change, validate, format, what }) {
  const file = path.join(root, relFile);
  let original;
  let next;
  try {
    original = fs.readFileSync(file, "utf8");
    next = change(JSON.parse(original.replace(/^﻿/, "")));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const errors = validate(next);
  if (errors.length) return { ok: false, error: `the ${what} would be invalid: ${errors.join("; ")}` };

  let text = format(next);
  if (original.includes("\r\n")) text = text.replace(/\n/g, "\r\n");
  // Nothing to commit (a reorder to where the item already is): git would refuse.
  if (text === original) return { ok: true };
  writeAtomic(file, text);
  try {
    git(["add", "--", relFile], root);
    // The pathspec keeps anything else that happens to be staged out of this commit.
    git(["commit", "-q", "-m", message, "--", relFile], root);
  } catch (err) {
    writeAtomic(file, original);
    try {
      git(["reset", "-q", "--", relFile], root);
    } catch {
      // The file is back; a stale index entry is harmless.
    }
    return { ok: false, error: `couldn't commit the ${what}, left it unchanged: ${err.message}` };
  }
  return { ok: true };
}

export function editSchedule({ root, scheduleFile, git, message, change }) {
  return editJsonFile({
    root,
    file: scheduleFile,
    git,
    message,
    change,
    validate: (items) => validateSchedule(items, root),
    format: formatSchedule,
    what: "schedule",
  });
}
