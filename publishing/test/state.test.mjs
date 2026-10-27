import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publisherHome, loadEnv } from "../lib/env.mjs";
import { createStateStore, createSecretTokenStore, getEntry, setEntry, isDone, postedFloatingOn, postedOn, holdsDate } from "../lib/state.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { createLogger } from "../lib/log.mjs";

// Every test points PIPELINE_HOME at its own fresh temp dir.
function freshHome() {
  process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  return publisherHome();
}

test("load returns an empty state when none exists", () => {
  const store = createStateStore(freshHome());
  assert.deepEqual(store.load(), { version: 1, items: {} });
});

test("save is atomic and round-trips", () => {
  const home = freshHome();
  const store = createStateStore(home);
  const state = { version: 1, items: { "reel-01-launch": { instagram: { status: "manual", at: "2026-10-06T13:00:00.000Z", date: "2026-10-06", url: "https://www.instagram.com/reel/a/" } } } };
  store.save(state);
  assert.equal(fs.existsSync(path.join(home, "state.json.tmp")), false);
  assert.ok(fs.existsSync(path.join(home, "state.json")));
  assert.deepEqual(store.load(), state);
});

test("load throws on a corrupt state file instead of starting empty", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "state.json"), "{ not json");
  assert.throws(() => createStateStore(home).load(), /state\.json/);
});

test("backup keeps the newest 30", () => {
  const home = freshHome();
  const store = createStateStore(home);
  const state = { version: 1, items: {} };
  const start = Date.parse("2026-10-25T14:00:00Z"); // 19:30 IST
  const written = [];
  for (let i = 0; i < 32; i++) written.push(store.backup(state, new Date(start + i * 1000)));
  const files = fs.readdirSync(path.join(home, "backups")).sort();
  assert.equal(files.length, 30);
  assert.equal(path.basename(written[0]), "state-20261025-193000.json");
  assert.ok(!files.includes(path.basename(written[0])));
  assert.ok(!files.includes(path.basename(written[1])));
  assert.equal(files[0], path.basename(written[2]));
  assert.equal(files[29], path.basename(written[31]));
  assert.deepEqual(JSON.parse(fs.readFileSync(written[31], "utf8")), state);
});

test("isDone", () => {
  freshHome();
  const state = { version: 1, items: {} };
  for (const status of ["posted", "manual", "dropped", "failed"]) {
    setEntry(state, status, "instagram", { status, at: "2026-10-25T14:00:00.000Z" });
  }
  assert.equal(isDone(state, "posted", "instagram"), true);
  assert.equal(isDone(state, "manual", "instagram"), true);
  assert.equal(isDone(state, "dropped", "instagram"), true);
  assert.equal(isDone(state, "failed", "instagram"), false);
  assert.equal(isDone(state, "missing", "instagram"), false);
  assert.equal(isDone(state, "posted", "youtube"), false);
});

test("getEntry and setEntry", () => {
  freshHome();
  const state = { version: 1, items: {} };
  assert.equal(getEntry(state, "a", "instagram"), undefined);
  const entry = { status: "posted", at: "2026-10-25T14:00:00.000Z", date: "2026-10-25", mediaId: "M1", url: "u" };
  assert.equal(setEntry(state, "a", "instagram", entry), state);
  assert.deepEqual(getEntry(state, "a", "instagram"), entry);
  setEntry(state, "a", "youtube", { status: "failed", at: "x", error: "boom", attempts: 2 });
  assert.deepEqual(getEntry(state, "a", "instagram"), entry);
  assert.equal(getEntry(state, "a", "youtube").status, "failed");
});

test("postedFloatingOn ignores pinned items and other dates", () => {
  freshHome();
  const items = [{ id: "F1" }, { id: "F2" }, { id: "P", on: "2026-10-25" }];
  const state = { version: 1, items: {} };
  setEntry(state, "P", "instagram", { status: "posted", at: "x", date: "2026-10-25" });
  setEntry(state, "F1", "instagram", { status: "posted", at: "x", date: "2026-10-24" });
  setEntry(state, "F2", "instagram", { status: "failed", at: "x", date: "2026-10-25" });
  assert.equal(postedFloatingOn(state, items, "instagram", "2026-10-25"), false);
  assert.equal(postedFloatingOn(state, items, "instagram", "2026-10-24"), true);
  assert.equal(postedFloatingOn(state, items, "youtube", "2026-10-24"), false);
  setEntry(state, "F2", "instagram", { status: "manual", at: "x", date: "2026-10-25" });
  assert.equal(postedFloatingOn(state, items, "instagram", "2026-10-25"), true);
});

test("postedOn: one item posted or marked manual on that platform and date, pinned or not", () => {
  const state = { version: 1, items: {} };
  setEntry(state, "P", "instagram", { status: "posted", at: "x", date: "2026-10-25" });
  setEntry(state, "M", "instagram", { status: "manual", at: "x", date: "2026-10-25" });
  setEntry(state, "D", "instagram", { status: "dropped", at: "x", date: "2026-10-25" });
  assert.equal(postedOn(state, "P", "instagram", "2026-10-25"), true);
  assert.equal(postedOn(state, "M", "instagram", "2026-10-25"), true);
  assert.equal(postedOn(state, "D", "instagram", "2026-10-25"), false);
  assert.equal(postedOn(state, "P", "instagram", "2026-10-24"), false);
  assert.equal(postedOn(state, "P", "youtube", "2026-10-25"), false);
  assert.equal(postedOn(state, "nope", "instagram", "2026-10-25"), false);
});

