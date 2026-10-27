// The console's Campaigns controls: pause or resume a campaign, save its settings, and
// create a new one.
//
//   setPaused({ id, paused })        paused is true or false
//   saveSettings({ id, fields })     fields by name, from SETTINGS or checks.<name> only; a
//                                    dotted name is a nested field ("platforms.youtube.enabled").
//                                    Any other name refuses the lot, by name.
//   createCampaign({ id, name, template })  template "blank" (templates/<name>.campaign.json)
//
// setPaused and saveSettings edit the campaign's campaign.json with updateCampaignFile
// (campaign-file.mjs) under its "schedule" lock: the merged config is checked with
// validateCampaign first, the old copy kept in <campaign home>/backups/, the file replaced
// atomically and nothing committed (C:\Campaigns\<id> need not be a git repo). A lock is
// waited for 3 s at most: a build session holds "schedule" for its whole run.
//
// createCampaign builds <root>/<id>/ like a client campaign: campaign.json (root set to
// the folder, from templates/blank.campaign.json, so it starts paused), headings-only
// brief.md, voice.md and references.md, empty guardrails.json word lists, empty
// backlog.json and schedule.json, .claude/skills/ for its own skills and a .gitignore for
// rendered out/ folders. Then it runs git init and commits "campaign: create <id>" inside
// it, since the build verifier needs a repo; a failure removes the folder. An id that is
// already taken is refused before the lock is waited for.
//
// Every action is logged as "dashboard <action>" in the campaign's log, and returns
// { ok: true, message } or { ok: false, error }.
//
// deps = { secrets, env? (the owner's .env, whose credentials are scrubbed too),
//          git?(args, cwd), now?, log? (every campaign's log, for tests) }

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCampaign, validateCampaign } from "../../campaigns/lib/campaign.mjs";
import { buildCreationDeps } from "../../creation/lib/campaign-deps.mjs";
import { withLock } from "../../publishing/lib/lock.mjs";
import { createLogger } from "../../publishing/lib/log.mjs";
import { checkApprovers, updateCampaignFile } from "./campaign-file.mjs";
import { loadCampaignData, scrub } from "./sources.mjs";

const WAIT_MS = 3000;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_MAX = 80;
export const SETTINGS = ["name", "slot", "lateLimitMinutes", "bufferMin", "fallbackDays", "platforms.instagram.enabled", "platforms.youtube.enabled", "approvers"];
const CHECK_FIELD = /^checks\.[A-Za-z]+$/;
const TEMPLATES = ["blank"];
const TEMPLATE_DIR = new URL("../../campaigns/templates/", import.meta.url);

// git's warnings (line endings on a fresh repo) stay out of the console's output; a
// failure's message still carries them. A git that hangs fails after 30 s.
const defaultGit = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe", timeout: 30000 });
const refuse = (error) => ({ ok: false, error });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const readTemplate = (name) => JSON.parse(fs.readFileSync(new URL(`${name}.campaign.json`, TEMPLATE_DIR), "utf8"));

// A campaign's settings as the form shows them: SETTINGS and every check, by name.
export function campaignSettings(campaign) {
  const c = campaign.config;
  return {
    name: c.name,
    slot: c.slot,
    lateLimitMinutes: c.lateLimitMinutes,
    bufferMin: c.bufferMin,
    fallbackDays: [...c.fallbackDays],
    "platforms.instagram.enabled": c.platforms.instagram.enabled,
    "platforms.youtube.enabled": c.platforms.youtube.enabled,
    approvers: [...c.approvers],
    ...Object.fromEntries(Object.entries(c.checks).map(([k, v]) => [`checks.${k}`, v])),
  };
}

// The name trimmed, or throws: one line of 1 to 80 characters.
function checkName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > NAME_MAX || /[\r\n]/.test(name)) throw new Error(`name must be 1 to ${NAME_MAX} characters on one line`);
  return name;
}

function setField(config, name, value) {
  const keys = name.split(".");
  let at = config;
  for (const k of keys.slice(0, -1)) {
    if (!isObject(at[k])) at[k] = {};
    at = at[k];
  }
  at[keys.at(-1)] = value;
}

// The files of a new campaign folder, by path.
function starterFiles(name) {
  return {
    "brief.md": `# ${name}\n\n## About\n\n## Audience\n\n## What to make\n\n## Never\n`,
    "voice.md": "# Voice\n\n## Tone\n\n## Words to use\n\n## Words to avoid\n",
    "references.md": "# References\n",
    "guardrails.json": "{}\n",
    "backlog.json": "[]\n",
    "schedule.json": "[]\n",
    ".gitignore": "out/\n",
    ".claude/skills/.gitkeep": "",
  };
}

