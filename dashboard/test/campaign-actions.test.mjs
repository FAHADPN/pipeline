import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCampaign, loadCampaigns } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { withLock } from "../../publishing/lib/lock.mjs";
import { campaignSettings, createCampaignActions } from "../lib/campaign-actions.mjs";
import { loadCampaignData } from "../lib/sources.mjs";

const NOW = new Date("2026-10-26T04:30:00Z");
const BUSY = "a build is running for Globex Sample; try again when it finishes";

// campaign.json as a person would lay it out: inline lists and nested objects.
const CAMPAIGN_JSON = `{
  "id": "globex",
  "name": "Globex Sample",
  "root": "ROOT",
  "fallbackDays": ["Mon", "Wed", "Fri", "Sun"],
  "platforms": {
    "instagram": { "enabled": true, "graphVersion": "v24.0" },
    "youtube": { "enabled": false }
  },
  "checks": {
    "captionPy": true,
    "detect": true
  },
  "approvers": ["111"]
}
`;

// A git with an identity, as the owner's machine has one.
const git = (args, cwd) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe" });

function fakeLog() {
  const lines = [];
  return {
    lines,
    info: (msg, data) => lines.push(["info", msg, data]),
    error: (msg, data) => lines.push(["error", msg, data]),
  };
}

// A campaigns root holding the globex sample (not a git repo), a publisher home, and the actions.
function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-actions-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "campaigns");
  const home = path.join(tmp, "home");
  const folder = path.join(root, "globex");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(home);
  const file = path.join(folder, "campaign.json");
  fs.writeFileSync(file, CAMPAIGN_JSON.replace("ROOT", folder.replaceAll("\\", "\\\\")));
  const log = fakeLog();
  const actions = createCampaignActions({ root, home, deps: { secrets: createSecrets(home), git, log, now: () => NOW } });
  const backupsDir = path.join(home, "campaigns", "globex", "backups");
  return {
    root,
    home,
    file,
    log,
    actions,
    read: () => fs.readFileSync(file, "utf8"),
    config: () => JSON.parse(fs.readFileSync(file, "utf8")),
    backups: () => (fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []),
    backupsDir,
  };
}

test("setPaused: pauses and resumes in the file's own layout, with a backup and no commit", async (t) => {
  const { actions, read, root, home, backups, backupsDir, log } = setup(t);
  const original = read();
  const paused = await actions.setPaused({ id: "globex", paused: true });
  assert.deepEqual(paused, { ok: true, message: "Paused Globex Sample." });
  assert.equal(read(), original.replace('"approvers": ["111"]\n', '"approvers": ["111"],\n  "paused": true\n'));
  assert.equal(getCampaign("globex", { root, home }).paused, true);
  assert.equal(backups().length, 1);
  assert.equal(fs.readFileSync(path.join(backupsDir, backups()[0]), "utf8"), original);
  assert.ok(!fs.existsSync(path.join(root, "globex", ".git")), "nothing is committed: the folder isn't a repo");

  const resumed = await actions.setPaused({ id: "globex", paused: false });
  assert.deepEqual(resumed, { ok: true, message: "Resumed Globex Sample." });
  assert.equal(read(), original.replace('"approvers": ["111"]\n', '"approvers": ["111"],\n  "paused": false\n'));
  assert.deepEqual(log.lines.map(([level, msg]) => [level, msg]), [["info", "dashboard setPaused"], ["info", "dashboard setPaused"]]);

  for (const value of ["yes", 1, undefined]) assert.equal((await actions.setPaused({ id: "globex", paused: value })).ok, false, String(value));
  assert.match((await actions.setPaused({ id: "nope", paused: true })).error, /unknown campaign nope/);
});

test("setPaused and saveSettings: a busy schedule lock refuses with the build message and changes nothing", async (t) => {
  const { actions, read, home, backups } = setup(t);
  const original = read();
  await withLock(home, "globex:schedule", async () => {
    const started = Date.now();
    assert.deepEqual(await actions.setPaused({ id: "globex", paused: true }), { ok: false, error: BUSY });
    assert.deepEqual(await actions.saveSettings({ id: "globex", fields: { slot: "20:00" } }), { ok: false, error: BUSY });
    assert.ok(Date.now() - started < 9000);
  });
  assert.equal(read(), original);
  assert.deepEqual(backups(), []);
});

test("saveSettings: a field outside the list is refused", async (t) => {
  const { actions, read, backups } = setup(t);
  const original = read();
  for (const name of ["paths.piecesDir", "maxBuilds", "root", "id", "timezone", "checks", "platforms.instagram.graphVersion", "extraAllowedTools", "__proto__", "checks.__proto__"]) {
    const res = await actions.saveSettings({ id: "globex", fields: { [name]: true } });
    assert.equal(res.ok, false, name);
    assert.equal(res.error, `${name} can't be set here`);
  }
  // One refused field refuses the lot.
  const mixed = await actions.saveSettings({ id: "globex", fields: { slot: "20:00", paused: true } });
  assert.equal(mixed.error, "paused can't be set here");
  for (const fields of [{}, null, [], "slot"]) assert.equal((await actions.saveSettings({ id: "globex", fields })).ok, false, JSON.stringify(fields));
  assert.equal(read(), original);
  assert.deepEqual(backups(), []);
});

