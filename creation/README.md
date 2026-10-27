# creation

Builds pieces. Each night it picks work from a campaign's backlog, runs a fenced Claude Code build session per piece, verifies the session stayed in its folder, runs the automatic checks and the read-only review, and sends what passes to Telegram for approval.

| File | Does |
| --- | --- |
| `create.mjs` | the CLI: `nightly`, `poll`, `status`, `reset`, `recheck` |
| `lib/nightly.mjs` | `runNightly` and `runRecheck`: the night's loop, fix rounds, retries and summary |
| `lib/picker.mjs` | what to build tonight: redo, retry, then todo, within the caps |
| `lib/backlog.mjs` | loading and validating `backlog.json` |
| `lib/prompt.mjs` | the build prompt: brief, voice, references, rules and output contract |
| `lib/session.mjs` | the headless `claude -p` build session: allowlist, time limit and environment |
| `lib/verify.mjs` | the post-session verifier: changed paths, fingerprints, attribution and revert |
| `lib/checks.mjs` | the automatic checks: contract, skill scripts, guardrails and ffprobe |
| `lib/review.mjs` | the read-only review session and its SHIP/FIX verdict |
| `lib/approval.mjs` | Approve and Redo from Telegram and the console |
| `lib/insert.mjs` | putting an approved piece into the schedule |
| `lib/build-queue.mjs` | queued Build now and Recheck requests |
| `lib/client-text.mjs` | screening notes from clients |
| `lib/cstate.mjs` | each piece's build status |
| `lib/constants.mjs` | shared values: the `creation-out` folder, the build lock's stale age and the posting-window margins |
| `lib/campaign-deps.mjs` | everything above, wired for one campaign |

Guides: [Claude Code](../docs/claude-code.md), [Skills](../docs/skills.md), [Video and TTS](../docs/video-and-tts.md), [Operations](../docs/operations.md#creation-commands).

Tests: `node --test "creation/test/*.test.mjs"` (keep the quotes).
