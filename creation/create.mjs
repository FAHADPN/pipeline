// The creation CLI: one campaign's builds, approvals and build list, by hand. The
// scheduled loops (campaigns/pipeline.mjs) run the same steps for every campaign. See
// creation/README.md for the whole pipeline.
//
// Every command works on one campaign under the campaigns root (PIPELINE_CAMPAIGNS_ROOT,
// or C:\Campaigns): `--campaign <id>` picks it; without it, the only campaign there is
// used, and none or several is a usage error that lists the ids found. The campaign's
// build list, brief, checks, state, approvers, Telegram bot and locks come from
// lib/campaign-deps.mjs; internal alerts go to the owner chat in <home>/.env, which
// nightly, poll and recheck need.
//
// Exit code 0 means OK, 1 means something failed.
//
// When a nightly or recheck run ends, its lock released, the next piece in the
// campaign's build queue starts (lib/build-queue.mjs). A `nightly --id` or `recheck`
// that finds the creation lock taken by another start puts its piece back at the head
// of the queue. A queue problem is logged and never changes the exit code.
//
// Importing this file runs nothing; the tests call main() with fakes.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { campaignsRoot, getCampaign, pickCampaignId } from "../campaigns/lib/campaign.mjs";
import { createSecrets } from "../campaigns/lib/secrets.mjs";
import { istDate } from "../publishing/lib/dates.mjs";
import { loadEnv, publisherHome } from "../publishing/lib/env.mjs";
import { poll } from "./lib/approval.mjs";
import { requeueAtHead, startNextQueued as realStartNextQueued } from "./lib/build-queue.mjs";
import { buildCreationDeps } from "./lib/campaign-deps.mjs";
import { itemState, transition } from "./lib/cstate.mjs";
import { runNightly as realRunNightly, runRecheck as realRunRecheck } from "./lib/nightly.mjs";
import { SUPPORTED_FORMATS } from "./lib/picker.mjs";

const USAGE = `Usage: node creation/create.mjs <command> [options] [--campaign <id>]

  nightly [--now] [--id <id>] [--max-builds <n>] [--formats <a,b,...>]
                     build tonight's pieces and send them to the approvers
                     (--id builds one piece by hand and needs --now; defaults:
                     the campaign's maxBuilds and formats)
  poll               handle Approve and Redo taps from the campaign's approvers
  status             every backlog piece's status and the awaiting list
  reset <id>         put one piece back to todo (clears its attempts and note)
  recheck <id>       check and review a built piece (failed or awaiting approval)
                     again without rebuilding it; a SHIP goes to the approvers

  --campaign <id> picks the campaign under the campaigns root (PIPELINE_CAMPAIGNS_ROOT,
  default C:\\Campaigns). Without it, the only campaign there is used.
`;

// Which flags each command accepts. A flag a command doesn't take is refused.
const COMMANDS = {
  nightly: { flags: ["--now", "--id", "--max-builds", "--formats"] },
  poll: { flags: [] },
  status: { flags: [] },
  reset: { flags: [] },
  recheck: { flags: [] },
};
const VALUE_FLAGS = new Set(["--id", "--max-builds", "--formats", "--campaign"]);
// Taken by every command.
const GLOBAL_FLAGS = ["--campaign"];

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      flags[arg] = argv[++i];
    } else {
      flags[arg] = true;
    }
  }
  const command = positional.shift();
  if (!command) throw new UsageError("no command given");
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command: ${command}`);
  for (const flag of Object.keys(flags)) {
    if (!spec.flags.includes(flag) && !GLOBAL_FLAGS.includes(flag)) throw new UsageError(`${command} doesn't take ${flag}`);
  }
  return { command, args: positional, flags };
}

