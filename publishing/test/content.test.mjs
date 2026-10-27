import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCaption, youtubeDescription, firstLine, findAssets, checkItem } from "../lib/content.mjs";

const CAPTION = [
  "INSTAGRAM / TIKTOK",
  "POV: you finally found a coffee that tastes like the café ☕ Morning #1",
  "",
  "Fresh beans every Monday. Order yours 👉 acme.example (link in bio)",
  "Send this to your coffee person ❤️",
  "#coffee #morningroutine #coffeelover #barista #acmecoffee",
  "",
  "YOUTUBE SHORTS TITLE",
  "POV: you finally found a coffee that tastes like the café ☕ #shorts #coffee",
  "",
].join("\n");

// Builds <root>/c/x/out/ with the given files. Strings are written as UTF-8,
// numbers make a file of that many bytes.
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-content-"));
  const out = path.join(root, "c", "x", "out");
  fs.mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(out, name);
    if (typeof body === "number") {
      fs.writeFileSync(file, "");
      fs.truncateSync(file, body);
    } else {
      fs.writeFileSync(file, body, "utf8");
    }
  }
  return { root, item: { id: "x", kind: "ep", dir: "c/x" } };
}

test("parses the caption format", () => {
  const c = parseCaption(CAPTION);
  assert.ok(c.instagram.startsWith("POV:"), c.instagram);
  assert.ok(c.instagram.endsWith("#acmecoffee"), c.instagram);
  assert.ok(c.instagram.includes("\n\nFresh beans every Monday."), c.instagram);
  assert.equal(c.youtubeTitle, "POV: you finally found a coffee that tastes like the café ☕ #shorts #coffee");
  assert.ok(c.youtubeTitle.endsWith("#shorts #coffee"));
});

test("parses BOM + CRLF caption", () => {
  assert.deepEqual(parseCaption("﻿" + CAPTION.replace(/\n/g, "\r\n")), parseCaption(CAPTION));
});

test("throws when YOUTUBE SHORTS TITLE is missing", () => {
  const noTitle = CAPTION.slice(0, CAPTION.indexOf("YOUTUBE SHORTS TITLE"));
  assert.throws(() => parseCaption(noTitle), /YOUTUBE SHORTS TITLE/);
});

test("throws when a section is empty", () => {
  assert.throws(() => parseCaption("INSTAGRAM / TIKTOK\n\nYOUTUBE SHORTS TITLE\nA title #shorts\n"), /INSTAGRAM \/ TIKTOK/);
  assert.throws(() => parseCaption("INSTAGRAM / TIKTOK\nA caption\n\nYOUTUBE SHORTS TITLE\n  \n"), /YOUTUBE SHORTS TITLE/);
});

test("youtubeDescription drops (link in bio)", () => {
  assert.equal(
    youtubeDescription("Order yours 👉 acme.example (link in bio)\nSend this to your coffee person"),
    "Order yours 👉 acme.example\nSend this to your coffee person",
  );
});

test("firstLine normalizes", () => {
  assert.equal(firstLine("  POV:  They’ve said\r\nmore"), "pov: they’ve said");
  assert.equal(firstLine("\n\n  \nSecond\tLine "), "second line");
  assert.equal(firstLine("Café"), firstLine("Café"));
  assert.equal(firstLine(""), "");
});

test("checkItem ok on a complete folder", () => {
  const { root, item } = fixture({ "x.mp4": 10, "x-caption.txt": CAPTION, "x-cover.png": 10 });
  const r = checkItem(root, item);
  assert.equal(r.ok, true, r.errors?.join("\n"));
  assert.equal(r.assets.name, "x");
  assert.equal(r.assets.video, path.join(root, "c", "x", "out", "x.mp4"));
  assert.equal(r.assets.caption, path.join(root, "c", "x", "out", "x-caption.txt"));
  assert.equal(r.assets.cover, path.join(root, "c", "x", "out", "x-cover.png"));
  assert.ok(path.isAbsolute(r.assets.video));
  assert.deepEqual(r.caption, parseCaption(CAPTION));
  assert.deepEqual(findAssets(root, item), r.assets);
});

test("checkItem lists every problem", () => {
  const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
  const caption = `INSTAGRAM / TIKTOK\n${"a".repeat(2200)}\n${tags}\n\nYOUTUBE SHORTS TITLE\n${"t".repeat(101)}\n`;
  const { root, item } = fixture({ "x.mp4": 0, "x-caption.txt": caption });
  const r = checkItem(root, item);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 4, r.errors.join("\n"));
  assert.ok(r.errors.some((e) => /cover/.test(e)), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => /0 bytes/.test(e)), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => /2200/.test(e)), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => /hashtags/.test(e)), r.errors.join("\n"));
  assert.equal(r.warnings.length, 1, r.warnings.join("\n"));
  assert.match(r.warnings[0], /YouTube title is 101 characters/);
});

test("a YouTube title over 100 chars is a warning, not an error", () => {
  const caption = `INSTAGRAM / TIKTOK\nA caption #acmecoffee\n\nYOUTUBE SHORTS TITLE\n${"t".repeat(101)}\n`;
  const { root, item } = fixture({ "x.mp4": 10, "x-caption.txt": caption, "x-cover.png": 10 });
  const r = checkItem(root, item);
  assert.equal(r.ok, true, r.errors?.join("\n"));
  assert.deepEqual(r.warnings, ["YouTube title is 101 characters (max 100 characters)"]);

  const fine = fixture({ "x.mp4": 10, "x-caption.txt": CAPTION, "x-cover.png": 10 });
  assert.deepEqual(checkItem(fine.root, fine.item).warnings, []);
});

test("checkItem flags a video over 100 MB", () => {
  const { root, item } = fixture({ "x.mp4": 100 * 1024 * 1024 + 1, "x-caption.txt": CAPTION, "x-cover.png": 10 });
  const r = checkItem(root, item);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1, r.errors.join("\n"));
  assert.match(r.errors[0], /100 MB/);
});

test("checkItem reports a missing or ambiguous caption file", () => {
  const none = fixture({ "x.mp4": 10, "x-cover.png": 10 });
  const r1 = checkItem(none.root, none.item);
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join("\n"), /caption/);
  assert.throws(() => findAssets(none.root, none.item), /caption/);

  const two = fixture({ "x.mp4": 10, "x-cover.png": 10, "x-caption.txt": CAPTION, "y-caption.txt": CAPTION });
  const r2 = checkItem(two.root, two.item);
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join("\n"), /2 caption files/);

  const noOut = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-content-"));
  fs.mkdirSync(path.join(noOut, "c", "x"), { recursive: true });
  const r3 = checkItem(noOut, { id: "x", kind: "ep", dir: "c/x" });
  assert.equal(r3.ok, false);
  assert.match(r3.errors.join("\n"), /out/);
});

test("checkItem reports an unparseable caption", () => {
  const { root, item } = fixture({ "x.mp4": 10, "x-cover.png": 10, "x-caption.txt": "just some text\n" });
  const r = checkItem(root, item);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /INSTAGRAM \/ TIKTOK/);
});
