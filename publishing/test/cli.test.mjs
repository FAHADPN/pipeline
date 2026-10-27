import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(REPO_ROOT, "publishing", "publish.mjs");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const tempHome = () => tmp("publish-home-");

// Each run gets its own empty publisher home (no .env and no secrets, so no tokens
// and no Telegram) and, unless the test gives one, an empty campaigns root.
function run(args, { home = tempHome(), env: extra = {} } = {}) {
  const env = { ...process.env, PIPELINE_HOME: home, PIPELINE_CAMPAIGNS_ROOT: tmp("publish-cli-empty-"), ...extra };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8", env, timeout: 60000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, out: res.stdout + res.stderr, home };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A postable piece in the folder contract, under root/dir.
function writePiece(root, dir, line) {
  const out = path.join(root, dir, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "piece.mp4"), "video");
  fs.writeFileSync(path.join(out, "piece-cover.png"), "cover");
  fs.writeFileSync(path.join(out, "piece-caption.txt"), `INSTAGRAM / TIKTOK\n${line}\n\nYOUTUBE SHORTS TITLE\n${line} #shorts\n`);
}

// A campaigns root with one campaign, "acme" (Acme Coffee), whose schedule holds
// two ready pieces. add() puts another campaign beside it, with its own pieces.
function sampleCampaign(t, over = {}) {
  const dir = tmp("publish-cli-campaign-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const campaignsRoot = path.join(dir, "campaigns");
  const add = (id, config = {}, ids = [`${id}-one`, `${id}-two`]) => {
    const root = path.join(dir, `${id}-root`);
    writeJson(path.join(root, "schedule.json"), ids.map((p) => ({ id: p, kind: "post", dir: `pieces/${p}` })));
    for (const p of ids) writePiece(root, `pieces/${p}`, `${p} line`);
    writeJson(path.join(campaignsRoot, id, "campaign.json"), { id, name: `${id} Co`, root, ...config });
    return root;
  };
  const root = add("acme", { name: "Acme Coffee", ...over }, ["reel-01-launch", "reel-02-menu"]);
  return { campaignsRoot, root, add, env: { PIPELINE_CAMPAIGNS_ROOT: campaignsRoot } };
}

const campaignHome = (home, id = "acme") => path.join(home, "campaigns", id);

test("check exits 0 when every queued item passes", (t) => {
  const { env } = sampleCampaign(t);
  const r = run(["check"], { env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^ok    reel-01-launch$/m);
  assert.match(r.stdout, /^ok    reel-02-menu$/m);
  assert.match(r.stdout, /Every queued item passes\./);
});

test("check exits 1 on a broken queued item", (t) => {
  const { env, root } = sampleCampaign(t);
  fs.rmSync(path.join(root, "pieces", "reel-01-launch", "out"), { recursive: true });
  const r = run(["check"], { env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /reel-01-launch.*no out\/ folder/);
  // The rest of the queue is still checked.
  assert.match(r.stdout, /^ok    reel-02-menu$/m);
});

test("--dry-run needs no tokens and prints DRY RUN", (t) => {
  const { env } = sampleCampaign(t);
  const r = run(["--dry-run"], { env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^DRY RUN · Acme Coffee · /);
  assert.match(r.stdout, /Queue: \d+ ready/);
  assert.match(r.stdout, /Plan: window (early|open|late)/);
  // Nothing written to the publisher home.
  assert.ok(!fs.existsSync(path.join(campaignHome(r.home), "state.json")));
  assert.ok(!fs.existsSync(path.join(r.home, "secrets")));
  assert.ok(!fs.existsSync(path.join(r.home, "locks")));
});

test("mark then status shows the new status", (t) => {
  const { env } = sampleCampaign(t);
  const home = tempHome();
  const before = run(["status"], { home, env });
  assert.equal(before.code, 0, before.out);
  assert.match(before.stdout, /^reel-01-launch\s+-\s+-\s+-\s+yes$/m);

  const mark = run(["mark", "reel-01-launch", "instagram", "manual"], { home, env });
  assert.equal(mark.code, 0, mark.out);
  const state = JSON.parse(fs.readFileSync(path.join(campaignHome(home), "state.json"), "utf8"));
  assert.equal(state.items["reel-01-launch"].instagram.status, "manual");
  // Taken under the campaign's publish lock, and released.
  assert.deepEqual(fs.readdirSync(path.join(home, "locks")), []);

  const after = run(["status"], { home, env });
  assert.equal(after.code, 0, after.out);
  assert.match(after.stdout, /^reel-01-launch\s+-\s+manual\s+-\s+yes$/m);
  assert.match(after.stdout, /Ready: \d+ · (daily|4-a-week) · runs dry/);
  assert.match(after.stdout, /Instagram token: not set/);

  const clear = run(["mark", "reel-01-launch", "instagram", "clear"], { home, env });
  assert.equal(clear.code, 0, clear.out);
  assert.match(run(["status"], { home, env }).stdout, /^reel-01-launch\s+-\s+-\s+-\s+yes$/m);
});

test("mark rejects an unknown id or status", (t) => {
  const { env } = sampleCampaign(t);
  assert.match(run(["mark", "nope", "instagram", "posted"], { env }).out, /no item nope/);
  assert.equal(run(["mark", "reel-01-launch", "instagram", "failed"], { env }).code, 1);
  assert.equal(run(["mark", "reel-01-launch", "tiktok", "posted"], { env }).code, 1);
  assert.equal(run(["mark", "reel-01-launch", "instagram", "posted", "--date", "2026-02-30"], { env }).code, 1);
});

test("post refuses without --now", (t) => {
  const { env } = sampleCampaign(t);
  const r = run(["post", "reel-01-launch"], { env });
  assert.equal(r.code, 1);
  assert.match(r.out, /--now/);
  assert.match(r.out, /Usage:/);
});

test("ig-fetch-test needs an id and a token before it starts ngrok", (t) => {
  const { env } = sampleCampaign(t);
  const noId = run(["ig-fetch-test"], { env });
  assert.equal(noId.code, 1);
  assert.match(noId.out, /Usage:/);

  assert.match(run(["ig-fetch-test", "nope"], { env }).out, /no item nope/);

  const noToken = run(["ig-fetch-test", "reel-01-launch"], { env });
  assert.equal(noToken.code, 1);
  assert.match(noToken.out, /no Instagram token saved for acme/);
});

test("unknown command prints usage and exits 1", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /Usage:/);
});

test("a flag the command doesn't take is refused", () => {
  const r = run(["status", "--dry-run"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /Usage:/);
});

test("without --campaign, an empty campaigns root or several campaigns is a usage error that lists the ids", (t) => {
  const none = run(["status"]);
  assert.equal(none.code, 1, none.out);
  assert.match(none.stderr, /no campaign found under .*; make one there, or point PIPELINE_CAMPAIGNS_ROOT at yours/);
  assert.match(none.stderr, /Usage:/);

  const { env, add } = sampleCampaign(t);
  add("globex");
  for (const args of [["status"], ["--dry-run"], ["mark", "reel-01-launch", "instagram", "manual"], ["post", "reel-01-launch", "--now"]]) {
    const r = run(args, { env });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, /several campaigns under .* \(acme, globex\); pick one with --campaign <id>/, args.join(" "));
    assert.match(r.stderr, /Usage:/);
    assert.ok(!fs.existsSync(path.join(r.home, "campaigns")), "no campaign's state is touched");
    assert.ok(!fs.existsSync(path.join(r.home, "locks")));
  }
});

test("--campaign runs status, check, mark and the dry run against that campaign only", (t) => {
  const { env, add } = sampleCampaign(t);
  add("globex", { name: "Globex", timezone: "Europe/London", slot: "14:00" });
  const home = tempHome();
  const cli = (args) => run(args, { home, env });

  const status = cli(["status", "--campaign", "globex"]);
  assert.equal(status.code, 0, status.out);
  assert.match(status.stdout, /^globex-one\s+-\s+-\s+-\s+yes$/m);
  assert.doesNotMatch(status.stdout, /reel-01-launch/);
  assert.match(status.stdout, /Instagram token: not set/);

  const check = cli(["check", "--campaign", "globex"]);
  assert.equal(check.code, 0, check.out);
  assert.match(check.stdout, /^ok    globex-one$/m);

  const mark = cli(["mark", "globex-one", "instagram", "manual", "--campaign", "globex"]);
  assert.equal(mark.code, 0, mark.out);
  const state = JSON.parse(fs.readFileSync(path.join(campaignHome(home, "globex"), "state.json"), "utf8"));
  assert.equal(state.items["globex-one"].instagram.status, "manual");
  assert.ok(!fs.existsSync(campaignHome(home, "acme")));
  assert.deepEqual(fs.readdirSync(path.join(home, "locks")), []);
  assert.match(cli(["status", "--campaign", "globex"]).stdout, /^globex-one\s+-\s+manual\s+-\s+yes$/m);

  // Another campaign's items aren't in this one.
  const other = cli(["mark", "reel-01-launch", "instagram", "manual", "--campaign", "globex"]);
  assert.equal(other.code, 1);
  assert.match(other.out, /no item reel-01-launch/);

  const dry = cli(["--dry-run", "--campaign", "globex"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.stdout, /^DRY RUN · Globex · /);
  assert.doesNotMatch(dry.stdout, /reel-/);
});

test("--campaign with an unknown or bad id exits 1", (t) => {
  const { env } = sampleCampaign(t);
  const unknown = run(["status", "--campaign", "nope"], { env });
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /unknown campaign nope/);
  const bad = run(["status", "--campaign", "../acme"], { env });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /bad campaign id/);
  const noValue = run(["status", "--campaign"], { env });
  assert.equal(noValue.code, 1);
  assert.match(noValue.out, /--campaign needs a value/);
});
