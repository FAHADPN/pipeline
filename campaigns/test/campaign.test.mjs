import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { campaignIds, getCampaign, loadCampaigns, pickCampaignId, validateCampaign } from "../lib/campaign.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "campaigns-"));
}

// A campaigns root and a publisher home, both temp dirs, plus a writer for
// <root>/<dir>/campaign.json.
function setup() {
  const root = tmp();
  const home = tmp();
  const write = (dir, config) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "campaign.json"), JSON.stringify(config, null, 2));
  };
  return { root, home, write };
}

function minimal(id, root) {
  return { id, name: `Campaign ${id}`, root };
}

test("loads a campaign with defaults", () => {
  const { root, home, write } = setup();
  const croot = path.join(root, "acme");
  write("acme", minimal("acme", croot));

  const [c] = loadCampaigns({ root, home });
  assert.equal(c.id, "acme");
  assert.equal(c.name, "Campaign acme");
  assert.equal(c.root, croot);
  assert.equal(c.paused, false);
  assert.equal(c.home, path.join(home, "campaigns", "acme"));

  assert.equal(c.config.timezone, "Asia/Kolkata");
  assert.equal(c.config.slot, "19:30");
  assert.equal(c.config.lateLimitMinutes, 120);
  assert.equal(c.config.bufferMin, 7);
  assert.deepEqual(c.config.fallbackDays, ["Mon", "Wed", "Fri", "Sun"]);
  assert.equal(c.config.platforms.instagram.enabled, true);
  assert.equal(c.config.platforms.instagram.graphVersion, "v24.0");
  assert.equal(c.config.platforms.instagram.tokenRefreshDays, 30);
  assert.equal(c.config.platforms.instagram.ngrokBin, "ngrok", "found on PATH");
  assert.deepEqual(c.config.platforms.youtube, { enabled: false, privacy: "private", categoryId: "22" });
  assert.equal(c.config.maxBuilds, 2);
  assert.equal(c.config.maxAwaiting, 6);
  assert.deepEqual(c.config.approvers, []);
  assert.deepEqual(c.config.extraAllowedTools, []);
  assert.deepEqual(c.config.checks, { captionPy: true, detect: true, detectOnScreen: true, hookscore: true, guardrails: true });
  assert.deepEqual(c.config.videoSpec, {
    width: 1080,
    height: 1920,
    minSeconds: 7,
    maxSeconds: 35,
    audioRequired: true,
    youtubeTitleRequired: true,
  });

  assert.equal(c.paths.schedule, path.join(croot, "schedule.json"));
  assert.equal(c.paths.backlog, path.join(croot, "backlog.json"));
  assert.equal(c.paths.brief, path.join(croot, "brief.md"));
  assert.equal(c.paths.voice, path.join(croot, "voice.md"));
  assert.equal(c.paths.references, path.join(croot, "references.md"));
  assert.equal(c.paths.piecesDir, path.join(croot, "pieces"));
  assert.equal(c.paths.guardrails, path.join(croot, "guardrails.json"));
});

test("loads path overrides", () => {
  const { root, home, write } = setup();
  const repo = tmp();
  write("acme", {
    id: "acme",
    name: "Acme Coffee",
    root: repo,
    timezone: "Europe/London",
    slot: "18:00",
    lateLimitMinutes: 90,
    bufferMin: 5,
    fallbackDays: ["Tue", "Thu"],
    retryDelaySeconds: 30,
    platforms: {
      instagram: {
        enabled: true,
        graphVersion: "v24.0",
        useCover: false,
        thumbOffsetMs: 1000,
        tokenRefreshDays: 20,
        ngrokBin: "C:\\Tools\\ngrok\\ngrok.exe",
      },
      youtube: { enabled: true, privacy: "unlisted", categoryId: "22" },
    },
    approvers: ["123456789"],
    paths: {
      schedule: "publishing/schedule.json",
      backlog: "content/backlog.json",
      brief: "content/brief.md",
      voice: "%USERPROFILE%\\.claude\\instagram\\voice.md",
      references: "content/references.md",
      piecesDir: "content/reels",
      verifyPrefix: "content/reels/<id>/",
      guardrails: "content/guardrails.json",
    },
  });

  const c = getCampaign("acme", { root, home });
  assert.equal(c.root, repo);
  assert.equal(c.config.timezone, "Europe/London");
  assert.equal(c.config.retryDelaySeconds, 30);
  assert.equal(c.config.platforms.instagram.ngrokBin, "C:\\Tools\\ngrok\\ngrok.exe");
  assert.deepEqual(c.config.platforms.youtube, { enabled: true, privacy: "unlisted", categoryId: "22" });
  assert.deepEqual(c.config.approvers, ["123456789"]);
  assert.equal(c.paths.schedule, path.join(repo, "publishing", "schedule.json"));
  assert.equal(c.paths.backlog, path.join(repo, "content", "backlog.json"));
  assert.equal(c.paths.brief, path.join(repo, "content", "brief.md"));
  assert.equal(c.paths.voice, path.join(os.homedir(), ".claude", "instagram", "voice.md"));
  assert.equal(c.paths.references, path.join(repo, "content", "references.md"));
  assert.equal(c.paths.piecesDir, path.join(repo, "content", "reels"));
  assert.equal(c.paths.guardrails, path.join(repo, "content", "guardrails.json"));
  assert.equal(c.paths.verifyPrefix("reel-01-launch"), "content/reels/reel-01-launch/");
  assert.equal(c.home, path.join(home, "campaigns", "acme"));
});

