// The publisher's dependencies for one campaign: what runDay, postNow and the CLI
// commands take, built from a campaign object (campaigns/lib/campaign.mjs). A
// campaign reads its own schedule and settings, keeps its state in campaign.home,
// takes its tokens from its own secrets file, reports through its own Telegram bot
// to its approvers, and locks under "<id>:<name>" in the shared publisher home.
//
// Internal alerts (a crash, a broken setup) go to the owner chat only: the owner's
// bot and TELEGRAM_CHAT_ID from the owner's .env (`ownerEnv`). A campaign with no
// bot of its own reports through the owner's bot, labelled with its name. YouTube
// uses the owner's Google client (YT_CLIENT_ID/YT_CLIENT_SECRET) with the
// campaign's own refresh token.
//
// `make` replaces the client constructors, for tests.

import path from "node:path";
import { loadSchedule } from "./schedule.mjs";
import { createStateStore, createSecretTokenStore } from "./state.mjs";
import { createLogger } from "./log.mjs";
import { withLock } from "./lock.mjs";
import { createInstagram } from "./instagram.mjs";
import { createYouTube } from "./youtube.mjs";
import { createTelegram } from "./telegram.mjs";

const MAKERS = { instagram: createInstagram, youtube: createYouTube, telegram: createTelegram };

// campaign.json's posting fields, in the shape runDay, planDay and the console take.
export function publishConfig(campaign) {
  const c = campaign.config;
  return {
    timeZone: c.timezone,
    slot: c.slot,
    lateLimitMinutes: c.lateLimitMinutes,
    bufferMin: c.bufferMin,
    fallbackDays: [...c.fallbackDays],
    retryDelaySeconds: c.retryDelaySeconds,
    platforms: structuredClone(c.platforms),
  };
}

// One send() to every approver. Every chat is tried; the first failure is thrown
// after the rest have had their turn.
function toApprovers(bots, label) {
  const prefix = label ? `[${label}] ` : "";
  return {
    async send(text) {
      let failure;
      for (const bot of bots) {
        try {
          await bot.send(`${prefix}${text}`);
        } catch (err) {
          failure ??= err;
        }
      }
      if (failure) throw failure;
    },
  };
}

export function buildPublishDeps(campaign, { secrets, now = () => new Date(), ownerEnv = {}, make = {} } = {}) {
  if (!secrets) throw new Error("buildPublishDeps needs the secrets store");
  const makers = { ...MAKERS, ...make };
  const { id, name } = campaign;
  const config = publishConfig(campaign);
  const tokens = createSecretTokenStore(secrets, id);
  const secretsFile = `secrets/${id}.json`;
  // campaign.home is <publisher home>/campaigns/<id>; locks are shared across it.
  const lockHome = path.resolve(campaign.home, "..", "..");

  // Each throws a plain message, never a value, when its credentials are missing.
  const builders = {
    instagram() {
      const saved = tokens.load().instagram;
      if (!saved?.token || !saved?.userId) throw new Error(`no Instagram token saved for ${id}: set IG_ACCESS_TOKEN and IG_USER_ID in ${secretsFile}`);
      return makers.instagram({ token: saved.token, userId: saved.userId, graphVersion: config.platforms.instagram.graphVersion });
    },
    youtube() {
      const { YT_CLIENT_ID: clientId, YT_CLIENT_SECRET: clientSecret } = ownerEnv;
      const refreshToken = tokens.load().youtube?.refreshToken;
      if (!clientId || !clientSecret) throw new Error("YT_CLIENT_ID and YT_CLIENT_SECRET must be set in the owner's .env");
      if (!refreshToken) throw new Error(`no YouTube refresh token saved for ${id}: set YT_REFRESH_TOKEN in ${secretsFile}`);
      return makers.youtube({ clientId, clientSecret, refreshToken });
    },
  };
  const client = (platform) => {
    if (!builders[platform]) throw new Error(`unknown platform: ${platform}`);
    return builders[platform]();
  };

  // Clients for the enabled platforms. A platform whose credentials are missing
  // gets none; runDay records that as a failure and the report says so.
  const clients = {};
  const warnings = [];
  for (const [platform, settings] of Object.entries(config.platforms)) {
    if (!settings.enabled) continue;
    try {
      clients[platform] = client(platform);
    } catch (err) {
      warnings.push(`${platform}: ${err.message}`);
    }
  }

  const { TELEGRAM_BOT_TOKEN: ownerBot, TELEGRAM_CHAT_ID: ownerChat } = ownerEnv;
  const ownBot = secrets.get(id, "TELEGRAM_BOT_TOKEN");
  const botToken = ownBot ?? ownerBot;
  const { approvers } = campaign.config;
  const telegram = botToken && approvers.length
    ? toApprovers(approvers.map((chatId) => makers.telegram({ token: botToken, chatId })), ownBot ? undefined : name)
    : undefined;
  const ownerTelegram = ownerBot && ownerChat ? makers.telegram({ token: ownerBot, chatId: ownerChat }) : undefined;

  const loadItems = () => loadSchedule(campaign.paths.schedule, campaign.root);

  return {
    campaign,
    name,
    home: campaign.home,
    lockHome,
    repoRoot: campaign.root,
    items: loadItems(),
    loadItems,
    config,
    store: createStateStore(campaign.home, { timeZone: config.timeZone }),
    tokens,
    clients,
    client,
    warnings,
    telegram,
    ownerTelegram,
    log: createLogger(campaign.home),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now,
    lockName: campaign.lockName,
    withLock: (lockName, fn, options) => withLock(lockHome, campaign.lockName(lockName), fn, options),
  };
}