test("holdsDate: a pin holds its date unless it was done there before that day", () => {
  freshHome();
  const P = { id: "P", on: "2026-10-28" };
  const state = { version: 1, items: {} };
  assert.equal(holdsDate(state, P, "instagram", "2026-10-28"), true, "not done yet");
  assert.equal(holdsDate(state, P, "instagram", "2026-10-27"), false, "another date");
  assert.equal(holdsDate(state, { id: "F" }, "instagram", "2026-10-28"), false, "floating");
  setEntry(state, "P", "instagram", { status: "posted", at: "x", date: "2026-10-28" });
  assert.equal(holdsDate(state, P, "instagram", "2026-10-28"), true, "posted on its day");
  setEntry(state, "P", "instagram", { status: "posted", at: "x", date: "2026-10-25" });
  assert.equal(holdsDate(state, P, "instagram", "2026-10-28"), false, "posted early");
  assert.equal(holdsDate(state, P, "youtube", "2026-10-28"), true, "per platform");
  setEntry(state, "P", "youtube", { status: "dropped", at: "x" });
  assert.equal(holdsDate(state, P, "youtube", "2026-10-28"), false, "dropped");
  setEntry(state, "P", "youtube", { status: "failed", at: "x", error: "boom" });
  assert.equal(holdsDate(state, P, "youtube", "2026-10-28"), true, "failed isn't done");
});

test("logger redacts secrets", () => {
  const home = freshHome();
  const log = createLogger(home);
  log.info("x", { token: "abc", igAccessToken: "def", nested: { clientSecret: "ghi" }, ok: 1 });
  log.error("y", { error: "boom" });
  const dir = path.join(home, "logs");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}\.log$/);
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  for (const secret of ["abc", "def", "ghi"]) assert.ok(!text.includes(secret), text);
  assert.ok(text.includes('"ok":1'), text);
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /INFO x/);
  assert.match(lines[1], /ERROR y .*"error":"boom"/);
});

test("publisherHome defaults to ~/.pipeline", () => {
  freshHome();
  assert.equal(publisherHome({}), path.join(os.homedir(), ".pipeline"));
  assert.equal(publisherHome({ PIPELINE_HOME: "/tmp/x" }), "/tmp/x");
  assert.equal(publisherHome(), process.env.PIPELINE_HOME);
});

test("loadEnv parses KEY=value lines and a missing file gives {}", () => {
  const home = freshHome();
  assert.deepEqual(loadEnv(path.join(home, ".env")), {});
  const file = path.join(home, ".env");
  fs.writeFileSync(file, '\uFEFFIG_ACCESS_TOKEN=abc\r\n# comment\r\nTELEGRAM_CHAT_ID = "123"\r\nlower=no\r\n');
  assert.deepEqual(loadEnv(file), { IG_ACCESS_TOKEN: "abc", TELEGRAM_CHAT_ID: "123" });
});

test("backup names use the store's time zone", () => {
  const home = freshHome();
  const now = new Date("2026-10-25T14:00:00Z");
  assert.match(createStateStore(home).backup({ version: 1, items: {} }, now), /state-20261025-193000\.json$/);
  const london = createStateStore(path.join(home, "london"), { timeZone: "Europe/London" });
  assert.match(london.backup({ version: 1, items: {} }, now), /state-20261025-140000\.json$/);
});

test("secret-backed token store keeps each campaign's tokens in its own secrets", () => {
  const home = freshHome();
  const secrets = createSecrets(home, { now: () => new Date("2026-10-24T08:00:00.000Z") });
  const acme = createSecretTokenStore(secrets, "acme");
  assert.deepEqual(acme.load(), {});

  acme.save({
    instagram: { token: "T", userId: 17841400000, username: "acme.coffee", issuedAt: "2026-10-25T14:00:00.000Z" },
    youtube: { refreshToken: "R", obtainedAt: "ignored" },
  });
  assert.deepEqual(acme.load(), {
    instagram: { token: "T", userId: "17841400000", username: "acme.coffee", issuedAt: "2026-10-25T14:00:00.000Z" },
    youtube: { refreshToken: "R", obtainedAt: "2026-10-24T08:00:00.000Z" },
  });
  assert.equal(secrets.get("acme", "IG_ACCESS_TOKEN"), "T");
  assert.equal(secrets.get("globex", "IG_ACCESS_TOKEN"), undefined);
  assert.deepEqual(createSecretTokenStore(secrets, "globex").load(), {});

  // A refresh rewrites only what changed.
  const before = secrets.status("acme");
  acme.save({ ...acme.load(), instagram: { ...acme.load().instagram, token: "T2" } });
  assert.equal(secrets.get("acme", "IG_ACCESS_TOKEN"), "T2");
  assert.equal(secrets.status("acme").IG_USERNAME.updatedAt, before.IG_USERNAME.updatedAt);
});
