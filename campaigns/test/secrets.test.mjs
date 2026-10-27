import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSecrets, SECRET_NAMES } from "../lib/secrets.mjs";

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "secrets-"));
}

const fixedNow = () => new Date("2026-10-24T08:00:00.000Z");

test("set then get round-trips per campaign", () => {
  const home = freshHome();
  const secrets = createSecrets(home, { now: fixedNow });
  assert.equal(secrets.get("acme", "IG_ACCESS_TOKEN"), undefined);

  secrets.set("acme", "IG_ACCESS_TOKEN", "tok-acme");
  secrets.set("acme", "TELEGRAM_BOT_TOKEN", "bot-acme");
  assert.equal(secrets.get("acme", "IG_ACCESS_TOKEN"), "tok-acme");
  assert.equal(secrets.get("acme", "TELEGRAM_BOT_TOKEN"), "bot-acme");
  assert.ok(fs.existsSync(path.join(home, "secrets", "acme.json")));

  // A second store over the same home reads what the first wrote.
  assert.equal(createSecrets(home).get("acme", "IG_ACCESS_TOKEN"), "tok-acme");

  secrets.set("acme", "IG_ACCESS_TOKEN", "tok-new");
  assert.equal(secrets.get("acme", "IG_ACCESS_TOKEN"), "tok-new");

  secrets.remove("acme", "IG_ACCESS_TOKEN");
  assert.equal(secrets.get("acme", "IG_ACCESS_TOKEN"), undefined);
  assert.equal(secrets.get("acme", "TELEGRAM_BOT_TOKEN"), "bot-acme");
  secrets.remove("acme", "IG_ACCESS_TOKEN"); // removing a missing one is fine
});

test("campaign A cannot read campaign B", () => {
  const home = freshHome();
  const secrets = createSecrets(home);
  secrets.set("globex", "TELEGRAM_BOT_TOKEN", "bot-globex");
  secrets.set("acme", "TELEGRAM_BOT_TOKEN", "bot-acme");

  assert.equal(secrets.get("globex", "TELEGRAM_BOT_TOKEN"), "bot-globex");
  assert.equal(secrets.get("acme", "TELEGRAM_BOT_TOKEN"), "bot-acme");
  assert.deepEqual(fs.readdirSync(path.join(home, "secrets")).sort(), ["acme.json", "globex.json"]);
  assert.ok(!fs.readFileSync(path.join(home, "secrets", "acme.json"), "utf8").includes("bot-globex"));
  assert.ok(!fs.readFileSync(path.join(home, "secrets", "globex.json"), "utf8").includes("bot-acme"));

  secrets.set("globex", "IG_ACCESS_TOKEN", "tok-globex");
  assert.equal(secrets.get("acme", "IG_ACCESS_TOKEN"), undefined);
  secrets.remove("acme", "TELEGRAM_BOT_TOKEN");
  assert.equal(secrets.get("globex", "TELEGRAM_BOT_TOKEN"), "bot-globex");

  // An id can't reach another campaign's file or outside secrets/.
  for (const bad of ["../globex", "globex/../acme", "Globex", "", "a\\b", undefined]) {
    assert.throws(() => secrets.get(bad, "IG_ACCESS_TOKEN"), /campaign id/);
    assert.throws(() => secrets.set(bad, "IG_ACCESS_TOKEN", "x"), /campaign id/);
  }
});

test("status has no values", () => {
  const home = freshHome();
  const secrets = createSecrets(home, { now: fixedNow });
  assert.deepEqual(secrets.status("acme"), {});

  secrets.set("acme", "IG_ACCESS_TOKEN", "tok-very-secret");
  secrets.set("acme", "YT_REFRESH_TOKEN", "yt-very-secret");
  const status = secrets.status("acme");
  assert.deepEqual(status, {
    IG_ACCESS_TOKEN: { set: true, updatedAt: "2026-10-24T08:00:00.000Z" },
    YT_REFRESH_TOKEN: { set: true, updatedAt: "2026-10-24T08:00:00.000Z" },
  });
  assert.ok(!JSON.stringify(status).includes("very-secret"));
  assert.deepEqual(secrets.status("globex"), {});
});

test("atomic write", () => {
  const home = freshHome();
  const secrets = createSecrets(home);
  const dir = path.join(home, "secrets");
  secrets.set("acme", "IG_USER_ID", "1789");
  assert.deepEqual(fs.readdirSync(dir), ["acme.json"]);

  // A stale temp file from an interrupted write is replaced, never read.
  fs.writeFileSync(path.join(dir, "acme.json.tmp"), "{ half written");
  secrets.set("acme", "IG_USERNAME", "acme.words");
  assert.deepEqual(fs.readdirSync(dir), ["acme.json"]);
  assert.equal(secrets.get("acme", "IG_USER_ID"), "1789");
  assert.equal(secrets.get("acme", "IG_USERNAME"), "acme.words");
  JSON.parse(fs.readFileSync(path.join(dir, "acme.json"), "utf8"));

  // A corrupt file fails loudly, and the error doesn't quote its contents.
  fs.writeFileSync(path.join(dir, "acme.json"), '{"IG_ACCESS_TOKEN": "leaky-value" oops');
  assert.throws(
    () => secrets.get("acme", "IG_ACCESS_TOKEN"),
    (err) => /acme\.json/.test(err.message) && !err.message.includes("leaky-value"),
  );
});

test("unknown name rejected", () => {
  const home = freshHome();
  const secrets = createSecrets(home);
  assert.deepEqual(SECRET_NAMES, [
    "IG_ACCESS_TOKEN",
    "IG_USER_ID",
    "IG_USERNAME",
    "IG_ISSUED_AT",
    "YT_REFRESH_TOKEN",
    "YT_CHANNEL",
    "TELEGRAM_BOT_TOKEN",
    "ANTHROPIC_API_KEY",
  ]);
  for (const name of ["TELEGRAM_CHAT_ID", "ig_access_token", "toString", "__proto__", ""]) {
    assert.throws(() => secrets.set("acme", name, "x"), /unknown secret/);
    assert.throws(() => secrets.get("acme", name), /unknown secret/);
    assert.throws(() => secrets.remove("acme", name), /unknown secret/);
  }
  // Values are non-empty strings, and the error never echoes the value.
  for (const value of ["", 42, null, undefined, { t: 1 }]) {
    assert.throws(() => secrets.set("acme", "IG_ACCESS_TOKEN", value), /must be text/);
  }
  assert.equal(fs.existsSync(path.join(home, "secrets", "acme.json")), false);
});
