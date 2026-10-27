import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, createCampaignSource, startQueueRunner } from "../server.mjs";
import { createPreviews } from "../lib/preview.mjs";
import { buildStatus } from "../lib/status.mjs";
import { getCampaign } from "../../campaigns/lib/campaign.mjs";
import { createSecrets } from "../../campaigns/lib/secrets.mjs";
import { TYPES } from "../../creation/lib/backlog.mjs";
import { DEFAULT_FORMATS } from "../../creation/lib/picker.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
// The real source's clock check must never reach the network from a test.
globalThis.fetch = async () => {
  throw new Error("no network in tests");
};

const LOGIN = "owner@example.com";
const IG_TOKEN = "IGQVJ-fixture-instagram-token-123";
const VIDEO = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

// A temp repo with one scheduled item and one backlog piece, each with an out/ folder,
// plus files that must never be served: one beside out/ and one that isn't media.
function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-repo-"));
  fs.writeFileSync(
    path.join(repoRoot, "schedule.json"),
    JSON.stringify([{ id: "ep-01", kind: "ep", dir: "pieces/ep-01" }]),
  );
  for (const id of ["ep-01", "piece-07"]) {
    const out = path.join(repoRoot, "pieces", id, "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "clip.mp4"), VIDEO);
    fs.writeFileSync(path.join(out, "clip-cover.png"), "png");
    fs.writeFileSync(path.join(out, "clip-caption.txt"), "INSTAGRAM / TIKTOK\nhi\n\nYOUTUBE SHORTS TITLE\nhi\n");
    fs.writeFileSync(path.join(repoRoot, "pieces", id, "outside.mp4"), "not in out");
  }
  fs.writeFileSync(path.join(repoRoot, "backlog.json"), JSON.stringify([{ id: "piece-07", title: "Piece seven" }]));
  return repoRoot;
}

// A publisher home with acme's Instagram token in its secrets.
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  createSecrets(home).set("acme", "IG_ACCESS_TOKEN", IG_TOKEN);
  return home;
}

// A campaigns root holding `configs` (id -> campaign.json).
function makeCampaignsRoot(configs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-campaigns-"));
  for (const [id, config] of Object.entries(configs)) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, "campaign.json"), JSON.stringify(config));
  }
  return root;
}

// acme's campaign.json, rooted at `repoRoot`: the default layout makeRepo writes.
const acmeConfig = (repoRoot) => ({ id: "acme", name: "Acme Coffee", root: repoRoot });

// A source with acme only, whose media are found through its campaign folder as
// the real source finds them, and whose status and actions are `getStatus` and `actions`.
function acmeOnly({ repoRoot, home, getStatus, actions }) {
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const { media } = createCampaignSource({ home, env: {}, root }).get("acme");
  return {
    list: async () => [{ id: "acme", name: "Acme Coffee", paused: false }],
    get: (id) => (id === "acme" ? { getStatus, actions, media } : null),
  };
}

const STATUS = { today: "2026-10-25", connected: true, next: null, queue: [] };

