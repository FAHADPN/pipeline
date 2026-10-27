# publishing

Posts approved pieces. For each campaign, it plans the day from the schedule, guards against double posts, serves the video to Instagram through a short-lived ngrok tunnel, records every post in the campaign's `state.json`, and reports to Telegram.

| File | Does |
| --- | --- |
| `publish.mjs` | the CLI: daily run, `--dry-run`, `status`, `check`, `post`, `sync-state`, `mark`, `auth`, `test-telegram`, `ig-fetch-test` |
| `lib/run.mjs` | `runDay` and `postNow`: plan, guard, post, retry, record, report |
| `lib/planner.mjs` | which item posts today: pinned, floating, windows, rhythm and run-dry projection |
| `lib/schedule.mjs`, `lib/schedule-edit.mjs` | loading, validating and editing `schedule.json` |
| `lib/content.mjs` | the folder contract: video, caption sections and cover |
| `lib/instagram.mjs` | Instagram API with Instagram Login: containers, status, publish, refresh |
| `lib/public-file.mjs` | the random-path file server behind an ngrok tunnel |
| `lib/youtube.mjs` | YouTube Data API uploads and OAuth |
| `lib/telegram.mjs` | the Bot API client |
| `lib/report.mjs` | the Telegram report for a run |
| `lib/state.mjs`, `lib/sync.mjs` | posting state, token stores and sync-state |
| `lib/lock.mjs`, `lib/log.mjs`, `lib/env.mjs`, `lib/dates.mjs` | locks, logs, the publisher home and time zones |
| `lib/campaign-deps.mjs` | everything above, wired for one campaign |
| `install-task.mjs` | shared Task Scheduler XML helpers |

Guides: [Operations](../docs/operations.md), [Instagram](../docs/instagram.md), [ngrok](../docs/ngrok.md), [YouTube](../docs/youtube.md).

Tests: `node --test "publishing/test/*.test.mjs"` (keep the quotes).
