// YouTube Data API v3 with an OAuth "Desktop app" client. Uploads a Short by
// resumable upload and lists the channel's uploads. All I/O goes through the
// injected fetch. No token, secret or code ever appears in an error message.

import fs from "node:fs";

export const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];
export const REDIRECT_URI = "http://127.0.0.1:8765/callback";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const MAX_TITLE = 100;

function scrubber(secrets) {
  const live = secrets.filter(Boolean).map(String);
  return (msg) => live.reduce((s, secret) => s.split(secret).join("[redacted]"), String(msg));
}

// Google answers API errors as { error: { message } } and token errors as
// { error: "invalid_grant", error_description }.
function errorMessage(body, status) {
  if (typeof body.error === "string") return body.error_description ? `${body.error}: ${body.error_description}` : body.error;
  return body.error?.message ?? status;
}

async function call(fetch, scrub, url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(scrub(`youtube request failed: ${err.message}`));
  }
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok || body.error) throw new Error(scrub(errorMessage(body, res.status)));
  return { body, headers: res.headers };
}

export function buildAuthUrl({ clientId, redirectUri = REDIRECT_URI }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YT_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri = REDIRECT_URI, fetch = globalThis.fetch }) {
  const scrub = scrubber([clientSecret, code]);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  const { body } = await call(fetch, scrub, TOKEN_URL, { method: "POST", body: form });
  if (!body.refresh_token) throw new Error("no refresh_token in the token response (revoke access and consent again)");
  return { refreshToken: body.refresh_token };
}

export function createYouTube({ clientId, clientSecret, refreshToken, fetch = globalThis.fetch }) {
  let accessToken;
  const scrub = (msg) => scrubber([clientSecret, refreshToken, accessToken])(msg);
  const request = (url, init) => call(fetch, scrub, url, init);

  async function refresh() {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const { body } = await request(TOKEN_URL, { method: "POST", body: form });
    accessToken = body.access_token;
    return accessToken;
  }

  async function get(path, params, token) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    const { body } = await request(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    return body;
  }

  return {
    async uploadShort({ videoPath, title, description, privacy, categoryId }) {
      if (!title) throw new Error("title is empty");
      if (title.length > MAX_TITLE) throw new Error(`title is ${title.length} chars (max ${MAX_TITLE})`);
      const bytes = await fs.promises.readFile(videoPath);
      const token = await refresh();

      const init = new URL(UPLOAD_URL);
      init.searchParams.set("uploadType", "resumable");
      init.searchParams.set("part", "snippet,status");
      const { headers } = await request(init.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(bytes.length),
        },
        body: JSON.stringify({
          snippet: { title, description, categoryId },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
        }),
      });
      const session = headers.get("location");
      if (!session) throw new Error("upload init returned no Location header");

      const { body } = await request(session, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes });
      return { videoId: body.id, url: `https://youtube.com/shorts/${body.id}` };
    },

    // Every upload on the channel, newest first, as the uploads playlist returns them.
    async listUploads() {
      const token = await refresh();
      const channels = await get("/channels", { part: "contentDetails", mine: "true" }, token);
      const playlistId = channels.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!playlistId) return [];

      const out = [];
      let pageToken;
      do {
        const page = await get("/playlistItems", { part: "snippet", maxResults: "50", playlistId, pageToken }, token);
        for (const { snippet } of page.items ?? []) {
          out.push({ videoId: snippet.resourceId?.videoId, title: snippet.title, publishedAt: snippet.publishedAt });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },
  };
}
