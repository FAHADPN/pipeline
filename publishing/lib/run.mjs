// The daily run: check every item, plan the day, then post, recording each step in
// state the moment it succeeds so a crash or a re-run can never post twice.
//
// RunResult = { today, window, rhythm, readyCount, runDry, dryRun, postingDay,
//               posted: [{ id, platform, url }], failed: [{ id, platform, error }],
//               dropped: Drop[], notReady: [{ id, errors }], alreadyLive: [{ id, platform, url }],
//               warnings: string[], plan }

import { istDate, istMinutes } from "./dates.mjs";
import { checkItem, firstLine, youtubeDescription } from "./content.mjs";
import { planDay, projectRunDry } from "./planner.mjs";
import { getEntry, isDone, setEntry } from "./state.mjs";
import { formatReport } from "./report.mjs";
import { servePublicly } from "./public-file.mjs";

const DAY_MS = 86400000;
const LIVE_WINDOW_MS = 2 * DAY_MS;

// A post made by an earlier run that crashed before writing state, or by an earlier
// attempt that threw after publishing. Checked before every attempt.
async function findLive(platform, client, caption, now) {
  const since = now.getTime() - LIVE_WINDOW_MS;
  if (platform === "instagram") {
    const want = firstLine(caption.instagram);
    const media = await client.listMedia({ limit: 10 });
    const hit = media.find((m) => Date.parse(m.timestamp) >= since && want && firstLine(m.caption ?? "") === want);
    return hit && { mediaId: hit.id, url: hit.permalink };
  }
  const want = firstLine(caption.youtubeTitle);
  const uploads = await client.listUploads();
  const hit = uploads.find((u) => Date.parse(u.publishedAt) >= since && want && firstLine(u.title ?? "") === want);
  return hit && { mediaId: hit.videoId, url: `https://youtube.com/shorts/${hit.videoId}` };
}

// Instagram takes a Reel only from a public URL, so each attempt serves the video
// (and the cover, unless `useCover` is false) through its own ngrok tunnel, closed
// whatever happens.
async function publishInstagram(client, item, checked, { config, servePublicly: serve = servePublicly }) {
  const { assets, caption } = checked;
  const ig = config.platforms.instagram;
  const useCover = ig.useCover !== false;
  const files = [{ path: assets.video, name: "video.mp4" }];
  if (useCover) files.push({ path: assets.cover, name: "cover.png" });
  const tunnel = await serve({ files, ngrokBin: ig.ngrokBin });
  try {
    return await client.publishReel({
      videoUrl: tunnel.urls["video.mp4"],
      coverUrl: useCover ? tunnel.urls["cover.png"] : undefined,
      caption: caption.instagram,
      thumbOffsetMs: item.thumbOffsetMs ?? ig.thumbOffsetMs,
    });
  } finally {
    await tunnel.close();
  }
}

async function publish(platform, client, item, checked, deps) {
  if (platform === "instagram") return publishInstagram(client, item, checked, deps);
  const { assets, caption } = checked;
  const { config } = deps;
  const { privacy, categoryId } = config.platforms.youtube;
  const { videoId, url } = await client.uploadShort({
    videoPath: assets.video,
    title: caption.youtubeTitle,
    description: youtubeDescription(caption.instagram),
    privacy,
    categoryId,
  });
  return { mediaId: videoId, url };
}

async function refreshInstagramToken({ now, config, tokens, clients, warnings }) {
  const ig = config.platforms.instagram;
  const saved = tokens.load();
  const issuedAt = Date.parse(saved.instagram?.issuedAt);
  if (!ig?.enabled || !clients.instagram || Number.isNaN(issuedAt)) return;
  if (now.getTime() - issuedAt <= ig.tokenRefreshDays * DAY_MS) return;
  try {
    const { token } = await clients.instagram.refreshToken();
    tokens.save({ ...saved, instagram: { ...saved.instagram, token, issuedAt: now.toISOString() } });
  } catch (err) {
    warnings.push(`Instagram token refresh failed: ${err.message}`);
  }
}

