// The prompt for one headless build session: a campaign piece's backlog entry, the
// campaign's whole brief, voice and references, and the redo note. Pure.

import os from "node:os";
import path from "node:path";
import { CLIENT_RULE, hasClientText } from "./client-text.mjs";

function lines(text) {
  return text.replace(/^﻿/, "").split(/\r?\n/);
}

function trimBlank(ls) {
  let a = 0;
  let b = ls.length;
  while (a < b && !ls[a].trim()) a++;
  while (b > a && !ls[b - 1].trim()) b--;
  return ls.slice(a, b);
}

function hookLine(hook) {
  return hook == null ? "none: there is no hook formula for this piece" : `ig-reel hook formula ${hook}`;
}

function hookStep(hook) {
  return hook == null
    ? "There is no hook formula for this piece; still write a short opening line that passes `hookscore.py`."
    : `Start from hook formula ${hook} in ig-reel's \`hooks.json\` and fit it to the premise.`;
}

// A note with a client's text in it (client-text.mjs) also gets the rule for it.
function redoBlock(note) {
  if (!note?.trim()) return "";
  const quoted = lines(note.trim()).map((l) => `> ${l}`.trimEnd()).join("\n");
  return [
    "## Redo note",
    "",
    "The user sent the last build of this piece back. Your folder already holds it: change it rather than starting again from the reference. Fix this first and keep what already worked:",
    "",
    quoted,
    "",
    ...(hasClientText(note) ? [CLIENT_RULE, ""] : []),
    "",
  ].join("\n");
}

// One pass, so text inside the brief, the voice, the references or the note is never
// treated as a placeholder.
function fill(template, values) {
  return lines(template).join("\n").replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (values[key] === undefined) throw new Error(`prompt template: no value for {{${key}}}`);
    return String(values[key]);
  });
}

// The /ig skills' own voice and swipe files, which may be another brand's.
export const GLOBAL_VOICE = "~/.claude/instagram/voice.md";
const GLOBAL_SWIPE = "~/.claude/instagram/swipe.md";

function voiceRule(voicePath, globalVoicePath) {
  if (path.resolve(voicePath).toLowerCase() === path.resolve(globalVoicePath).toLowerCase()) {
    return `This campaign's brand voice is \`${GLOBAL_VOICE}\`, the one the /ig skills read already.`;
  }
  return `This campaign's brand voice is \`${voicePath}\`, quoted below. Don't read \`${GLOBAL_VOICE}\` or \`${GLOBAL_SWIPE}\`: they aren't this campaign's. When an /ig skill asks for a voice file, give it this one.`;
}

