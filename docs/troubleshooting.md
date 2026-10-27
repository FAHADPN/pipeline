# Troubleshooting

Start with the campaign's log (`%USERPROFILE%\.pipeline\campaigns\<id>\logs\YYYY-MM.log`), the console's **Health** screen and the Telegram alerts. Every failure names its reason.

## Setup

| Symptom | Fix |
| --- | --- |
| `spawn claude ENOENT` in a build | Claude Code isn't installed as `claude.exe`, or not on the task's PATH. Use the native installer, and check `where.exe claude`. |
| A build fails at once with a sign-in error | Run `claude` and `/login` as the same Windows user the tasks run as, or save an Anthropic API key for the campaign. |
| `Invalid campaign config: ... id "x" must match its folder` | The folder name and `id` differ. Rename one. |
| `root must be an absolute path` | Use the full path, with doubled backslashes in JSON: `"C:\\Campaigns\\acme"`. |
| `several campaigns under C:\Campaigns (a, b); pick one with --campaign <id>` | Add `--campaign <id>` to the command. |
| `no campaign found under C:\Campaigns; make one there, or point PIPELINE_CAMPAIGNS_ROOT at yours` | Create a campaign folder (step 5 of [Setup](SETUP.md#5-create-your-first-campaign)), or set `PIPELINE_CAMPAIGNS_ROOT`. |
| `unknown campaign <id>` | No folder with that name has a `campaign.json`. Check the spelling and the campaigns root. |
| `ffprobe did not return JSON` | ffprobe isn't found. Put ffmpeg on PATH, or set `FFMPEG_BIN` to the full path of `ffmpeg.exe`. |
| `caption.py did not return JSON` (or `detect.py`, `hookscore.py`) | The skill isn't installed at `%USERPROFILE%\.claude\skills\<skill>\`. Install a compatible one, or turn its check off. See [Skills](skills.md#the-instagram-writing-skills). |
| Python scripts crash on emoji | Something stripped the UTF-8 settings. Pipeline sets `PYTHONUTF8=1`, so run scripts by hand with `python -X utf8`. |

## Builds

| Symptom | Fix |
| --- | --- |
| `has no approval chat: no approvers in its campaign.json` | Add your chat id to `approvers`. |
| `nothing built, the cap of 3 went to other campaigns` | Normal with several campaigns. Raise `PIPELINE_MAX_BUILDS_TOTAL` if your PC and plan can take it. |
| No builds while pieces wait | `maxAwaiting` pieces are already waiting for approval. Approve or redo some. |
| **Violation:** files changed outside the piece folder | The session wrote somewhere it shouldn't. It's been reverted. Read the named files, tighten the brief, and check your skills. |
| `video is 1080x1350, not 1080x1920` or `video is 41 s long` | The piece doesn't meet the campaign's `videoSpec`. Fix the brief's build instructions, or change `videoSpec`. |
| `video has no audio stream` | Add a voiceover or music in the brief, or set `videoSpec.audioRequired` to `false` if silent videos are intended. |
| `review did not complete: timed out` | The reviewer ran out of time (20 minutes). Rerun with `create.mjs recheck <id>`. |
| Build now didn't start straight away | Builds run one at a time, and never inside a posting window. The console **queues** the build instead and starts it when it can. Check **Review** for "Queued #n". |
| A build failed twice | It needs you: read the reason in `create.mjs status`, fix by hand if you like, then `recheck <id>`, or `reset <id>` to rebuild from scratch. |

## Posting

| Symptom | Fix |
| --- | --- |
| Nothing posted, report says `window early` or `late` | The run happened outside `slot` to `slot + lateLimitMinutes`. Check the PC's clock and time zone, and that it was awake at the slot. |
| Nothing posted on an off day | Fewer than `bufferMin` pieces are ready, so the campaign only posts on `fallbackDays`. Approve more pieces. |
| `ngrok failed to start` | See [ngrok](ngrok.md#troubleshooting). |
| `API access blocked.` | Meta blocked the token or app. Generate a new token and save it in Connections. Check the Meta app dashboard for alerts. |
| A post went out twice | It shouldn't: the already-live guard checks the last 48 hours. If you posted by hand with a different first caption line, run `sync-state` or `mark <id> instagram manual`. |
| Report says `not ready: <id>` | The piece's folder fails the contract. `publish.mjs check --campaign <id>` lists why. |

## Console

| Symptom | Fix |
| --- | --- |
| Buttons are missing (read-only) | `DASHBOARD_LOGIN` doesn't match your Tailscale login exactly, or you opened it without Tailscale. The status JSON's `canAct` shows what the server decided. |
| The page doesn't load on the phone | Is the phone on Tailscale? Check `tailscale serve status` on the PC, and that the **Pipeline Dashboard** task is running. |
| A save says the schedule is locked | A build holds the campaign's `schedule` lock. Try again after it finishes. |
| A secret can't be saved | No secret can be saved while any build runs, because the build would fail. Wait for it to finish. |

## Getting help

Open an issue with the failing command, the log lines around the failure (check them for secrets first: logs are redacted, but double-check) and your Windows, Node and Claude Code versions.