// One item on one platform: the already-live guard, then publish, with one retry.
// State is saved the moment the outcome is known.
// Returns { outcome: "posted"|"alreadyLive", url } or { outcome: "failed", error }.
async function postItem({ item, platform, client, checked, state, now, deps }) {
  const { config, store, log, sleep } = deps;
  const { id } = item;
  const today = istDate(now, config.timeZone);
  const at = now.toISOString();
  if (!client) {
    const error = `no ${platform} client configured`;
    setEntry(state, id, platform, { status: "failed", error, attempts: 0, at });
    store.save(state);
    return { outcome: "failed", error };
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await sleep(config.retryDelaySeconds * 1000);
    try {
      const live = await findLive(platform, client, checked.caption, now);
      if (live) {
        setEntry(state, id, platform, { status: "posted", mediaId: live.mediaId, url: live.url, date: today, at });
        store.save(state);
        return { outcome: "alreadyLive", url: live.url };
      }
      const { mediaId, url } = await publish(platform, client, item, checked, deps);
      setEntry(state, id, platform, { status: "posted", mediaId, url, date: today, at });
      store.save(state);
      return { outcome: "posted", url };
    } catch (err) {
      lastError = err;
      log.error(`${platform} ${id} attempt ${attempt} failed`, { error: err.message });
    }
  }
  const error = lastError.message;
  setEntry(state, id, platform, { status: "failed", error, attempts: 2, at });
  store.save(state);
  return { outcome: "failed", error };
}

// `post <id> --now`: one item on one platform, bypassing the planner, with the
// same guard, retry and state recording as the daily run. Refuses (throws, having
// touched nothing) when the item is already done there, fails its check, or the
// platform has no client. No Telegram report: the caller prints the outcome.
export async function postNow({ item, platform, now, deps }) {
  const { repoRoot, store, clients = {}, log, check = checkItem } = deps;
  const state = store.load();
  const entry = getEntry(state, item.id, platform);
  if (isDone(state, item.id, platform)) throw new Error(`${item.id} is already ${entry.status} on ${platform}`);
  const checked = check(repoRoot, item);
  if (!checked.ok) throw new Error(`${item.id} fails check: ${checked.errors.join("; ")}`);
  const client = clients[platform];
  if (!client) throw new Error(`no ${platform} client configured`);

  const outcome = await postItem({ item, platform, client, checked, state, now, deps });
  store.backup(state, now);
  const result = { id: item.id, platform, ...outcome, warnings: checked.warnings ?? [] };
  log.info("post now", result);
  return result;
}

export async function runDay({ now, dryRun = false, deps }) {
  const { repoRoot, items, config, store, tokens, clients = {}, telegram, log, check = checkItem } = deps;
  const today = istDate(now, config.timeZone);
  const minutesNow = istMinutes(now, config.timeZone);
  const at = now.toISOString();

  const checks = new Map();
  for (const item of items) {
    try {
      checks.set(item.id, check(repoRoot, item));
    } catch (err) {
      checks.set(item.id, { ok: false, errors: [err.message], warnings: [] });
    }
  }
  const ready = new Set([...checks].filter(([, c]) => c.ok).map(([id]) => id));

  const state = store.load();
  const plan = planDay({ today, minutesNow, items, state, ready, config });

  const posted = [];
  const failed = [];
  const alreadyLive = [];
  const warnings = [];
  const plannedIds = new Set(plan.posts.map((p) => p.id));
  for (const id of plannedIds) for (const w of checks.get(id).warnings ?? []) warnings.push(`${id}: ${w}`);

  const result = () => ({
    today,
    window: plan.window,
    rhythm: plan.rhythm,
    readyCount: plan.readyCount,
    runDry: projectRunDry({ today, items, state, ready, config }),
    dryRun,
    postingDay: plan.postingDay,
    posted,
    failed,
    dropped: plan.drops,
    notReady: plan.notReady.map((id) => ({ id, errors: checks.get(id)?.errors ?? [] })),
    alreadyLive,
    warnings,
    plan,
  });

  if (dryRun) return result();

  await refreshInstagramToken({ now, config, tokens, clients, warnings });

  if (plan.drops.length) {
    for (const drop of plan.drops) setEntry(state, drop.id, drop.platform, { status: "dropped", reason: drop.reason, at });
    store.save(state);
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  for (const { id, platform } of plan.posts) {
    const outcome = await postItem({
      item: byId.get(id), platform, client: clients[platform], checked: checks.get(id), state, now, deps,
    });
    if (outcome.outcome === "posted") posted.push({ id, platform, url: outcome.url });
    else if (outcome.outcome === "alreadyLive") alreadyLive.push({ id, platform, url: outcome.url });
    else failed.push({ id, platform, error: outcome.error });
  }

  store.backup(state, now);
  const out = result();

  if (plan.window !== "early" && telegram) {
    try {
      await telegram.send(formatReport(out, { name: deps.name, slot: config.slot, lateLimitMinutes: config.lateLimitMinutes }));
    } catch (err) {
      log.error("telegram send failed", { error: err.message });
    }
  }

  log.info("run", { ...out, plan: undefined });
  return out;
}
