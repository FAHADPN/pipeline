# ngrok

## Why Pipeline needs it

The Instagram API with Instagram Login creates a Reel only from a **public `video_url`**. It refuses a direct file upload (`upload_type=resumable`) for Reels on `graph.instagram.com` with "The parameter video_url is required", on every API version we tried. So the video has to be reachable from the internet while Instagram fetches it.

Pipeline doesn't keep anything public. For each Instagram attempt it:

1. Starts a tiny local web server on a random port, serving only the item's `.mp4` and `-cover.png` at a random 32-character path. Every other path returns 404.
2. Starts `ngrok http 127.0.0.1:<port>` and waits up to 30 s for the tunnel's `https://` URL.
3. Creates the Reel container with that `video_url` (and `cover_url`), and waits while Instagram fetches and processes the file.
4. Publishes, then **closes the tunnel and the server**, whether the post worked or not. A retry opens a new tunnel with a new path.

The code is in [`publishing/lib/public-file.mjs`](../publishing/lib/public-file.mjs).

## Install and sign in

1. Create a free account at [ngrok.com](https://ngrok.com) and copy your **authtoken** from the dashboard.
2. Install the agent:
   - **Download (recommended):** get the Windows zip from ngrok.com and unzip `ngrok.exe` to a fixed folder, for example `C:\Tools\ngrok\ngrok.exe`.
   - **winget:** `winget install --id Ngrok.Ngrok -e`, then `ngrok update`.
3. Add the authtoken once, as the same Windows user that runs the scheduled tasks:

   ```powershell
   ngrok config add-authtoken <your token>
   ```

   This writes ngrok's own config file in your profile. Pipeline never reads or writes it.

## Tell Pipeline where ngrok is

By default Pipeline runs `ngrok` from your PATH. Scheduled tasks start it without a shell, and a winget install puts a shortcut in `%LOCALAPPDATA%\Microsoft\WinGet\Links` that some non-interactive sessions can't follow. To avoid that, give each campaign the real path in `campaign.json`:

```json
"platforms": {
  "instagram": { "enabled": true, "ngrokBin": "C:\\Tools\\ngrok\\ngrok.exe" }
}
```

To find the real file behind a winget install:

```powershell
(Get-Item (Get-Command ngrok).Source).Target
```

## Test it

With at least one item in the campaign's schedule:

```powershell
node publishing/publish.mjs ig-fetch-test <item id> --campaign <id>
```

This does everything a real post does except publish. It serves the files through ngrok, creates the Reel container and waits until Instagram has fetched and processed it. It then prints the container status and how long it took, and closes the tunnel. It exits 0 only on `Container status: FINISHED`. The unpublished container expires on its own after 24 hours.

Run it after setting up ngrok, after changing `ngrokBin`, and whenever a post fails with a fetch or download error.

## Limits and good to know

- **One tunnel at a time.** A free ngrok account may refuse a second agent session running at the same time. Posting and `ig-fetch-test` take the same per-campaign lock, and campaigns post one after another within a tick.
- **Bandwidth.** Each post moves one video (a few MB) through the tunnel. The free plan's monthly transfer covers daily posting comfortably.
- **No inbound ports.** ngrok makes an outbound connection, so you don't need to open your router or firewall.
- **Errors surface in the report.** If the tunnel won't start (no authtoken, an expired agent, a bad path), that attempt fails with ngrok's own message, and the Telegram report shows it.
- **The browser warning page** that ngrok's free plan shows to browsers doesn't affect Instagram's server-side fetch.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `ngrok failed to start: spawn ngrok ENOENT` | ngrok isn't on the PATH of the session running the task. Set `ngrokBin` to the full path. |
| `ngrok failed to start: ... authentication failed` | Run `ngrok config add-authtoken <token>` as the user the tasks run as. |
| `ngrok did not open a tunnel within 30s` | Check the PC's internet connection, then run `ngrok http 80` by hand and read its error. |
| `... your account is limited to 1 simultaneous ngrok agent session` | Another ngrok is running (perhaps your own). Close it, or upgrade the plan. |
| `Container status: ERROR` | Instagram fetched the file but rejected it. Check the video meets Instagram's current Reels specifications (H.264 video, AAC audio, 9:16). |