test("rejects bad id, missing root, unknown format, bad timezone, approvers not strings", () => {
  const good = minimal("ok", tmp());
  assert.deepEqual(validateCampaign(good), []);

  const has = (config, word) => {
    const problems = validateCampaign(config);
    assert.ok(problems.some((p) => p.includes(word)), `expected a "${word}" problem in ${JSON.stringify(problems)}`);
  };
  has({ ...good, id: "Bad_Id" }, "id");
  has({ ...good, id: "../escape" }, "id");
  has({ ...good, root: undefined }, "root");
  has({ ...good, root: "relative/dir" }, "root");
  has({ ...good, formats: ["episode", "dance-off"] }, "format");
  has({ ...good, timezone: "Mars/Olympus" }, "timezone");
  has({ ...good, approvers: [123456789] }, "approvers");

  // loadCampaigns throws one error that lists every problem across every file.
  const { root, home, write } = setup();
  write("first", { ...minimal("first", tmp()), timezone: "Mars/Olympus" });
  write("second", { ...minimal("second", tmp()), approvers: [42], formats: ["dance-off"] });
  write("third", minimal("third", tmp()));
  assert.throws(
    () => loadCampaigns({ root, home }),
    (err) =>
      err.message.includes("first") &&
      err.message.includes("timezone") &&
      err.message.includes("second") &&
      err.message.includes("approvers") &&
      err.message.includes("format") &&
      !err.message.includes("third"),
  );
});

test("verifyPrefix defaults to pieces/<id>/", () => {
  const { root, home, write } = setup();
  write("acme", minimal("acme", tmp()));
  const c = getCampaign("acme", { root, home });
  assert.equal(c.paths.verifyPrefix("idea-01-first"), "pieces/idea-01-first/");
  assert.throws(() => c.paths.verifyPrefix("../other"), /piece id/);
});

test("paused flag is read", () => {
  const { root, home, write } = setup();
  write("live", minimal("live", tmp()));
  write("resting", { ...minimal("resting", tmp()), paused: true });
  const byId = Object.fromEntries(loadCampaigns({ root, home }).map((c) => [c.id, c]));
  assert.equal(byId.live.paused, false);
  assert.equal(byId.resting.paused, true);
  assert.ok(validateCampaign({ ...minimal("x", tmp()), paused: "yes" }).some((p) => p.includes("paused")));
});

test("lockName prefixes the id", () => {
  const { root, home, write } = setup();
  write("acme", minimal("acme", tmp()));
  write("globex", minimal("globex", tmp()));
  assert.equal(getCampaign("acme", { root, home }).lockName("publish"), "acme:publish");
  assert.equal(getCampaign("globex", { root, home }).lockName("schedule"), "globex:schedule");
});

test("the campaigns root comes from PIPELINE_CAMPAIGNS_ROOT", () => {
  const { root, home, write } = setup();
  write("acme", minimal("acme", tmp()));
  const saved = process.env.PIPELINE_CAMPAIGNS_ROOT;
  process.env.PIPELINE_CAMPAIGNS_ROOT = root;
  try {
    assert.deepEqual(loadCampaigns({ home }).map((c) => c.id), ["acme"]);
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_CAMPAIGNS_ROOT;
    else process.env.PIPELINE_CAMPAIGNS_ROOT = saved;
  }
});

test("campaignIds lists the folders with a campaign.json, valid or not, in folder order", () => {
  const { root, write } = setup();
  write("globex", minimal("globex", tmp()));
  write("acme", minimal("acme", tmp()));
  write("broken", { id: "broken" });
  fs.mkdirSync(path.join(root, "no-config"));
  assert.deepEqual(campaignIds({ root }), ["acme", "broken", "globex"]);
  assert.deepEqual(campaignIds({ root: path.join(root, "missing") }), []);
});

test("pickCampaignId: the flag's id, else the only campaign; none or several is a usage error listing the ids", () => {
  const { root, write } = setup();
  const usage = (message) => (err) => err.usage === true && err.message === message;
  assert.throws(() => pickCampaignId(undefined, { root }), usage(`no campaign found under ${root}; make one there, or point PIPELINE_CAMPAIGNS_ROOT at yours`));
  write("globex", minimal("globex", tmp()));
  assert.equal(pickCampaignId(undefined, { root }), "globex");
  write("acme", minimal("acme", tmp()));
  assert.throws(() => pickCampaignId(undefined, { root }), usage(`several campaigns under ${root} (acme, globex); pick one with --campaign <id>`));
  assert.equal(pickCampaignId("globex", { root }), "globex");
  assert.equal(pickCampaignId("missing", { root }), "missing", "the flag's id is getCampaign's to check");
});

test("an id that doesn't match its folder, or an unknown campaign, is refused", () => {
  const { root, home, write } = setup();
  write("acme", minimal("other", tmp()));
  assert.throws(() => loadCampaigns({ root, home }), /folder/);
  assert.throws(() => getCampaign("missing", { root, home }), /unknown campaign/);
  assert.throws(() => getCampaign("..\\x", { root, home }), /id/);
});
