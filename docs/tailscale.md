# Tailscale

The console is a web app that binds to `127.0.0.1:8787` only, so nothing on your network or the internet can reach it directly. [Tailscale](https://tailscale.com) publishes it to **your own devices** over HTTPS, and tells Pipeline which Tailscale user is asking. That's what decides who may press buttons.

## How access works

- `tailscale serve` proxies `https://<pc>.<tailnet>.ts.net` to `http://127.0.0.1:8787`, inside your tailnet only.
- For every request from a tailnet user, Tailscale adds a `Tailscale-User-Login` header with that user's login, such as `you@example.com`.
- The console shows status to anyone who can reach it. **Actions** (approve, post now, edit the queue, save tokens) need all of these:
  - the `Tailscale-User-Login` header equals `DASHBOARD_LOGIN` from your `.env`,
  - the request carries this server start's CSRF token,
  - its `Origin` matches its `Host`.
- With no `DASHBOARD_LOGIN` set, nobody can act, and the console is read-only.

Requests that skip Tailscale (for example, opening `http://127.0.0.1:8787` on the PC itself) carry no login header, so they're read-only too.

## Set it up

1. Install Tailscale on the PC (`winget install --id Tailscale.Tailscale -e`) and sign in.
2. Install the Tailscale app on your phone and laptop, and sign in with the **same** account (or invite them to your tailnet).
3. In the [admin console](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates**.
4. Put your Tailscale login in `%USERPROFILE%\.pipeline\.env`:

   ```ini
   DASHBOARD_LOGIN=you@example.com
   ```

   Use exactly the login the Tailscale app shows. For a GitHub sign-in, that's your GitHub handle with `@github`.
5. Start the console and publish it:

   ```powershell
   node dashboard/server.mjs
   tailscale serve --bg 8787
   ```

   `--bg` keeps serving after you close the window and across reboots. Check it with `tailscale serve status`. To stop, run `tailscale serve reset`.
6. Open `https://<pc-name>.<tailnet-name>.ts.net` on your phone. The first visit may take a few seconds while Tailscale issues the certificate.

On older Tailscale versions, the serve syntax was `tailscale serve https / http://127.0.0.1:8787`. Run `tailscale serve --help` to see which yours takes.

## Run the console at sign-in

```powershell
node dashboard/install-task.mjs
schtasks /Run /TN "Pipeline Dashboard"
```

The **Pipeline Dashboard** task starts `node dashboard/server.mjs` when you sign in, restarts it up to 3 times if it crashes, and never times out. It runs in your session (InteractiveToken) because it also runs the **build queue**: a **Build now** or **Recheck** you press while another build runs is started from here when the build finishes. Builds need your logged-in session.

`DASHBOARD_PORT` runs a second copy on another port, for testing.

## Don't use Funnel

`tailscale funnel` would put the console on the public internet. Public requests carry no login header, so they couldn't act, but they could still read every campaign's status, captions and videos. Pipeline is designed for `serve` only.

## Your phone

The console's layout works at phone width, with bottom tabs, full-screen video and touch-friendly controls. Videos are served with Range support, so they scrub smoothly. The **phone preview** variant is a lighter copy, cached per piece, so playback works on mobile data.

## Sharing with someone else

Invite them to your tailnet, or [share the machine](https://tailscale.com/kb/1084/sharing) with them. They can see the console. Only `DASHBOARD_LOGIN` can act. To let a client approve their own pieces, add their Telegram chat id to the campaign's `approvers` instead. See [Telegram](telegram.md#clients-as-approvers).
