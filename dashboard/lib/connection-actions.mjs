// The console's Connections controls for one campaign. Secrets are write-only: a value
// goes into the campaign's secrets file and never comes back out, in a result, a log
// line or an error.
//
//   setInstagramToken({ token })  checks the pasted token with Instagram's /me (the
//                                 token alone, as `publish.mjs auth instagram` does);
//                                 only then saves IG_ACCESS_TOKEN, IG_USER_ID,
//                                 IG_USERNAME and IG_ISSUED_AT and runs sync-state once,
//                                 so posts already live aren't posted again. A failed
//                                 sync keeps the token: { ok, username, synced: false,
//                                 syncError }.
//   setTelegram({ botToken?, approvers? })  the campaign's own bot token, and its
//                                 approvers (Telegram chat ids, at most 10) written to
//                                 campaign.json
//   testTelegram()                "Test message from the console" to each approver with
//                                 the campaign's own bot, ok or failed per chat
//   setSecret({ name, value })    ANTHROPIC_API_KEY only; an empty value clears it
//
// Secrets are written under the campaign's "publish" lock, which the token refresh in
// the daily run also takes, so neither loses the other's write. campaign.json is
// written under its "schedule" lock by updateCampaignFile (campaign-file.mjs): checked
// with validateCampaign first, the old copy kept in <campaign home>/backups/, then
// replaced atomically in its own layout, never committed. A lock is waited for 3 s at
// most. No secret is written while any campaign's build runs (a build session fails if
// any secrets file changes; build-guard.mjs): the refusal names the campaign building.
//
// Every action is logged as "dashboard <action>" with the campaign and its result only,
// never what was submitted, and returns { ok: true, message, ... } or { ok: false, error }.
//
// deps = { withLock(name, fn, options), log, campaignFile, sync() (sync-state for
//          Instagram, run inside the publish lock), buildRunning() (the refusal while a
//          build runs, or null), makeInstagram?, makeTelegram?, now?, secretValues? }
//          (connectionDeps builds them)

import { buildCreationDeps } from "../../creation/lib/campaign-deps.mjs";
import { buildPublishDeps } from "../../publishing/lib/campaign-deps.mjs";
import { createInstagram } from "../../publishing/lib/instagram.mjs";
import { createSecretTokenStore } from "../../publishing/lib/state.mjs";
import { syncState } from "../../publishing/lib/sync.mjs";
import { createTelegram } from "../../publishing/lib/telegram.mjs";
import { buildRunningError } from "./build-guard.mjs";
import { checkApprovers, updateCampaignFile } from "./campaign-file.mjs";
import { loadCampaignData, scrub } from "./sources.mjs";

const WAIT_MS = 3000;
// One line of printable text with no spaces: what every token and key looks like.
const TOKEN_TEXT = /^[\x21-\x7e]{8,4096}$/;
const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,200}$/;
// The secrets the console sets by name; the rest have their own actions.
const SETTABLE = ["ANTHROPIC_API_KEY"];
const TEST_TEXT = "Test message from the console";

const refuse = (error) => ({ ok: false, error });
const text = (v) => (typeof v === "string" ? v.trim() : "");

