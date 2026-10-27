import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { servePublicly } from "../lib/public-file.mjs";

process.env.PIPELINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));

const PUBLIC = "https://ab12-cd34.ngrok-free.app";

function tempFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-public-"));
  const video = path.join(dir, "x.mp4");
  const cover = path.join(dir, "x-cover.png");
  fs.writeFileSync(video, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  fs.writeFileSync(cover, Buffer.alloc(50, 9));
  fs.writeFileSync(path.join(dir, "secret.txt"), "not listed");
  return { dir, video, cover };
}

// A fake child_process.spawn. The ngrok child prints `lines` (JSON objects or raw
// text) on stdout; taskkill exits 0 at once. Every call is recorded.
function fakeSpawn({ lines = [{ lvl: "info", msg: "started tunnel", url: PUBLIC }], exitCode } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    calls.push({ cmd, args, opts, child });
    setImmediate(() => {
      if (cmd === "taskkill") {
        child.emit("exit", 0);
        return;
      }
      for (const line of lines) child.stdout.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
      if (exitCode !== undefined) setTimeout(() => child.emit("exit", exitCode), 20);
    });
    return child;
  };
  return { spawn, calls };
}

// Requests go to the local server, found from the ngrok command line.
function localPort(calls) {
  const target = calls[0].args[1];
  return Number(target.split(":")[1]);
}