// Starts a server on a free port and hands `fn` a request helper. Requests go through
// http.request so raw paths like /media/../x reach the server unnormalized. Without
// `campaigns`, the server has acme only, with `getStatus` and `actions`.
async function withServer(opts, fn) {
  const repoRoot = makeRepo();
  const home = makeHome();
  const { getStatus = async () => STATUS, actions = {}, campaigns, ...rest } = opts;
  const source = campaigns ?? acmeOnly({ repoRoot, home, getStatus, actions });
  const server = createServer({ campaigns: source, login: LOGIN, ...rest });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const request = (urlPath, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    return await fn({ request, server, repoRoot, home });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("server listens on 127.0.0.1 only", async () => {
  const source = acmeOnly({ repoRoot: makeRepo(), home: makeHome(), getStatus: async () => STATUS, actions: {} });
  const server = createServer({ campaigns: source, login: LOGIN });
  assert.ok(server instanceof http.Server);
  // Even asked for every interface, it binds the loopback address.
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  try {
    assert.equal(server.address().address, "127.0.0.1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const UI_DIR = new URL("../ui/", import.meta.url);
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Every file under dashboard/ui, relative to it with forward slashes.
function uiFiles(dir = fileURLToPath(UI_DIR)) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? uiFiles(full) : [path.relative(fileURLToPath(UI_DIR), full).split(path.sep).join("/")];
  });
}

test("server: GET / serves ui/index.html with the CSP above; GET /ui/app.js is text/javascript; GET /ui/styles.css is text/css; GET /ui/../server.mjs, /ui/package.json and /ui/missing.js are 404", async () => {
  await withServer({}, async ({ request }) => {
    const res = await request("/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^text\/html/);
    assert.equal(res.headers["content-security-policy"], PAGE_CSP);
    assert.equal(res.body.toString("utf8"), fs.readFileSync(new URL("index.html", UI_DIR), "utf8"));

    const app = await request("/ui/app.js");
    assert.equal(app.status, 200);
    assert.match(app.headers["content-type"], /^text\/javascript/);
    assert.equal(app.headers["x-content-type-options"], "nosniff");
    assert.equal(app.body.toString("utf8"), fs.readFileSync(new URL("app.js", UI_DIR), "utf8"));
    const css = await request("/ui/styles.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /^text\/css/);

    // Every UI file but the page and package.json is on the allowlist.
    for (const rel of uiFiles().filter((f) => f !== "index.html" && f !== "package.json")) {
      const file = await request(`/ui/${rel}`);
      assert.equal(file.status, 200, rel);
      assert.match(file.headers["content-type"], rel.endsWith(".css") ? /^text\/css/ : /^text\/javascript/, rel);
    }

    for (const p of [
      "/ui/../server.mjs",
      "/ui/..%2Fserver.mjs",
      "/ui/package.json",
      "/ui/missing.js",
      "/ui/index.html",
      "/ui/",
      "/ui/APP.js",
      "/ui/app.js/",
      "/ui\\app.js",
      "/page.html",
      "/nope",
    ]) {
      assert.equal((await request(p)).status, 404, p);
    }
  });
});

test("status canAct false without the identity header, true with the right login", async () => {
  await withServer({}, async ({ request }) => {
    const anon = await request("/api/status");
    assert.equal(anon.status, 200);
    assert.match(anon.headers["content-type"], /^application\/json/);
    assert.equal(anon.headers["cache-control"], "no-store");
    const a = JSON.parse(anon.body);
    assert.equal(a.canAct, false);
    assert.equal("csrf" in a, false);
    assert.equal(a.today, STATUS.today);
    assert.equal(a.connected, true);

    const wrong = JSON.parse((await request("/api/status", { "Tailscale-User-Login": "stranger@example.com" })).body);
    assert.equal(wrong.canAct, false);
    assert.equal("csrf" in wrong, false);

    const me = JSON.parse((await request("/api/status", { "Tailscale-User-Login": LOGIN })).body);
    assert.equal(me.canAct, true);
    assert.equal(me.login, LOGIN, "the signed-in login, for the header");
    assert.equal("login" in a, false);
    assert.equal("login" in wrong, false);
    assert.equal(typeof me.csrf, "string");
    assert.ok(me.csrf.length >= 32);
    const again = JSON.parse((await request("/api/status", { "Tailscale-User-Login": LOGIN })).body);
    assert.equal(again.csrf, me.csrf, "one token per server start");
    assert.ok(!JSON.stringify(me).includes(IG_TOKEN));
  });

  // No DASHBOARD_LOGIN configured: nobody can act, not even a request without the header.
  for (const login of [undefined, ""]) {
    await withServer({ login }, async ({ request }) => {
      assert.equal(JSON.parse((await request("/api/status")).body).canAct, false);
      assert.equal(JSON.parse((await request("/api/status", { "Tailscale-User-Login": "" })).body).canAct, false);
    });
  }
});

test("status carries the todos, worst first", async () => {
  const getStatus = async () => ({
    ...STATUS,
    problems: { failed: [{ id: "ep-03", platform: "instagram", error: "boom", at: "x" }], dropped: [], notReady: [], warnings: [] },
    creation: { counts: {}, awaiting: [{ id: "post-06", title: "Two phones" }], failed: [], redo: [], building: [], error: null },
  });
  await withServer({ getStatus }, async ({ request }) => {
    const { todos } = JSON.parse((await request("/api/status")).body);
    assert.deepEqual(todos.map((t) => [t.severity, t.action.label]), [["red", "Retry"], ["purple", "Review"]]);
  });
  await withServer({}, async ({ request }) => {
    assert.deepEqual(JSON.parse((await request("/api/status")).body).todos, []);
  });
});

test("status failure is a 500 without details beyond the message", async () => {
  await withServer({ getStatus: async () => { throw new Error("schedule broken"); } }, async ({ request }) => {
    const res = await request("/api/status");
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { error: "schedule broken" });
  });
});

test("media serves an item mp4 with Range", async () => {
  await withServer({}, async ({ request }) => {
    const full = await request("/media/ep-01/clip.mp4");
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-type"], "video/mp4");
    assert.equal(full.headers["accept-ranges"], "bytes");
    assert.equal(Number(full.headers["content-length"]), VIDEO.length);
    assert.deepEqual(full.body, VIDEO);

    const part = await request("/media/ep-01/clip.mp4", { Range: "bytes=10-19" });
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], `bytes 10-19/${VIDEO.length}`);
    assert.equal(Number(part.headers["content-length"]), 10);
    assert.deepEqual(part.body, VIDEO.subarray(10, 20));

    const open = await request("/media/ep-01/clip.mp4", { Range: "bytes=30-" });
    assert.equal(open.status, 206);
    assert.deepEqual(open.body, VIDEO.subarray(30));

    const suffix = await request("/media/ep-01/clip.mp4", { Range: "bytes=-4" });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers["content-range"], `bytes ${VIDEO.length - 4}-${VIDEO.length - 1}/${VIDEO.length}`);
    assert.deepEqual(suffix.body, VIDEO.subarray(-4));

    const past = await request("/media/ep-01/clip.mp4", { Range: "bytes=999-" });
    assert.equal(past.status, 416);
    assert.equal(past.headers["content-range"], `bytes */${VIDEO.length}`);

    const cover = await request("/media/ep-01/clip-cover.png");
    assert.equal(cover.status, 200);
    assert.equal(cover.headers["content-type"], "image/png");

    // A backlog piece (video creation) is served too.
    const piece = await request("/media/piece-07/clip.mp4");
    assert.equal(piece.status, 200);
    assert.deepEqual(piece.body, VIDEO);
  });
});

test("media path traversal is 404", async () => {
  await withServer({}, async ({ request }) => {
    for (const p of [
      "/media/../../tokens.json",
      "/media/ep-01/../../../tokens.json",
      "/media/ep-01/..%2F..%2F..%2Fpublishing%2Fschedule.json",
      "/media/ep-01/..%2Foutside.mp4",
      "/media/ep-01/%2e%2e/outside.mp4",
      "/media/ep-01/..\\outside.mp4",
      "/media/ep-01/..%5Coutside.mp4",
      "/media/ep-01/clip-caption.txt",
      "/media/ep-01/",
      "/media/ep-01",
      "/media/ep-01/missing.mp4",
      "/media/ep-01/sub/clip.mp4",
      "/media/..%2F..%2Fpublishing/schedule.json",
    ]) {
      const res = await request(p);
      assert.equal(res.status, 404, p);
      assert.ok(!res.body.toString().includes(IG_TOKEN), p);
    }
  });
});

test("unknown id is 404", async () => {
  await withServer({}, async ({ request, repoRoot }) => {
    // A folder that exists on disk but is in neither the schedule nor the backlog.
    const out = path.join(repoRoot, "pieces", "stray", "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "clip.mp4"), VIDEO);
    assert.equal((await request("/media/stray/clip.mp4")).status, 404);
    assert.equal((await request("/media/nope/clip.mp4")).status, 404);
    assert.equal((await request("/media/EP-01/clip.mp4")).status, 404);
  });
});

// Fake actions that record every call, so a test can assert nothing posted.
function fakeActions() {
  const calls = [];
  return {
    calls,
    async postNow(args) {
      calls.push(["postNow", args]);
      return args.force
        ? { ok: true, id: "f2", platform: "instagram", outcome: "posted", url: "https://www.instagram.com/reel/r1/" }
        : { ok: false, needsForce: true, id: "f2", platform: "instagram" };
    },
    async retry(args) {
      calls.push(["retry", args]);
      return { ok: true, id: args.id, platform: args.platform, outcome: "posted", url: "https://youtube.com/shorts/V1" };
    },
    ...Object.fromEntries(
      ["postItem", "hold", "release", "pin", "unpin", "reorder", "drop", "approve", "redo", "recheck", "buildNow", "unqueue", "saveIdea", "removeIdea", "setInstagramToken", "setTelegram", "testTelegram", "setSecret"].map((name) => [
        name,
        async (args) => {
          calls.push([name, args]);
          return { ok: true, message: `${name} done` };
        },
      ]),
    ),
  };
}

// POSTs `body` to /api/action as the tailnet user would, from the dashboard's own
// origin. A header set to undefined in `headers` is left out.
function poster(port) {
  return (body, headers = {}) =>
    new Promise((resolve, reject) => {
      const all = {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
        "Tailscale-User-Login": LOGIN,
        ...headers,
      };
      for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/action", headers: all }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(typeof body === "string" ? body : JSON.stringify(body));
    });
}

async function withActions(fn, opts = {}) {
  const actions = fakeActions();
  await withServer({ actions, ...opts }, async ({ request, server }) => {
    const post = poster(server.address().port);
    const { csrf } = JSON.parse((await request("/api/status", { "Tailscale-User-Login": LOGIN })).body);
    await fn({ post, csrf, actions, request });
  });
  return actions;
}

test("action without identity is 403", async () => {
  await withActions(async ({ post, csrf, actions }) => {
    for (const login of [undefined, "", "stranger@example.com", LOGIN.toUpperCase()]) {
      const res = await post({ action: "postNow", csrf, force: true }, { "Tailscale-User-Login": login });
      assert.equal(res.status, 403, String(login));
      assert.equal(JSON.parse(res.body).ok, false);
    }
    assert.deepEqual(actions.calls, []);
  });

  // No DASHBOARD_LOGIN configured: nobody can act.
  for (const login of [undefined, ""]) {
    const actions = fakeActions();
    await withServer({ actions, login }, async ({ server }) => {
      const res = await poster(server.address().port)({ action: "postNow", force: true, csrf: "x" }, { "Tailscale-User-Login": "" });
      assert.equal(res.status, 403);
    });
    assert.deepEqual(actions.calls, []);
  }
});

test("wrong csrf is 403", async () => {
  // A token from an earlier server start.
  let old;
  await withActions(async ({ csrf }) => {
    old = csrf;
  });
  await withActions(async ({ post, csrf, actions }) => {
    assert.notEqual(old, csrf);
    for (const body of [
      { action: "postNow", force: true },
      { action: "postNow", force: true, csrf: "" },
      { action: "postNow", force: true, csrf: old },
      { action: "postNow", force: true, csrf: `${csrf}x` },
      { action: "postNow", force: true, csrf: csrf.slice(1) },
      { action: "postNow", force: true, csrf: 123 },
    ]) {
      assert.equal((await post(body)).status, 403, JSON.stringify(body));
    }
    assert.deepEqual(actions.calls, []);
  });
});

test("foreign Origin is 403", async () => {
  await withActions(async ({ post, csrf, actions }) => {
    for (const origin of ["https://evil.example", "http://127.0.0.1:1", "null", "", "not a url", undefined]) {
      assert.equal((await post({ action: "postNow", force: true, csrf }, { Origin: origin })).status, 403, String(origin));
    }
    assert.deepEqual(actions.calls, []);

    // The Origin must match whatever Host the request came in on (tailscale serve).
    const res = await post({ action: "postNow", force: true, csrf }, { Host: "pc.tailnet-1234.ts.net", Origin: "https://pc.tailnet-1234.ts.net" });
    assert.equal(res.status, 200);
    assert.equal(actions.calls.length, 1);
  });
});

test("actions run with the right arguments and return their result", async () => {
  await withActions(async ({ post, csrf, actions, request }) => {
    const refused = await post({ action: "postNow", csrf, id: "f2" });
    assert.equal(refused.status, 200);
    assert.deepEqual(JSON.parse(refused.body), { ok: false, needsForce: true, id: "f2", platform: "instagram" });

    const forced = JSON.parse((await post({ action: "postNow", csrf, id: "f2", force: true })).body);
    assert.equal(forced.ok, true);

    const retried = JSON.parse((await post({ action: "retry", csrf, id: "f1", platform: "youtube" })).body);
    assert.equal(retried.platform, "youtube");

    // Only a literal true forces.
    await post({ action: "postNow", csrf, force: "yes" });

    assert.deepEqual(actions.calls, [
      ["postNow", { id: "f2", force: false }],
      ["postNow", { id: "f2", force: true }],
      ["retry", { id: "f1", platform: "youtube" }],
      ["postNow", { id: undefined, force: false }],
    ]);

    assert.equal((await post({ action: "launch", csrf })).status, 400);
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post({ action: "postNow", csrf, force: true }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post("x".repeat(20000))).status, 413);
    assert.equal((await request("/api/action")).status, 404, "GET is not an action");
    assert.equal(actions.calls.length, 4);
  });
});

test("server: each new action needs the login, CSRF and Origin, as postNow does; an unknown action is 400", async () => {
  const valid = {
    postItem: { id: "f2", force: true },
    hold: { id: "f1" },
    release: { id: "f1" },
    pin: { id: "f1", date: "2026-11-02" },
    unpin: { id: "f1" },
    reorder: { id: "f1", before: "f3" },
    drop: { id: "f1", platform: "youtube" },
    approve: { id: "f1" },
    redo: { id: "f1", note: "Make the hook shorter." },
    recheck: { id: "f1" },
    buildNow: { id: "f1" },
    saveIdea: { entry: { title: "Chai or coffee", premise: "Which wins?", format: "episode", type: "story", targetDate: "2026-11-02" } },
    removeIdea: { id: "f1" },
    setInstagramToken: { token: "IGAA-pasted-token" },
    setTelegram: { botToken: "123:AA-bot", approvers: ["111"] },
    testTelegram: {},
    setSecret: { name: "ANTHROPIC_API_KEY", value: "sk-ant-key" },
  };
  await withActions(async ({ post, csrf, actions }) => {
    for (const [action, args] of Object.entries(valid)) {
      const body = { action, csrf, ...args };
      assert.equal((await post(body, { "Tailscale-User-Login": undefined })).status, 403, `${action} without login`);
      assert.equal((await post(body, { "Tailscale-User-Login": "stranger@example.com" })).status, 403, `${action} wrong login`);
      assert.equal((await post({ ...body, csrf: `${csrf}x` })).status, 403, `${action} wrong csrf`);
      assert.equal((await post({ action, ...args })).status, 403, `${action} no csrf`);
      assert.equal((await post(body, { Origin: "https://evil.example" })).status, 403, `${action} foreign origin`);
      assert.equal((await post(body, { Origin: undefined })).status, 403, `${action} no origin`);
    }
    assert.deepEqual(actions.calls, [], "nothing ran");

    for (const [action, args] of Object.entries(valid)) {
      const res = await post({ action, csrf, ...args });
      assert.equal(res.status, 200, action);
      assert.deepEqual(JSON.parse(res.body), { ok: true, message: `${action} done` });
    }
    // Each gets only its own arguments; force is a literal true and before may be null.
    await post({ action: "postItem", csrf, id: "f2", force: "yes", platform: "youtube" });
    await post({ action: "reorder", csrf, id: "f1", before: null });
    await post({ action: "setTelegram", csrf, approvers: ["222"], id: "f1" });
    assert.deepEqual(actions.calls, [
      ...Object.entries(valid),
      ["postItem", { id: "f2", force: false }],
      ["reorder", { id: "f1", before: null }],
      ["setTelegram", { botToken: undefined, approvers: ["222"] }],
    ]);

    for (const action of ["launch", "__proto__", "constructor", "toString", "", undefined, 7]) {
      assert.equal((await post({ action, csrf, id: "f1" })).status, 400, String(action));
    }
    for (const body of [
      { action: "hold", id: "F1" },
      { action: "hold", id: "../f1" },
      { action: "hold" },
      { action: "release", id: 7 },
      { action: "unpin", id: "" },
      { action: "pin", id: "f1", date: "2026-02-30" },
      { action: "pin", id: "f1", date: "2026-11-2" },
      { action: "pin", id: "f1" },
      { action: "reorder", id: "f1", before: "F3" },
      { action: "reorder", id: "f1" },
      { action: "drop", id: "f1", platform: "tiktok" },
      { action: "drop", id: "f1" },
      { action: "retry", id: "f1", platform: "tiktok" },
      { action: "retry", id: "F1", platform: "instagram" },
      { action: "postItem" },
      { action: "postNow", id: "F2" },
      { action: "approve", id: "F1" },
      { action: "redo", id: "f1" },
      { action: "redo", id: "f1", note: 7 },
      { action: "buildNow" },
      { action: "recheck", id: "../f1" },
      { action: "saveIdea" },
      { action: "saveIdea", entry: "title" },
      { action: "saveIdea", entry: null },
      { action: "saveIdea", entry: [] },
      { action: "removeIdea" },
      { action: "removeIdea", id: "F1" },
      { action: "setInstagramToken" },
      { action: "setInstagramToken", token: 7 },
      { action: "setTelegram", botToken: 7 },
      { action: "setTelegram", approvers: "111" },
      { action: "setSecret", name: "ANTHROPIC_API_KEY" },
      { action: "setSecret", value: "sk-ant-key" },
    ]) {
      const res = await post({ ...body, csrf });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(JSON.parse(res.body).ok, false);
    }
    assert.equal(actions.calls.length, Object.keys(valid).length + 3, "no bad request ran");
    // A bad argument's refusal names the field, never what was sent.
    const bad = await post({ action: "setTelegram", csrf, botToken: { secret: "123:AA-bot-value" } });
    assert.deepEqual(JSON.parse(bad.body), { ok: false, error: "bad botToken" });

    // Bodies up to 16 KB are read.
    assert.equal((await post({ action: "hold", csrf, id: "f1", note: "x".repeat(12000) })).status, 200);
  });
});

test("server: unqueue needs login, CSRF and Origin like the other actions", async () => {
  await withActions(async ({ post, csrf, actions }) => {
    const body = { action: "unqueue", csrf, id: "f1" };
    assert.equal((await post(body, { "Tailscale-User-Login": undefined })).status, 403, "without login");
    assert.equal((await post(body, { "Tailscale-User-Login": "stranger@example.com" })).status, 403, "wrong login");
    assert.equal((await post({ ...body, csrf: `${csrf}x` })).status, 403, "wrong csrf");
    assert.equal((await post({ action: "unqueue", id: "f1" })).status, 403, "no csrf");
    assert.equal((await post(body, { Origin: "https://evil.example" })).status, 403, "foreign origin");
    assert.equal((await post(body, { Origin: undefined })).status, 403, "no origin");
    assert.deepEqual(actions.calls, [], "nothing ran");

    for (const bad of [{}, { id: "F1" }, { id: "../f1" }, { id: 7 }]) {
      assert.equal((await post({ action: "unqueue", csrf, ...bad })).status, 400, JSON.stringify(bad));
    }
    const res = await post({ ...body, note: "ignored", platform: "youtube" });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, message: "unqueue done" });
    assert.deepEqual(actions.calls, [["unqueue", { id: "f1" }]]);
  });
});

