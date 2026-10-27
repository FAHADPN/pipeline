// The creation pipeline's dependencies for one campaign: what runNightly,
// runRecheck and the approval poller take, built from a campaign object
// (campaigns/lib/campaign.mjs). A campaign builds in its own folder with its own
// skills and MCPs, from its own brief, voice and references, checks pieces with its
// own switches, video spec and word lists, keeps its state in campaign.home and
// locks under "<id>:<name>" in the shared publisher home. Its build sessions report
// to creation-out/<id>.json, where the reviewer's files go too.
//
// Telegram: approval videos go to the campaign's approvers through its own bot (or
// the owner's, labelled with the campaign's name), and only those chats can approve
// or redo. Internal alerts (violations, failures, must-fix lists, the summary) go to
// the owner chat only: the owner's bot and TELEGRAM_CHAT_ID from the owner's .env
// (`ownerEnv`). A note from any other approver is a client's and is screened.
//
// `make` replaces the Telegram constructor and the process and git runners, for tests.

import fs from "node:fs";
import path from "node:path";
import { withLock } from "../../publishing/lib/lock.mjs";
import { createLogger } from "../../publishing/lib/log.mjs";
import { createTelegram } from "../../publishing/lib/telegram.mjs";
import { loadBacklog } from "./backlog.mjs";
import { loadGuardrails, runChecks } from "./checks.mjs";
import { OUT_DIR } from "./constants.mjs";
import { createCreationStore } from "./cstate.mjs";
import { buildCampaignPrompt } from "./prompt.mjs";
import { checksFilePath, reviewPrompt, runReview } from "./review.mjs";
import { runSession } from "./session.mjs";
import { HOME_FILES, revertSession, snapshot, verifySession } from "./verify.mjs";

const toPosix = (p) => p.split(path.sep).join("/");

function readText(file, what) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (err) {
    throw new Error(`can't read the ${what} ${file}: ${err.code ?? err.message}`);
  }
}

// A Telegram client whose every message starts with `label`.
function labelled(bot, label) {
  if (!label) return bot;
  return {
    ...bot,
    send: (text) => bot.send(`${label}${text}`),
    sendMessage: (text, options) => bot.sendMessage(`${label}${text}`, options),
    sendVideo: ({ caption, ...rest }) => bot.sendVideo({ ...rest, caption: caption == null ? caption : `${label}${caption}` }),
  };
}

