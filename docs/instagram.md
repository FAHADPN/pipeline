# Instagram

Pipeline posts Reels through the **Instagram API with Instagram Login** (`graph.instagram.com`). It doesn't need a Facebook Page. You do every sign-in and consent screen yourself, and Pipeline only ever gets a token.

## 1. Make the account Professional

In the Instagram app: **Settings → Account type and tools → Switch to professional account**. Creator and Business both work.

## 2. Create a Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com), and create a developer account if you don't have one.
2. **Create app.** For the use case, pick the option for managing messaging and content on Instagram, which adds the **Instagram API with Instagram Login** product. Meta renames these screens often, so look for "Instagram API with Instagram Login".
3. While the app is in **development mode**, only accounts with a role on the app can be used. Under **App roles → Roles**, add your Instagram account as an **Instagram Tester**. Then accept the invite in the Instagram app: **Settings → Website permissions → Apps and websites → Tester invites**. (The path varies by app version: search the settings for "tester".)
4. In the product's **API setup with Instagram business login**, under **Generate access tokens**, add your account and generate a token. It needs the `instagram_business_basic` and `instagram_business_content_publish` permissions.

You don't need App Review to post to your own account in development mode.

## Saving the token

### In the console (recommended)

**Connections → Instagram → paste the token → Save.** Pipeline then:

1. checks the token with Instagram's `/me` and shows the account's username,
2. saves `IG_ACCESS_TOKEN`, `IG_USER_ID`, `IG_USERNAME` and `IG_ISSUED_AT` to the campaign's secrets file, `%USERPROFILE%\.pipeline\secrets\<campaign>.json`,
3. runs **sync-state** once, which marks every post already live on the account as `manual`. Pipeline never re-posts something you published by hand.

Secrets are write-only in the console. A saved token is never shown again, in the UI, the logs or an error.

### From the command line

Create the secrets file by hand, with the token as its only value:

```json
{
  "version": 1,
  "secrets": {
    "IG_ACCESS_TOKEN": { "value": "IGAA...", "updatedAt": "2026-01-01T00:00:00.000Z" }
  }
}
```

Save it as `%USERPROFILE%\.pipeline\secrets\<campaign>.json`, then run:

```powershell
node publishing/publish.mjs auth instagram --campaign <id>
node publishing/publish.mjs sync-state --campaign <id>
```

`auth instagram` checks the token, prints the username and saves the user id beside it. `sync-state` records what's already live.

## Token refresh

Instagram tokens last 60 days. Pipeline refreshes the token by itself every `tokenRefreshDays` (30 by default) during a daily run, and saves the new one under the campaign's `publish` lock. You only need a new token if it's revoked, or if it expires because nothing ran for 60 days. The console's **Health** screen shows each token's age.

## How a post works

1. The planner picks today's item (see [Operations](operations.md#how-posting-is-planned)).
2. **Already-live guard.** Pipeline lists the account's posts from the last 48 hours and compares each caption's first line with the item's. If it's already there (for example, after a crash mid-post), Pipeline records that post instead of posting again.
3. The video and cover are served through a short-lived [ngrok](ngrok.md) tunnel.
4. Pipeline creates a container (`media_type=REELS`, `share_to_feed=true`, `video_url`, `cover_url` or `thumb_offset`, and the caption) and polls `status_code` until it's `FINISHED`. `ERROR` or `EXPIRED` fails the attempt.
5. It calls `media_publish`, records the post in the campaign's `state.json` straight away, and closes the tunnel.
6. A failed attempt is retried once after `retryDelaySeconds` (60 by default), with a fresh tunnel.

The cover comes from the piece's `-cover.png`. Set `"useCover": false` under `platforms.instagram` to let Instagram take the frame at `thumbOffsetMs` instead.

## Commands

```powershell
node publishing/publish.mjs status --campaign <id>                 # queue, rhythm, run-dry date, token age
node publishing/publish.mjs check --campaign <id>                  # every queued item against the folder contract
node publishing/publish.mjs --dry-run --campaign <id>              # what a run started now would do
node publishing/publish.mjs ig-fetch-test <item> --campaign <id>   # fetch and process, never publish
node publishing/publish.mjs post <item> --now --campaign <id>      # post one item now
node publishing/publish.mjs sync-state --campaign <id>             # record posts already live
node publishing/publish.mjs mark <item> instagram manual --campaign <id>
```

See [Operations](operations.md#publishing-commands) for every command and flag.

## Common errors

| Error | Meaning |
| --- | --- |
| `The parameter video_url is required` | Something tried a direct upload. Pipeline always uses `video_url`; check you're on the current code. |
| `API access blocked.` (OAuthException, code 200) | Meta has blocked the app or the token. Generate a new token in the app dashboard and save it again. Check the app's alerts in the developer dashboard. |
| `Invalid OAuth access token` | The token was revoked or expired. Save a new one. |
| `Container status: ERROR` | Instagram fetched the video but rejected it. Check codecs and aspect ratio. |
| `Application request limit reached` | Too many API calls. Wait an hour. Pipeline makes only a handful per post. |

Instagram also caps how many posts an account can publish through the API in 24 hours. A daily rhythm is far below that cap.
