// The dashboard's buttons. Each runs under the shared "publish" lock, so it can never
// overlap the 19:30 run or a CLI command, and posts through run.mjs's postNow with
// the same guard, retry and state recording. Every attempt is logged and announced
// on Telegram. Refusals return { ok: false, error } and touch nothing. Results and log
// lines are scrubbed of the campaign's and the owner's secret values: a client error
// can quote a request URL with its token.
//
//   postNow({ id?, force? })  the next floating Instagram item; `id` is the one the
//                             user confirmed, refused if it's no longer next.
//                             { ok: false, needsForce: true } if a floating post
//                             already went out today, unless `force`. A held item
//                             is never picked.
//   postItem({ id, force? })  that Instagram item now, pinned or floating, with the
//                             same guards; { ok: false, needsForce: true } if anything
//                             already went out on Instagram today, pinned or floating,
//                             unless `force`. Refused outside its notBefore/notAfter window.
//   retry({ id, platform })   one failed item on one platform
// All three are refused while the platform is disabled in the campaign's settings.
//
// campaignDeps are one campaign's: its schedule, settings, state home and secrets, and
// its "<id>:publish" lock, the one its scheduler loop and CLI take.

import { istDate } from "../../publishing/lib/dates.mjs";
import { isFloating, isHeld, inWindow } from "../../publishing/lib/schedule.mjs";
import { checkItem } from "../../publishing/lib/content.mjs";
import { getEntry, isDone, postedFloatingOn, postedOn } from "../../publishing/lib/state.mjs";
import { withLock } from "../../publishing/lib/lock.mjs";
import { postNow as postItemNow } from "../../publishing/lib/run.mjs";
import { buildPublishDeps } from "../../publishing/lib/campaign-deps.mjs";
import { buildRunningError } from "./build-guard.mjs";
import { loadCampaignData, scrub } from "./sources.mjs";

const PLATFORMS = ["instagram", "youtube"];
const BUFFER_PLATFORM = "instagram";

// An item's notBefore/notAfter window in words, naming only the bounds it has.
function windowText({ notBefore, notAfter }) {
  if (notBefore !== undefined && notAfter !== undefined) return `between ${notBefore} and ${notAfter}`;
  return notBefore !== undefined ? `from ${notBefore}` : `until ${notAfter}`;
}

