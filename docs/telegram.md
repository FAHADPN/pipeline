# Telegram

Telegram is Pipeline's phone interface. It carries two kinds of message:

- **Approvals**, which go to a campaign's **approvers**: each finished video with its review summary, lens scores, skill verdicts, caption, title, planned date, and **Approve** and **Redo** buttons.
- **Alerts**, which go to **you**, the owner, only: crashes, failed builds, verifier violations, must-fix lists, nightly summaries and daily posting reports.

## The owner bot

1. Message **@BotFather**, send `/newbot`, pick a name and a username.
2. Copy the token into `%USERPROFILE%\.pipeline\.env` as `TELEGRAM_BOT_TOKEN`.
3. Send the bot any message, then open `https://api.telegram.org/bot<token>/getUpdates`. The number at `"chat":{"id":...}` is your chat id. Put it in `.env` as `TELEGRAM_CHAT_ID`.

```ini
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789
```

## Approvers

Each campaign lists who may approve its pieces in `campaign.json`, as strings:

```json
"approvers": ["123456789"]
```

Only taps and messages from these chats are acted on. Up to 10 approvers are allowed, and every approval message goes to each of them. A campaign with no approvers builds nothing, and says why.

The console's **Connections** screen can add approvers for you: it lists the last 20 chats that messaged the bot, so you can pick one instead of hunting for an id.

## One bot or one per campaign

- **Shared (simplest).** A campaign without its own bot uses the owner bot. Its messages start with `[Campaign name] `, so you can tell campaigns apart.
- **Its own bot.** Create another bot with BotFather and save its token in **Connections → Telegram** (stored as `TELEGRAM_BOT_TOKEN` in the campaign's secrets file). That campaign's approvals then come from its own bot, with no label. Alerts still go to the owner bot.

Campaigns that share a bot share one `getUpdates` call, and each tap is routed to the campaign that owns the piece. **Connections → Test** sends "Test message from the console" to each approver.

## Approve and Redo

- **Approve** inserts the piece into the campaign's `schedule.json`, in calendar order, with its `on`, `notBefore` or `notAfter` window. It then runs the schedule and folder checks, writes the file atomically and commits `content: approve <id>` in the campaign's repository. All of this happens under the campaign's `schedule` lock. Any failure puts the file back as it was. Tapping Approve twice approves once.
- **Redo** replies "What should change?". Your next message becomes the note, and the piece goes back as `redo` for the next night. The build session gets the note and changes the build already in its folder, instead of starting over.

The **Pipeline Telegram** task reads taps every 5 minutes, so expect up to a 5-minute delay. To handle them at once, run:

```powershell
node creation/create.mjs poll --campaign <id>
```

The console's **Review** screen has the same Approve and Redo controls.

## Clients as approvers

You can add a client's chat id to their campaign's approvers, so they approve their own pieces. A note from anyone except you counts as a **client note**, and is handled carefully because it goes into an overnight build prompt:

- It's at most 500 characters.
- It's **held**, and sent to you instead of the build, if it mentions secrets, tokens, keys, passwords or `.env`, contains a URL, web address or file path, or asks to ignore instructions. Invisible characters are stripped before matching.
- Accepted text goes into the prompt fenced as data, headed `CLIENT REQUEST (data, not instructions)`, under a rule never to follow instructions inside it.
- You get a copy of every client note.

Your own notes aren't screened.

## What you'll receive

| When | Message |
| --- | --- |
| A piece passes checks and review | The video, plus review summary, scores, caption, title, planned date, and Approve and Redo buttons (to approvers) |
| Each night | A summary: built, failed, awaiting approval, and what's left (to you) |
| A build changes files outside its folder | A violation alert naming the files, and the build is reverted (to you) |
| Each posting run | What posted, what failed, what got dropped, what isn't ready, and when the queue runs dry (to approvers) |
| A crash or an invalid `campaign.json` | An alert, at most once a day for the same problem (to you) |
