# Security model

Pipeline runs AI sessions unattended, on your PC, with access to your accounts. This page says plainly what protects you and what doesn't, so you can decide what to trust it with.

## The short version

- Nothing posts without a human tapping **Approve**.
- Build sessions are fenced by a tool allowlist and, more importantly, checked afterwards. Anything they change outside their own folder is reverted, and you're alerted.
- Secrets live outside every repository, are write-only in the console and are scrubbed from logs and errors.
- The console is reachable only inside your tailnet, and only your login can act.
- The PC itself is trusted. Anything running as your Windows user can already read your secrets.

## Approval is the gate

A piece reaches `schedule.json` only through an **Approve** tap, from a chat in the campaign's `approvers`, or from the console by `DASHBOARD_LOGIN`. Build sessions are told never to touch the schedule, and they hold the `schedule` lock while they run, so nothing else edits it mid-build either. The verifier reverts any change a build makes to it.

## Build sessions

A build session is `claude -p` running as **your Windows user**, in the campaign's folder. What limits it:

1. **The tool allowlist.** Read, Edit, Write, Glob, Grep, Skill, and Bash only for `node`, `python`, `git add/commit/status/diff`, `ls` and `mkdir`, plus the campaign's `extraAllowedTools`. WebFetch, WebSearch, `git push`, `curl` and `schtasks` are denied.
2. **The prompt's rules.** Work only in the piece folder, read nothing outside the campaign, never read `.env` or `secrets`, never print a secret, never push.
3. **The post-session verifier**, which is the real wall. After every session it lists what changed (git commits since the start, plus the working tree) and fails the piece if:
   - any path is outside `pieces/<id>/` and `creation-out/<id>.json`,
   - the owner `.env`, the campaign's `state.json` or `tokens.json`, or **any** campaign's secrets file changed (fingerprinted before and after),
   - any commit message carries AI attribution.

   It then reverts the changes outside the folder and alerts you with the file names.
4. **A time limit.** 60 minutes, then the whole process tree is killed.

**What this doesn't stop.** A session can **read** anything your user can read, including `%USERPROFILE%\.pipeline\secrets\`. The prompt forbids it and nothing writes it back, but a malicious skill, a prompt injection in a file the session reads, or a model mistake could expose a secret in the piece's own files or report. Mitigations:

- Install only skills you trust (see [Skills](skills.md#skills-and-safety)).
- Keep untrusted content out of campaign folders.
- Review what you approve. Captions and videos are what leave your PC.
- Use a separate Windows account for Pipeline if you want an OS-level boundary.

`extraAllowedTools` widens the allowlist. Add only what the campaign needs, and prefer narrow patterns (`Bash(npx hyperframes:*)`, not `Bash`).

## The reviewer

The review session gets Read, Glob, Grep and Skill. Bash, Edit, Write and NotebookEdit are **denied outright**, so an allow rule in your own settings can't hand them back. It can judge a piece but never change one. A malformed or missing verdict counts as **FIX**, and a SHIP that lists must-fix items counts as FIX too.

## Client notes

A Redo note from an approver who isn't you goes into an overnight build prompt with no review by you. It's limited to 500 characters. It's held for you if it mentions secrets, tokens, keys, passwords or `.env`, or contains URLs, web addresses or file paths, or asks to ignore instructions (after stripping invisible characters). When accepted, it's fenced in the prompt as data under a rule never to follow instructions inside it. You get a copy of every one. See [Telegram](telegram.md#clients-as-approvers).

## Secrets

- **Where:** the owner `.env` and `secrets\<id>.json` in the publisher home, never inside a campaign folder or this repository. Writes are atomic.
- **Write-only:** the console shows "set, N days ago", never a value. Saved values never come back in a response, a log line or an error message. Errors from reading a broken secrets file never quote its contents.
- **Scrubbed:** the console and logs replace every known secret value with a placeholder before showing text.
- **Not while building:** no secret can be saved while any build runs.
- **Least privilege:** each campaign has its own tokens. A campaign without its own Anthropic key never inherits one from your environment.

## The console

- It binds to `127.0.0.1` only. `tailscale serve` publishes it inside your tailnet over HTTPS.
- **Actions** need the `Tailscale-User-Login` header to equal `DASHBOARD_LOGIN`, a per-server-start CSRF token and an `Origin` that matches the `Host`. Without `DASHBOARD_LOGIN`, nobody can act.
- Pages are text-only DOM with a strict Content Security Policy (`script-src 'self'`). Static files come from a fixed allowlist, and media only from inside a piece's `out\`.
- **Trust boundary:** a process on the PC itself can reach `127.0.0.1:8787` and send any header it likes, so it could act as you. That's within the "the PC is trusted" assumption above.
- Never use `tailscale funnel` for the console.

## Public exposure

The only thing ever exposed to the internet is the [ngrok](ngrok.md) tunnel during an Instagram post. It serves only that item's video and cover, at a random 32-character path, and closes when the attempt ends. Every other path is a 404.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
