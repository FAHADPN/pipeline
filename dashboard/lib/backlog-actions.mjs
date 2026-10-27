// The console's build-list editing for one campaign. saveIdea adds an idea, or edits
// one; removeIdea deletes one. Both edit the campaign's build list (paths.backlog in its
// campaign.json) through editJsonFile, under the campaign's "schedule" lock, and commit
// it as "ideas: add|edit|remove <id>". A lock is waited for 3 s at most: a build session
// holds "schedule" for its whole run, and a tap must never hang or land mid-build.
//
// Only an idea nothing has started on can change: its creation state is todo (or it has
// none) and it isn't in the schedule. A building, awaiting, approved, failed or redo
// piece is refused with a reason, so a stale tab can't rewrite what a build is using.
//
// The form's fields are title (1-80), premise (1-1000), format, type, targetDate (today or
// later; an edit may keep an older one) and the optional notBefore and notAfter. The
// rest of an entry the validator needs is set here: kind follows format (episode is ep,
// anything else post), hook is null and a new entry's reference is the one the nearest
// idea of the same format builds from. An id is a slug of the title, made unique against
// the build list and the schedule.
//
// Every action is logged as "dashboard <action>" with its arguments and result, the
// console's audit trail (scrubbed of secrets), and returns { ok: true, message } or
// { ok: false, error }.
//
// deps = { withLock(name, fn, options), repoRoot, backlogFile, scheduleFile,
//          store (the creation store), log, git?, now?, secretValues? } (backlogDeps builds them)

import fs from "node:fs";
import path from "node:path";
import { istDate, isRealDate } from "../../publishing/lib/dates.mjs";
import { loadSchedule } from "../../publishing/lib/schedule.mjs";
import { editJsonFile } from "../../publishing/lib/schedule-edit.mjs";
import { buildCreationDeps } from "../../creation/lib/campaign-deps.mjs";
import { formatBacklog, TYPES, validateBacklog } from "../../creation/lib/backlog.mjs";
import { itemState } from "../../creation/lib/cstate.mjs";
import { loadCampaignData, scrub } from "./sources.mjs";

const WAIT_MS = 3000;
const TITLE_MAX = 80;
const PREMISE_MAX = 1000;
const FIELDS = ["title", "premise", "format", "type", "targetDate", "notBefore", "notAfter"];
const OPTIONAL = ["notBefore", "notAfter"];

const refuse = (error) => ({ ok: false, error });

function readEntries(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`can't read the build list: ${err.message}`);
  }
}

// The formats the form offers for a campaign: its own setting.
export function ideaFormats(campaign) {
  return [...new Set(campaign.config.formats)];
}

