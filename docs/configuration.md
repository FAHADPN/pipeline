# Configuration

Pipeline reads its settings from three places:

| Where | What | Committed? |
| --- | --- | --- |
| `%USERPROFILE%\.pipeline\.env` | the owner's settings and credentials | never |
| `%USERPROFILE%\.pipeline\secrets\<id>.json` | each campaign's tokens and keys | never |
| `C:\Campaigns\<id>\campaign.json` | each campaign's settings | yes, in the campaign's repo |

Plus a few environment variables.

## The owner `.env`

One `KEY=value` per line. Quotes are optional, and lines starting with `#` are comments.

| Key | Used for |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the owner bot: alerts, and approvals for campaigns without their own bot |
| `TELEGRAM_CHAT_ID` | your chat with the owner bot, where alerts go |
| `DASHBOARD_LOGIN` | the Tailscale login allowed to act in the console |
| `YT_CLIENT_ID`, `YT_CLIENT_SECRET` | the Google Desktop OAuth client, shared by every campaign's YouTube connection |

## Campaign secrets

`secrets\<id>.json` holds a campaign's credentials. The console writes it, and so do `publish.mjs auth`. You can also write it by hand:

```json
{
  "version": 1,
  "secrets": {
    "IG_ACCESS_TOKEN": { "value": "...", "updatedAt": "2026-01-01T00:00:00.000Z" }
  }
}
```

| Name | Set by |
| --- | --- |
| `IG_ACCESS_TOKEN`, `IG_USER_ID`, `IG_USERNAME`, `IG_ISSUED_AT` | Connections → Instagram, or `auth instagram`. Refreshed automatically. |
| `YT_REFRESH_TOKEN`, `YT_CHANNEL` | `auth youtube` |
| `TELEGRAM_BOT_TOKEN` | Connections → Telegram (the campaign's own bot) |
| `ANTHROPIC_API_KEY` | Connections → Anthropic API key |

Other names are refused.

## `campaign.json`

Only `id`, `name` and `root` are required. Everything else has a default. The full field reference is [campaigns/schema.md](../campaigns/schema.md). A broken file is refused with every problem listed at once, and the scheduled loops skip just that campaign and alert you once a day.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PIPELINE_HOME` | `%USERPROFILE%\.pipeline` | the publisher home |
| `PIPELINE_CAMPAIGNS_ROOT` | `C:\Campaigns` | where campaign folders live |
| `PIPELINE_MAX_BUILDS_TOTAL` | `3` | builds per night across all campaigns |
| `DASHBOARD_PORT` | `8787` | the console's port (for a test instance) |
| `FFMPEG_BIN` | (unset) | full path to `ffmpeg.exe`. The checks look for `ffprobe.exe` beside it when ffprobe isn't on PATH. Build sessions inherit it. |
| `GEMINI_API_KEY` | (unset) | not read by Pipeline. Build sessions inherit it, for Gemini TTS and Lyria music through your skills. |
| `ELEVENLABS_API_KEY` | (unset) | the same, for ElevenLabs voices |

Set persistent variables with `setx NAME "value"`, then sign out and back in, so scheduled tasks see them.

Build and review sessions get your whole environment, plus `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`, and a campaign's `ANTHROPIC_API_KEY` when it has one. When it doesn't, the variable is removed.
