# dashboard

The console: `node dashboard/server.mjs` serves a JSON API and a dependency-free UI on `127.0.0.1:8787`, published privately with `tailscale serve`. It also runs the build queue every minute.

| File | Does |
| --- | --- |
| `server.mjs` | routes, the action checks (Tailscale login, CSRF, Origin), media with Range, and the queue runner. Its header documents the API. |
| `install-task.mjs` | registers the "Pipeline Dashboard" task (at sign-in) |
| `lib/status.mjs`, `lib/inbox.mjs` | a campaign's status and its to-dos |
| `lib/library.mjs`, `lib/calendar.mjs`, `lib/review.mjs` | the Library, Calendar and Review data |
| `lib/health.mjs` | scheduled tasks, loops, token ages, clock and disk |
| `lib/actions.mjs`, `lib/queue-actions.mjs`, `lib/creation-actions.mjs`, `lib/backlog-actions.mjs` | post now, queue controls, approve and redo and builds, and ideas |
| `lib/connection-actions.mjs`, `lib/campaign-actions.mjs`, `lib/campaign-file.mjs` | tokens and approvers, campaign settings and new campaigns |
| `lib/preview.mjs` | cached 720p phone previews |
| `lib/sources.mjs`, `lib/build-guard.mjs` | reading campaign data with secrets scrubbed, and refusing secret writes during builds |
| `ui/` | `index.html`, `app.js`, the screens, the player and styles. Text-only DOM, CSP `script-src 'self'`. |

Guides: [Console](../docs/console.md), [Tailscale](../docs/tailscale.md).

Tests: `node --test "dashboard/test/*.test.mjs"` (keep the quotes).