test("saveIdea and removeIdea edit a real campaign's build list and commit it; the pipeline shows the idea's fields", async () => {
  const repoRoot = makeRepo();
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true }).trim();
  const entry = { id: "piece-07", kind: "post", format: "this-or-that", type: "participation", title: "Piece seven", premise: "p", targetDate: "2999-01-01", hook: null, reference: "ep-01" };
  fs.writeFileSync(path.join(repoRoot, "backlog.json"), `${JSON.stringify([entry], null, 2)}\n`);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const source = createCampaignSource({ home: makeHome(), env: {}, root });

  await withServer({ campaigns: source }, async ({ request, server }) => {
    const post = poster(server.address().port);
    const { csrf } = JSON.parse((await request("/api/status", { "Tailscale-User-Login": LOGIN })).body);
    const idea = { title: "Chai or coffee", premise: "Which wins?", format: "this-or-that", type: "participation", targetDate: "2999-01-02" };
    const saved = JSON.parse((await post({ action: "saveIdea", csrf, entry: idea })).body);
    assert.equal(saved.ok, true, saved.error);
    assert.equal(git("log", "-1", "--format=%s"), "ideas: add chai-or-coffee");

    const { builds } = JSON.parse((await request("/api/pipeline")).body);
    assert.deepEqual(builds.find((b) => b.id === "chai-or-coffee").idea, { premise: "Which wins?", format: "this-or-that", targetDate: "2999-01-02" });

    const removed = JSON.parse((await post({ action: "removeIdea", csrf, id: "chai-or-coffee" })).body);
    assert.equal(removed.ok, true, removed.error);
    assert.equal(git("log", "-1", "--format=%s"), "ideas: remove chai-or-coffee");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoRoot, "backlog.json"), "utf8")), [entry]);
  });
});

test("setTelegram and setSecret through the real campaign source write that campaign's campaign.json and secrets; the status shows neither value", async () => {
  const repoRoot = makeRepo();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const home = makeHome();
  const source = createCampaignSource({ home, env: {}, root });
  const key = "sk-ant-fixture-server-key-123";

  await withServer({ campaigns: source }, async ({ request, server }) => {
    const post = poster(server.address().port);
    const { csrf } = JSON.parse((await request("/api/status", { "Tailscale-User-Login": LOGIN })).body);
    const saved = JSON.parse((await post({ action: "setTelegram", csrf, approvers: ["4242", "-100777"] })).body);
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "acme", "campaign.json"), "utf8")).approvers, ["4242", "-100777"]);
    assert.equal(fs.readdirSync(path.join(home, "campaigns", "acme", "backups")).filter((f) => f.startsWith("campaign-")).length, 1);

    const set = JSON.parse((await post({ action: "setSecret", csrf, name: "ANTHROPIC_API_KEY", value: key })).body);
    assert.equal(set.ok, true, set.error);
    assert.equal(createSecrets(home).get("acme", "ANTHROPIC_API_KEY"), key);

    const body = (await request("/api/status", { "Tailscale-User-Login": LOGIN })).body;
    const status = JSON.parse(body);
    assert.deepEqual(status.connections.telegram.approvers, ["4242", "-100777"]);
    assert.equal(status.connections.secrets.ANTHROPIC_API_KEY.set, true);
    assert.ok(!body.includes(key) && !body.includes(IG_TOKEN), "no secret value in the status");
  });
});

