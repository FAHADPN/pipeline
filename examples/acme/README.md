# Example campaign: Acme Coffee

A complete campaign for a fictional coffee roaster. Copy it, make it yours, and you have a working setup.

```powershell
New-Item -ItemType Directory -Force C:\Campaigns | Out-Null
Copy-Item -Recurse C:\pipeline\examples\acme C:\Campaigns\acme
cd C:\Campaigns\acme
git init; git add -A; git commit -m "campaign: create acme"
```

To make it yours:

1. **`campaign.json`:** keep `id` equal to the folder name and `root` equal to its full path. Set `name`, `timezone`, `slot` and your Telegram chat id in `approvers`. It ships **paused**: unpause it once a hand-built piece has worked.
2. **`brief.md`:** your brand, audience, what to make, the "Never" list, and how to build the video. The example uses HyperFrames, with Gemini or Kokoro voices.
3. **`voice.md`:** your tone, words to use and avoid, and the narration voice.
4. **`references.md`:** craft rules every piece should follow.
5. **`guardrails.json`:** words and phrases that must never appear in a caption.
6. **`backlog.json`:** your first ideas. The three examples show each field.

Leave `schedule.json` as `[]`: approved pieces are added to it for you.

`extraAllowedTools` lets the build session run `npx hyperframes`, `ffmpeg` and `ffprobe`. Change it to match the tools your brief uses.

You can delete this README from your copy. See [Campaigns](../../docs/campaigns.md) for the details.
