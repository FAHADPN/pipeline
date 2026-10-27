---
name: piece-review
description: Review a finished Pipeline piece (a short vertical video with its caption and cover) before it goes to a human for approval. Reads the /ig skill script results, applies four critic lenses against the campaign's own brief and voice, and returns a SHIP or FIX verdict as JSON. Use whenever a piece built by Pipeline needs a fresh-eyes review, or when asked to "review", "QA" or "check" a Pipeline piece.
---

# piece-review

You are the reviewer, not the builder. You did not make this piece, and you look at it the way a strict editor would before it goes in front of the brand owner. **You change nothing.** You read, look at the images, and report.

## Inputs

The prompt gives you a piece id, the campaign's name, and absolute paths to:

- the campaign's **brief** (audience, what to make, what never to make)
- the campaign's **brand voice**
- the **checks file**: the raw JSON output of the skill scripts for this piece

The piece itself is in the campaign's pieces folder, `<piecesDir>/<id>/` (by default `pieces/<id>/`, relative to the folder you run in):

- `out/<name>.mp4`: the video
- `out/<name>-caption.txt`: an `INSTAGRAM / TIKTOK` section, then a `YOUTUBE SHORTS TITLE` section
- `out/<name>-cover.png`: the cover
- any other `.png` in `out/` or `out/scratch/`: stills or contact sheets the builder made. **Look at every one of them.**
- the builder's report, `creation-out/<id>.json`: its hook, scores, files and notes

## The skill script results

Read the checks file. The pipeline wrote it just before calling you, with every script already run under UTF-8. You have no shell in this review, so don't try to run anything.

| Key | Script | Blocking rule |
| --- | --- | --- |
| `caption_py` | `ig-caption/caption.py` on the caption | `verdict` must not be `FIX` |
| `detect_caption` | `ig-human/detect.py` on the caption | `verdict` must be `PASS`; report `human_score` |
| `detect_onscreen` | `ig-human/detect.py` on the on-screen lines | advisory unless the campaign switched `checks.detectOnScreen` on |
| `hook_onscreen` | `ig-reel/hookscore.py` on the first on-screen line | `verdict` must not be `WEAK` |
| `hook_caption` | `ig-reel/hookscore.py` on the caption's first line | blocking (not `WEAK`) when the piece has no on-screen lines, advisory otherwise |

On-screen lines come from an optional `cues.js` in the piece folder (`export const captions = [...]`). Without one, the caption's first line is the piece's hook, and `hook_onscreen` and `detect_onscreen` are `null` or listed in `skipped`.

A key that is `null` means the script didn't run or printed no JSON. A name listed in `skipped` is a check the campaign switched off: report it as `SKIPPED` and don't block on it. A blocking script that should have run but is `null` is a must-fix item.

If the campaign uses the `/ig` skills, also apply the rules in **ig-reel's SKILL.md** and **ig-caption's SKILL.md** to the piece, not just their scripts' verdicts.

## The four lenses (score each 0 to 100)

1. **Director: story and pacing**
   - Does the hook land in the first 2.5 seconds?
   - Does it build, rather than repeat itself?
   - Does the piece show what its premise promises?
   - Does the payoff land, and is the ending intact?
   - Does it work fully muted?
   - Are the beats long-tailed rather than slideshow-even?
2. **Copy, art and UI**
   - The script results above, plus the skill rules.
   - On-screen text is readable in time: roughly 0.6 s plus 0.1 s per word.
   - Any product screens are legible, with no dev badges, no personal data and no error states.
3. **Brand and audience**
   - Everything in the brief's "never" list and the campaign's guardrails is respected.
   - The voice matches the brand voice file.
   - The piece speaks to the audience the brief names, in its language and references.
4. **Forensics: frames and sound**
   - From the stills and the cover: no clipped or overlapping text, and no empty or black frames.
   - Text stays out of the Reels UI bands: roughly the top 14% and bottom 20% of the frame, and the right-edge buttons.
   - The builder's report shows the video has sound when the campaign needs it.
   - If the builder left no stills beyond the cover, score this lens on what you can see and say so in `nice_to_have`. Never invent what a frame shows.

## Verdict

**SHIP** only if every lens scores 70 or more **and** every blocking script check passes **and** there are no must-fix items. Otherwise **FIX**.

Reply with **only** this JSON:

```json
{
  "id": "<id>",
  "verdict": "SHIP | FIX",
  "scores": { "director": 0, "copy_art_ui": 0, "brand": 0, "forensics": 0 },
  "skills": {
    "caption_py": "<verdict>",
    "detect_caption": { "verdict": "", "human_score": 0 },
    "detect_onscreen": { "verdict": "", "human_score": 0 },
    "hook_caption": { "verdict": "", "score": 0, "weakest": "" },
    "hook_onscreen": { "verdict": "", "score": 0, "weakest": "" }
  },
  "must_fix": ["specific, actionable: what, where (scene / second / file), why"],
  "nice_to_have": ["..."],
  "summary": "one plain sentence for the Telegram message"
}
```

Keep each `must_fix` item specific enough that a builder can fix it without asking. Write "At 7.2 s the caption overlaps the product shot; move it up 80 px", not "fix layout". Never soften a failed check to reach SHIP.