test("saveSettings: an invalid value leaves the file unchanged", async (t) => {
  const { actions, read, backups } = setup(t);
  const original = read();
  const bad = [
    [{ slot: "25:99" }, /slot must be HH:MM/],
    [{ bufferMin: -1 }, /bufferMin must be a whole number/],
    [{ lateLimitMinutes: 0 }, /lateLimitMinutes must be a whole number above 0/],
    [{ fallbackDays: ["Funday"] }, /fallbackDays must list days/],
    [{ approvers: [123] }, /approver 1 isn't a Telegram chat id/],
    [{ approvers: "111" }, /approvers must be a list of chat ids/],
    [{ approvers: Array.from({ length: 11 }, (_, i) => String(100 + i)) }, /at most 10 approvers/],
    [{ "checks.detect": "no" }, /checks\.detect must be true or false/],
    [{ "checks.sparkle": true }, /checks\.sparkle is not a known field/],
    [{ "platforms.youtube.enabled": "on" }, /platforms\.youtube\.enabled must be true or false/],
    [{ name: "  " }, /name/],
    [{ name: "Two\nlines" }, /name/],
  ];
  for (const [fields, why] of bad) {
    const res = await actions.saveSettings({ id: "globex", fields });
    assert.equal(res.ok, false, JSON.stringify(fields));
    assert.match(res.error, why);
  }
  assert.equal(read(), original);
  assert.deepEqual(backups(), []);
});

test("saveSettings: the allowed fields are written where they are, a new one goes last, and the rest stays", async (t) => {
  const { actions, read, config, root, home, backups } = setup(t);
  const original = read();
  const res = await actions.saveSettings({
    id: "globex",
    fields: {
      name: " Globex Co ",
      slot: "20:15",
      fallbackDays: ["Tue", "Sat"],
      "platforms.youtube.enabled": true,
      "checks.detect": false,
      approvers: ["111", "-1002233"],
      bufferMin: 4,
    },
  });
  assert.deepEqual(res, { ok: true, message: "Saved Globex Co's settings." });
  assert.equal(
    read(),
    original
      .replace('"Globex Sample"', '"Globex Co"')
      .replace('["Mon", "Wed", "Fri", "Sun"]', '["Tue", "Sat"]')
      .replace('"youtube": { "enabled": false }', '"youtube": { "enabled": true }')
      .replace('"detect": true', '"detect": false')
      .replace('"approvers": ["111"]\n', '"approvers": ["111", "-1002233"],\n  "slot": "20:15",\n  "bufferMin": 4\n'),
  );
  assert.equal(config().platforms.instagram.graphVersion, "v24.0");
  const c = getCampaign("globex", { root, home });
  assert.equal(c.config.slot, "20:15");
  assert.equal(c.config.platforms.youtube.enabled, true);
  assert.equal(c.config.checks.detect, false);
  assert.equal(backups().length, 1);

  // The settings as the form shows them.
  assert.deepEqual(campaignSettings(c), {
    name: "Globex Co",
    slot: "20:15",
    lateLimitMinutes: 120,
    bufferMin: 4,
    fallbackDays: ["Tue", "Sat"],
    "platforms.instagram.enabled": true,
    "platforms.youtube.enabled": true,
    approvers: ["111", "-1002233"],
    "checks.captionPy": true,
    "checks.detect": false,
    "checks.detectOnScreen": true,
    "checks.hookscore": true,
    "checks.guardrails": true,
  });

  // A check the file doesn't list yet goes into its checks.
  assert.equal((await actions.saveSettings({ id: "globex", fields: { "checks.hookscore": false } })).ok, true);
  assert.deepEqual(config().checks, { captionPy: true, detect: false, hookscore: false });

  // Saving what is already there changes nothing and keeps no backup.
  const same = read();
  assert.equal((await actions.saveSettings({ id: "globex", fields: { slot: "20:15" } })).ok, true);
  assert.equal(read(), same);
  assert.equal(backups().length, 2);
});

test("saveSettings: approvers follow the same rule as Connections: duplicates dropped, 10 at most", async (t) => {
  const { actions, config } = setup(t);
  const ten = Array.from({ length: 10 }, (_, i) => String(100 + i));
  assert.equal((await actions.saveSettings({ id: "globex", fields: { approvers: [...ten, "100", "-100"] } })).error, "at most 10 approvers");
  assert.equal((await actions.saveSettings({ id: "globex", fields: { approvers: [...ten, "100"] } })).ok, true);
  assert.deepEqual(config().approvers, ten);
});

test("createCampaign: an existing id or a bad id is refused", async (t) => {
  const { actions, root } = setup(t);
  const before = fs.readdirSync(root);
  assert.deepEqual(await actions.createCampaign({ id: "globex", name: "Again", template: "blank" }), { ok: false, error: "a campaign globex already exists" });
  fs.mkdirSync(path.join(root, "stray"));
  assert.deepEqual(await actions.createCampaign({ id: "stray", name: "Stray", template: "blank" }), { ok: false, error: "a folder stray is already in the campaigns root" });
  for (const id of ["Bad", "../x", "a b", "", "a_b", "-x", "x".repeat(41), undefined, 7]) {
    const res = await actions.createCampaign({ id, name: "Acme", template: "blank" });
    assert.equal(res.ok, false, String(id));
    assert.match(res.error, /id must be/);
  }
  assert.match((await actions.createCampaign({ id: "acme", name: "Acme", template: "fancy" })).error, /template must be blank/);
  assert.match((await actions.createCampaign({ id: "acme", name: "", template: "blank" })).error, /name/);
  assert.deepEqual(fs.readdirSync(root), [...before, "stray"].sort());
});

test("createCampaign: an existing id is refused at once, even while its lock is held", async (t) => {
  const { actions, home } = setup(t);
  await withLock(home, "globex:schedule", async () => {
    const started = Date.now();
    assert.deepEqual(await actions.createCampaign({ id: "globex", name: "Again", template: "blank" }), { ok: false, error: "a campaign globex already exists" });
    assert.ok(Date.now() - started < 1000, "no wait for the lock");
  });
});

test("createCampaign: the new folder passes getCampaign and has a git commit", async (t) => {
  const { actions, root, home, log } = setup(t);
  const res = await actions.createCampaign({ id: "acme", name: "Acme Studio", template: "blank" });
  assert.deepEqual(res, { ok: true, id: "acme", message: "Created Acme Studio. It starts paused: connect it, add ideas, then resume it." });
  const folder = path.join(root, "acme");
  const c = getCampaign("acme", { root, home });
  assert.equal(c.root, folder);
  assert.equal(c.name, "Acme Studio");
  assert.equal(c.paused, true);
  assert.deepEqual(loadCampaigns({ root, home }).map((x) => x.id), ["acme", "globex"]);

  const read = (rel) => fs.readFileSync(path.join(folder, rel), "utf8");
  // The blank template and the new campaign's own id, name and folder; the rest is defaults.
  assert.deepEqual(JSON.parse(read("campaign.json")), { id: "acme", name: "Acme Studio", root: folder, paused: true });
  assert.equal(c.paths.voice, path.join(folder, "voice.md"));
  assert.equal(c.paths.piecesDir, path.join(folder, "pieces"));
  for (const rel of ["brief.md", "voice.md", "references.md"]) {
    const lines = read(rel).split("\n").filter((l) => l.trim());
    assert.ok(lines.length > 0 && lines.every((l) => l.startsWith("#")), `${rel} is headings only`);
  }
  assert.deepEqual(JSON.parse(read("backlog.json")), []);
  assert.deepEqual(JSON.parse(read("schedule.json")), []);
  assert.deepEqual(JSON.parse(read("guardrails.json")), {});
  assert.ok(fs.statSync(path.join(folder, ".claude", "skills")).isDirectory());

  const inRepo = (...args) => git(args, folder).trim();
  assert.equal(inRepo("log", "--format=%s"), "campaign: create acme");
  assert.equal(inRepo("status", "--porcelain"), "", "everything is committed");
  assert.ok(inRepo("ls-files").split("\n").includes("campaign.json"));
  assert.deepEqual(log.lines.at(-1), ["info", "dashboard createCampaign", { campaign: "acme", template: "blank", ...res }]);

  // A generic campaign's reports go to creation-out/.
  assert.equal(loadCampaignData({ campaign: c, secrets: createSecrets(home) }).outDir, path.join(folder, "creation-out"));
});

test("createCampaign: a failed commit leaves no folder behind", async (t) => {
  const { root, home } = setup(t);
  const failing = (args, cwd) => {
    if (args[0] === "commit") throw new Error("Author identity unknown");
    return git(args, cwd);
  };
  const actions = createCampaignActions({ root, home, deps: { secrets: createSecrets(home), git: failing, log: fakeLog(), now: () => NOW } });
  const res = await actions.createCampaign({ id: "acme", name: "Acme", template: "blank" });
  assert.equal(res.ok, false);
  assert.match(res.error, /couldn't create the campaign folder: Author identity unknown/);
  assert.ok(!fs.existsSync(path.join(root, "acme")));
});
