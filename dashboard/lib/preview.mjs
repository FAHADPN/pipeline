// Phone previews: a 720p H.264 copy of a rendered video, made once with ffmpeg and
// cached in the publisher home (never in a campaign or the repo). The cache key is the
// source's path, size and mtime, so a rebuilt video can never get a stale preview.
//
// createPreviews({ cacheDir, ffmpeg, exec, now }) -> { get(sourceFile), prune(maxAgeDays) }
// get resolves the cached preview's path, or null when there is no ffmpeg; it rejects
// when ffmpeg fails. exec is promisified execFile. Two gets for the same source share
// one ffmpeg run. The cache holds only <sha1>.mp4; ffmpeg writes <sha1>.<uuid>.part.mp4
// beside them and renames it when done, and prune removes both kinds once they're old.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const TIMEOUT_MS = 120_000;
const DAY_MS = 86_400_000;
const CACHED = /^[0-9a-f]{40}\.mp4$/;
const PART = /^[0-9a-f]{40}\.[0-9a-f-]+\.part\.mp4$/;

export function createPreviews({ cacheDir, ffmpeg, exec = promisify(execFile), now = () => new Date() }) {
  const running = new Map(); // cache file -> promise of its path

  async function render(src, out) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = path.join(cacheDir, `${path.basename(out, ".mp4")}.${crypto.randomUUID()}.part.mp4`);
    try {
      await exec(
        ffmpeg,
        ["-y", "-i", src, "-vf", "scale=-2:1280", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", tmp],
        { timeout: TIMEOUT_MS, windowsHide: true },
      );
      fs.renameSync(tmp, out);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return out;
  }

  return {
    async get(sourceFile) {
      if (!ffmpeg) return null;
      const st = fs.statSync(sourceFile);
      const key = crypto.createHash("sha1").update(`${sourceFile}|${st.size}|${st.mtimeMs}`).digest("hex");
      const out = path.join(cacheDir, `${key}.mp4`);
      if (fs.existsSync(out)) {
        fs.utimesSync(out, now(), now()); // a played preview stays fresh for prune
        return out;
      }
      if (!running.has(out)) {
        running.set(out, render(sourceFile, out).finally(() => running.delete(out)));
      }
      return running.get(out);
    },

    // Deletes cache files and leftover temporaries not touched for maxAgeDays.
    prune(maxAgeDays = 30) {
      const cutoff = now().getTime() - maxAgeDays * DAY_MS;
      let names;
      try {
        names = fs.readdirSync(cacheDir);
      } catch {
        return; // No cache yet.
      }
      for (const name of names) {
        if (!CACHED.test(name) && !PART.test(name)) continue;
        const file = path.join(cacheDir, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
        } catch {
          // Gone already.
        }
      }
    },
  };
}
