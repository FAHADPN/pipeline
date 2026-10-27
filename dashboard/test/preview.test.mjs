import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPreviews } from "../lib/preview.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-preview-"));

// A source video, and a fake exec that records its calls and writes the output file.
function setup({ fail = false, ffmpeg = "ffmpeg-bin" } = {}) {
  const dir = tmp();
  const src = path.join(dir, "clip.mp4");
  fs.writeFileSync(src, "original video");
  const cacheDir = path.join(tmp(), "previews", "acme");
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(args[args.length - 1], "partial");
    if (fail) throw new Error("ffmpeg exploded");
  };
  const previews = createPreviews({ cacheDir, ffmpeg, exec, now: () => new Date() });
  return { src, cacheDir, calls, previews };
}

test("the cache key changes when the source size or mtime changes", async () => {
  const { src, calls, previews } = setup();
  const first = await previews.get(src);
  assert.equal(await previews.get(src), first, "a repeat get is a cache hit");
  assert.equal(calls.length, 1);

  fs.writeFileSync(src, "rebuilt video, longer");
  const second = await previews.get(src);
  assert.equal(calls.length, 2);
  assert.notEqual(second, first);

  // Same size, later mtime.
  fs.writeFileSync(src, "rebuilt video, longer");
  const later = new Date(fs.statSync(src).mtimeMs + 5000);
  fs.utimesSync(src, later, later);
  const third = await previews.get(src);
  assert.equal(calls.length, 3);
  assert.notEqual(third, second);
});

test("two concurrent first gets run ffmpeg once", async () => {
  const { src, calls, previews } = setup();
  const [a, b] = await Promise.all([previews.get(src), previews.get(src)]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

test("ffmpeg args are exactly the phone preset, renamed into the cache by sha1", async () => {
  const { src, cacheDir, calls, previews } = setup();
  const out = await previews.get(src);
  const { file, args, opts } = calls[0];
  assert.equal(file, "ffmpeg-bin");
  const tmpOut = args[args.length - 1];
  assert.deepEqual(args, [
    "-y", "-i", src, "-vf", "scale=-2:1280", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", tmpOut,
  ]);
  assert.equal(opts.timeout, 120000);
  const st = fs.statSync(src);
  const key = crypto.createHash("sha1").update(`${src}|${st.size}|${st.mtimeMs}`).digest("hex");
  assert.equal(out, path.join(cacheDir, `${key}.mp4`));
  assert.equal(fs.readFileSync(out, "utf8"), "partial");
  assert.notEqual(tmpOut, out);
  assert.deepEqual(fs.readdirSync(cacheDir), [`${key}.mp4`], "the temporary file is gone");
});

test("a failed ffmpeg leaves no file in the cache and get rejects", async () => {
  const { src, cacheDir, previews } = setup({ fail: true });
  await assert.rejects(previews.get(src), /ffmpeg exploded/);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
  await assert.rejects(previews.get(src), /ffmpeg exploded/, "a failure is not cached");
});

test("no ffmpeg: get resolves null", async () => {
  const { src, calls, previews } = setup({ ffmpeg: null });
  assert.equal(await previews.get(src), null);
  assert.equal(calls.length, 0);
});

test("prune removes old cache files and stale temporaries, and nothing else", async () => {
  const { src, cacheDir, previews } = setup();
  const fresh = await previews.get(src);
  const oldKey = "a".repeat(40);
  const old = path.join(cacheDir, `${oldKey}.mp4`);
  const oldPart = path.join(cacheDir, `${oldKey}.1.part.mp4`);
  const other = path.join(cacheDir, "notes.txt");
  for (const f of [old, oldPart, other]) fs.writeFileSync(f, "x");
  const longAgo = new Date(Date.now() - 40 * 86400000);
  for (const f of [old, oldPart, other]) fs.utimesSync(f, longAgo, longAgo);
  previews.prune();
  assert.deepEqual(fs.readdirSync(cacheDir).sort(), [path.basename(fresh), "notes.txt"].sort());
});