// deps = { home, repoRoot, loadConfig(), loadItems(), store, client(platform), telegram?,
//          log, sleep, check?, now?, lock? (withLock options), servePublicly?,
//          lockHome?, lockName?, configName?, buildRunning?() (the refusal while the
//          campaign's build runs, or null), secretValues?() (the values to scrub) }
// Config, schedule, state and clients are all read inside the lock, so an action
// sees whatever the run it waited for left behind.
export function createActions({ deps }) {
  const { home, repoRoot, store, log, sleep, check = checkItem, now = () => new Date(), lock = {} } = deps;
  const { lockHome = home, lockName = "publish", configName = "publishing/config.json" } = deps;

  // The secret values as they are now, or none when they can't be read.
  function secretValues() {
    try {
      return deps.secretValues?.() ?? [];
    } catch {
      return [];
    }
  }

  const scrubbed = (value) => (value === undefined ? value : scrub(value, secretValues()));
  // The log, scrubbed. run.mjs logs to it too: a failed attempt's error as the client gave it.
  const safeLog = {
    info: (msg, data) => log.info(msg, scrubbed(data)),
    error: (msg, data) => log.error(msg, scrubbed(data)),
  };

  // The refusal while `platform` is disabled in the campaign's settings, or null.
  const disabled = (config, platform) => (config.platforms[platform]?.enabled ? null : `${platform} is disabled in ${configName}`);

  async function notify(text) {
    if (!deps.telegram) return;
    try {
      await deps.telegram.send(scrubbed(text));
    } catch (err) {
      safeLog.error("telegram send failed", { error: err.message });
    }
  }

  // Posts one item through run.mjs and reports it. Refusals from postNow (already
  // done, fails its check, no client) come back as { ok: false, error }.
  async function post(item, platform, at, config) {
    let client;
    try {
      client = deps.client(platform);
    } catch (err) {
      return { ok: false, id: item.id, platform, error: err.message };
    }
    let result;
    try {
      result = await postItemNow({
        item,
        platform,
        now: at,
        deps: { repoRoot, config, store, clients: { [platform]: client }, log: safeLog, sleep, check, servePublicly: deps.servePublicly },
      });
    } catch (err) {
      return { ok: false, id: item.id, platform, error: err.message };
    }
    const { id, outcome, url, error } = result;
    if (outcome === "posted") await notify(`Posted via dashboard: ${id} ${url}`);
    else if (outcome === "alreadyLive") await notify(`Already live, recorded via dashboard: ${id} ${url}`);
    else await notify(`❌ Dashboard post failed: ${id} (${platform}): ${error}`);
    return { ok: outcome !== "failed", ...result };
  }

  // Runs one action under the lock and logs its result, whatever it was. Every action
  // here writes the campaign's state.json, so none runs while its build does.
  async function act(name, args, fn) {
    const before = secretValues();
    let result;
    try {
      result = await withLock(lockHome, lockName, () => {
        const running = deps.buildRunning?.();
        return running ? { ok: false, error: running } : fn();
      }, lock);
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    // Read again after: a token the post refreshed is scrubbed too.
    const values = [...new Set([...before, ...secretValues()])];
    result = scrub(result, values);
    const line = scrub({ ...args, ...result }, values);
    if (result.ok) log.info(`dashboard ${name}`, line);
    else log.error(`dashboard ${name}`, line);
    return result;
  }

  function isReady(item) {
    try {
      return check(repoRoot, item).ok;
    } catch {
      return false;
    }
  }

  return {
    postNow({ id, force = false } = {}) {
      return act("post now", { requested: id ?? null, force }, async () => {
        const at = now();
        const config = deps.loadConfig();
        const off = disabled(config, BUFFER_PLATFORM);
        if (off) return { ok: false, error: off };
        const items = deps.loadItems();
        const today = istDate(at, config.timeZone);
        const state = store.load();
        // The same pick as the planner's floating queue, minus the clock.
        const next = items.find(
          (item) => isFloating(item) && !isHeld(item) && !isDone(state, item.id, BUFFER_PLATFORM) && inWindow(item, today) && isReady(item),
        );
        if (!next) return { ok: false, error: "nothing queued is ready to post" };
        if (id !== undefined && id !== next.id) {
          return { ok: false, next: next.id, error: `the next queued item is ${next.id}, not ${id}: reload and try again` };
        }
        if (!force && postedFloatingOn(state, items, BUFFER_PLATFORM, today)) {
          return { ok: false, needsForce: true, id: next.id, platform: BUFFER_PLATFORM };
        }
        return post(next, BUFFER_PLATFORM, at, config);
      });
    },

    postItem({ id, force = false } = {}) {
      return act("post item", { id, force }, async () => {
        const at = now();
        const config = deps.loadConfig();
        const off = disabled(config, BUFFER_PLATFORM);
        if (off) return { ok: false, error: off };
        const items = deps.loadItems();
        const item = items.find((i) => i.id === id);
        if (!item) return { ok: false, error: `no item ${id} in the schedule` };
        if (isHeld(item)) return { ok: false, error: `${id} is held: release it first` };
        const state = store.load();
        const today = istDate(at, config.timeZone);
        // Checked before force, so a stale tab isn't asked to force a post that can't happen.
        if (isDone(state, id, BUFFER_PLATFORM)) {
          return { ok: false, error: `${id} is already ${getEntry(state, id, BUFFER_PLATFORM).status} on ${BUFFER_PLATFORM}` };
        }
        if (!inWindow(item, today)) return { ok: false, error: `${id} can only post ${windowText(item)}` };
        // Anything out today counts, pinned or floating, and whether or not it is still scheduled.
        if (!force && Object.keys(state.items).some((i) => postedOn(state, i, BUFFER_PLATFORM, today))) {
          return { ok: false, needsForce: true, id, platform: BUFFER_PLATFORM };
        }
        return post(item, BUFFER_PLATFORM, at, config);
      });
    },

    retry({ id, platform } = {}) {
      return act("retry", { id, platform }, async () => {
        if (!PLATFORMS.includes(platform)) return { ok: false, error: `unknown platform: ${platform}` };
        const config = deps.loadConfig();
        const off = disabled(config, platform);
        if (off) return { ok: false, error: off };
        const item = deps.loadItems().find((i) => i.id === id);
        if (!item) return { ok: false, error: `no item ${id} in the schedule` };
        const entry = getEntry(store.load(), id, platform);
        if (entry?.status !== "failed") return { ok: false, error: `${id} has not failed on ${platform}` };
        return post(item, platform, now(), config);
      });
    },
  };
}

// One campaign's dependencies, from buildPublishDeps (Task 4), so the dashboard
// posts exactly as that campaign's scheduler loop does. Build them per action: the
// schedule, campaign.json and tokens are read fresh, the settings and schedule
// through loadCampaignData inside the lock. Dashboard notices go to the owner chat
// (the owner's bot and TELEGRAM_CHAT_ID), labelled with the campaign's name, never
// to the campaign's approvers. `make` replaces the client constructors.
export function campaignDeps({ campaign, secrets, ownerEnv = {}, make = {} }) {
  const deps = buildPublishDeps(campaign, { secrets, ownerEnv, make });
  const owner = deps.ownerTelegram;
  const data = () => loadCampaignData({ campaign, secrets, env: ownerEnv });
  return {
    home: deps.home,
    repoRoot: deps.repoRoot,
    lockHome: deps.lockHome,
    lockName: campaign.lockName("publish"),
    configName: `${campaign.id}'s campaign.json`,
    loadConfig: () => data().config,
    loadItems: () => data().items,
    store: deps.store,
    client: deps.client,
    telegram: owner ? { send: (text) => owner.send(`[${campaign.name}] ${text}`) } : undefined,
    log: deps.log,
    sleep: deps.sleep,
    // A build session fails if this campaign's state.json changes under it.
    buildRunning: () => buildRunningError({ lockHome: deps.lockHome, campaigns: [campaign] }),
    secretValues: () => data().secretValues,
  };
}