function request(port, pathname, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function start(opts = {}) {
  const { video, cover, dir } = tempFiles();
  const fake = fakeSpawn(opts);
  const tunnel = await servePublicly({
    files: [
      { path: video, name: "video.mp4" },
      { path: cover, name: "cover.png" },
    ],
    ngrokBin: "C:/tools/ngrok.exe",
    spawn: fake.spawn,
  });
  return { tunnel, calls: fake.calls, port: localPort(fake.calls), video, cover, dir };
}

test("resolves the public url from ngrok json log", async () => {
  const { tunnel, calls } = await start({
    lines: [
      { lvl: "info", msg: "no configuration paths supplied" },
      "not json at all",
      { lvl: "info", msg: "client session established", obj: "tunnels.session" },
      { lvl: "info", msg: "started tunnel", obj: "tunnels", name: "command_line", addr: "http://127.0.0.1:1", url: PUBLIC },
    ],
  });
  try {
    assert.equal(calls[0].cmd, "C:/tools/ngrok.exe");
    assert.deepEqual(calls[0].args.slice(0, 1), ["http"]);
    assert.match(calls[0].args[1], /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(calls[0].args.slice(2), ["--log", "stdout", "--log-format", "json"]);

    const video = new URL(tunnel.urls["video.mp4"]);
    const cover = new URL(tunnel.urls["cover.png"]);
    assert.equal(video.origin, PUBLIC);
    assert.match(video.pathname, /^\/[0-9a-f]{32}\/video\.mp4$/);
    assert.equal(cover.pathname, video.pathname.replace("video.mp4", "cover.png"));
  } finally {
    await tunnel.close();
  }
});

test("serves only listed files at the secret path", async () => {
  const { tunnel, port, video, cover } = await start();
  try {
    const videoPath = new URL(tunnel.urls["video.mp4"]).pathname;
    const coverPath = new URL(tunnel.urls["cover.png"]).pathname;

    const v = await request(port, videoPath);
    assert.equal(v.status, 200);
    assert.equal(v.headers["content-type"], "video/mp4");
    assert.equal(v.headers["content-length"], "1000");
    assert.equal(v.headers["accept-ranges"], "bytes");
    assert.deepEqual(v.body, fs.readFileSync(video));

    const c = await request(port, coverPath);
    assert.equal(c.status, 200);
    assert.equal(c.headers["content-type"], "image/png");
    assert.deepEqual(c.body, fs.readFileSync(cover));

    const head = await request(port, videoPath, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], "1000");
    assert.equal(head.body.length, 0);

    assert.equal((await request(port, videoPath, { method: "POST" })).status, 404);
  } finally {
    await tunnel.close();
  }
});

test("range request returns 206", async () => {
  const { tunnel, port, video } = await start();
  try {
    const p = new URL(tunnel.urls["video.mp4"]).pathname;
    const bytes = fs.readFileSync(video);

    const mid = await request(port, p, { headers: { Range: "bytes=100-199" } });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers["content-range"], "bytes 100-199/1000");
    assert.equal(mid.headers["content-length"], "100");
    assert.deepEqual(mid.body, bytes.subarray(100, 200));

    const open = await request(port, p, { headers: { Range: "bytes=990-" } });
    assert.equal(open.status, 206);
    assert.equal(open.headers["content-range"], "bytes 990-999/1000");
    assert.deepEqual(open.body, bytes.subarray(990));

    const suffix = await request(port, p, { headers: { Range: "bytes=-5" } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(suffix.body, bytes.subarray(995));

    const beyond = await request(port, p, { headers: { Range: "bytes=5000-" } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers["content-range"], "bytes */1000");
  } finally {
    await tunnel.close();
  }
});

test("unknown path is 404", async () => {
  const { tunnel, port } = await start();
  try {
    const videoPath = new URL(tunnel.urls["video.mp4"]).pathname;
    const secret = videoPath.split("/")[1];
    for (const p of [
      "/",
      "/video.mp4",
      `/${secret}`,
      `/${secret}/`,
      `/${secret}/secret.txt`,
      `/${secret}/../${secret}/video.mp4x`,
      `/${"0".repeat(32)}/video.mp4`,
      `${videoPath}/extra`,
    ]) {
      assert.equal((await request(port, p)).status, 404, p);
    }
  } finally {
    await tunnel.close();
  }
});

test("ngrok error text surfaces", async () => {
  const { video, cover } = tempFiles();
  const fake = fakeSpawn({
    lines: [
      { lvl: "info", msg: "no configuration paths supplied" },
      {
        lvl: "eror",
        msg: "session closing",
        obj: "tunnels.session",
        err: "authentication failed: Usage of ngrok requires a verified account and authtoken.\n\nERR_NGROK_4018",
      },
    ],
    exitCode: 1,
  });
  await assert.rejects(
    servePublicly({ files: [{ path: video, name: "video.mp4" }, { path: cover, name: "cover.png" }], ngrokBin: "ngrok", spawn: fake.spawn }),
    /ngrok.*authentication failed: Usage of ngrok requires a verified account and authtoken/s,
  );
  // The failed ngrok is killed and its server closed.
  assert.ok(fake.calls.some((c) => c.cmd === "taskkill"));

  // Plain text from an ngrok that quits by itself; nothing left to kill.
  const quit = fakeSpawn({ lines: ["ERROR:  authentication failed: Your authtoken is invalid."], exitCode: 1 });
  await assert.rejects(
    servePublicly({ files: [{ path: video, name: "video.mp4" }], ngrokBin: "ngrok", spawn: quit.spawn }),
    /ngrok failed to start: ERROR: {2}authentication failed: Your authtoken is invalid\./,
  );
  assert.ok(!quit.calls.some((c) => c.cmd === "taskkill"));

  // Without a tunnel line, the wait gives up.
  const silent = fakeSpawn({ lines: [{ lvl: "info", msg: "starting" }] });
  await assert.rejects(
    servePublicly({ files: [{ path: video, name: "video.mp4" }], ngrokBin: "ngrok", spawn: silent.spawn, startTimeoutMs: 50 }),
    /ngrok did not open a tunnel/,
  );
  assert.ok(silent.calls.some((c) => c.cmd === "taskkill"));

  // A missing file fails before ngrok starts.
  const unused = fakeSpawn();
  await assert.rejects(
    servePublicly({ files: [{ path: path.join(os.tmpdir(), "nope-pipeline.mp4"), name: "video.mp4" }], ngrokBin: "ngrok", spawn: unused.spawn }),
    /nope-pipeline\.mp4/,
  );
  assert.equal(unused.calls.length, 0);
});

test("close kills the tree and stops the server", async () => {
  const { tunnel, calls, port } = await start();
  const ngrok = calls[0].child;
  await tunnel.close();

  const kills = calls.filter((c) => c.cmd === "taskkill");
  assert.equal(kills.length, 1);
  assert.deepEqual(kills[0].args, ["/PID", String(ngrok.pid), "/T", "/F"]);
  await assert.rejects(request(port, "/"), /ECONNREFUSED/);

  // Idempotent.
  await tunnel.close();
  assert.equal(calls.filter((c) => c.cmd === "taskkill").length, 1);
});
