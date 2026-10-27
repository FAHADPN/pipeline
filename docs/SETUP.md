# Setup guide

This walks you from a fresh Windows PC to a campaign that builds a Reel overnight, sends it to your phone for approval and posts it on schedule. Plan on about two hours the first time. Most of that is accounts and tokens, not code.

Each step links to a reference page with the details. Do the steps in order: later steps test the earlier ones.

- [0. What you need](#0-what-you-need)
- [1. Install the tools](#1-install-the-tools)
- [2. Get the code](#2-get-the-code)
- [3. Create the publisher home](#3-create-the-publisher-home)
- [4. Set up Telegram](#4-set-up-telegram)
- [5. Create your first campaign](#5-create-your-first-campaign)
- [6. Install the skills](#6-install-the-skills)
- [7. Set up how videos get made](#7-set-up-how-videos-get-made)
- [8. Build one piece by hand](#8-build-one-piece-by-hand)
- [9. Connect Instagram and ngrok](#9-connect-instagram-and-ngrok)
- [10. Open the console over Tailscale](#10-open-the-console-over-tailscale)
- [11. Schedule everything](#11-schedule-everything)
- [12. Day to day](#12-day-to-day)

## 0. What you need

**A Windows 10 or 11 PC that stays on.** Pipeline runs on Windows Task Scheduler. Builds happen at night, in your logged-in session, so the PC must stay logged in and awake overnight. A desktop or a laptop on its charger both work. A GPU helps renders but isn't required.

**Accounts:**

| Account | Used for | Cost |
| --- | --- | --- |
| Claude (Pro or Max), or an Anthropic API key | the headless Claude Code sessions that build and review each piece | subscription or API usage |
| Instagram Professional account (Creator or Business) | posting Reels | free |
| Meta developer account | the app that gets your Instagram token | free |
| ngrok | the short-lived public link Instagram fetches each video from | free plan works |
| Telegram | approving pieces from your phone | free |
| Tailscale | opening the console privately from your phone or laptop | free plan works |
| Google Cloud (optional) | YouTube Shorts, once Google's API audit passes | free |

## 1. Install the tools

Open PowerShell and install these with `winget` (or from each project's site):

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e        # Node 22 or newer
winget install --id Python.Python.3.13 -e       # for the skill scripts
winget install --id Gyan.FFmpeg -e              # ffmpeg and ffprobe
winget install --id Google.Chrome -e            # headless renders
winget install --id Ngrok.Ngrok -e
winget install --id Tailscale.Tailscale -e
```

winget's ngrok package can lag behind, so update the agent once it's installed (open a new window first):

```powershell
ngrok update
```

Then install **Claude Code** with the native installer, so that `claude.exe` is on your PATH:

```powershell
irm https://claude.ai/install.ps1 | iex
```

Pipeline starts `claude` directly, without a shell. Windows can't start a `.cmd` shim that way, so the npm-installed `claude.cmd` won't work for builds.

Open a **new** PowerShell window, then check everything is found:

```powershell
git --version; node --version; python --version; ffmpeg -version | Select-Object -First 1; ffprobe -version | Select-Object -First 1; ngrok version; tailscale version; where.exe claude
```

`where.exe claude` must list a `claude.exe`. Node must be 22 or newer.

Sign Claude Code in once: run `claude`, type `/login`, and follow the browser prompt. Build sessions reuse this sign-in. To bill a campaign to an API key instead, see [Claude Code](claude-code.md#signing-in).

If `ffprobe` isn't found after a fresh `winget` install, set `FFMPEG_BIN` to the full path of `ffmpeg.exe`: Pipeline then looks for `ffprobe.exe` beside it. See [Configuration](configuration.md#environment-variables).

## 2. Get the code

```powershell
cd C:\
git clone https://github.com/FAHADPN/pipeline.git
cd C:\pipeline
npm test
```

Pipeline has no npm dependencies, so there is nothing to install. `npm test` runs the full suite (about 650 tests, no network) and should end with every test passing.

You can keep the code anywhere. This guide uses `C:\pipeline`.

## 3. Create the publisher home

Everything that must never be committed lives in one folder outside the code, the **publisher home**: `%USERPROFILE%\.pipeline` by default. It holds your owner settings, each campaign's secrets and state, locks and logs. To use another folder, set the `PIPELINE_HOME` environment variable.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.pipeline" | Out-Null
notepad "$env:USERPROFILE\.pipeline\.env"
```

Put these lines in `.env`. You fill the values in the next steps:

```ini
# Owner alerts: crashes, failures and nightly summaries go here.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Your Tailscale login (the email shown in the Tailscale app). Only this login can press buttons in the console.
DASHBOARD_LOGIN=

# Optional, for YouTube: a Google "Desktop app" OAuth client.
YT_CLIENT_ID=
YT_CLIENT_SECRET=
```

Never commit or share this file. [Configuration](configuration.md) lists every key and environment variable.

## 4. Set up Telegram

Telegram is how you approve pieces and how Pipeline tells you when something breaks.

1. In Telegram, message **@BotFather**, send `/newbot` and follow the prompts. Copy the token it gives you into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message (for example "hi").
3. In a browser, open `https://api.telegram.org/bot<your token>/getUpdates`. Find `"chat":{"id":123456789` and put that number in `.env` as `TELEGRAM_CHAT_ID`.

That one bot can serve every campaign. To give a campaign its own bot, or to let a client approve their own pieces, see [Telegram](telegram.md).

## 5. Create your first campaign

A **campaign** is one brand or account: its brief, voice, build list, posting schedule and settings. Campaigns live under the **campaigns root**, `C:\Campaigns` by default (set `PIPELINE_CAMPAIGNS_ROOT` to change it). Each campaign folder is its own git repository, because the build verifier uses git to see exactly what a build changed.

Start from the example:

```powershell
New-Item -ItemType Directory -Force C:\Campaigns | Out-Null
Copy-Item -Recurse C:\pipeline\examples\acme C:\Campaigns\acme
cd C:\Campaigns\acme
git init
git add -A
git commit -m "campaign: create acme"
```

Then edit `C:\Campaigns\acme\campaign.json`:

- `id` must match the folder name, and `root` must be the folder's full path.
- Set `name`, `timezone` (an IANA name such as `Europe/London` or `America/New_York`) and `slot` (the daily posting time in that zone).
- Put your Telegram chat id in `approvers`, as a string: `"approvers": ["123456789"]`.
- Leave `"paused": true` for now. A paused campaign never posts or builds on schedule.

Then rewrite `brief.md` (who you are, who it's for, what to make and never make), `voice.md` (how you sound) and `references.md` (techniques to follow) for your brand, and replace the ideas in `backlog.json`. Commit your changes.

Check it loads:

```powershell
cd C:\pipeline
node creation/create.mjs status --campaign acme
node publishing/publish.mjs status --campaign acme
```

[Campaigns](campaigns.md) explains every file. The full `campaign.json` reference is in [campaigns/schema.md](../campaigns/schema.md). You can also create campaigns from the console once it's running (step 10).

## 6. Install the skills

Claude Code **skills** are folders with a `SKILL.md` that teach a session how to do a job. Pipeline's sessions use three kinds:

1. **`piece-review`**, which ships with Pipeline. The fresh-eyes reviewer runs it on every piece. Install it for your user:

   ```powershell
   Copy-Item -Recurse C:\pipeline\skills\piece-review "$env:USERPROFILE\.claude\skills\piece-review"
   ```

2. **Instagram writing skills named `ig-reel`, `ig-caption` and `ig-human`.** The build prompt asks for them, and three automatic checks run their scripts (`hookscore.py`, `caption.py`, `detect.py`). Pipeline doesn't ship them. Either install skills with those names that follow the [script contract](skills.md#the-check-scripts), or switch those checks off in `campaign.json`:

   ```json
   "checks": { "captionPy": false, "detect": false, "detectOnScreen": false, "hookscore": false, "guardrails": true }
   ```

3. **Your video tools**, for example HyperFrames and media-use for rendering, voice and music. See the next step.

[Skills](skills.md) covers where skills live (for all campaigns, or one campaign only) and how to write your own.

## 7. Set up how videos get made

Pipeline doesn't render video itself. Each build session follows your campaign's `brief.md` and uses whatever tools you give it. The example brief uses **HyperFrames**, which renders HTML to MP4 with headless Chrome, plus its **media-use** skill for voiceover and music.

Install the HyperFrames skills for your user, including `media-use` (see the [HyperFrames repository](https://github.com/heygen-com/hyperframes) for the current command):

```powershell
npx hyperframes@latest skills
```

For voiceover with Google's Gemini text-to-speech and music with Lyria, add your Gemini API key as a user environment variable. Build sessions inherit it:

```powershell
setx GEMINI_API_KEY "your-key-here"
```

Then sign out and back in, so scheduled tasks pick it up. Without a Gemini key, media-use falls back to free local voices (Kokoro) and music (MusicGen), which need a one-time `pip install`.

Your finished piece must meet the folder contract: a 1080×1920 MP4 with sound, a caption file and a cover in `pieces/<id>/out/`. [Video and TTS](video-and-tts.md) covers the contract, other render stacks, voices, music and measuring loudness.

## 8. Build one piece by hand

Before scheduling anything, build one piece and watch what happens. With your campaign still paused:

```powershell
cd C:\pipeline
node creation/create.mjs nightly --now --id reel-01-first-sip --campaign acme
```

This runs everything the nightly run does, for one piece:

1. A headless Claude Code build session in `C:\Campaigns\acme`, fenced to `pieces/reel-01-first-sip/`, with a 60-minute limit.
2. The verifier, which reverts anything the session changed outside its folder.
3. The automatic checks: the folder contract, the skill scripts, the guardrail words, and ffprobe on the video.
4. The fresh-eyes review by a second, read-only session running `piece-review`.
5. On SHIP, the video goes to your Telegram with **Approve** and **Redo** buttons.

`--now` only builds the piece. Approve and Redo taps are read by the Telegram poll, so run it once by hand after you tap:

```powershell
node creation/create.mjs poll --campaign acme
```

**Approve** adds the piece to `schedule.json` and commits it. **Redo** asks what should change, and your reply becomes the note for the next build. If the piece fails, `node creation/create.mjs status --campaign acme` shows why. [Operations](operations.md) and [Troubleshooting](troubleshooting.md) cover what to do next.

## 9. Connect Instagram and ngrok

1. **Instagram.** Follow [Instagram](instagram.md) to switch your account to Professional, create a Meta app with the **Instagram API with Instagram Login** product, and generate a token.
2. **Save the token.** The simplest way is the console's **Connections** screen (step 10): paste the token there, and Pipeline checks it with Instagram, saves it to the campaign's secrets file and records posts that are already live, so they're never posted twice. [Instagram](instagram.md#saving-the-token) also covers a command-line way.
3. **ngrok.** Instagram only accepts a Reel from a public URL, so each post serves the video for a few minutes through a fresh ngrok tunnel. Add your ngrok authtoken once:

   ```powershell
   ngrok config add-authtoken <your token>
   ```

4. **Test without posting.** Once a piece is approved and in the schedule:

   ```powershell
   node publishing/publish.mjs ig-fetch-test reel-01-first-sip --campaign acme
   ```

   This does everything a real post does except publish. It should end with `Container status: FINISHED`. [ngrok](ngrok.md) explains the tunnel and its limits.

## 10. Open the console over Tailscale

The console is a local web app on `127.0.0.1:8787`. Tailscale publishes it privately to your own devices over HTTPS, and tells Pipeline who you are, so only your login can press buttons.

1. Sign Tailscale in on the PC, and on your phone with the same account.
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates** (on the DNS page).
3. Start the console, then publish it:

   ```powershell
   cd C:\pipeline
   node dashboard/server.mjs          # leave this running for now
   tailscale serve --bg 8787          # in another window
   ```

4. Open `https://<your-pc-name>.<your-tailnet>.ts.net` on your phone. `DASHBOARD_LOGIN` in `.env` must be exactly the login Tailscale shows. Otherwise the console is read-only.

To start the console automatically when you sign in, register its task once (step 11). Never use `tailscale funnel` for the console, because that would put it on the public internet. [Tailscale](tailscale.md) and [Console](console.md) have the details.

## 11. Schedule everything

Register the scheduled tasks. Run PowerShell as yourself, not as administrator:

```powershell
cd C:\pipeline
node campaigns/install-tasks.mjs --shadow    # first: a dry run that only logs what it would post
node dashboard/install-task.mjs
```

| Task | Runs | When |
| --- | --- | --- |
| Pipeline Publisher | `campaigns/pipeline.mjs publish-tick` | every 15 minutes; posts each campaign once its slot opens |
| Pipeline Creation | `campaigns/pipeline.mjs create-nightly` | 02:00, in your logged-in session |
| Pipeline Telegram | `campaigns/pipeline.mjs telegram-tick` | every 5 minutes; reads Approve and Redo taps |
| Pipeline Dashboard | `dashboard/server.mjs` | when you sign in; also runs the build queue |

Let the shadow publisher run for a day, then check its log in `%USERPROFILE%\.pipeline\logs\`. When it would have posted what you expect, register it for real:

```powershell
node campaigns/install-tasks.mjs
```

Finally, unpause the campaign: set `"paused": false` in `campaign.json`, or use **Campaigns → Resume** in the console.

Keep the PC awake and logged in overnight. In **Settings → System → Power**, set sleep to **Never** when plugged in. Then check the console's **Health** screen: every task should show its last run. [Operations](operations.md#scheduled-tasks) explains each task and why it runs the way it does.

## 12. Day to day

- **Overnight**, the creation task builds up to `maxBuilds` pieces per campaign (and 3 across all campaigns), checks and reviews them, and sends the ones that pass to Telegram.
- **You** tap **Approve**, or **Redo** with a note, on your phone, or use the console's **Review** screen.
- **At the slot**, the publisher posts the next approved piece: daily while `bufferMin` or more are ready, otherwise only on `fallbackDays`. Pinned pieces (`on`) post on their date.
- **Every run** reports to Telegram: what posted, what failed, what's queued and when the queue runs dry.
- **Ideas** go into `backlog.json`, or into the console's **Pipeline** screen.

Next: read [Security](security.md) to understand what the build sessions can and can't do, and [Troubleshooting](troubleshooting.md) for the common first-week problems.