function nightlyOptions({ args, flags }) {
  if (args.length) throw new UsageError("nightly takes no arguments");
  const options = {};
  if (flags["--id"] !== undefined) {
    // Like `publish.mjs post <id> --now`: a build by hand is asked for explicitly.
    if (!flags["--now"]) throw new UsageError("--id needs --now to confirm a build by hand");
    options.onlyId = flags["--id"];
  }
  if (flags["--max-builds"] !== undefined) {
    const n = Number(flags["--max-builds"]);
    if (!/^\d+$/.test(flags["--max-builds"]) || n < 1) {
      throw new UsageError(`--max-builds must be a positive integer: ${flags["--max-builds"]}`);
    }
    options.maxBuilds = n;
  }
  if (flags["--formats"] !== undefined) {
    const formats = flags["--formats"].split(",").map((f) => f.trim()).filter(Boolean);
    const bad = formats.find((f) => !SUPPORTED_FORMATS.includes(f));
    if (bad !== undefined || !formats.length) {
      throw new UsageError(`unknown or unsupported format: ${bad ?? "(none)"}; use ${SUPPORTED_FORMATS.join(", ")}`);
    }
    options.formats = formats;
  }
  return options;
}

// The campaign's deps, and what the commands do around a run.
function campaignContext(id, home, { root, startNextQueued }) {
  const ownerEnv = loadEnv(path.join(home, ".env"));
  const campaign = getCampaign(id, { home, root });
  const deps = buildCreationDeps(campaign, { secrets: createSecrets(home), ownerEnv });
  return {
    deps,
    startNext: async () => {
      try {
        await startNextQueued({ campaign, deps });
      } catch (err) {
        deps.log.error("build queue: next not started", { error: err.message });
      }
    },
    // A run by hand that lost the creation lock to another start goes back to the
    // head of the queue, so the hand-off race never drops it.
    requeue: async (kind, pieceId) => {
      try {
        if (await requeueAtHead(deps, { kind, id: pieceId })) deps.log.info("build queue: re-queued", { id: pieceId, kind });
      } catch (err) {
        deps.log.error("build queue: not re-queued", { id: pieceId, kind, error: err.message });
      }
    },
    // The approval chat and the owner chat, which nightly, poll and recheck need.
    requireTelegram() {
      if (!deps.telegram) throw new Error(deps.telegramProblem);
      if (!ownerEnv.TELEGRAM_BOT_TOKEN || !ownerEnv.TELEGRAM_CHAT_ID) {
        throw new Error(`TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in ${path.join(home, ".env")} for the owner's alerts`);
      }
    },
  };
}

async function cmdNightly(ctx, parsed) {
  const options = nightlyOptions(parsed);
  ctx.requireTelegram();
  const { deps } = ctx;
  deps.log.info("nightly start", { manual: Boolean(parsed.flags["--now"]), ...options });
  let result;
  try {
    result = await ctx.runNightly({ ...deps.picker, ...options, deps });
    if (result.lockBusy && options.onlyId !== undefined) await ctx.requeue("build", options.onlyId);
  } catch (err) {
    // The unattended run must never fail silently.
    deps.log.error("nightly crashed", { error: err.message });
    try {
      await deps.alerts.sendMessage(`❌ builds crashed: ${err.message}`);
    } catch {
      // Reported on stderr below.
    }
    throw err;
  } finally {
    // The run is over and its creation lock released: the queue's next piece may go.
    await ctx.startNext();
  }
  if (result.skipped) console.log(`Skipped: ${result.skipped}`);
  for (const id of result.built) console.log(`sent for approval  ${id}`);
  for (const { id, reason } of result.failed) console.log(`failed             ${id}: ${reason}`);
  deps.log.info("nightly done", { built: result.built, failed: result.failed.map((f) => f.id), skipped: result.skipped });
  return result.failed.length ? 1 : 0;
}

async function cmdPoll(ctx, { args }) {
  if (args.length) throw new UsageError("poll takes no arguments");
  ctx.requireTelegram();
  await poll({ deps: ctx.deps });
  return 0;
}

