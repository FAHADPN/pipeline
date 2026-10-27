// Serves a few local files on a short-lived public https URL, through an ngrok
// tunnel to a local server. Instagram's API creates a Reel only from a public
// video_url, so the files are reachable for as long as one post takes, and only at
// a random path nobody can guess. Everything else on the server is a 404.
//
// servePublicly({ files: [{ path, name }], ngrokBin }) -> { urls: { [name]: url }, close() }

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { spawn as nodeSpawn } from "node:child_process";

const TYPES = { ".mp4": "video/mp4", ".png": "image/png" };

// `bytes=a-b`, `bytes=a-` or `bytes=-n` on a file of `size` bytes. Returns
// { start, end }, "unsatisfiable", or undefined to serve the whole file (no
// header, several ranges, or a header we don't understand).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function startServer(files) {
  const secret = crypto.randomBytes(16).toString("hex");
  const byPath = new Map(files.map((f) => [`/${secret}/${encodeURIComponent(f.name)}`, f]));

  const server = http.createServer((req, res) => {
    const file = byPath.get(req.url);
    if (!file || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end();
      return;
    }
    const { size } = fs.statSync(file.path);
    const headers = { "Content-Type": file.type, "Accept-Ranges": "bytes" };
    const range = parseRange(req.headers.range, size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    headers["Content-Length"] = String(size ? end - start + 1 : 0);
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file.path, { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, secret, port: server.address().port }));
  });
}

// What ngrok said went wrong: its JSON error lines (lvl "eror" or "crit", or an
// `err` field), else any plain-text line it printed.
function describe(problems, plain) {
  if (problems.length) return problems.join("; ");
  return plain.filter(Boolean).slice(-3).join(" / ");
}

export async function servePublicly({ files, ngrokBin, startTimeoutMs = 30000, spawn = nodeSpawn, now = Date.now }) {
  const served = files.map((f) => {
    const type = TYPES[path.extname(f.path).toLowerCase()];
    if (!type) throw new Error(`can't serve ${f.path}: only .mp4 and .png files`);
    if (!fs.statSync(f.path, { throwIfNoEntry: false })?.isFile()) throw new Error(`can't serve ${f.path}: no such file`);
    return { ...f, type };
  });

  const { server, secret, port } = await startServer(served);
  const started = now();
  let child;
  let exited = false;
  let closing;

  function close() {
    closing ??= (async () => {
      // An ngrok that already exited is left alone: its pid may belong to another process by now.
      if (child?.pid !== undefined && !exited) {
        // ngrok can leave helper processes behind; /T takes the whole tree.
        await new Promise((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("exit", resolve);
          killer.once("error", resolve);
        });
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    })();
    return closing;
  }

  let publicUrl;
  try {
    publicUrl = await new Promise((resolve, reject) => {
      const problems = [];
      const plain = [];
      const fail = (why) => reject(new Error(`ngrok failed to start: ${why}`));
      const timer = setTimeout(() => {
        const seconds = Math.round((now() - started) / 1000);
        const said = describe(problems, plain);
        reject(new Error(`ngrok did not open a tunnel within ${seconds}s${said ? `: ${said}` : ""}`));
      }, startTimeoutMs);
      const done = (fn) => (arg) => {
        clearTimeout(timer);
        fn(arg);
      };
      const ok = done(resolve);
      const bad = done(fail);

      child = spawn(ngrokBin, ["http", `127.0.0.1:${port}`, "--log", "stdout", "--log-format", "json"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.once("error", (err) => bad(err.message));
      child.once("exit", (code) => {
        exited = true;
        bad(describe(problems, plain) || `ngrok exited with code ${code}`);
      });

      const onLine = (line) => {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          entry = undefined;
        }
        if (!entry || typeof entry !== "object") {
          plain.push(line.trim());
          return;
        }
        if (typeof entry.url === "string" && entry.url.startsWith("https://")) {
          ok(entry.url);
          return;
        }
        const err = entry.err && entry.err !== "<nil>" ? entry.err : undefined;
        const fatal = entry.lvl === "eror" || entry.lvl === "crit";
        if (!err && !fatal) return;
        const why = String(err ?? entry.msg ?? "unknown error").replace(/\s+/g, " ").trim();
        problems.push(why);
        // A failed login doesn't recover: report it now rather than at the timeout.
        if (fatal) bad(why);
      };
      readline.createInterface({ input: child.stdout }).on("line", onLine);
      if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", onLine);
    });
  } catch (err) {
    await close();
    throw err;
  }

  const base = publicUrl.replace(/\/+$/, "");
  const urls = Object.fromEntries(served.map((f) => [f.name, `${base}/${secret}/${encodeURIComponent(f.name)}`]));
  return { urls, close };
}
