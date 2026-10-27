# Operations

Everything you run by hand, everything that runs on its own, and where it keeps its state. Run commands from the Pipeline folder (for example `C:\pipeline`). Every command takes `--campaign <id>`. With only one campaign under the campaigns root you can leave it out. With several, it's required.

## Scheduled tasks

Registered by `node campaigns/install-tasks.mjs` and `node dashboard/install-task.mjs`. Each writes the task XML to `%TEMP%` and runs `schtasks /Create`. Registering needs no admin rights.

| Task | Command | Schedule | Runs as | Time limit |
| --- | --- | --- | --- | --- |
| **Pipeline Publisher** | `node campaigns/pipeline.mjs publish-tick` | every 15 minutes, all day | S4U (whether or not you're signed in) | 1 hour |
| **Pipeline Creation** | `node campaigns/pipeline.mjs create-nightly` | daily at 02:00 | your signed-in session | 10 hours |
| **Pipeline Telegram** | `node campaigns/pipeline.mjs telegram-tick` | every 5 minutes, all day | S4U | 30 minutes |
| **Pipeline Dashboard** | `node dashboard/server.mjs` | at sign-in, restarted up to 3 times | your signed-in session | none |

A task never starts a second copy while the previous one still runs.

- **publish-tick** goes over every campaign that isn't paused. Before a campaign's slot (in its own time zone) it does nothing. The first tick from the slot on runs that day's posting under the campaign's `publish` lock and records the day in `publish-day.json`, so later ticks leave it alone: one run and one report a day, with no same-day retry of a failed post. If the PC was asleep through the window, the first tick after it is that day's late run, and it posts nothing.
- **create-nightly** shares `PIPELINE_MAX_BUILDS_TOTAL` builds (default 3) round-robin across campaigns that aren't paused, each within its own `maxBuilds` and `maxAwaiting`, starting from a different campaign each night. A campaign the cap leaves out builds nothing that night, and you're told.
- **telegram-tick** polls each campaign's bot and handles Approve and Redo taps. It polls paused campaigns too, so a tap on a piece already sent still lands. It never starts builds, because S4U sessions can't run them. The console's server runs the build queue instead.

`node campaigns/install-tasks.mjs --shadow` registers the publisher as `publish-tick --shadow`: a dry run that logs what each campaign would post, sends nothing and records the day in `publish-shadow-day.json`. Use it for a day before going live.

Check a task:

```powershell
schtasks /Query /TN "Pipeline Publisher" /V /FO LIST
schtasks /Run /TN "Pipeline Publisher"
```

Or look at the console's **Health** screen.

### Keep the PC ready

- Set sleep to **Never** when plugged in (Settings → System → Power).
- Stay **signed in** overnight. Locking the screen is fine. Signing out stops the creation task and the console.
- Keep the **clock** right (Settings → Time & language → Set time automatically). A wrong clock shifts posting windows and breaks sign-ins.

## How posting is planned

For each enabled platform, every run:

1. **Checks** every queued item's folder against the [folder contract](video-and-tts.md#the-folder-contract). A broken item is skipped and reported, and the queue carries on.
2. Works out today's post:
   - **Pinned** items (`"on": "YYYY-MM-DD"`) post on that date only. A missed date drops the item.
   - **Floating** items post in list order, one a day while `bufferMin` (7) or more are ready, otherwise only on `fallbackDays` (Mon, Wed, Fri, Sun).
   - Items with `notBefore` and/or `notAfter` float, but only inside their window. Past `notAfter`, they're dropped.
   - **Held** items are skipped until released.
3. Looks for the same post already live (Instagram: the last 48 hours, matched on the caption's first line), and records it instead of posting twice.
4. Posts, and retries once after `retryDelaySeconds`. Each success is saved to `state.json` straight away.
5. Sends the report: what posted, what failed, what got dropped, what isn't ready, and the date the queue runs dry.

A run before the slot, or after `slot + lateLimitMinutes`, posts nothing. Instagram and YouTube each keep their own place in the queue.

## Publishing commands

```text
node publishing/publish.mjs [command] [--campaign <id>]
```

| Command | What it does |
| --- | --- |
| *(none)* | The daily run, as the publisher task does it. |
| `--dry-run` | The report and plan for a run started now. Changes nothing and needs no tokens. Before the slot it says `window early`. |
| `status` | Every item's dates and status per platform, whether it's ready, the next item per platform, the ready count, the rhythm, the run-dry date and the token ages. |
| `check` | Checks every item not yet on Instagram against the folder contract. Exits 1 if any fail. |
| `post <id> --now [--platform instagram\|youtube]` | Posts one item now, bypassing the planner, with the same already-live guard and retry. Refuses an item already done there. |
| `sync-state [--platform instagram\|youtube]` | Matches posts already live to items by the caption's first line, and marks the matches `manual`. |
| `mark <id> <instagram\|youtube> <posted\|manual\|dropped\|clear> [--date YYYY-MM-DD]` | A manual correction. `clear` makes the item due again. |
| `auth instagram` | Checks the campaign's saved `IG_ACCESS_TOKEN` and saves the account's user id and username. |
| `auth youtube` | Runs Google's consent flow on `http://127.0.0.1:8765/callback` and saves the refresh token. |
| `test-telegram` | Sends a test message to the campaign's approvers. |
| `ig-fetch-test <id>` | Everything a real Instagram post does except publish. See [ngrok](ngrok.md#test-it). |

Exit code 0 means OK, and 1 means something failed. A flag a command doesn't take is refused, so a typo can never turn a check into a real post.

## Creation commands

```text
node creation/create.mjs <command> [--campaign <id>]
```

| Command | What it does |
| --- | --- |
| `nightly` | Tonight's builds for this campaign, within its caps. |
| `nightly --now --id <piece>` | Builds one piece straight away, ignoring the nightly caps and formats. |
| `nightly --max-builds <n> --formats <a,b>` | Overrides the picker for one run. |
| `poll` | Handles Approve and Redo taps once, then exits. |
| `status` | Every backlog piece with its target date, format, status and failed attempts, plus failure reasons and redo notes. Read-only. |
| `reset <id>` | Puts a piece back to `todo`, with no attempts and no note. Refuses a piece that's building. |
| `recheck <id>` | Runs the checks and the review again on a built piece, as it is in its `out/` folder, with no build session. Use it after fixing a failed piece by hand. |

### How the nightly run picks

Under the campaign's `creation` lock, each night:

1. Marks any piece still `building` from a run that stopped as `failed`.
2. Picks from `backlog.json`: **redo** pieces first, then **failed** pieces with a try left, then **todo** pieces in target-date order. It takes at most `maxBuilds`, only from the campaign's `formats`, and nothing at all while `maxAwaiting` pieces already wait for approval.
3. Runs each piece: build session, verifier, checks, review. A **FIX** gets one automatic fix round with the review's must-fix list, and a second FIX fails the piece.
4. A failure is retried the next night once. After that it needs you (`reset` or `recheck`). The retry's build gets the stored failure reason as its note, so it fixes the build already in its folder instead of repeating the mistake.
5. Sends you a summary. One piece crashing never stops the next.

Builds never overlap a posting window: from 160 minutes before a campaign's slot until 15 minutes after its late limit, a **Build now** or **Recheck** is queued, not started.

## Campaign loops by hand

```powershell
node campaigns/pipeline.mjs publish-tick [--shadow]
node campaigns/pipeline.mjs create-nightly
node campaigns/pipeline.mjs telegram-tick
```

These are exactly what the scheduled tasks run, across all campaigns.

## Where everything lives

**The publisher home**, `%USERPROFILE%\.pipeline\` (or `PIPELINE_HOME`):

```text
.pipeline\
  .env                        owner settings and credentials (never commit)
  secrets\<id>.json           each campaign's tokens and keys (write-only from the console)
  locks\                      <id>:publish, <id>:creation, <id>:schedule and friends
  logs\YYYY-MM.log            owner-level events
  pipeline-alerts.json        the last invalid-campaign alert, so it's sent once a day
  previews\<id>\              cached phone previews for the console
  campaigns\<id>\
    state.json                what is posted, manual, dropped or failed, per item and platform
    backups\                  state.json after each run (newest 30) and old campaign.json copies
    publish-day.json          the day the publisher last ran for this campaign
    creation-state.json       each piece's build status, attempts, failure reason and redo note
    build-queue.json          queued Build now / Recheck requests (up to 10)
    telegram-offset.json      the poller's next update id
    telegram-seen.json        the last 20 chats that messaged the bot
    logs\YYYY-MM.log          one line per event, secrets redacted
```

`state.json` is the record that stops double posts. Don't delete it. Use `mark` to fix one item.

**The campaign folder**, for example `C:\Campaigns\acme\`, a git repository:

```text
campaign.json  brief.md  voice.md  references.md
backlog.json               ideas to build
schedule.json              approved pieces, in posting order
guardrails.json            word lists the checks scan for
pieces\<id>\               each piece's sources (committed) and out\ (rendered, ignored)
creation-out\<id>.json     the build's report, plus .checks.json and .review.json
.claude\skills\            this campaign's own skills
```

## Logs

Every component writes one line per event to `logs\YYYY-MM.log`, as JSON, with known secrets redacted. Start there when something goes wrong:

```powershell
Get-Content "$env:USERPROFILE\.pipeline\campaigns\acme\logs\$(Get-Date -Format yyyy-MM).log" -Tail 50
```

## Updating Pipeline

```powershell
cd C:\pipeline
git pull
npm test
```

The tasks run the code in place, so they pick up the update on their next start. Re-run the installers only if you move the folder or change Node's install path. Don't update while a build runs (check **Health**, or for a `creation` lock in `locks\`).

## Removing Pipeline

```powershell
schtasks /Delete /TN "Pipeline Publisher" /F
schtasks /Delete /TN "Pipeline Creation" /F
schtasks /Delete /TN "Pipeline Telegram" /F
schtasks /Delete /TN "Pipeline Dashboard" /F
tailscale serve reset
```

Then revoke the tokens you created (Meta app, Telegram bots via @BotFather, ngrok, Google), and delete `%USERPROFILE%\.pipeline` once you no longer need its records.