test("createCampaign, setPaused and saveSettings through the real campaign source; /api/campaigns lists the new one with its settings", async (t) => {
  // The new folder's commit uses the owner's git identity; a test brings its own.
  const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const saved = Object.fromEntries(Object.keys(identity).map((k) => [k, process.env[k]]));
  Object.assign(process.env, identity);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const repoRoot = makeRepo();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const home = makeHome();
  const source = createCampaignSource({ home, env: {}, root, exec: async () => ({ stdout: "" }) });

  await withServer({ campaigns: source }, async ({ request, server }) => {
    const post = poster(server.address().port);
    const { csrf } = JSON.parse((await request("/api/status", { "Tailscale-User-Login": LOGIN })).body);
    const list = async () => JSON.parse((await request("/api/campaigns")).body).campaigns;
    assert.deepEqual((await list()).map((c) => c.id), ["acme"]);
    assert.equal((await list())[0].settings.slot, "19:30");

    // The campaign named in the body doesn't matter: createCampaign is the console's.
    const created = JSON.parse((await post({ action: "createCampaign", campaign: "nope", csrf, id: "initech", name: "Initech", template: "blank" })).body);
    assert.equal(created.ok, true, created.error);
    const initech = (await list()).find((c) => c.id === "initech");
    assert.equal(initech.paused, true);
    assert.equal(initech.settings.name, "Initech");

    const resumed = JSON.parse((await post({ action: "setPaused", campaign: "initech", csrf, paused: false })).body);
    assert.equal(resumed.ok, true, resumed.error);
    const renamed = JSON.parse((await post({ action: "saveSettings", campaign: "initech", csrf, fields: { name: "Initech Studio", "checks.detect": false } })).body);
    assert.equal(renamed.ok, true, renamed.error);
    const after = (await list()).find((c) => c.id === "initech");
    assert.deepEqual([after.name, after.paused, after.settings["checks.detect"]], ["Initech Studio", false, false]);
    assert.equal(getCampaign("acme", { root, home }).paused, false, "acme untouched");

    for (const body of [{ action: "setPaused", paused: "yes" }, { action: "saveSettings", fields: [] }, { action: "createCampaign", id: "x", name: "X" }]) {
      assert.equal((await post({ ...body, csrf })).status, 400, JSON.stringify(body));
    }
    assert.equal((await post({ action: "createCampaign", csrf, id: "beta", name: "Beta", template: "blank" }, { "Tailscale-User-Login": undefined })).status, 403);
    assert.ok(!fs.existsSync(path.join(root, "beta")));
  });
});

// setInterval and clearInterval that only record: the test fires the runner's ticks.
function fakeTimers() {
  const timers = { set: [], cleared: [] };
  timers.setInterval = (fn, ms) => {
    const handle = { fn, ms };
    timers.set.push(handle);
    return handle;
  };
  timers.clearInterval = (handle) => timers.cleared.push(handle);
  return timers;
}

const fakeLog = () => {
  const lines = [];
  return { lines, info: (msg, data) => lines.push(["info", msg, data]), error: (msg, data) => lines.push(["error", msg, data]) };
};

test("queue runner: calls startNextQueued for each unpaused campaign every interval", async () => {
  // The real source's targets: acme, and a paused second campaign.
  const root = makeCampaignsRoot({
    acme: acmeConfig(makeRepo()),
    beta: { ...acmeConfig(makeRepo()), id: "beta", name: "Beta", paused: true },
  });
  const source = createCampaignSource({ home: makeHome(), env: {}, root });
  const targets = source.queueTargets();
  assert.deepEqual(targets.map(({ campaign }) => [campaign.id, campaign.paused]), [["acme", false], ["beta", true]]);
  for (const { campaign, deps } of targets) {
    assert.equal(deps.home, campaign.home, "the console's own creation deps");
    assert.equal(typeof deps.withLock, "function");
  }

  const timers = fakeTimers();
  const started = [];
  const runner = startQueueRunner({
    campaigns: () => source.queueTargets(),
    startNext: async ({ campaign, deps }) => started.push([campaign.id, deps.home === campaign.home]),
    timers,
  });
  assert.equal(timers.set.length, 1);
  assert.equal(timers.set[0].ms, 60000, "every minute by default");
  await timers.set[0].fn();
  await timers.set[0].fn();
  assert.deepEqual(started, [["acme", true], ["acme", true]], "beta is paused");
  runner.stop();
});

test("queue runner: a throw for one campaign doesn't stop the others", async () => {
  const logs = { a: fakeLog(), b: fakeLog(), c: fakeLog() };
  const target = (id) => ({ campaign: { id, paused: false }, deps: { log: logs[id] } });
  const timers = fakeTimers();
  const started = [];
  const owner = fakeLog();
  startQueueRunner({
    campaigns: async () => [target("a"), target("b"), target("c")],
    startNext: async ({ campaign }) => {
      started.push(campaign.id);
      if (campaign.id === "b") throw new Error("lock b:build-queue busy");
    },
    log: owner,
    timers,
  });
  await timers.set[0].fn();
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.deepEqual(logs.b.lines, [["error", "queue runner: queued build not started", { error: "lock b:build-queue busy" }]], "in that campaign's log");
  assert.deepEqual([...logs.a.lines, ...logs.c.lines, ...owner.lines], []);

  // A campaign list that can't be read goes to the console's own log, and the next tick tries again.
  let fail = true;
  const again = fakeTimers();
  startQueueRunner({
    campaigns: async () => {
      if (fail) throw new Error("campaigns root unreadable");
      return [target("a")];
    },
    startNext: async ({ campaign }) => started.push(campaign.id),
    log: owner,
    timers: again,
  });
  await again.set[0].fn();
  assert.deepEqual(owner.lines, [["error", "queue runner: campaigns not read", { error: "campaigns root unreadable" }]]);
  fail = false;
  await again.set[0].fn();
  assert.deepEqual(started.slice(3), ["a"]);
});

test("queue runner: a throwing log doesn't produce an unhandled rejection", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const throwingLog = { info() { throw new Error("disk full"); }, error() { throw new Error("disk full"); } };
  const started = [];
  const target = (id) => ({ campaign: { id, paused: false }, deps: { log: throwingLog } });

  // Through the timer's own callback: it settles, and the campaign after the failure still runs.
  const timers = fakeTimers();
  startQueueRunner({
    campaigns: async () => [target("a"), target("b")],
    startNext: async ({ campaign }) => {
      started.push(campaign.id);
      if (campaign.id === "a") throw new Error("lock a:build-queue busy");
    },
    log: throwingLog,
    timers,
  });
  await timers.set[0].fn();
  assert.deepEqual(started, ["a", "b"]);

  // With real timers, a list that can't be read and a log that throws on every line.
  const real = startQueueRunner({
    campaigns: async () => {
      throw new Error("campaigns root unreadable");
    },
    log: throwingLog,
    intervalMs: 5,
  });
  await new Promise((r) => setTimeout(r, 40));
  real.stop();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(unhandled, []);
});

test("queue runner: stop() clears the interval", async () => {
  const timers = fakeTimers();
  const runner = startQueueRunner({ campaigns: async () => [], startNext: async () => {}, intervalMs: 5, timers });
  assert.equal(timers.set[0].ms, 5);
  runner.stop();
  assert.deepEqual(timers.cleared, [timers.set[0]]);

  // With the real timers too: no tick after stop().
  let ticks = 0;
  const real = startQueueRunner({ campaigns: async () => [{ campaign: { id: "a", paused: false }, deps: {} }], startNext: async () => void ticks++, intervalMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  real.stop();
  const seen = ticks;
  assert.ok(seen >= 1, `${seen} ticks`);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ticks, seen);
});

test("an action that throws is a 500 with its message", async () => {
  const actions = {
    async postNow() {
      throw new Error("schedule broken");
    },
  };
  await withServer({ actions }, async ({ request, server }) => {
    const { csrf } = JSON.parse((await request("/api/status", { "Tailscale-User-Login": LOGIN })).body);
    const res = await poster(server.address().port)({ action: "postNow", csrf });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: "schedule broken" });
  });
});

// --- Campaigns -------------------------------------------------------------------

// A campaign root like makeRepo's, with the generic layout: schedule.json at the root
// and pieces/<id>/out.
function makeCampaignRoot(ids) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-root-"));
  fs.writeFileSync(path.join(root, "schedule.json"), JSON.stringify(ids.map((id) => ({ id, kind: "ep", dir: `pieces/${id}` }))));
  for (const id of ids) {
    const out = path.join(root, "pieces", id, "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "clip.mp4"), VIDEO);
  }
  return root;
}

// A fake campaign source: acme plus beta, listed in that order, each with its own
// status, actions and media folder.
function fakeSource(repoRoot) {
  const betaRoot = makeCampaignRoot(["b1"]);
  const entries = {
    acme: { name: "Acme Coffee", status: STATUS, actions: fakeActions(), media: { root: repoRoot, itemDir: (id) => (id === "ep-01" ? "pieces/ep-01" : null) } },
    beta: {
      name: "Beta",
      paused: true,
      status: { ...STATUS, today: "2026-10-26", connected: false },
      actions: fakeActions(),
      media: { root: betaRoot, itemDir: (id) => (id === "b1" ? "pieces/b1" : null) },
    },
  };
  return {
    entries,
    list: async () => Object.entries(entries).map(([id, e]) => ({ id, name: e.name, paused: e.paused === true })),
    get(id) {
      const e = entries[id];
      return e ? { getStatus: async () => ({ ...e.status, problems: { failed: [], notReady: [], dropped: [], warnings: [] } }), actions: e.actions, media: e.media } : null;
    },
  };
}

