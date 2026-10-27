import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockHeld, pidAlive, withLock } from "../lib/lock.mjs";

function freshHome() {
  process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  return process.env.PIPELINE_HOME;
}

const lockFile = (home, name) => path.join(home, "locks", `${name}.lock`);

// A clock that only moves when the lock sleeps.
function fakeClock(start = Date.parse("2026-10-25T14:00:00Z")) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("runs fn and removes the lock", async () => {
  const home = freshHome();
  let seen;
  const result = await withLock(home, "publish", async () => {
    seen = JSON.parse(fs.readFileSync(lockFile(home, "publish"), "utf8"));
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(seen.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(seen.at)), seen.at);
  assert.equal(fs.existsSync(lockFile(home, "publish")), false);
});

test("second withLock waits, stale lock is taken over", async () => {
  const home = freshHome();
  const order = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const first = withLock(home, "publish", async () => {
    order.push("first start");
    await held;
    order.push("first end");
  });
  const second = withLock(home, "publish", async () => order.push("second"), { pollMs: 5 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(order, ["first start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first start", "first end", "second"]);

  // A lock left behind by a crashed run, three hours old.
  const clock = fakeClock();
  fs.writeFileSync(lockFile(home, "publish"), JSON.stringify({ pid: 999999, at: new Date(clock.now() - 3 * 3600000).toISOString() }));
  let slept = 0;
  const ran = await withLock(home, "publish", async () => "took over", { now: clock.now, sleep: async () => { slept++; } });
  assert.equal(ran, "took over");
  assert.equal(slept, 0);
  assert.equal(fs.existsSync(lockFile(home, "publish")), false);
});

test("waitMs exceeded throws lock busy", async () => {
  const home = freshHome();
  const clock = fakeClock();
  fs.mkdirSync(path.join(home, "locks"));
  const held = JSON.stringify({ pid: 999999, at: new Date(clock.now()).toISOString() });
  fs.writeFileSync(lockFile(home, "publish"), held);
  let ran = false;
  await assert.rejects(
    withLock(home, "publish", async () => { ran = true; }, { waitMs: 3000, pollMs: 1000, now: clock.now, sleep: clock.sleep }),
    (err) => err.message === "lock publish busy" && err.code === "ELOCKBUSY",
  );
  // A lock that can't be made at all isn't busy: no ELOCKBUSY.
  const blocked = freshHome();
  fs.writeFileSync(path.join(blocked, "locks"), "a file where the locks folder goes");
  await assert.rejects(withLock(blocked, "publish", async () => {}), (err) => err.code !== "ELOCKBUSY");
  assert.equal(ran, false);
  // The other holder's lock is left alone.
  assert.equal(fs.readFileSync(lockFile(home, "publish"), "utf8"), held);
});

test("released when fn throws", async () => {
  const home = freshHome();
  await assert.rejects(withLock(home, "schedule", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(lockFile(home, "schedule")), false);
  // And the next caller gets it straight away.
  assert.equal(await withLock(home, "schedule", async () => "next", { waitMs: 0 }), "next");
});

test("a campaign lock name gets a file name Windows accepts", async () => {
  const home = freshHome();
  const file = path.join(home, "locks", "acme.publish.lock");
  const result = await withLock(home, "acme:publish", async () => {
    // A ":" in the file name would be an NTFS alternate data stream.
    assert.deepEqual(fs.readdirSync(path.join(home, "locks")), ["acme.publish.lock"]);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
    await assert.rejects(withLock(home, "acme:publish", async () => {}, { waitMs: 0 }), /lock acme:publish busy/);
    // An unprefixed lock of the same name is a different file.
    return withLock(home, "publish", async () => "both", { waitMs: 0 });
  });
  assert.equal(result, "both");
  assert.deepEqual(fs.readdirSync(path.join(home, "locks")), []);
});

test("a lock name that could leave locks/ is refused", async () => {
  const home = freshHome();
  for (const bad of ["../publish", "a/b", "a\\b", "Publish", "a:b:c", ":publish", "acme:", "", undefined]) {
    let ran = false;
    await assert.rejects(withLock(home, bad, async () => { ran = true; }), /bad lock name/);
    assert.equal(ran, false);
  }
  assert.equal(fs.existsSync(path.join(home, "publish.lock")), false);
});

test("lockHeld: a lock whose process is gone isn't held; a live one is, until it goes stale", () => {
  const home = freshHome();
  const hold = (content) => {
    fs.mkdirSync(path.join(home, "locks"), { recursive: true });
    fs.writeFileSync(lockFile(home, "creation"), JSON.stringify(content));
  };
  const at = new Date().toISOString();
  const alive = (pid) => pid === process.pid;

  assert.equal(lockHeld(home, "creation", { alive }), false, "no lock file");
  hold({ pid: process.pid, at });
  assert.equal(lockHeld(home, "creation", { alive }), true);
  assert.equal(lockHeld(home, "creation", { alive, staleMs: 1000, now: () => Date.now() + 2000 }), false, "stale");
  hold({ pid: 4242, at });
  assert.equal(lockHeld(home, "creation", { alive }), false, "its process is gone");
  // A lock written before pids were recorded goes by its age alone.
  hold({ at });
  assert.equal(lockHeld(home, "creation", { alive }), true);
});

test("withLock takeoverDeadPid: takes over a lock whose pid is dead; leaves a live-pid lock alone; a lock without a pid keeps the age rule", async () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, "locks"));
  const hold = (content) => fs.writeFileSync(lockFile(home, "creation"), JSON.stringify(content));
  const clock = fakeClock();
  const at = new Date(clock.now()).toISOString();
  const logged = [];
  const log = { info: (msg, data) => logged.push([msg, data]) };
  const options = { takeoverDeadPid: true, log, waitMs: 3000, pollMs: 1000, now: clock.now, sleep: clock.sleep };

  // Its process is gone: taken over at once, no waiting, and logged.
  const DEAD = 2 ** 30;
  hold({ pid: DEAD, at });
  const start = clock.now();
  assert.equal(await withLock(home, "creation", async () => {
    assert.equal(JSON.parse(fs.readFileSync(lockFile(home, "creation"), "utf8")).pid, process.pid);
    return "took over";
  }, options), "took over");
  assert.equal(clock.now(), start, "no wait");
  assert.deepEqual(logged, [["lock taken over from a dead process", { name: "creation", pid: DEAD }]]);
  assert.equal(fs.existsSync(lockFile(home, "creation")), false);

  // Without the option, the same lock is waited on until it goes stale.
  hold({ pid: DEAD, at: new Date(clock.now()).toISOString() });
  await assert.rejects(withLock(home, "creation", async () => {}, { ...options, takeoverDeadPid: false }), /lock creation busy/);

  // A live holder is left alone.
  const live = JSON.stringify({ pid: process.pid, at: new Date(clock.now()).toISOString() });
  fs.writeFileSync(lockFile(home, "creation"), live);
  await assert.rejects(withLock(home, "creation", async () => {}, options), /lock creation busy/);
  assert.equal(fs.readFileSync(lockFile(home, "creation"), "utf8"), live);

  // No pid: only its age counts.
  hold({ at: new Date(clock.now()).toISOString() });
  await assert.rejects(withLock(home, "creation", async () => {}, options), /lock creation busy/);
  hold({ at: new Date(clock.now() - 3 * 3600000).toISOString() });
  assert.equal(await withLock(home, "creation", async () => "stale", options), "stale");
  assert.equal(logged.length, 1, "only the dead pid was logged");
});

test("pidAlive: this process is alive; a pid nothing runs as isn't", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
});