// One client for all the approvers: messages and videos go to each (every chat is
// tried, the first failure thrown after); getUpdates and callback answers are the
// bot's own.
function toApprovers(clients, bot) {
  const each = async (fn) => {
    let failure;
    for (const c of clients) {
      try {
        await fn(c);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure) throw failure;
  };
  return {
    send: (text) => each((c) => c.send(text)),
    sendMessage: (text, options) => each((c) => c.sendMessage(text, options)),
    sendVideo: (args) => each((c) => c.sendVideo(args)),
    getUpdates: (args) => bot.getUpdates(args),
    answerCallbackQuery: (id, text) => bot.answerCallbackQuery(id, text),
  };
}

export function buildCreationDeps(campaign, { secrets, ownerEnv = {}, make = {} } = {}) {
  if (!secrets) throw new Error("buildCreationDeps needs the secrets store");
  const makeTelegram = make.telegram ?? createTelegram;
  const runner = (keys) => Object.fromEntries(keys.filter((k) => make[k] !== undefined).map((k) => [k, make[k]]));
  const { id, name, root } = campaign;
  // campaign.home is <publisher home>/campaigns/<id>; locks and secrets are shared across it.
  const publisherHome = path.resolve(campaign.home, "..", "..");

  // Telegram: the campaign's bot to its approvers, and the owner chat for alerts.
  const { TELEGRAM_BOT_TOKEN: ownerBot, TELEGRAM_CHAT_ID: ownerChat } = ownerEnv;
  const ownBot = secrets.get(id, "TELEGRAM_BOT_TOKEN");
  const botToken = ownBot ?? ownerBot;
  const label = ownBot ? "" : `[${name}] `;
  const { approvers } = campaign.config;
  let telegramProblem;
  if (!approvers.length) telegramProblem = `${id} has no approval chat: no approvers in its campaign.json`;
  else if (!botToken) telegramProblem = `${id} has no approval chat: no TELEGRAM_BOT_TOKEN in secrets/${id}.json or the owner's .env`;
  const chats = new Map();
  const telegramFor = (chatId) => {
    const key = String(chatId);
    if (!chats.has(key)) chats.set(key, labelled(makeTelegram({ token: botToken, chatId: key }), label));
    return chats.get(key);
  };
  const telegram = telegramProblem
    ? undefined
    : toApprovers(approvers.map(telegramFor), makeTelegram({ token: botToken, chatId: approvers[0] }));
  const ownerTelegram = ownerBot && ownerChat ? makeTelegram({ token: ownerBot, chatId: ownerChat }) : undefined;
  const alerts = {
    async sendMessage(text) {
      if (!ownerTelegram) throw new Error("no owner chat: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the owner's .env");
      return ownerTelegram.sendMessage(`[${name}] ${text}`);
    },
  };

  // Where a piece lives, and what its session may change.
  const prefix = (entryId) => campaign.paths.verifyPrefix(entryId);
  const pieceDir = (entryId) => prefix(entryId).replace(/\/+$/, "");
  const outFile = (entryId) => `${OUT_DIR}/${entryId}.json`;
  // The owner's .env, this campaign's state and tokens, and every campaign's secrets file.
  const homeFiles = () => {
    const files = {};
    for (const f of HOME_FILES) files[f] = path.join(publisherHome, f);
    for (const f of ["state.json", "tokens.json"]) files[`campaigns/${id}/${f}`] = path.join(campaign.home, f);
    const dir = path.join(publisherHome, "secrets");
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    for (const f of names) files[`secrets/${f}`] = path.join(dir, f);
    return files;
  };

  // An API key in this campaign's secrets is used by its build and review sessions;
  // without one, none is passed on.
  const sessionEnv = { ANTHROPIC_API_KEY: secrets.get(id, "ANTHROPIC_API_KEY") };
  const reviewPromptFor = (entryId) => reviewPrompt({
    id: entryId,
    name,
    pieceDir: pieceDir(entryId),
    brief: campaign.paths.brief,
    voice: campaign.paths.voice,
    checksFile: checksFilePath(root, entryId),
  });
  const checkOptions = () => ({
    switches: { ...campaign.config.checks },
    videoSpec: { ...campaign.config.videoSpec },
    guardrails: loadGuardrails(campaign.paths.guardrails),
  });
  let backlog;

  return {
    campaign,
    name,
    home: campaign.home,
    lockHome: publisherHome,
    repoRoot: root,
    store: createCreationStore(campaign.home),
    log: createLogger(campaign.home),
    get backlog() {
      backlog ??= loadBacklog(campaign.paths.backlog);
      return backlog;
    },
    // nightly hands these to buildPrompt.
    get brief() {
      return readText(campaign.paths.brief, "brief");
    },
    get references() {
      return readText(campaign.paths.references, "references");
    },
    get checkOptions() {
      return checkOptions();
    },
    picker: { formats: [...campaign.config.formats], maxBuilds: campaign.config.maxBuilds, maxAwaiting: campaign.config.maxAwaiting },
    pieceDir,
    scheduleFile: toPosix(path.relative(root, campaign.paths.schedule)),
    lockName: campaign.lockName,
    withLock: (lockName, fn, options) => withLock(publisherHome, campaign.lockName(lockName), fn, options),

    approvers: approvers.map(String),
    telegram,
    telegramFor,
    telegramProblem,
    ownerChatId: ownerChat ?? null,
    alerts,

    reviewPrompt: reviewPromptFor,
    buildPrompt: ({ entry, brief, references, redoNote }) => buildCampaignPrompt({
      campaign,
      entry,
      brief,
      voice: readText(campaign.paths.voice, "voice file"),
      references,
      redoNote,
      pieceDir: pieceDir(entry.id),
      outFile: outFile(entry.id),
    }),
    runSession: (args) => runSession({
      ...args,
      cwd: root,
      extraAllowedTools: campaign.config.extraAllowedTools,
      env: sessionEnv,
      ...runner(["spawn", "killTree"]),
    }),
    snapshot: (args) => snapshot({ ...args, repoRoot: root, homeFiles: homeFiles(), ...runner(["git"]) }),
    verifySession: (args) => verifySession({
      ...args,
      repoRoot: root,
      prefix: prefix(args.entryId),
      ownFile: outFile(args.entryId),
      homeFiles: homeFiles(),
      ...runner(["git"]),
    }),
    revertSession: (args) => revertSession({ ...args, repoRoot: root, prefix: prefix(args.entryId), ...runner(["git"]) }),
    runChecks: (args) => runChecks({
      repoRoot: root,
      item: { id: args.entry.id, kind: args.entry.kind, dir: pieceDir(args.entry.id) },
      ...checkOptions(),
      ...runner(["exec", "ffprobe", "skillsDir"]),
    }),
    runReview: (args) => runReview({
      ...args,
      cwd: root,
      prompt: reviewPromptFor(args.entryId),
      env: sessionEnv,
      ...runner(["spawn", "killTree"]),
    }),
  };
}
