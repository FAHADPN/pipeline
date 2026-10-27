# Console

The console is Pipeline's admin app: one page for every campaign, on desktop and phone. It's served by `node dashboard/server.mjs` on `127.0.0.1:8787` and reached privately through [Tailscale](tailscale.md).

Everyone who can reach it can see it. Only your Tailscale login (`DASHBOARD_LOGIN`) can press buttons. Pick the campaign from the switcher at the top. Its id goes in the address as `?campaign=<id>`, and without one the console shows the first campaign in folder order.

## Screens

### Needs you

The home screen: the campaign's stats, a to-do list with one action per item (a failed build, a piece awaiting approval, an expiring token), the next post with **Post now** and **Hold**, and this week's queue.

### Pipeline

Every piece by where it is, from idea to posted, in six columns. You can:

- **+ Idea** opens a form for a new backlog entry: title, premise, format, type, target date and an optional window. Edit and remove ideas that aren't built yet.
- Drag the **Ready** pieces to change posting order. The order is the queue.
- See which pieces are building, and their place in the build queue.

### Calendar

Five weeks from a Monday: what posts on each day, pinned festival pieces, and which builds are due. Drag a Ready post onto a later day to pin it there. Days beyond the projection show pinned posts only. On a phone, the calendar becomes an agenda list.

### Library

Every piece the campaign has built, as cover cards, with status filters, search over titles and captions, and sorting. Tap a card to play it.

### Review

Every piece waiting for you: awaiting approval, failed, back for a redo, or queued to build. Open one to see:

- the video, and the skill checks with their verdicts,
- the reviewer's verdict, lens scores and must-fix list,
- the caption and YouTube title,
- the actions its status allows: **Approve**, **Redo** (with a note), **Build again now** or **Recheck**.

While a piece builds, its progress and log lines show live. A failed piece leads with why it stopped.

### Health

The campaign's posting checks, then the machine's own:

- the four scheduled tasks, each with its last result,
- each campaign's loops (publish, create, Telegram) and its Instagram token age,
- the PC's clock compared with internet time (a wrong clock breaks posting windows and sign-ins),
- free disk space,
- the console's recent actions.

### Connections

Instagram, YouTube, Telegram and the campaign's Anthropic API key. Secrets are **write-only**: each shows "set, N days ago" or "not set". A new value goes in through a password field that's never pre-filled and is cleared once sent.

- **Instagram:** paste a token. It's checked with Instagram, saved, and followed by one sync-state (see [Instagram](instagram.md#saving-the-token)).
- **Telegram:** the campaign's own bot token, its approvers (chosen from the last chats that messaged the bot), and **Test**.
- **Anthropic API key:** bills this campaign's build and review sessions to that key.
- **YouTube:** shows status only. Connect it from the command line (see [YouTube](youtube.md)).

### Campaigns

Every campaign with its health, its next post and whether it's paused.

- **Pause** and **Resume**.
- A settings form: name, slot, late limit, buffer, fallback days, platforms, approvers and every check switch.
- **New campaign**, from the blank template. It creates `C:\Campaigns\<id>\` with a starter `brief.md`, `voice.md`, `references.md`, empty `backlog.json`, `schedule.json` and `guardrails.json`, `.claude\skills\` and a `.gitignore`. It then runs `git init`, and the campaign starts paused.

## The player

One player for every screen. On a desktop it's a modal, with the video on the left and details and actions on the right. On a phone it fills the screen and plays a lighter 720p preview. Previews are made with ffmpeg on first play and cached. Actions available in the player: Post now, Pin, Hold, Release, Unpin, Drop, Approve and Redo, depending on the piece's status.

## How edits are made safely

- Every action needs your Tailscale login, this server start's CSRF token and a matching `Origin`. Anything less gets a 403.
- Schedule, backlog and `campaign.json` edits are made under the campaign's `schedule` lock, waiting 3 seconds at most. A build holds that lock for its whole run, so an edit during a build is refused with a message naming the build, instead of being reverted later.
- `campaign.json` edits are validated first, the old file is copied to `<campaign home>\backups\`, and the new one is written atomically, in its own layout.
- No secret is saved while any build runs. A build fails if any secrets file changes under it.
- **Build now** and **Recheck** pressed during a build, or inside a posting window, are **queued**, not refused. The queue holds up to 10 entries per campaign, in order. The console's server starts the next queued build every minute when nothing else is running, and each finished build starts the next one too.
- Every action is logged as `dashboard <action>` in the campaign's log, with its result but never what was submitted.
- Every error and log line shown in the console has known secret values scrubbed out.

## API

The UI is plain JavaScript modules that call a small JSON API. It's documented at the top of [`dashboard/server.mjs`](../dashboard/server.mjs): `/api/campaigns`, `/api/status`, `/api/health`, `/api/library`, `/api/calendar`, `/api/pipeline`, `/api/review`, `/api/build`, `/media/<id>/<file>` and `POST /api/action`.