async function withCampaigns(fn) {
  const repoRoot = makeRepo();
  const campaigns = fakeSource(repoRoot);
  await withServer({ campaigns }, async ({ request, server }) => {
    const post = poster(server.address().port);
    const { csrf } = JSON.parse((await request("/api/status", { "Tailscale-User-Login": LOGIN })).body);
    await fn({ request, post, csrf, campaigns });
  });
}

test("campaigns are listed with a health summary", async () => {
  await withCampaigns(async ({ request }) => {
    const res = await request("/api/campaigns");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(res.body), {
      campaigns: [
        { id: "acme", name: "Acme Coffee", paused: false, health: "ok", connected: true, next: null, problems: 0 },
        { id: "beta", name: "Beta", paused: true, health: "problems", connected: false, next: null, problems: 0 },
      ],
    });
  });
});

test("status per campaign, defaulting to the first one the source lists", async () => {
  await withCampaigns(async ({ request }) => {
    assert.equal(JSON.parse((await request("/api/status")).body).today, "2026-10-25");
    assert.equal(JSON.parse((await request("/api/status?campaign=acme")).body).today, "2026-10-25");
    const beta = JSON.parse((await request("/api/status?campaign=beta", { "Tailscale-User-Login": LOGIN })).body);
    assert.equal(beta.today, "2026-10-26");
    assert.equal(beta.canAct, true);

    // Media comes from the named campaign's folders only.
    const piece = await request("/media/b1/clip.mp4?campaign=beta");
    assert.equal(piece.status, 200);
    assert.deepEqual(piece.body, VIDEO);
    assert.equal((await request("/media/b1/clip.mp4")).status, 404);
    assert.equal((await request("/media/ep-01/clip.mp4?campaign=beta")).status, 404);
    assert.equal((await request("/media/ep-01/clip.mp4?campaign=acme")).status, 200);
  });
});

test("actions are routed to the named campaign", async () => {
  await withCampaigns(async ({ post, csrf, campaigns }) => {
    const res = await post({ action: "retry", campaign: "beta", csrf, id: "b1", platform: "instagram" });
    assert.equal(res.status, 200);
    assert.deepEqual(campaigns.entries.beta.actions.calls, [["retry", { id: "b1", platform: "instagram" }]]);
    assert.deepEqual(campaigns.entries.acme.actions.calls, []);

    await post({ action: "postNow", csrf, id: "ep-01" });
    await post({ action: "postNow", campaign: "acme", csrf, id: "ep-01", force: true });
    assert.deepEqual(campaigns.entries.acme.actions.calls, [
      ["postNow", { id: "ep-01", force: false }],
      ["postNow", { id: "ep-01", force: true }],
    ]);
    assert.equal(campaigns.entries.beta.actions.calls.length, 1);
  });
});

test("unknown campaign is 404", async () => {
  await withCampaigns(async ({ request, post, csrf, campaigns }) => {
    for (const q of ["nope", "", "..%2Fbeta", "BETA", "beta%00"]) {
      const res = await request(`/api/status?campaign=${q}`);
      assert.equal(res.status, 404, q);
      assert.deepEqual(JSON.parse(res.body), { error: "unknown campaign" });
      assert.equal((await request(`/media/b1/clip.mp4?campaign=${q}`)).status, 404, q);
    }
    for (const campaign of ["nope", "", 7, null, "../beta"]) {
      const res = await post({ action: "postNow", campaign, csrf, force: true });
      assert.equal(res.status, 404, String(campaign));
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: "unknown campaign" });
    }
    // Still 403 first for a request that isn't allowed to act.
    assert.equal((await post({ action: "postNow", campaign: "nope", csrf }, { "Tailscale-User-Login": undefined })).status, 403);
    assert.deepEqual(campaigns.entries.acme.actions.calls, []);
    assert.deepEqual(campaigns.entries.beta.actions.calls, []);
  });
});

// A campaign's state in its own home: ep-01 posted today.
function postedInCampaignHome(campaign) {
  fs.mkdirSync(campaign.home, { recursive: true });
  fs.writeFileSync(
    path.join(campaign.home, "state.json"),
    JSON.stringify({ version: 1, items: { "ep-01": { instagram: { status: "posted", date: "2026-10-25", at: "x" } } } }),
  );
}

test("server: GET /api/status without ?campaign serves the first campaign in folder order", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const campaign = getCampaign("acme", { root, home });
  postedInCampaignHome(campaign);
  // A state file at the top of the publisher home isn't the campaign's.
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ version: 1, items: {} }));
  const exec = async () => ({ stdout: "" });
  const now = () => new Date("2026-10-25T10:00:00Z");
  const source = createCampaignSource({ home, env: {}, root, exec, now });

  await withServer({ campaigns: source }, async ({ request }) => {
    const res = await request("/api/status");
    assert.equal(res.status, 200);
    const { canAct, todos, ...status } = JSON.parse(res.body);
    assert.equal(canAct, false);
    assert.ok(Array.isArray(todos));
    assert.deepEqual(status, await buildStatus({ now: now(), campaign, secrets: createSecrets(home), exec }));
    assert.deepEqual(status.posted.map((p) => p.id), ["ep-01"]);
    assert.equal(status.connected, true);
    assert.ok(!res.body.toString().includes(IG_TOKEN));

    assert.equal((await request("/media/ep-01/clip.mp4")).status, 200);
    assert.equal((await request("/media/piece-07/clip.mp4")).status, 200, "a build-list piece");

    // A campaign whose folder sorts first becomes the default; no id is special.
    const firstRoot = makeCampaignRoot([]);
    fs.mkdirSync(path.join(root, "aaa-first"));
    fs.writeFileSync(path.join(root, "aaa-first", "campaign.json"), JSON.stringify({ id: "aaa-first", name: "First", root: firstRoot }));
    assert.equal(JSON.parse((await request("/api/status")).body).campaign.id, "aaa-first");
    assert.equal((await request("/media/ep-01/clip.mp4")).status, 404);
    assert.equal((await request("/media/ep-01/clip.mp4?campaign=acme")).status, 200);
  });
});

test("a broken build list or build progress file still serves the status", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const campaign = getCampaign("acme", { root, home });
  fs.mkdirSync(campaign.home, { recursive: true });
  const progress = path.join(campaign.home, "creation-state.json");
  fs.writeFileSync(progress, JSON.stringify({ items: { "piece-07": { status: "failed", attempts: 1, reason: "checks failed", at: "x" } } }));
  // A hand-edit typo in the build list.
  fs.writeFileSync(path.join(repoRoot, "backlog.json"), `[{ "id": "piece-07", "title": "Piece seven" ${IG_TOKEN}`);
  const source = createCampaignSource({ home, env: {}, root, exec: async () => ({ stdout: "" }), now: () => new Date("2026-10-25T10:00:00Z") });

  await withServer({ campaigns: source }, async ({ request }) => {
    const res = await request("/api/status");
    assert.equal(res.status, 200);
    const status = JSON.parse(res.body);
    assert.deepEqual(status.queue.map((q) => q.id), ["ep-01"], "the posting queue is still there");
    assert.equal(status.next.id, "ep-01");
    assert.match(status.creation.error, /can't read build list .*backlog\.json/);
    assert.deepEqual(status.creation.failed.map((f) => [f.id, f.title, f.reason]), [["piece-07", "piece-07", "checks failed"]], "titles fall back to ids");
    assert.ok(!res.body.toString().includes(IG_TOKEN), "the error is scrubbed");
    assert.notEqual(JSON.parse((await request("/api/campaigns")).body).campaigns[0].health, "error");

    // A broken build progress file: no lists, the error, and still the queue.
    fs.writeFileSync(path.join(repoRoot, "backlog.json"), "[]");
    fs.writeFileSync(progress, "{ not json");
    const broken = JSON.parse((await request("/api/status")).body);
    assert.equal(broken.next.id, "ep-01");
    assert.match(broken.creation.error, /can't read .*creation-state\.json/);
    assert.deepEqual(
      [broken.creation.counts, broken.creation.awaiting, broken.creation.failed, broken.creation.redo, broken.creation.building],
      [{}, [], [], [], []],
    );
  });
});

test("no campaigns root: nothing is listed and nothing is created", async () => {
  const root = path.join(os.tmpdir(), `no-campaigns-${process.pid}-${Date.now()}`);
  const source = createCampaignSource({ home: makeHome(), env: {}, root });

  assert.deepEqual(await source.list(), []);
  assert.equal(source.get("acme"), null);
  assert.ok(!fs.existsSync(root), "the campaigns root is never created");
});

test("the real source lists every campaign in folder order, each read from its own folder", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const betaRoot = makeCampaignRoot(["b1", "b2"]);
  const root = makeCampaignsRoot({
    beta: { id: "beta", name: "Beta", root: betaRoot, paused: true },
    broken: { id: "broken", name: "Broken" },
    acme: acmeConfig(repoRoot),
  });
  createSecrets(home).set("beta", "IG_ACCESS_TOKEN", "beta-token-xyz");
  const campaign = getCampaign("acme", { root, home });
  postedInCampaignHome(campaign);

  const exec = async () => ({ stdout: "" });
  const now = () => new Date("2026-10-25T10:00:00Z");
  const source = createCampaignSource({ home, env: {}, root, exec, now });

  assert.deepEqual(await source.list(), [
    { id: "acme", name: "Acme Coffee", paused: false },
    { id: "beta", name: "Beta", paused: true },
    { id: "broken", name: "broken", paused: false, error: true },
  ]);
  const acme = source.get("acme");
  const status = await acme.getStatus();
  assert.deepEqual(status, await buildStatus({ now: now(), campaign, secrets: createSecrets(home), exec }));
  assert.deepEqual(status.posted.map((p) => p.id), ["ep-01"], "read from its campaign home");
  for (const name of ["postNow", "retry", "postItem", "hold", "release", "pin", "unpin", "reorder", "drop"]) {
    assert.equal(typeof acme.actions[name], "function", name);
  }
  assert.equal(acme.media.root, repoRoot);
  assert.equal(acme.media.itemDir("ep-01"), "pieces/ep-01");
  assert.equal(acme.media.itemDir("piece-07"), "pieces/piece-07");
  assert.equal(acme.media.itemDir("stray"), null);

  const beta = source.get("beta");
  const s = await beta.getStatus();
  assert.deepEqual(s.problems.notReady.map((n) => n.id), ["b1", "b2"], "beta's own schedule");
  assert.equal(s.connected, true);
  assert.ok(!JSON.stringify(s).includes("beta-token-xyz"));
  assert.equal(beta.media.root, betaRoot);
  assert.equal(beta.media.itemDir("b2"), "pieces/b2");
  assert.equal(beta.media.itemDir("ep-01"), null);
  assert.throws(() => source.get("broken"), /root is required/);
  assert.equal(source.get("nope"), null);
  assert.equal(source.get("../acme"), null);

  // The server lists the broken one as an error and 500s its status, never crashing.
  await withServer({ campaigns: source }, async ({ request }) => {
    const list = JSON.parse((await request("/api/campaigns")).body).campaigns;
    assert.deepEqual(list.map((c) => c.id), ["acme", "beta", "broken"]);
    assert.deepEqual(list.map((c) => c.health === "error"), [false, false, true]);
    assert.equal(list[1].problems, 2);
    assert.equal((await request("/api/status?campaign=broken")).status, 500);
    assert.equal((await request("/media/b1/clip.mp4?campaign=beta")).status, 200);
  });
});