export function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function createBacklogActions({ campaign, deps }) {
  const { withLock, repoRoot, backlogFile, scheduleFile, store, log, git, now = () => new Date(), secretValues = [] } = deps;
  const busy = `lock ${campaign.lockName("schedule")} busy`;
  const formats = ideaFormats(campaign);

  // Runs one action under the schedule lock and logs its result, whatever it was.
  async function act(name, args, fn) {
    let result;
    try {
      result = await withLock("schedule", fn, { waitMs: WAIT_MS });
    } catch (err) {
      result = refuse(err.message === busy ? `a build is running for ${campaign.name}; try again when it finishes` : err.message);
    }
    // The arguments too: an idea's text is typed by hand and could hold anything.
    const line = scrub({ ...args, ...result }, secretValues);
    if (result.ok) log.info(`dashboard ${name}`, line);
    else log.error(`dashboard ${name}`, line);
    return scrub(result, secretValues);
  }

  // The refusal for an idea that has started building or been approved, or null.
  function lockedReason(id) {
    const { status } = itemState(store.load(), id);
    if (status !== "todo") return `${id} is ${status}; only an idea that hasn't been built can be changed`;
    if (loadSchedule(scheduleFile, repoRoot).some((i) => i.id === id)) return `${id} is already scheduled; only an idea that hasn't been built can be changed`;
    return null;
  }

  // Edits the build list: change(entries) returns the new entries or throws the refusal.
  function edit(commit, message, change) {
    const res = editJsonFile({
      root: repoRoot,
      file: backlogFile,
      git,
      message: `ideas: ${commit}`,
      change,
      validate: validateBacklog,
      format: formatBacklog,
      what: "build list",
    });
    return res.ok ? { ok: true, message } : res;
  }

  // The fields from the form, checked; throws the first problem.
  function checkFields(entry, existing) {
    for (const key of Object.keys(entry)) {
      if (key !== "id" && !FIELDS.includes(key)) throw new Error(`${key} can't be set here`);
    }
    const out = {};
    for (const key of ["title", "premise"]) {
      const max = key === "title" ? TITLE_MAX : PREMISE_MAX;
      const value = typeof entry[key] === "string" ? entry[key].trim() : "";
      if (!value || value.length > max) throw new Error(`${key} must be 1 to ${max} characters`);
      out[key] = value;
    }
    if (!formats.includes(entry.format)) throw new Error(`format must be one of ${formats.join(", ")}`);
    if (!TYPES.includes(entry.type)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
    out.format = entry.format;
    out.type = entry.type;
    if (!isRealDate(entry.targetDate)) throw new Error("targetDate must be a real YYYY-MM-DD date");
    if (entry.targetDate !== existing?.targetDate && entry.targetDate < istDate(now(), campaign.config.timezone)) {
      throw new Error(`targetDate ${entry.targetDate} has passed; pick today or later`);
    }
    out.targetDate = entry.targetDate;
    for (const key of OPTIONAL) {
      const value = entry[key];
      if (value === undefined || value === null || value === "") continue;
      if (!isRealDate(value)) throw new Error(`${key} must be a real YYYY-MM-DD date`);
      out[key] = value;
    }
    return out;
  }

  // Where an entry planned for `date` goes: before the first one planned later.
  function place(entries, entry) {
    const at = entries.findIndex((e) => e.targetDate > entry.targetDate);
    return at === -1 ? [...entries, entry] : [...entries.slice(0, at), entry, ...entries.slice(at)];
  }

  const kindFor = (format) => (format === "episode" ? "ep" : "post");

  function add(fields) {
    const base = slugify(fields.title);
    if (!base) throw new Error("title needs a letter or a digit");
    // The commit message names the id, so it is chosen before the edit.
    const taken = new Set(loadSchedule(scheduleFile, repoRoot).map((i) => i.id));
    for (const e of readEntries(path.join(repoRoot, backlogFile))) taken.add(e.id);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const res = edit(`add ${id}`, `Added ${id} to the build list.`, (entries) => {
      // The piece a new idea builds from: the latest idea of its format, else any.
      const reference = (entries.findLast((e) => e.format === fields.format) ?? entries.at(-1))?.reference;
      if (!reference) throw new Error("no idea in the build list to take a reference from; add the first one by hand");
      const { title, premise, format, type, targetDate, ...window } = fields;
      return place(entries, { id, kind: kindFor(format), format, type, title, premise, targetDate, hook: null, reference, ...window });
    });
    return res.ok ? { ...res, id } : res;
  }

  return {
    saveIdea({ entry } = {}) {
      const id = entry?.id;
      return act("saveIdea", { entry }, () => {
        if (id === undefined) return add(checkFields(entry, undefined));
        return edit(`edit ${id}`, `Saved ${id}.`, (entries) => {
          const existing = entries.find((e) => e.id === id);
          if (!existing) throw new Error(`no idea ${id} in the build list`);
          const locked = lockedReason(id);
          if (locked) throw new Error(locked);
          const fields = checkFields(entry, existing);
          const next = { ...existing };
          for (const key of OPTIONAL) delete next[key];
          Object.assign(next, fields);
          if (fields.format !== existing.format) next.kind = kindFor(fields.format);
          const rest = entries.filter((e) => e !== existing);
          return fields.targetDate === existing.targetDate ? entries.map((e) => (e === existing ? next : e)) : place(rest, next);
        });
      });
    },

    removeIdea({ id } = {}) {
      return act("removeIdea", { id }, () =>
        edit(`remove ${id}`, `Removed ${id} from the build list.`, (entries) => {
          if (!entries.some((e) => e.id === id)) throw new Error(`no idea ${id} in the build list`);
          const locked = lockedReason(id);
          if (locked) throw new Error(locked);
          return entries.filter((e) => e.id !== id);
        }),
      );
    },
  };
}

// One campaign's build-list dependencies: its schedule, creation store and lock helper
// from buildCreationDeps, where its build list is, and its secret values (and the
// owner's, from `env`) for scrubbing.
export function backlogDeps({ campaign, secrets, env }) {
  const deps = buildCreationDeps(campaign, { secrets });
  return {
    withLock: deps.withLock,
    repoRoot: deps.repoRoot,
    backlogFile: path.relative(campaign.root, campaign.paths.backlog).split(path.sep).join("/"),
    scheduleFile: deps.scheduleFile,
    store: deps.store,
    log: deps.log,
    secretValues: loadCampaignData({ campaign, secrets, env }).secretValues,
  };
}
