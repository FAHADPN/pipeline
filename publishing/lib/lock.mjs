// One writer at a time. A lock is the file <home>/locks/<name>.lock holding
// { pid, at }, created exclusively. "publish" covers anything that posts or writes
// state.json; "schedule" covers anything that writes schedule.json.
// A campaign's locks are named <campaignId>:<name> (e.g. "acme:publish") and
// their file is <campaignId>.<name>.lock, since ":" isn't allowed in a Windows
// file name.

import fs from "node:fs";
import path from "node:path";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME_RE = /^(?:[a-z0-9-]+:)?[a-z0-9-]+$/;

function lockFileName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`bad lock name ${JSON.stringify(name)}`);
  return `${name.replace(":", ".")}.lock`;
}

// The file that exists while lock `name` in `home` is held.
export const lockPath = (home, name) => path.join(home, "locks", lockFileName(name));

// When the lock was taken, in ms. A file still being written, or garbled, falls
// back to its mtime, so a crash mid-write still goes stale.
function takenAt(file) {
  try {
    const at = Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).at);
    if (!Number.isNaN(at)) return at;
  } catch {
    // Fall through to the mtime.
  }
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined; // Released while we looked.
  }
}

function tryCreate(file, content) {
  try {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
}

const DEFAULT_STALE_MS = 7200000;

// The pid recorded in a lock file, or undefined (an older lock, or one being written).
function holderPid(file) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

// Whether process `pid` is running on this machine. EPERM means it is, but isn't ours.
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// True while lock `name` in `home` is held: its file exists, isn't older than
// `staleMs` (the age past which withLock takes it over), and the process it names is
// still running. A lock with no pid goes by its age alone. Takes nothing.
export function lockHeld(home, name, { staleMs = DEFAULT_STALE_MS, now = Date.now, alive = pidAlive } = {}) {
  const file = lockPath(home, name);
  const at = takenAt(file);
  if (at === undefined || +now() - at > staleMs) return false;
  const pid = holderPid(file);
  return pid === undefined || alive(pid);
}

// Whether process `pid` is known to be gone: process.kill(pid, 0) fails with ESRCH.
// Any other failure (EPERM: running, not ours) leaves it alive.
function pidGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

// The dead holder's pid when lock `file` (as `raw`) names a process that is gone, else
// undefined. A lock with no pid isn't judged here: its age decides.
function deadHolder(file, raw) {
  let pid;
  try {
    pid = JSON.parse(raw).pid;
  } catch {
    return undefined; // Still being written.
  }
  if (!Number.isInteger(pid) || pid <= 0 || !pidGone(pid)) return undefined;
  // Still the same lock: not released and retaken while we looked.
  let now;
  try {
    now = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return now === raw ? pid : undefined;
}

// `now` returns ms or a Date. With `takeoverDeadPid`, a lock whose recorded process is
// gone is taken over at once (and logged to `log`) instead of being waited on until it
// goes stale. Only the creation lock asks for it: a crashed build must not block.
export async function withLock(home, name, fn, { waitMs = 600000, staleMs = DEFAULT_STALE_MS, pollMs = 1000, now = Date.now, sleep = defaultSleep, takeoverDeadPid = false, log } = {}) {
  const file = lockPath(home, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const start = +now();
  let content;
  for (;;) {
    content = JSON.stringify({ pid: process.pid, at: new Date(+now()).toISOString() });
    if (tryCreate(file, content)) break;
    const at = takenAt(file);
    if (at === undefined) continue;
    if (+now() - at > staleMs) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (takeoverDeadPid) {
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue; // Released while we looked.
      }
      const pid = deadHolder(file, raw);
      if (pid !== undefined) {
        log?.info("lock taken over from a dead process", { name, pid });
        fs.rmSync(file, { force: true });
        continue;
      }
    }
    if (+now() - start >= waitMs) {
      // The code tells a lock held by someone else from a lock file that can't be used.
      const busy = new Error(`lock ${name} busy`);
      busy.code = "ELOCKBUSY";
      throw busy;
    }
    await sleep(pollMs);
  }

  try {
    return await fn();
  } finally {
    // Only remove our own lock: if this ran past staleMs, someone else may hold it now.
    let current;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      // Already gone.
    }
    if (current === content) fs.rmSync(file, { force: true });
  }
}