test("GET /api/library never carries a token: failed-post error, caption text, check error, error message", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const campaign = getCampaign("acme", { root, home });
  const dirs = { ep: "pieces/ep-01", bad: `pieces/${IG_TOKEN}` };
  fs.mkdirSync(path.join(repoRoot, dirs.bad), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "schedule.json"),
    JSON.stringify([
      { id: "ep-01", kind: "ep", dir: dirs.ep },
      { id: "ep-02", kind: "ep", dir: dirs.ep.replace("ep-01", "piece-07") },
      { id: "ep-03", kind: "ep", dir: dirs.bad },
    ]),
  );
  fs.writeFileSync(
    path.join(repoRoot, "pieces", "ep-01", "out", "clip-caption.txt"),
    `INSTAGRAM / TIKTOK\nlink?access_token=${IG_TOKEN}\n\nYOUTUBE SHORTS TITLE\nhi\n`,
  );
  fs.mkdirSync(campaign.home, { recursive: true });
  fs.writeFileSync(
    path.join(campaign.home, "state.json"),
    JSON.stringify({ version: 1, items: { "ep-02": { instagram: { status: "failed", at: "x", error: `Graph 190: token ${IG_TOKEN} expired` } } } }),
  );
  const source = createCampaignSource({ home, env: {}, root, now: () => new Date("2026-10-25T10:00:00Z") });

  await withServer({ campaigns: source }, async ({ request }) => {
    const res = await request("/api/library");
    assert.equal(res.status, 200);
    const text = res.body.toString();
    const { pieces } = JSON.parse(text);
    assert.ok(!text.includes(IG_TOKEN), "no token anywhere in the body");
    assert.match(pieces.find((p) => p.id === "ep-01").caption, /access_token=\[redacted\]/);
    assert.match(pieces.find((p) => p.id === "ep-02").reason, /token \[redacted\] expired/);
    assert.match(pieces.find((p) => p.id === "ep-03").reason, /no out\/ folder in .*\[redacted\]/);

    // A broken build list whose parse error quotes the token: the 500 never does.
    fs.writeFileSync(path.join(repoRoot, "backlog.json"), `[{ "id": "piece-07" ${IG_TOKEN}`);
    const broken = await request("/api/library");
    assert.equal(broken.status, 500);
    assert.ok(!broken.body.toString().includes(IG_TOKEN));
  });
});

test("GET /api/library returns the campaign's pieces and counts; an unknown campaign is 404", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const source = createCampaignSource({ home, env: {}, root, now: () => new Date("2026-10-25T10:00:00Z") });

  await withServer({ campaigns: source }, async ({ request }) => {
    const res = await request("/api/library");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/json/);
    const { pieces, counts } = JSON.parse(res.body);
    assert.deepEqual(pieces.map((p) => [p.id, p.status, p.date]), [["ep-01", "ready", "2026-10-25"]]);
    assert.equal(pieces[0].video, "/media/ep-01/clip.mp4?campaign=acme");
    assert.deepEqual(counts, { all: 1, ready: 1, held: 0, awaiting: 0, posted: 0, fix: 0, dropped: 0 });
    assert.ok(!res.body.toString().includes(IG_TOKEN));

    assert.equal((await request("/api/library?campaign=nope")).status, 404);
    assert.equal((await request("/api/library?campaign=..%2Facme")).status, 404);
  });
});

test("GET /api/calendar starts on the Monday of today's week by default; days 43 or from 2026-02-30 is 400; an unknown campaign is 404", async () => {
  const repoRoot = makeRepo();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const source = createCampaignSource({ home: makeHome(), env: {}, root, now: () => new Date("2026-10-25T10:00:00Z") });

  await withServer({ campaigns: source }, async ({ request }) => {
    const res = await request("/api/calendar");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/json/);
    const cal = JSON.parse(res.body);
    assert.equal(cal.from, "2026-10-19");
    assert.equal(cal.days.length, 35);
    assert.deepEqual(cal.days.find((d) => d.date === "2026-10-25").posts.map((p) => [p.id, p.kind, p.video]), [["ep-01", "scheduled", "/media/ep-01/clip.mp4?campaign=acme"]]);

    const later = JSON.parse((await request("/api/calendar?from=2026-11-23&days=7")).body);
    assert.equal(later.from, "2026-11-23");
    assert.deepEqual(later.days.map((d) => d.date), ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);

    for (const q of ["days=43", "days=0", "days=abc", "days=", "days=3.5", "from=2026-02-30", "from=yesterday", "from="]) {
      const bad = await request(`/api/calendar?${q}`);
      assert.equal(bad.status, 400, q);
      assert.ok(JSON.parse(bad.body).error, q);
    }
    assert.equal((await request("/api/calendar?campaign=nope")).status, 404);
  });
});

// makeCampaignRoot's layout as a committed git repo, the way a queue edit needs it.
function makeGitCampaignRoot(ids) {
  const root = makeCampaignRoot(ids);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

test("server (end to end, temp git campaign): POST pin then GET /api/calendar shows the item pinned on that date", async () => {
  const betaRoot = makeGitCampaignRoot(["b1", "b2"]);
  const root = makeCampaignsRoot({ beta: { id: "beta", name: "Beta", root: betaRoot } });
  const source = createCampaignSource({ home: makeHome(), env: {}, root, exec: async () => ({ stdout: "" }) });
  // Far enough ahead that the real clock never makes it a past date.
  const date = "2030-01-16";

  await withServer({ campaigns: source }, async ({ request, server }) => {
    const post = poster(server.address().port);
    const { csrf } = JSON.parse((await request("/api/status?campaign=beta", { "Tailscale-User-Login": LOGIN })).body);
    const res = await post({ action: "pin", campaign: "beta", csrf, id: "b2", date });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, message: `Pinned b2 to ${date}.` });

    const cal = JSON.parse((await request(`/api/calendar?campaign=beta&from=2030-01-14&days=7`)).body);
    const posts = (d) => cal.days.find((day) => day.date === d).posts.map((p) => [p.id, p.kind]);
    assert.deepEqual(posts(date), [["b2", "pinned"]]);
    assert.ok(cal.days.filter((d) => d.date !== date).every((d) => d.posts.length === 0), "on no other day");
    const library = JSON.parse((await request("/api/library?campaign=beta")).body);
    assert.equal(library.pieces.find((p) => p.id === "b2").pinned, true);
  });
});

