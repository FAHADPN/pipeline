# Video and TTS

Pipeline decides **what** gets made, checks it and posts it. It doesn't render video itself. Each build session makes the video the way the campaign's `brief.md` says, with the tools and skills you give it. That keeps Pipeline independent of any one render stack, voice provider or style.

## The folder contract

A finished piece must leave exactly this in `pieces/<id>/out/`, under one name of the session's choice:

| File | Rules |
| --- | --- |
| `<name>.mp4` | the video. By default 1080×1920, 7 to 35 s, **with an audio stream** (`videoSpec` in `campaign.json` changes these) |
| `<name>-caption.txt` | an `INSTAGRAM / TIKTOK` section with the full caption (at most 2,200 characters and 30 hashtags), then a `YOUTUBE SHORTS TITLE` section with a title of at most 100 characters |
| `<name>-cover.png` | the cover image |

No other file in `out/` may end in `-caption.txt`. Rendered `out/` folders are git-ignored in campaign repos: the build commits only its source files.

The automatic checks hold every piece to this contract. They run `ffprobe` on the video for its size, length and audio, then check the caption with the skill scripts and the guardrail word lists. Example `-caption.txt`:

```text
INSTAGRAM / TIKTOK
Your kettle knows before you do. ☕
...the rest of the caption...
#homecoffee #morningroutine #pourover

YOUTUBE SHORTS TITLE
The first sip that switches the day on
```

### Optional: on-screen lines

If the piece's on-screen text should be checked too, have the build write `pieces/<id>/cues.js` listing it (say so in your brief):

```js
export const captions = ["Your kettle knows before you do.", "Grind. Bloom. Wait.", "First sip."];
```

With a `cues.js`, the first on-screen line is the hook that `hookscore.py` scores, `detect.py` also reads the on-screen lines, and the guardrail lists scan every string in the file. Without one, the caption's first line is the hook. Pipeline reads `cues.js` as text and never runs it.

## What the session may run

The build session's Bash is limited to `node`, `python`, a few `git` commands, `ls` and `mkdir`. To let it run your render tools directly, add them to the campaign's `extraAllowedTools`:

```json
"extraAllowedTools": ["Bash(npx hyperframes:*)", "Bash(ffmpeg:*)", "Bash(ffprobe:*)"]
```

On Windows, Claude Code's Bash tool runs in Git Bash, which comes with Git for Windows.

## A recommended stack: HyperFrames

[HyperFrames](https://github.com/heygen-com/hyperframes) renders HTML compositions to MP4 by seeking a paused timeline frame by frame in headless Chrome, so every render is identical. It suits text-led, motion-graphic Reels well, and its skills teach Claude Code how to use it.

1. Install Node 22+, Chrome and ffmpeg (see [Setup](SETUP.md#1-install-the-tools)).
2. Install the skills: `npx hyperframes@latest skills`.
3. In the brief, say how to build. For example: "Build each piece as a HyperFrames project in the piece folder, 1080×1920 at 30 fps. Render with `npx hyperframes render -q delivery -o out/<name>.mp4`."
4. Allow it in `extraAllowedTools` (above).

Renders use the GPU through Chrome when one is available. A 30-second Reel takes a minute or two on a mid-range GPU, and longer on CPU only.

Other stacks work the same way: Remotion, Motion Canvas, an After Effects template driven by a script, or plain ffmpeg. Describe the stack in the brief, allow its commands, and make sure the result meets the folder contract.

## Voiceover (TTS)

Pick a provider in the brief and give the session what it needs through **environment variables**. Build sessions inherit your environment, and the prompt forbids reading `.env` files and secrets folders, so environment variables are how keys reach tools.

| Provider | What you set up | Notes |
| --- | --- | --- |
| **Google Gemini TTS** | `setx GEMINI_API_KEY "<key>"` | Natural voices with style directions ("warm, unhurried"). The free tier allows about 3 TTS requests a minute per key, so a piece with many lines takes a few minutes. The media-use skill supports it as `provider: "gemini"`. |
| **Kokoro** (local) | `pip install kokoro-onnx soundfile` | Free and offline. Downloads a ~300 MB model on first use. `npx hyperframes tts`. |
| **ElevenLabs** | `setx ELEVENLABS_API_KEY "<key>"` | Large voice library and voice cloning. |
| **HeyGen** | `heygen auth login --oauth` | Voices, cloning and avatars, through the HeyGen CLI. Allow it with `extraAllowedTools`. |

After `setx`, sign out and back in, so scheduled tasks see the new variable.

Write the voice in `voice.md` (for example "Voice: Kore. Calm, friendly, a short pause before the payoff"), and the brief tells the session to use it. Size narration to the slot. Gemini speaks at roughly 2.4 words a second, so a 6-second scene holds about 14 words.

## Music and sound effects

| Source | What you set up | Notes |
| --- | --- | --- |
| **Google Lyria RealTime** | `GEMINI_API_KEY`, plus `pip install google-genai` | Generates an instrumental bed from a mood prompt. It streams in real time, so 30 s of music takes about 30 s. |
| **MusicGen** (local) | `pip install transformers torch soundfile numpy` | Free and offline. Slow on CPU. |
| **HeyGen catalog** | HeyGen CLI sign-in | Licensed tracks, searched by mood. |
| **Bundled SFX** | nothing | media-use ships about 20 offline effects: whooshes, clicks, pops, risers and impacts. |
| **Your own library** | put files in the campaign folder | Say in the brief which tracks may be used. |

Make sure you have the rights to any music you post. Generated and catalog tracks have their own terms.

## Getting the mix right

Say these in the brief or references, and the session will follow them:

- **Voice** around −16 LUFS, peaks at −1.5 dBFS or lower.
- **Music bed** at about 0.14 volume under the voice, up to around 0.3 in gaps.
- **Effects** only on visible actions (a cut, a card landing), about 3 to 6 dB over the bed.
- **No silent videos.** `videoSpec.audioRequired` (on by default) fails a piece with no audio stream.

To measure a finished video:

```powershell
ffmpeg -hide_banner -nostats -i out\reel.mp4 -af ebur128=peak=true -f null -
```

The summary at the end shows integrated loudness (`I:`) and true peak (`Peak:`).

## The cover

The session exports the cover from the strongest frame, for example:

```powershell
ffmpeg -ss 1.5 -i out\reel.mp4 -frames:v 1 out\reel-cover.png
```

Instagram uses it as the Reel's cover (`cover_url`). Set `platforms.instagram.useCover` to `false` to let Instagram pick the frame at `thumbOffsetMs` instead.

## ffmpeg and ffprobe

The checks need `ffprobe`. Pipeline looks for it on your PATH, then next to `FFMPEG_BIN` if you set that. If a winget install of ffmpeg isn't found by scheduled tasks, set `FFMPEG_BIN` to the full path of `ffmpeg.exe`:

```powershell
setx FFMPEG_BIN "C:\Users\<you>\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_...\ffmpeg-<version>-full_build\bin\ffmpeg.exe"
```
