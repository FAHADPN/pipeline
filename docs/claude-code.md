# Claude Code

Pipeline uses [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) in headless mode (`claude -p`) for two jobs: the **build session** that makes each piece, and the **review session** that judges it. Both run unattended, in the campaign's folder, with the prompt on stdin.

## Install

Use the native installer, so `claude.exe` is on your PATH:

```powershell
irm https://claude.ai/install.ps1 | iex
where.exe claude      # must list claude.exe
```

Pipeline spawns `claude` directly, without a shell, so every argument (including parentheses and `*` in tool patterns) reaches it exactly as written. Windows can't start a `.cmd` shim that way, so an npm-installed `claude.cmd` fails with `spawn claude ENOENT`.

## Signing in

Sessions run as your Windows user and inherit your environment, so there are two ways to pay for them:

- **Your Claude subscription (Pro or Max).** Run `claude` once, type `/login`, and finish in the browser. Every build and review session reuses this sign-in.
- **An API key per campaign.** In the console, **Connections → Anthropic API key** saves `ANTHROPIC_API_KEY` to that campaign's secrets file. Its build and review sessions then use the key, and other campaigns keep using the sign-in. A campaign without its own key never inherits one from your environment: the variable is removed for its sessions.

Watch your usage while you tune a campaign. A build is one long session (up to 200 turns and 60 minutes), plus a review (up to 100 turns and 20 minutes). A failed review gets one fix round.

## The build session

Started by `creation/lib/session.mjs` as:

```
claude -p --permission-mode acceptEdits --output-format text --max-turns 200
  --allowedTools Read Edit Write Glob Grep Skill
                 "Bash(node:*)" "Bash(python:*)" "Bash(git add:*)" "Bash(git commit:*)"
                 "Bash(git status:*)" "Bash(git diff:*)" "Bash(ls:*)" "Bash(mkdir:*)"
                 <the campaign's extraAllowedTools>
  --disallowedTools WebFetch WebSearch "Bash(git push:*)" "Bash(curl:*)" "Bash(schtasks:*)"
```

- **Working folder:** the campaign's `root`.
- **Prompt:** built by `creation/lib/prompt.mjs` from the backlog entry, the campaign's whole `brief.md`, `voice.md` and `references.md`, any redo note, and the rules below.
- **Time limit:** 60 minutes. After that, the whole process tree is killed (`taskkill /T /F`) and the piece fails.
- **Environment:** your own, plus `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`, so the Python skill scripts don't crash on emoji under Windows' console code page. Anything you set yourself, such as `GEMINI_API_KEY` or `FFMPEG_BIN`, passes through.

The rules the prompt gives the session:

1. Work only in `pieces/<id>/`, plus the report file `creation-out/<id>.json`.
2. No web tools, and no internet unless one of the campaign's own tools is made for it.
3. Never push, never read outside the campaign folder, never read `.env` files or `secrets`, never print a secret.
4. Don't touch the schedule: pieces enter it only through approval.
5. Keep drafts in `pieces/<id>/out/scratch/`.
6. Deliver the video, caption and cover (see [Video and TTS](video-and-tts.md#the-folder-contract)), run the skill scripts until they pass, commit only the piece's own files as `content: build <id>`, with no AI attribution, and write the report.

### Giving a campaign more tools

`extraAllowedTools` in `campaign.json` adds tools to the allowlist. For example, to let a campaign's sessions use an MCP server you've configured, such as an avatar or stock-media service:

```json
"extraAllowedTools": ["mcp__heygen__*"]
```

The denied tools stay denied, whatever you add.

## The allowlist isn't the safety net. The verifier is.

A session runs as your Windows user, so a determined session could do anything you can. Pipeline doesn't rely on the allowlist alone. After every build, `creation/lib/verify.mjs`:

- lists every file the session changed, from git (its commits since the start, plus the working tree),
- fails the piece if any path is outside `pieces/<id>/` and `creation-out/<id>.json`,
- fails it if your publisher home's `.env`, the campaign's `state.json` or `tokens.json`, or **any** campaign's secrets file changed (it fingerprints them before and after),
- fails it if any commit message carries AI attribution (`Co-Authored-By`, `Generated with`, a robot emoji),
- then reverts everything outside the allowed folder and alerts you with the file names.

Build sessions also hold the campaign's `schedule` lock for their whole run, so the console and the Telegram poller can't edit the schedule mid-build. They're refused instead of being reverted later. No secret can be saved in the console while any build runs.

See [Security](security.md) for the whole model.

## The review session

Started by `creation/lib/review.mjs` as:

```
claude -p --output-format text --max-turns 100
  --allowedTools Read Glob Grep Skill
  --disallowedTools WebFetch WebSearch Bash Edit Write NotebookEdit
```

It's read-only: it can look at the piece and read files, but it can't run anything or change anything. Bash, Edit and Write are denied outright, so an allow rule in your own Claude Code settings can't hand them back. It runs the [`piece-review`](skills.md#piece-review) skill against the campaign's brief and voice, reads the skill scripts' results from `creation-out/<id>.checks.json`, and replies with a SHIP or FIX verdict as JSON. The verdict is saved to `creation-out/<id>.review.json` for the console.

Anything short of a clean verdict counts as **FIX**: a timeout, a non-zero exit, a spawn error or output with no JSON. A SHIP that still lists must-fix items is also treated as FIX.

## Your own Claude Code settings

Sessions read your normal Claude Code configuration (`%USERPROFILE%\.claude\`), including skills, `settings.json` and MCP servers, plus anything in the campaign folder's `.claude\`. Keep that in mind:

- A skill installed for your user is available to every campaign. Put brand-specific skills in `C:\Campaigns\<id>\.claude\skills\` instead.
- Broad `allow` rules in your user settings can widen what a build session may do without asking. The verifier still catches anything written outside the piece folder.