// A campaign's build: its pieces live in <piecesDir>/<id>/ and how they're made is up
// to its brief and its own skills. The pipeline fixes only the output contract
// (video, caption file, cover), the rules and the checks.
const CAMPAIGN_TEMPLATE = `# Build one piece for {{name}}: {{id}}

You are building one piece for the "{{name}}" campaign, unattended, in this campaign's folder. Nobody can answer questions during this run: when something is unclear, make the smallest reasonable choice and write it in the notes of \`{{outFile}}\`.

## The piece

- Id: {{id}}
- Kind: {{kind}}
- Format: {{format}}
- Type (ig-plan mix): {{type}}
- Title: {{title}}
- Premise: {{premise}}
- Target date: {{targetDate}}
- Hook: {{hook}}
- Reference: {{reference}}
- Your folder: \`{{pieceDir}}/\`

{{redo}}## Rules

1. Work only in \`{{pieceDir}}/\`, plus the report file \`{{outFile}}\`. Never edit \`campaign.json\`, the brief, the voice or references files, the schedule, the build list or any other piece's folder. Anything changed outside your folder fails the piece and is reverted.
2. Don't use WebFetch or WebSearch, and don't fetch anything from the internet unless one of this campaign's own tools is made for it.
3. Never push. Never read anything outside this campaign's folder, never read \`.env\` files or anything in a \`secrets\` folder, and never print a secret.
4. The piece only enters the posting queue after it's approved on Telegram. Don't touch the schedule.
5. Keep all scratch and draft files in \`{{pieceDir}}/out/scratch/\`.
6. {{voiceRule}}

## What to deliver

In \`{{pieceDir}}/out/\`, under one name of your choice:

- \`<name>.mp4\`: the video, {{width}}x{{height}}, {{minSeconds}} to {{maxSeconds}} s long{{audio}}.
- \`<name>-caption.txt\`: an \`INSTAGRAM / TIKTOK\` section with the full Instagram caption, then a \`YOUTUBE SHORTS TITLE\` section with a title of at most 100 characters.
- \`<name>-cover.png\`: the cover.

No other file in \`out/\` may end in \`-caption.txt\`.

## Order of work

1. **Hook and beats with \`ig-reel\`.** {{hookStep}} The first line on screen is the hook.
2. **Make the video** the way the brief below says, with this campaign's skills and tools.
3. **Look and fix.** Check stills of the finished video for clipped text, overlaps and empty frames, then render again. At most 2 rounds.
4. **Caption with \`ig-caption\`**, then run **\`ig-human\`** over the caption and every on-screen line.
5. **Run the skill scripts** with \`python -X utf8\` and \`--json\`: \`~/.claude/skills/ig-caption/caption.py\` on the caption (no \`FAIL\`), \`~/.claude/skills/ig-human/detect.py\` on the caption (\`PASS\`) and \`~/.claude/skills/ig-reel/hookscore.py\` on the hook (not \`WEAK\`). Rewrite until they pass, at most 3 rewrites. Never work around a check.
6. **Self-check** against the brief and the references below, and fix what fails. A separate reviewer judges the finished piece afterwards.
7. **Commit** the piece's source files only (\`git add {{pieceDir}}/\` by path) with the message \`content: build {{id}}\`. No \`Co-Authored-By\`, no "Generated with", no AI attribution of any kind.
8. **Report.** Write \`{{outFile}}\` as \`{ hook, scores, files, notes }\`: the final hook, the scripts' last JSON verdicts, the files you created or changed, and your notes.

## The brief (\`{{briefPath}}\`)

{{brief}}

## Brand voice (\`{{voicePath}}\`)

{{voice}}

## References (\`{{referencesPath}}\`)

{{references}}
`;

// The build prompt for a piece of a campaign (campaigns/lib/campaign.mjs): the whole
// brief, the voice file and the references go in. pieceDir and outFile are relative
// to the campaign's root.
export function buildCampaignPrompt({
  campaign,
  entry,
  brief,
  voice,
  references,
  redoNote,
  pieceDir,
  outFile,
  globalVoicePath = path.join(os.homedir(), ".claude", "instagram", "voice.md"),
}) {
  const spec = campaign.config.videoSpec;
  const rel = (file) => path.relative(campaign.root, file).split(path.sep).join("/");
  const inRoot = (file) => (rel(file).startsWith("..") || path.isAbsolute(rel(file)) ? file : rel(file));
  return fill(CAMPAIGN_TEMPLATE, {
    name: campaign.name,
    id: entry.id,
    kind: entry.kind,
    format: entry.format,
    type: entry.type,
    title: entry.title,
    premise: entry.premise,
    targetDate: entry.targetDate,
    reference: entry.reference,
    hook: hookLine(entry.hook),
    hookStep: hookStep(entry.hook),
    redo: redoBlock(redoNote),
    pieceDir,
    outFile,
    voiceRule: voiceRule(campaign.paths.voice, globalVoicePath),
    width: spec.width,
    height: spec.height,
    minSeconds: spec.minSeconds,
    maxSeconds: spec.maxSeconds,
    audio: spec.audioRequired ? ", with sound" : "",
    briefPath: inRoot(campaign.paths.brief),
    brief: trimBlank(lines(brief)).join("\n"),
    voicePath: campaign.paths.voice,
    voice: trimBlank(lines(voice)).join("\n"),
    referencesPath: inRoot(campaign.paths.references),
    references: trimBlank(lines(references)).join("\n"),
  });
}