export function createConnectionActions({ campaign, secrets, deps }) {
  const { withLock, log, campaignFile, sync, now = () => new Date(), secretValues = [] } = deps;
  const buildRunning = deps.buildRunning ?? (() => null);
  // Called just before a secret is written: any build fails if a secrets file changes.
  const noBuildRunning = () => {
    const running = buildRunning();
    if (running) throw new Error(running);
  };
  const makeInstagram = deps.makeInstagram ?? createInstagram;
  const makeTelegram = deps.makeTelegram ?? createTelegram;
  const { id, name } = campaign;
  const busy = {
    [`lock ${campaign.lockName("schedule")} busy`]: `a build is running for ${name}; try again when it finishes`,
    [`lock ${campaign.lockName("publish")} busy`]: `a post is running for ${name}; try again when it finishes`,
  };
  const locked = (lockName, fn) => withLock(lockName, fn, { waitMs: WAIT_MS });

  // Runs one action and logs its result. Everything leaving is scrubbed of the
  // submitted values as well as the campaign's own secrets.
  async function act(action, submitted, fn) {
    let result;
    try {
      result = await fn();
    } catch (err) {
      result = refuse(busy[err.message] ?? err.message);
    }
    const values = submitted.filter((v) => typeof v === "string" && v.length >= 8);
    result = scrub(result, [...values, ...secretValues]);
    if (result.ok) log.info(`dashboard ${action}`, { campaign: id, ...result });
    else log.error(`dashboard ${action}`, { campaign: id, ...result });
    return result;
  }

  // Writes approvers to campaign.json, under the schedule lock the caller holds.
  const writeApprovers = (approvers) =>
    updateCampaignFile({ file: campaignFile, campaignHome: campaign.home, now, change: (config) => ({ ...config, approvers }) });

  return {
    setInstagramToken({ token } = {}) {
      const value = text(token);
      return act("setInstagramToken", [value], async () => {
        if (!value) return refuse("paste the token first");
        if (!TOKEN_TEXT.test(value)) return refuse("that doesn't look like an Instagram token: it should be one line with no spaces");
        const graphVersion = campaign.config.platforms.instagram.graphVersion;
        let me;
        try {
          me = await makeInstagram({ token: value, userId: undefined, graphVersion }).me();
        } catch (err) {
          return refuse(`Instagram didn't accept that token: ${err.message}`);
        }
        const userId = me?.userId;
        const username = me?.username;
        if (!userId || userId === "undefined" || !username) return refuse("Instagram didn't say which account that token is for");

        return locked("publish", async () => {
          noBuildRunning();
          const issuedAt = now().toISOString();
          createSecretTokenStore(secrets, id).save({ instagram: { token: value, userId, username, issuedAt } });
          try {
            const { marked } = await sync();
            const posts = marked === 1 ? "1 post" : `${marked} posts`;
            return { ok: true, username, synced: true, marked, message: `Connected @${username}. Marked ${posts} already live.` };
          } catch (err) {
            return {
              ok: true,
              username,
              synced: false,
              syncError: err.message,
              message: `Connected @${username}, but checking for posts already live failed: ${err.message}`,
            };
          }
        });
      });
    },

    setTelegram({ botToken, approvers } = {}) {
      const bot = text(botToken);
      return act("setTelegram", [bot], async () => {
        if (!bot && approvers === undefined) return refuse("nothing to save: give a bot token or the approvers");
        if (bot && !BOT_TOKEN.test(bot)) return refuse("that doesn't look like a bot token: BotFather gives one like 123456789:AA…");
        let list;
        if (approvers !== undefined) {
          try {
            list = checkApprovers(approvers);
          } catch (err) {
            return refuse(err.message);
          }
        }
        const saveBot = () =>
          locked("publish", () => {
            noBuildRunning();
            secrets.set(id, "TELEGRAM_BOT_TOKEN", bot);
          });
        if (list) {
          await locked("schedule", async () => {
            // Checked before the approvers too, so a refused bot token leaves both unchanged.
            if (bot) noBuildRunning();
            writeApprovers(list);
            if (bot) await saveBot();
          });
        } else {
          await saveBot();
        }
        const saved = [bot ? "the bot token" : null, list ? `${list.length} approver${list.length === 1 ? "" : "s"}` : null].filter(Boolean);
        return { ok: true, message: `Saved ${saved.join(" and ")}.` };
      });
    },

    testTelegram() {
      // The bot token joins what is scrubbed once it is read.
      const used = [];
      return act("testTelegram", used, async () => {
        const bot = secrets.get(id, "TELEGRAM_BOT_TOKEN");
        if (!bot) return refuse(`${name} has no bot of its own yet; save its bot token first`);
        used.push(bot);
        const { approvers } = campaign.config;
        if (!approvers.length) return refuse("add an approver first");
        const results = [];
        for (const chatId of approvers) {
          try {
            await makeTelegram({ token: bot, chatId }).send(TEST_TEXT);
            results.push({ chatId, ok: true });
          } catch (err) {
            results.push({ chatId, ok: false, error: err.message });
          }
        }
        const failed = results.filter((r) => !r.ok);
        if (!failed.length) return { ok: true, results, message: `Sent the test to ${results.length} approver${results.length === 1 ? "" : "s"}.` };
        const why = failed.map((r) => `${r.chatId} (${r.error})`).join(", ");
        return { ok: false, results, error: `Couldn't reach ${failed.length} of ${results.length}: ${why}` };
      });
    },

    setSecret({ name: secret, value } = {}) {
      const v = typeof value === "string" ? value.trim() : value;
      return act("setSecret", [v], async () => {
        if (!SETTABLE.includes(secret)) return refuse(`${String(secret)} can't be set here`);
        if (typeof v !== "string") return refuse("the value must be text");
        if (v && !TOKEN_TEXT.test(v)) return refuse("that doesn't look like a key: it should be one line with no spaces");
        return locked("publish", () => {
          noBuildRunning();
          if (!v) {
            secrets.remove(id, secret);
            return { ok: true, message: `Removed ${secret}.` };
          }
          secrets.set(id, secret, v);
          return { ok: true, message: `Saved ${secret}.` };
        });
      });
    },
  };
}

// One campaign's connection dependencies: its lock helper and log from
// buildCreationDeps, sync-state over its publishing deps (built when it runs, so it
// uses the token just saved), whether any of `campaigns` (every campaign, this one by
// default) is building, and its secret values (and the owner's, from `env`) for
// scrubbing. `make` replaces the Instagram and Telegram constructors, for tests.
export function connectionDeps({ campaign, secrets, env, campaignFile, campaigns = [campaign], make = {} }) {
  const deps = buildCreationDeps(campaign, { secrets });
  return {
    withLock: deps.withLock,
    log: deps.log,
    campaignFile,
    buildRunning: () => buildRunningError({ lockHome: deps.lockHome, campaigns }),
    makeInstagram: make.instagram,
    makeTelegram: make.telegram,
    sync() {
      const p = buildPublishDeps(campaign, { secrets, make });
      return syncState({ client: p.client("instagram"), items: p.items, repoRoot: p.repoRoot, store: p.store, platform: "instagram", timeZone: p.config.timeZone });
    },
    secretValues: loadCampaignData({ campaign, secrets, env }).secretValues,
  };
}
