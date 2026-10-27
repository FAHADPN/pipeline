# YouTube Shorts (optional)

Pipeline can post the same pieces to YouTube as Shorts, with the title from the caption file's `YOUTUBE SHORTS TITLE` section. It's **off by default** (`platforms.youtube.enabled: false`). Uploads from an unaudited Google Cloud project are forced to private, so keep it off until Google's API audit passes.

## 1. Google Cloud project

1. In [console.cloud.google.com](https://console.cloud.google.com), create a project and enable **YouTube Data API v3**.
2. Set up the **OAuth consent screen**, then **publish the app to Production**. In Testing mode, refresh tokens expire after 7 days.
3. Create an **OAuth client** of type **Desktop app**. Put its id and secret in the owner's `.env`. One client serves every campaign:

   ```ini
   YT_CLIENT_ID=1234-abc.apps.googleusercontent.com
   YT_CLIENT_SECRET=GOCSPX-...
   ```

4. Submit the [YouTube API audit](https://support.google.com/youtube/contact/yt_api_form). Until it passes, uploads stay private, whatever `privacy` says.

## 2. Connect a channel

On the PC that runs Pipeline:

```powershell
node publishing/publish.mjs auth youtube --campaign <id>
```

It prints a Google sign-in URL and waits on `http://127.0.0.1:8765/callback`. Open the URL, sign in as the channel's owner and allow access. The terminal prints `YouTube connected.`, and the refresh token is saved to that campaign's secrets file.

To do this from another computer, forward the port over SSH first, so your browser can reach the PC's callback:

```powershell
ssh -L 8765:127.0.0.1:8765 <you>@<pipeline-pc>
```

## 3. Turn it on

In `campaign.json`:

```json
"platforms": {
  "youtube": { "enabled": true, "privacy": "public", "categoryId": "22" }
}
```

- `privacy` is `private`, `unlisted` or `public`.
- `categoryId` is a YouTube category number, in a string (`"22"` is People & Blogs).

YouTube keeps its own place in the queue, so turning it on later starts from the first item not yet on YouTube. If you've already posted some pieces to YouTube by hand, record them first:

```powershell
node publishing/publish.mjs sync-state --platform youtube --campaign <id>
```

`videoSpec.youtubeTitleRequired` (on by default) makes the checks fail a piece whose YouTube title is missing or over 100 characters.