test("GET /api/pipeline returns the build list's unbuilt entries; an unknown campaign is 404", async () => {
  const repoRoot = makeRepo();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const source = createCampaignSource({ home: makeHome(), env: {}, root, now: () => new Date("2026-10-25T10:00:00Z") });

  await withServer({ campaigns: source }, async ({ request }) => {
    const res = await request("/api/pipeline");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { builds: [{ id: "piece-07", title: "Piece seven", type: null, status: "todo", reason: null, date: null, idea: {} }], formats: DEFAULT_FORMATS, types: TYPES, queue: [] });
    assert.equal((await request("/api/pipeline?campaign=nope")).status, 404);
  });
});

test("GET /api/review lists the pieces to review and reads one (404 when there is none); GET /api/build reads its progress; no token leaves", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const campaignHome = path.join(home, "campaigns", "acme");
  fs.mkdirSync(path.join(campaignHome, "logs"), { recursive: true });
  const at = "2026-10-25T09:58:00.000Z";
  fs.writeFileSync(path.join(campaignHome, "creation-state.json"), JSON.stringify({ items: { "piece-07": { status: "building", attempts: 1, at } } }));
  fs.writeFileSync(
    path.join(campaignHome, "logs", "2026-10.log"),
    `${at} INFO nightly start {"manual":true,"onlyId":"piece-07"}\n${at} INFO step {"id":"piece-07","why":"${IG_TOKEN}"}\n`,
  );
  fs.mkdirSync(path.join(repoRoot, "creation-out"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "creation-out", "piece-07.review.json"),
    JSON.stringify({ verdict: "FIX", scores: null, skills: null, must_fix: [`move it ${IG_TOKEN}`], nice_to_have: [], summary: "s" }),
  );
  const source = createCampaignSource({ home, env: {}, root, now: () => new Date("2026-10-25T10:00:00Z") });

  await withServer({ campaigns: source }, async ({ request }) => {
    const one = await request("/api/review?id=piece-07");
    assert.equal(one.status, 200);
    const review = JSON.parse(one.body);
    assert.equal(review.title, "Piece seven");
    assert.equal(review.status, "building");
    assert.equal(review.video, "/media/piece-07/clip.mp4?campaign=acme");
    assert.deepEqual(review.review.must_fix, ["move it [redacted]"]);

    assert.deepEqual(JSON.parse((await request("/api/review")).body), { pieces: [] }, "a building piece is not in the review list");
    for (const q of ["id=nope", "id=..%2Fpiece-07", "id=", "id=piece-07&campaign=nope"]) assert.equal((await request(`/api/review?${q}`)).status, 404, q);

    const build = await request("/api/build?id=piece-07");
    assert.equal(build.status, 200);
    const progress = JSON.parse(build.body);
    assert.equal(progress.status, "building");
    assert.equal(progress.elapsedSeconds, 120);
    assert.equal(progress.lines.length, 2);
    assert.ok(!build.body.toString().includes(IG_TOKEN));
    assert.ok(!one.body.toString().includes(IG_TOKEN));
    for (const q of ["id=nope", "", "id=PIECE-07"]) assert.equal((await request(`/api/build?${q}`)).status, 404, q);
    assert.equal(review.queued, null);
    assert.equal(progress.queued, null);
  });
});

test("GET /api/review, /api/build and /api/pipeline show a queued piece's place in the build queue", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const campaignHome = path.join(home, "campaigns", "acme");
  fs.mkdirSync(campaignHome, { recursive: true });
  // piece-07 has never been built: queued, it shows in the review list all the same.
  fs.writeFileSync(path.join(campaignHome, "creation-state.json"), JSON.stringify({ items: { "ep-02": { status: "failed", attempts: 1, reason: "r", at: "2026-10-25T09:00:00.000Z" } } }));
  const queuedAt = "2026-10-25T09:30:00.000Z";
  fs.writeFileSync(path.join(campaignHome, "build-queue.json"), JSON.stringify([
    { id: "ep-02", kind: "recheck", queuedAt },
    { id: "piece-07", kind: "build", queuedAt },
  ]));
  const source = createCampaignSource({ home, env: {}, root, now: () => new Date("2026-10-25T10:00:00Z") });

  await withServer({ campaigns: source }, async ({ request }) => {
    assert.deepEqual(JSON.parse((await request("/api/review?id=piece-07")).body).queued, { position: 2 });
    assert.deepEqual(JSON.parse((await request("/api/build?id=piece-07")).body).queued, { position: 2 });
    const { pieces } = JSON.parse((await request("/api/review")).body);
    assert.deepEqual(pieces.map((p) => [p.id, p.status, p.queued]), [["ep-02", "failed", { position: 1 }], ["piece-07", "todo", { position: 2 }]]);
    const pipeline = JSON.parse((await request("/api/pipeline")).body);
    assert.deepEqual(pipeline.queue, [{ id: "ep-02", kind: "recheck", position: 1 }, { id: "piece-07", kind: "build", position: 2 }]);
    // A corrupt queue reads as empty.
    fs.writeFileSync(path.join(campaignHome, "build-queue.json"), "{ not json");
    assert.equal(JSON.parse((await request("/api/review?id=piece-07")).body).queued, null);
    assert.deepEqual(JSON.parse((await request("/api/pipeline")).body).queue, []);
  });
});

test("GET /api/calendar and /api/pipeline never carry a token, in a title, a build reason or an error message", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const campaign = getCampaign("acme", { root, home });
  fs.writeFileSync(
    path.join(repoRoot, "schedule.json"),
    JSON.stringify([{ id: "ep-01", kind: "ep", dir: "pieces/ep-01", title: `About ${IG_TOKEN}` }]),
  );
  fs.writeFileSync(
    path.join(repoRoot, "backlog.json"),
    JSON.stringify([{ id: "piece-07", title: `Piece ${IG_TOKEN}`, targetDate: "2026-10-28" }]),
  );
  fs.mkdirSync(campaign.home, { recursive: true });
  fs.writeFileSync(
    path.join(campaign.home, "creation-state.json"),
    JSON.stringify({ items: { "piece-07": { status: "failed", attempts: 1, reason: `upload with ${IG_TOKEN} refused` } } }),
  );
  const source = createCampaignSource({ home, env: {}, root, now: () => new Date("2026-10-25T10:00:00Z") });

  await withServer({ campaigns: source }, async ({ request }) => {
    const cal = await request("/api/calendar");
    assert.equal(cal.status, 200);
    assert.ok(!cal.body.toString().includes(IG_TOKEN));
    const { days } = JSON.parse(cal.body);
    assert.equal(days.find((d) => d.date === "2026-10-25").posts[0].title, "About [redacted]");
    assert.deepEqual(days.find((d) => d.date === "2026-10-28").builds[0], {
      id: "piece-07",
      title: "Piece [redacted]",
      type: null,
      status: "failed",
      reason: "upload with [redacted] refused",
    });

    const pipe = await request("/api/pipeline");
    assert.equal(pipe.status, 200);
    assert.ok(!pipe.body.toString().includes(IG_TOKEN));
    assert.equal(JSON.parse(pipe.body).builds[0].reason, "upload with [redacted] refused");

    // A broken build list whose parse error quotes the token: the 500s never do.
    fs.writeFileSync(path.join(repoRoot, "backlog.json"), `[{ "id": "piece-07" ${IG_TOKEN}`);
    for (const p of ["/api/calendar", "/api/pipeline"]) {
      const broken = await request(p);
      assert.equal(broken.status, 500, p);
      assert.ok(JSON.parse(broken.body).error, p);
      assert.ok(!broken.body.toString().includes(IG_TOKEN), p);
    }
  });
});

const PREVIEW = Buffer.from("PREVIEWBYTES");

// Server options for acme whose media carry `previews`.
function withPreviews(previews, repoRoot = makeRepo()) {
  const base = acmeOnly({ repoRoot,home: makeHome(), getStatus: async () => STATUS, actions: {} });
  const entry = base.get("acme");
  return { campaigns: { ...base, get: (id) => (id === "acme" ? { ...entry, media: { ...entry.media, previews } } : null) } };
}

// A real previews cache whose fake exec writes PREVIEW and records its args.
function fakePreviews({ ffmpeg = "ffmpeg-bin" } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push(args);
    fs.writeFileSync(args[args.length - 1], PREVIEW);
  };
  return { calls, previews: createPreviews({ cacheDir: path.join(makeHome(), "previews", "acme"), ffmpeg, exec }) };
}

test("?variant=preview serves the cached preview with Range, and never a stale one after a rebuild", async () => {
  const fake = fakePreviews();
  const repoRoot = makeRepo();
  await withServer(withPreviews(fake.previews, repoRoot), async ({ request }) => {
    const full = await request("/media/ep-01/clip.mp4?variant=preview");
    assert.equal(full.status, 200);
    assert.deepEqual(full.body, PREVIEW);

    const part = await request("/media/ep-01/clip.mp4?variant=preview", { Range: "bytes=0-1" });
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], `bytes 0-1/${PREVIEW.length}`);
    assert.deepEqual(part.body, PREVIEW.subarray(0, 2));
    assert.equal(fake.calls.length, 1);

    const orig = await request("/media/ep-01/clip.mp4", { Range: "bytes=0-1" });
    assert.equal(orig.status, 206);
    assert.equal(orig.headers["content-range"], `bytes 0-1/${VIDEO.length}`);

    fs.writeFileSync(path.join(repoRoot, "pieces", "ep-01", "out", "clip.mp4"), "rebuilt!!");
    await request("/media/ep-01/clip.mp4?variant=preview");
    assert.equal(fake.calls.length, 2, "a rebuilt source gets a fresh preview");
  });
});

