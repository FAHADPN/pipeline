# campaign.json

A campaign is a folder under the campaigns root, `C:\Campaigns\` (the `PIPELINE_CAMPAIGNS_ROOT` environment variable overrides it). The folder holds `campaign.json`, and its name must be the campaign's `id`. [`campaigns/lib/campaign.mjs`](lib/campaign.mjs) loads and checks it.

Every field except `id`, `name` and `root` is optional, and a missing field takes the default shown. A broken file is refused with every problem listed at once. The scheduled loops skip only that campaign and alert the owner once a day. Unknown top-level fields are kept as they are.

Secrets never go in `campaign.json`. They live in `%USERPROFILE%\.pipeline\secrets\<id>.json`. State (posting record, build progress, Telegram offset, logs) lives in `%USERPROFILE%\.pipeline\campaigns\<id>\`. The `PIPELINE_HOME` environment variable overrides the base folder. Locks are named `<id>:<name>`, for example `acme:publish`.

## Identity

| Field | Default | Rule |
|---|---|---|
| `id` | required | lowercase letters, digits and dashes, the same as the folder name |
| `name` | required | shown in the console and in Telegram |
| `root` | required | absolute path to the campaign's files, usually the campaign folder itself. It must be a git repository. |
| `timezone` | `Asia/Kolkata` | an IANA time zone, such as `Europe/London`. The slot is in this zone. |
| `paused` | `false` | a paused campaign never posts or builds. Its Telegram taps are still handled. |

## Posting

| Field | Default | Rule |
|---|---|---|
| `slot` | `"19:30"` | `HH:MM`, the daily posting time |
| `lateLimitMinutes` | `120` | a run more than this long after the slot posts nothing |
| `bufferMin` | `7` | with this many pieces ready, post daily. Below it, post only on `fallbackDays`. |
| `fallbackDays` | `["Mon", "Wed", "Fri", "Sun"]` | days from `Mon` to `Sun` |
| `retryDelaySeconds` | `60` | the wait before the one retry of a failed post |

## Platforms

`platforms.instagram`:

| Field | Default |
|---|---|
| `enabled` | `true` |
| `graphVersion` | `"v24.0"` |
| `useCover` | `true` (serve the `-cover.png`. `false` lets Instagram take the frame at `thumbOffsetMs`.) |
| `thumbOffsetMs` | `1500` |
| `tokenRefreshDays` | `30` |
| `ngrokBin` | `"ngrok"` (from PATH). Use the full path to `ngrok.exe` if scheduled runs can't find it. |

`platforms.youtube`:

| Field | Default |
|---|---|
| `enabled` | `false` (keep it off until Google's API audit passes) |
| `privacy` | `"private"` (`private`, `unlisted` or `public`) |
| `categoryId` | `"22"` |

No other platforms are accepted.

## Creation

| Field | Default | Rule |
|---|---|---|
| `formats` | `episode, this-or-that, how-many, two-phones, greeting` | the formats the nightly run picks, from `episode`, `this-or-that`, `how-many`, `two-phones`, `greeting`, `carousel` and `hot-take` |
| `maxBuilds` | `2` | builds a night for this campaign |
| `maxAwaiting` | `6` | no builds while this many pieces wait for approval |
| `approvers` | `[]` | Telegram chat ids, as strings (`"123456789"`, `"-1001234"`). Only these chats can approve or redo this campaign's pieces. A campaign with none builds nothing. |
| `extraAllowedTools` | `[]` | added to the build session's `--allowedTools`, for example `"Bash(npx hyperframes:*)"` or `"mcp__heygen__*"` |

## Checks

`checks` switches each automatic check on or off. The fresh-eyes review always runs.

| Field | Default | Check |
|---|---|---|
| `captionPy` | `true` | `ig-caption/caption.py` on the caption |
| `detect` | `true` | `ig-human/detect.py` on the caption |
| `detectOnScreen` | `true` | makes `detect.py` on the on-screen lines blocking, when a piece provides them |
| `hookscore` | `true` | `ig-reel/hookscore.py` on the hook |
| `guardrails` | `true` | the `guardrails.json` word lists |

See [Skills](../docs/skills.md#the-check-scripts) for the script contract.

## Video spec

`videoSpec` sets the limits the automatic checks hold a finished video to:

| Field | Default |
|---|---|
| `width` | `1080` |
| `height` | `1920` |
| `minSeconds` | `7` |
| `maxSeconds` | `35` |
| `audioRequired` | `true` |
| `youtubeTitleRequired` | `true` |

## Paths

`paths` overrides where the campaign's files are. Relative paths are inside `root`. A path starting with `%USERPROFILE%` or `~` is in your home folder.

| Field | Default |
|---|---|
| `schedule` | `schedule.json` |
| `backlog` | `backlog.json` |
| `brief` | `brief.md` |
| `voice` | `voice.md` |
| `references` | `references.md` |
| `piecesDir` | `pieces` |
| `guardrails` | `guardrails.json` |
| `verifyPrefix` | `<piecesDir>/<id>/`, so `pieces/<id>/` by default |

`verifyPrefix` is the folder a build session may change, relative to `root`, with `<id>` standing for the piece id. It must contain `<id>` and stay inside `root`. It's required when `piecesDir` is an absolute path.

## Example

See [`examples/acme/campaign.json`](../examples/acme/campaign.json) for a complete file.
