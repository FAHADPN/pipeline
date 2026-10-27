// The folder contract: what makes a queued item postable.
// <dir>/out/<name>.mp4, <name>-caption.txt, <name>-cover.png, where the caption
// file has an "INSTAGRAM / TIKTOK" section and a "YOUTUBE SHORTS TITLE" section.

import fs from "node:fs";
import path from "node:path";

const IG_HEADER = "INSTAGRAM / TIKTOK";
const YT_HEADER = "YOUTUBE SHORTS TITLE";
const HEADERS = [IG_HEADER, YT_HEADER];
const CAPTION_SUFFIX = "-caption.txt";

const IG_CAPTION_MAX = 2200;
const IG_HASHTAGS_MAX = 30;
const YT_TITLE_MAX = 100;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

const chars = (s) => [...s].length;

function normalize(text) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export function parseCaption(text) {
  const sections = {};
  let current = null;
  for (const line of normalize(text).split("\n")) {
    const header = HEADERS.find((h) => line.trim() === h);
    if (header) {
      current = header;
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  const body = (header) => {
    if (!sections[header]) throw new Error(`caption has no ${header} section`);
    const value = sections[header].join("\n").trim();
    if (!value) throw new Error(`caption ${header} section is empty`);
    return value;
  };
  const instagram = body(IG_HEADER);
  const youtubeTitle = body(YT_HEADER).split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  return { instagram, youtubeTitle };
}

export function youtubeDescription(instagram) {
  return instagram.replaceAll(" (link in bio)", "");
}

export function firstLine(text) {
  const line = normalize(text).normalize("NFC").split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

// Finds the item's files without throwing, so checkItem can report every problem.
function locate(repoRoot, item) {
  const out = path.resolve(repoRoot, item.dir, "out");
  const errors = [];
  let files;
  try {
    files = fs.readdirSync(out);
  } catch {
    return { errors: [`no out/ folder in ${item.dir}`] };
  }
  const captions = files.filter((f) => f.endsWith(CAPTION_SUFFIX));
  if (captions.length !== 1) {
    const found = captions.length ? `found ${captions.length} caption files (${captions.join(", ")})` : `no *${CAPTION_SUFFIX}`;
    return { errors: [`${found} in ${item.dir}/out/`] };
  }
  const name = captions[0].slice(0, -CAPTION_SUFFIX.length);
  const assets = {
    name,
    video: path.join(out, `${name}.mp4`),
    caption: path.join(out, captions[0]),
    cover: path.join(out, `${name}-cover.png`),
  };
  if (!fs.existsSync(assets.video)) errors.push(`video missing: ${item.dir}/out/${name}.mp4`);
  if (!fs.existsSync(assets.cover)) errors.push(`cover missing: ${item.dir}/out/${name}-cover.png`);
  return { assets, errors };
}

export function findAssets(repoRoot, item) {
  const { assets, errors } = locate(repoRoot, item);
  if (errors.length) throw new Error(`${item.id}: ${errors.join("; ")}`);
  return assets;
}

// Problems that would break the Instagram post are errors. A YouTube title over
// the limit is only a warning: Instagram shouldn't be blocked by a YouTube-only
// problem, and the YouTube client refuses that title itself before uploading.
export function checkItem(repoRoot, item) {
  const { assets, errors } = locate(repoRoot, item);
  const warnings = [];
  if (!assets) return { ok: false, errors, warnings };

  const video = fs.statSync(assets.video, { throwIfNoEntry: false });
  if (video?.size === 0) errors.push("video is empty (0 bytes)");
  else if (video?.size > VIDEO_MAX_BYTES) errors.push(`video is over 100 MB (${(video.size / 1024 / 1024).toFixed(1)} MB)`);

  let caption;
  try {
    caption = parseCaption(fs.readFileSync(assets.caption, "utf8"));
  } catch (err) {
    errors.push(err.message);
  }
  if (caption) {
    const igLength = chars(caption.instagram);
    if (igLength > IG_CAPTION_MAX) errors.push(`Instagram caption is ${igLength} characters (max ${IG_CAPTION_MAX})`);
    const hashtags = caption.instagram.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
    if (hashtags > IG_HASHTAGS_MAX) errors.push(`Instagram caption has ${hashtags} hashtags (max ${IG_HASHTAGS_MAX})`);
    const titleLength = chars(caption.youtubeTitle);
    if (titleLength > YT_TITLE_MAX) warnings.push(`YouTube title is ${titleLength} characters (max ${YT_TITLE_MAX} characters)`);
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, assets, caption, warnings };
}