function cmdStatus(ctx, { args }) {
  if (args.length) throw new UsageError("status takes no arguments");
  const { backlog } = ctx.deps;
  const cstate = ctx.deps.store.load();

  const rows = [["ID", "TARGET", "FORMAT", "STATUS", "FAILS"]];
  for (const e of backlog) {
    const s = itemState(cstate, e.id);
    rows.push([e.id, e.targetDate, e.format, s.status, String(s.attempts ?? 0)]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const row of rows) console.log(row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join("  "));

  const awaiting = backlog.filter((e) => itemState(cstate, e.id).status === "awaiting-approval").map((e) => e.id);
  console.log("");
  console.log(`Today: ${istDate(new Date(), ctx.deps.campaign.config.timezone)}`);
  console.log(`Awaiting approval (${awaiting.length}): ${awaiting.join(", ") || "none"}`);
  if (cstate.pendingNote) console.log(`Waiting for your redo note on: ${cstate.pendingNote}`);
  for (const e of backlog) {
    const s = itemState(cstate, e.id);
    if (s.status === "failed") console.log(`Failed ${e.id}: ${s.reason ?? "no reason recorded"}`);
    if (s.status === "redo") console.log(`Redo ${e.id}: ${s.note ?? ""}`);
  }
  return 0;
}

async function cmdReset(ctx, { args }) {
  const [id] = args;
  if (!id || args.length > 1) throw new UsageError("reset takes exactly one piece id");
  const { deps } = ctx;
  if (!deps.backlog.some((e) => e.id === id)) throw new Error(`${id} is not in the backlog`);
  // The same lock the nightly run and the approval handler take for creation-state.json.
  const prev = await deps.withLock("creation-state", () => {
    const cstate = deps.store.load();
    const prev = itemState(cstate, id);
    if (prev.status === "building") {
      throw new Error(`${id} is building; reset it once that run ends (the next nightly run marks a stuck build failed)`);
    }
    const { pendingNote, ...rest } = cstate;
    deps.store.save(transition(pendingNote === id ? rest : cstate, id, "todo"));
    return prev;
  });
  deps.log.info("reset", { id, from: prev.status });
  console.log(`Reset ${id} from ${prev.status} to todo.`);
  return 0;
}

async function cmdRecheck(ctx, { args }) {
  const [id] = args;
  if (!id || args.length > 1) throw new UsageError("recheck takes exactly one piece id");
  ctx.requireTelegram();
  const { deps } = ctx;
  let result;
  try {
    result = await ctx.runRecheck({ id, deps });
  } catch (err) {
    if (err.lockBusy) await ctx.requeue("recheck", id);
    throw err;
  } finally {
    await ctx.startNext();
  }
  deps.log.info("recheck", result);
  if (result.ok) {
    console.log(`sent for approval  ${id}`);
    return 0;
  }
  console.log(`failed             ${id}: ${result.reason}`);
  return 1;
}

const HANDLERS = { nightly: cmdNightly, poll: cmdPoll, status: cmdStatus, reset: cmdReset, recheck: cmdRecheck };

// `options` replace the environment, for tests: home, root (the campaigns root), and the
// runNightly, runRecheck and startNextQueued that run.
export async function main(argv, {
  home: givenHome,
  root: givenRoot,
  runNightly = realRunNightly,
  runRecheck = realRunRecheck,
  startNextQueued = realStartNextQueued,
} = {}) {
  try {
    const parsed = parseArgs(argv);
    const home = givenHome ?? publisherHome();
    const root = givenRoot ?? campaignsRoot();
    const id = pickCampaignId(parsed.flags["--campaign"], { root });
    const ctx = campaignContext(id, home, { root, startNextQueued });
    return await HANDLERS[parsed.command]({ ...ctx, runNightly, runRecheck }, parsed);
  } catch (err) {
    if (err instanceof UsageError || err.usage) {
      console.error(`${err.message}\n\n${USAGE}`);
      return 1;
    }
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (runDirectly) process.exitCode = await main(process.argv.slice(2));