test("two concurrent first previews through the real campaign source run ffmpeg once", async () => {
  const repoRoot = makeRepo();
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(repoRoot) });
  const calls = [];
  const previewExec = async (file, args) => {
    calls.push(args);
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(args[args.length - 1], PREVIEW);
  };
  const campaigns = createCampaignSource({ home, env: {}, root, ffmpeg: "ffmpeg-bin", previewExec });
  await withServer({ campaigns }, async ({ request }) => {
    const [a, b] = await Promise.all([
      request("/media/ep-01/clip.mp4?variant=preview"),
      request("/media/ep-01/clip.mp4?variant=preview"),
    ]);
    assert.equal(calls.length, 1);
    for (const res of [a, b]) {
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, PREVIEW);
    }
  });
});

test("?variant=preview serves the original when there is no ffmpeg or it fails", async () => {
  const failing = createPreviews({ cacheDir: makeHome(), ffmpeg: "x", exec: async () => { throw new Error("boom"); } });
  for (const previews of [fakePreviews({ ffmpeg: null }).previews, failing]) {
    await withServer(withPreviews(previews), async ({ request }) => {
      const res = await request("/media/ep-01/clip.mp4?variant=preview");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, VIDEO);
    });
  }
});

test("?download=1 sets Content-Disposition: attachment; filename", async () => {
  await withServer(withPreviews(fakePreviews().previews), async ({ request }) => {
    const video = await request("/media/ep-01/clip.mp4?download=1");
    assert.equal(video.headers["content-disposition"], 'attachment; filename="clip.mp4"');
    assert.deepEqual(video.body, VIDEO);
    const cover = await request("/media/ep-01/clip-cover.png?download=1");
    assert.equal(cover.headers["content-disposition"], 'attachment; filename="clip-cover.png"');
    const preview = await request("/media/ep-01/clip.mp4?variant=preview&download=1");
    assert.equal(preview.headers["content-disposition"], 'attachment; filename="clip.mp4"');
    assert.deepEqual(preview.body, PREVIEW);
    assert.equal((await request("/media/ep-01/clip.mp4")).headers["content-disposition"], undefined);
  });
});

test("?variant=preview on a .png, or an unknown variant, is 404", async () => {
  await withServer(withPreviews(fakePreviews().previews), async ({ request }) => {
    assert.equal((await request("/media/ep-01/clip-cover.png?variant=preview")).status, 404);
    assert.equal((await request("/media/ep-01/clip.mp4?variant=huge")).status, 404);
  });
});

// acme's source with a `health` of its own.
function withHealth(health) {
  const campaigns = acmeOnly({ repoRoot: makeRepo(), home: makeHome(), getStatus: async () => ({ ...STATUS, problems: { failed: [] } }), actions: {} });
  return { campaigns: { ...campaigns, health, system: health } };
}

const HEALTH = { tasks: [{ name: "Pipeline Telegram", registered: false }], loops: [], tokens: [], clock: { skewSeconds: 400, checkedAt: "x" }, disk: { freeGb: 80 }, actions: [] };

test("GET /api/health answers the source's health; the status todos include the machine's", async () => {
  await withServer(withHealth(async () => HEALTH), async ({ request }) => {
    const health = await request("/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), HEALTH);
    const { todos } = JSON.parse((await request("/api/status")).body);
    assert.deepEqual(todos.map((t) => t.title), ["This computer's clock is off by 7 min", "Scheduled task Pipeline Telegram is missing"]);
  });
});

test("a health that throws is a 500 on /api/health and leaves the status alone", async () => {
  await withServer(
    withHealth(async () => {
      throw new Error("boom");
    }),
    async ({ request }) => {
      assert.equal((await request("/api/health")).status, 500);
      const status = await request("/api/status");
      assert.equal(status.status, 200);
      assert.deepEqual(JSON.parse(status.body).todos, []);
    },
  );
});

test("the real source's health reads each campaign's logs and Instagram token age", async () => {
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(makeRepo()) });
  createSecrets(home).set("acme", "IG_ISSUED_AT", "2026-10-05T10:00:00Z");
  const campaign = getCampaign("acme", { root, home });
  fs.mkdirSync(path.join(campaign.home, "logs"), { recursive: true });
  fs.writeFileSync(path.join(campaign.home, "logs", "2026-10.log"), '2026-10-25T09:00:00.000Z INFO dashboard hold {"id":"ep-01"}\n');
  const now = () => new Date("2026-10-25T10:00:00Z");
  const fetch = async () => ({ headers: new Headers({ date: "Sun, 25 Oct 2026 10:00:30 GMT" }) });
  const source = createCampaignSource({ home, env: {}, root, exec: async () => ({ stdout: "" }), fetch, now });
  const health = await source.health();
  assert.equal(health.clock.skewSeconds, -30);
  assert.equal(health.actions[0].message, "dashboard hold");
  assert.equal(health.tokens[0].campaign, "acme");
  assert.deepEqual(health.tokens[0], { campaign: "acme", instagramAgeDays: 20, warn: false });
  assert.ok(!JSON.stringify(health).includes(IG_TOKEN));
});

// The real source over a temp acme campaign, served; `opts` are createCampaignSource's extras.
async function withRealSource(opts, fn) {
  const home = makeHome();
  const root = makeCampaignsRoot({ acme: acmeConfig(makeRepo()) });
  const fetch = async () => ({ headers: new Headers({ date: new Date().toUTCString() }) });
  const campaigns = createCampaignSource({ home, env: {}, root, fetch, ...opts });
  await withServer({ campaigns }, ({ request }) => fn({ request, campaign: getCampaign("acme", { root, home }) }));
}

test("/api/health scrubs a secret value out of the log lines it quotes", async () => {
  await withRealSource({ exec: async () => ({ stdout: "" }) }, async ({ request, campaign }) => {
    fs.mkdirSync(path.join(campaign.home, "logs"), { recursive: true });
    const line = `2026-10-25T09:00:00.000Z ERROR dashboard retry {"error":"Graph said ${IG_TOKEN} and ${encodeURIComponent(IG_TOKEN)}"}\n`;
    fs.writeFileSync(path.join(campaign.home, "logs", "2026-10.log"), line);
    const res = await request("/api/health");
    assert.equal(res.status, 200);
    const text = res.body.toString();
    assert.ok(!text.includes(IG_TOKEN), "no token value");
    assert.match(JSON.parse(text).actions[0].detail, /\[redacted\]/);
  });
});

test("/api/health scrubs the owner's .env bot token and Google client secret out of the log lines it quotes", async () => {
  const OWNER_BOT = "987654321:AAowner-bot-token-fixture";
  const CLIENT_SECRET = "GOCSPX-owner-client-secret";
  const env = { TELEGRAM_BOT_TOKEN: OWNER_BOT, YT_CLIENT_SECRET: CLIENT_SECRET, TELEGRAM_CHAT_ID: "999" };
  await withRealSource({ env, exec: async () => ({ stdout: "" }) }, async ({ request, campaign }) => {
    fs.mkdirSync(path.join(campaign.home, "logs"), { recursive: true });
    const detail = JSON.stringify({ error: `POST https://api.telegram.org/bot${OWNER_BOT}/sendMessage failed; client ${CLIENT_SECRET}` });
    fs.writeFileSync(path.join(campaign.home, "logs", "2026-10.log"), `2026-10-25T09:00:00.000Z ERROR dashboard post now ${detail}\n`);
    const res = await request("/api/health");
    assert.equal(res.status, 200);
    const text = res.body.toString();
    assert.ok(!text.includes(OWNER_BOT) && !text.includes(CLIENT_SECRET), text);
    assert.match(JSON.parse(text).actions[0].detail, /bot\[redacted\]\/sendMessage failed; client \[redacted\]/);
  });
});

test("a hung Task Scheduler leaves /api/status answering within the timeout, with no false missing-task to-do", async () => {
  await withRealSource({ exec: () => new Promise(() => {}), taskTimeoutMs: 150 }, async ({ request }) => {
    const started = Date.now();
    const res = await request("/api/status");
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 3000, "answered well inside the bound");
    assert.deepEqual(JSON.parse(res.body).todos.filter((t) => /missing/.test(t.title)), []);
  });
});

test("two concurrent status requests on a cold cache run each schtasks once, and later ones none", async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push(args[args.indexOf("/TN") + 1]);
    return { stdout: "" };
  };
  await withRealSource({ exec }, async ({ request }) => {
    await Promise.all([request("/api/status"), request("/api/status")]);
    assert.deepEqual([...calls].sort(), ["Pipeline Creation", "Pipeline Dashboard", "Pipeline Publisher", "Pipeline Telegram"]);
    await request("/api/status");
    await request("/api/health");
    assert.equal(calls.length, 4);
  });
});
