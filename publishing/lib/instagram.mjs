// Instagram API with Instagram Login (graph.instagram.com). Publishes a Reel from a
// public video_url (and cover_url): graph.instagram.com refuses upload_type=resumable
// for REELS, so the caller serves the files publicly for the length of the post
// (see public-file.mjs). All I/O goes through the injected fetch. The token never
// appears in an error message.

const FAILED = new Set(["ERROR", "EXPIRED"]);

export function createInstagram({
  token,
  userId,
  graphVersion,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollIntervalMs = 5000,
  pollTimeoutMs = 300000,
}) {
  const base = `https://graph.instagram.com/${graphVersion}`;

  const scrub = (msg) => (token ? String(msg).split(token).join("[redacted]") : String(msg));

  async function call(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new Error(scrub(`instagram request failed: ${err.message}`));
    }
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    const message = body.error?.message ?? body.debug_info?.message;
    if (!res.ok || body.error) throw new Error(scrub(message ?? res.status));
    return body;
  }

  function get(pathOrUrl, params = {}) {
    const url = new URL(pathOrUrl.startsWith("https://") ? pathOrUrl : `${base}${pathOrUrl}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", token);
    return call(url.toString(), { method: "GET" });
  }

  function post(path, params) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
    form.set("access_token", token);
    return call(`${base}${path}`, { method: "POST", body: form });
  }

  // Instagram downloads the video while the container processes, so the URLs must
  // stay reachable until this returns. Resolves "FINISHED", throws on ERROR/EXPIRED
  // with Instagram's status text when it gives one.
  async function waitForContainer(id) {
    let waited = 0;
    for (;;) {
      const { status_code: code, status } = await get(`/${id}`, { fields: "status_code,status" });
      if (code === "FINISHED") return code;
      if (FAILED.has(code)) throw new Error(`processing failed: ${code}${status ? ` (${status})` : ""}`);
      if (waited >= pollTimeoutMs) throw new Error("timed out");
      await sleep(pollIntervalMs);
      waited += pollIntervalMs;
    }
  }

  // The cover comes from cover_url when given, else from the frame at thumb_offset.
  async function createReelContainer({ videoUrl, coverUrl, caption, thumbOffsetMs }) {
    const container = await post(`/${userId}/media`, {
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      share_to_feed: true,
      cover_url: coverUrl,
      thumb_offset: coverUrl ? undefined : thumbOffsetMs,
    });
    return container.id;
  }

  return {
    async me() {
      const body = await get("/me", { fields: "user_id,username" });
      return { userId: String(body.user_id), username: body.username };
    },

    createReelContainer,
    waitForContainer,

    async publishReel({ videoUrl, coverUrl, caption, thumbOffsetMs }) {
      const id = await createReelContainer({ videoUrl, coverUrl, caption, thumbOffsetMs });
      await waitForContainer(id);
      const { id: mediaId } = await post(`/${userId}/media_publish`, { creation_id: id });
      const { permalink } = await get(`/${mediaId}`, { fields: "permalink" });
      return { mediaId, url: permalink };
    },

    // Newest first, as the API returns them. Paging links already carry the token.
    async listMedia({ limit } = {}) {
      const out = [];
      const first = new URL(`${base}/${userId}/media`);
      first.searchParams.set("fields", "id,caption,timestamp,permalink");
      if (limit) first.searchParams.set("limit", String(Math.min(limit, 100)));
      first.searchParams.set("access_token", token);
      let next = first.toString();
      while (next && (limit === undefined || out.length < limit)) {
        const page = await call(next, { method: "GET" });
        out.push(...(page.data ?? []));
        next = page.paging?.next;
      }
      return limit === undefined ? out : out.slice(0, limit);
    },

    async refreshToken() {
      const body = await get("https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token" });
      return { token: body.access_token, expiresIn: body.expires_in };
    },
  };
}
