// "Needs you": the to-dos a campaign's status asks of the owner, each with one action.
// Pure: built from the status alone (lib/status.mjs), worst first.
//
// Todo = { kind, severity: "red"|"amber"|"purple", title, detail,
//          action: { label, route?, action?, id?, platform? } }
//
// An action with `route` opens that console screen; one with `action` is a POST
// /api/action the console sends as is (id and platform included).

const SEVERITY_ORDER = ["red", "amber", "purple"];
// Instagram tokens last 60 days; warn with ten to go.
const TOKEN_WARN_DAYS = 50;
const CLOCK_SKEW_SECONDS = 120;
const LOW_DISK_GB = 5;
const PLATFORM = { instagram: "Instagram", youtube: "YouTube" };

// The second argument, { now }, is the time the status describes. Nothing here
// depends on it yet; it is part of the interface for time-based to-dos.
export function needsYou(status) {
  const todos = [];
  const add = (severity, kind, title, detail, action) => todos.push({ kind, severity, title, detail, action });
  const creation = status.creation ?? {};
  const health = status.health ?? {};

  // Switched off in its settings, a running campaign silently posts nothing.
  const campaign = status.campaign;
  if (campaign && campaign.paused !== true && campaign.instagramEnabled === false) {
    add("red", "instagramOff", `Instagram posting is off for ${campaign.name}`, "Nothing posts to Instagram until it is switched back on in its settings.", {
      label: "Campaigns",
      route: "#/campaigns",
    });
  }

  for (const f of status.problems?.failed ?? []) {
    const where = PLATFORM[f.platform] ?? f.platform;
    add("red", "postFailed", `${f.id} didn't post to ${where}`, f.error ?? "No error was recorded.", {
      label: "Retry",
      action: "retry",
      id: f.id,
      platform: f.platform,
    });
  }
  for (const n of status.problems?.notReady ?? []) {
    add("red", "notReady", `${name(n)} isn't ready to post`, (n.errors ?? []).join("; ") || "Its check failed.", {
      label: "Library",
      route: "#/library",
    });
  }
  // The machine's checks (lib/health.mjs), when the server adds them to the status.
  const system = status.system;
  const skew = system?.clock?.skewSeconds;
  if (typeof skew === "number" && Math.abs(skew) > CLOCK_SKEW_SECONDS) {
    add("red", "clock", `This computer's clock is off by ${Math.round(Math.abs(skew) / 60)} min`, "Posting and Instagram sign-in need the right time. Fix it in Windows date and time settings.", {
      label: "Health",
      route: "#/health",
    });
  }
  for (const t of (system?.tasks ?? []).filter((t) => t.registered === false)) {
    add("red", "task", `Scheduled task ${t.name} is missing`, "It doesn't run until it is registered again.", { label: "Health", route: "#/health" });
  }
  // The status' own task check is the Pipeline Publisher one; the machine's checks cover it.
  if (health.taskRegistered === false && !system?.tasks) {
    add("red", "task", "The scheduled posting task is missing", "Nothing posts on schedule until it is registered again.", {
      label: "Health",
      route: "#/health",
    });
  }

  // Drops the next run will record; ones already recorded are history, not to-dos.
  for (const d of (status.problems?.dropped ?? []).filter((d) => d.pending === true)) {
    add("amber", "dropping", `${d.id} will be dropped`, d.reason ?? "No reason was given.", { label: "Calendar", route: "#/calendar" });
  }
  for (const f of creation.failed ?? []) {
    add("amber", "buildFailed", `${name(f)} did not build`, f.reason ?? "No reason was recorded.", buildAgain(f.id));
  }
  for (const r of creation.redo ?? []) {
    add("amber", "redo", `${name(r)} is waiting for a redo`, r.reason ?? "No note was left.", buildAgain(r.id));
  }
  const freeGb = system?.disk?.freeGb;
  if (typeof freeGb === "number" && freeGb < LOW_DISK_GB) {
    add("amber", "disk", `Only ${freeGb} GB free on C:`, "Builds and renders need room. Free some space.", { label: "Health", route: "#/health" });
  }
  const igAge = health.tokenAgeDays?.instagram;
  if (typeof igAge === "number" && igAge >= TOKEN_WARN_DAYS) {
    add("amber", "token", `The Instagram token is ${igAge} days old`, "Instagram tokens last 60 days. Replace it before it runs out.", {
      label: "Connections",
      route: "#/connections",
    });
  }
  if (creation.error) {
    add("amber", "buildStatus", "Video creation can't be read", creation.error, { label: "Pipeline", route: "#/pipeline" });
  }

  for (const a of creation.awaiting ?? []) {
    add("purple", "awaiting", `${name(a)} is waiting for your approval`, "Watch it, then approve it or ask for a redo.", {
      label: "Review",
      route: `#/review/${a.id}`,
    });
  }

  // A stable sort, so each severity keeps the order above.
  return todos.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

// A piece's title, or its id when it has none.
function name(entry) {
  return entry.title || entry.id;
}

function buildAgain(id) {
  return { label: "Build again", route: `#/review/${id}` };
}
