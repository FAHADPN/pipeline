# Skills

A [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) is a folder with a `SKILL.md` (plus any scripts it needs) that teaches a session how to do one job. Pipeline's build and review sessions lean on skills for everything brand- or craft-specific, so the pipeline itself stays generic.

## Where skills live

| Location | Seen by |
| --- | --- |
| `%USERPROFILE%\.claude\skills\<name>\` | every session you run, so every campaign |
| `C:\Campaigns\<id>\.claude\skills\<name>\` | only that campaign's sessions, because they run in its folder |

New campaigns created from the console get an empty `.claude\skills\` folder for this. Put anything brand-specific there, such as a brand's own caption style, logo animation or voice. Put general craft skills in your user folder.

## piece-review

Ships with Pipeline in [`skills/piece-review/`](../skills/piece-review/SKILL.md). The review session runs it on every built piece. Install it once:

```powershell
Copy-Item -Recurse C:\pipeline\skills\piece-review "$env:USERPROFILE\.claude\skills\piece-review"
```

It scores four lenses from 0 to 100, against the campaign's own brief and voice:

1. **Director:** hook, escalation, payoff, and whether it works muted.
2. **Copy, art and UI:** the skill script results and readable on-screen text.
3. **Brand and audience:** the brief's "never" list, the voice and the guardrails.
4. **Forensics:** clipped text, the Reels UI safe zones, empty frames and sound.

It returns SHIP only when every lens scores 70 or more, every blocking script check passes, and nothing is on the must-fix list. The reply's JSON shape is fixed, because the pipeline and the console parse it. Edit the lenses and thresholds to taste, but keep the keys.

## The Instagram writing skills

The build prompt asks the session to use three skills by name, and three automatic checks run their scripts:

| Skill | The build uses it to | The check runs |
| --- | --- | --- |
| `ig-reel` | pick a hook formula from its `hooks.json` and plan the beats | `ig-reel/hookscore.py` on the hook (`checks.hookscore`) |
| `ig-caption` | write the caption | `ig-caption/caption.py` on the caption (`checks.captionPy`) |
| `ig-human` | strip machine-sounding phrasing from the caption and on-screen text | `ig-human/detect.py` on the caption (`checks.detect`) |

**Pipeline doesn't ship these skills.** You have three options:

1. **Install skills with these names** that you've written or obtained, following the contract below.
2. **Write your own** to the same contract. The scripts are small: each reads text and prints a JSON verdict.
3. **Switch the checks off** in `campaign.json`. The build session still writes a hook and a caption without the skills, and the reviewer still judges them.

   ```json
   "checks": { "captionPy": false, "detect": false, "detectOnScreen": false, "hookscore": false, "guardrails": true }
   ```

A backlog entry's `hook` field is a formula number in `ig-reel`'s `hooks.json`, or `null` for "write your own opening line".

### The check scripts

Pipeline runs each script with your Python, from `%USERPROFILE%\.claude\skills\`, with `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`, and parses the JSON it prints on stdout. A script that prints no JSON fails the check.

**`ig-caption/caption.py`**

```
python -X utf8 caption.py - --json      # the Instagram caption on stdin
```

It prints `{ "verdict": "READY" | "REVIEW" | "FIX", "checks": [{ "check": "...", "status": "PASS" | "WARN" | "FAIL", "detail": "..." }] }`. The check blocks on `FIX`, or on any check with `"status": "FAIL"`.

**`ig-human/detect.py`**

```
python -X utf8 detect.py - --json       # the text on stdin
```

It prints `{ "verdict": "PASS" | ..., "human_score": <number> }`. The caption must get `PASS`. Run on the on-screen lines, the check is advisory unless `checks.detectOnScreen` is `true`.

**`ig-reel/hookscore.py`**

```
python -X utf8 hookscore.py --hook=<text> --json
```

It prints `{ "verdict": "STRONG" | ... | "WEAK", "score": <number>, "weakest": "<dimension>" }`. The hook must not be `WEAK`. The hook is the first on-screen line when the piece has a [`cues.js`](video-and-tts.md#optional-on-screen-lines), and the caption's first line otherwise.

The raw JSON from every script goes into `creation-out/<id>.checks.json`, which the reviewer reads.

## Video skills

How a piece is rendered is up to the campaign's brief and its skills. A good default stack is [HyperFrames](https://github.com/heygen-com/hyperframes), which renders HTML compositions to MP4 with headless Chrome. Its skill pack includes **media-use**, for voiceover, music, sound effects and images. Install the HyperFrames skills for your user:

```powershell
npx hyperframes@latest skills
```

These belong to their authors and keep their own licenses. Pipeline links to them and doesn't bundle them. See [Video and TTS](video-and-tts.md).

## Skills and safety

Skills are code and instructions that run with your permissions in unattended sessions. Only install skills from sources you trust, and read a skill's `SKILL.md` and scripts before adding it to a campaign. The verifier stops a session from changing anything outside its piece folder, but it can't stop a malicious skill from reading files. See [Security](security.md).