export function createCampaignActions({ root, home, deps }) {
  const { secrets, env, git = defaultGit, now = () => new Date() } = deps;
  const logFor = (id) => deps.log ?? createLogger(path.join(home, "campaigns", id));

  // Runs fn(campaign) under the campaign's schedule lock, and logs the result.
  async function onCampaign(action, id, args, fn) {
    let campaign;
    let secretValues = [];
    let result;
    try {
      campaign = getCampaign(id, { root, home });
      secretValues = loadCampaignData({ campaign, secrets, env }).secretValues;
      const lock = buildCreationDeps(campaign, { secrets }).withLock;
      result = await lock("schedule", () => fn(campaign), { waitMs: WAIT_MS });
    } catch (err) {
      const busy = campaign && err.message === `lock ${campaign.lockName("schedule")} busy`;
      result = refuse(busy ? `a build is running for ${campaign.name}; try again when it finishes` : err.message);
    }
    result = scrub(result, secretValues);
    // An unknown campaign has no log to go to.
    if (campaign) log(action, campaign.id, scrub(args, secretValues), result);
    return result;
  }

  function log(action, id, args, result) {
    const line = { campaign: id, ...args, ...result };
    if (result.ok) logFor(id).info(`dashboard ${action}`, line);
    else logFor(id).error(`dashboard ${action}`, line);
  }

  const update = (campaign, change) =>
    updateCampaignFile({ file: path.join(root, campaign.id, "campaign.json"), campaignHome: campaign.home, now, change });

  // The new campaign's campaign.json, checked.
  function newConfig(id, name, template, folder) {
    const config = { id, name, root: folder, ...readTemplate(template) };
    const problems = validateCampaign(config);
    if (problems.length) throw new Error(problems.join("; "));
    return config;
  }

  // The refusal for an id whose campaign or folder already exists, or null.
  function taken(id) {
    const folder = path.join(root, id);
    if (fs.existsSync(path.join(folder, "campaign.json"))) return `a campaign ${id} already exists`;
    if (fs.existsSync(folder)) return `a folder ${id} is already in the campaigns root`;
    return null;
  }

  function build(id, name, template) {
    const folder = path.join(root, id);
    // Again under the lock: another tab may have created it meanwhile.
    const exists = taken(id);
    if (exists) return refuse(exists);
    const config = newConfig(id, name, template, folder);
    try {
      for (const [rel, text] of Object.entries(starterFiles(name))) {
        fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
        fs.writeFileSync(path.join(folder, rel), text);
      }
      git(["init", "-q", "-b", "main"], folder);
      // Written last: the scheduler picks up any folder with a campaign.json.
      fs.writeFileSync(path.join(folder, "campaign.json"), `${JSON.stringify(config, null, 2)}\n`);
      git(["add", "-A"], folder);
      git(["commit", "-q", "-m", `campaign: create ${id}`], folder);
    } catch (err) {
      fs.rmSync(folder, { recursive: true, force: true });
      return refuse(`couldn't create the campaign folder: ${err.message}`);
    }
    return { ok: true, id, message: `Created ${name}. It starts paused: connect it, add ideas, then resume it.` };
  }

  return {
    setPaused({ id, paused } = {}) {
      return onCampaign("setPaused", id, { paused }, (campaign) => {
        if (typeof paused !== "boolean") return refuse("paused must be true or false");
        update(campaign, (config) => ({ ...config, paused }));
        return { ok: true, message: `${paused ? "Paused" : "Resumed"} ${campaign.name}.` };
      });
    },

    saveSettings({ id, fields } = {}) {
      return onCampaign("saveSettings", id, { fields }, (campaign) => {
        if (!isObject(fields) || !Object.keys(fields).length) return refuse("nothing to save");
        const refused = Object.keys(fields).find((name) => !SETTINGS.includes(name) && !CHECK_FIELD.test(name));
        if (refused !== undefined) return refuse(`${refused} can't be set here`);
        const values = { ...fields };
        if ("name" in values) values.name = checkName(values.name);
        if ("approvers" in values) values.approvers = checkApprovers(values.approvers);
        update(campaign, (config) => {
          for (const [name, value] of Object.entries(values)) setField(config, name, value);
          return config;
        });
        return { ok: true, message: `Saved ${values.name ?? campaign.name}'s settings.` };
      });
    },

    async createCampaign({ id, name, template } = {}) {
      let result;
      try {
        if (typeof id !== "string" || !ID.test(id)) throw new Error("id must be up to 40 lowercase letters, digits and dashes, starting with a letter or digit");
        const title = checkName(name);
        if (!TEMPLATES.includes(template)) throw new Error(`template must be ${TEMPLATES.join(" or ")}`);
        const exists = taken(id);
        if (exists) throw new Error(exists);
        result = await withLock(home, `${id}:schedule`, () => build(id, title, template), { waitMs: WAIT_MS });
      } catch (err) {
        result = refuse(err.message === `lock ${id}:schedule busy` ? `a build is running for ${id}; try again when it finishes` : err.message);
      }
      if (typeof id === "string" && ID.test(id)) log("createCampaign", id, { template }, result);
      return result;
    },
  };
}
