// Health: the campaign's posting checks from its status, then the machine's own
// (lib/health.mjs): scheduled tasks, each campaign's loops and token age, the clock,
// the disk and the console's recent actions. Text only, read-only; every log line is
// text.
//
//   healthScreen(ctx) -> Node, where ctx = { status, health: { data, error } | null }

import { h } from "../dom.js";
import { dayLabel, days, rhythmLabel } from "../lib/format.js";

const TOKEN_WARN_DAYS = 50;
const CLOCK_SKEW_SECONDS = 120;
const LOW_DISK_GB = 5;
// schtasks' results for a task that is running now or has never run: not failures.
const NOT_A_FAILURE = new Set([0, 267009, 267011]);
const LOOP_LABELS = { publish: "Posting", create: "Building", telegram: "Telegram" };

const pill = (ok, text) => h("span", { className: `pill ${ok ? "status-posted" : "status-fix"}` }, text);

function row(name, detail, ok) {
  return h("tr", {}, h("th", { scope: "row" }, name), h("td", {}, detail), h("td", {}, pill(ok, ok ? "OK" : "Attention")));
}

function tokenRow(name, age) {
  if (age === null || age === undefined) return row(name, "Not connected", name === "YouTube");
  return row(name, `${days(age)} old`, age < TOKEN_WARN_DAYS);
}

// "26 Oct, 12:30 am" in the viewer's zone, or a dash.
function when(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

function section(title, ...body) {
  return h("section", { className: "health-section" }, h("h2", {}, title), ...body);
}

function table(headers, rows) {
  return h(
    "div",
    { className: "card table-wrap" },
    h(
      "table",
      { className: "table" },
      h("thead", {}, h("tr", {}, headers.map((t) => h("th", { scope: "col" }, t)))),
      h("tbody", {}, rows),
    ),
  );
}

function taskRow(t) {
  // registered is null when schtasks couldn't say, which is not the same as missing.
  const failed = t.registered === true && typeof t.lastResult === "number" && !NOT_A_FAILURE.has(t.lastResult);
  const state = t.registered === false ? "Missing" : t.registered === null ? "Unknown" : failed ? "Failed" : (t.status ?? "OK");
  const result = t.registered !== true || t.lastResult === null ? "—" : String(t.lastResult);
  return h(
    "tr",
    {},
    h("th", { scope: "row" }, t.name),
    h("td", {}, when(t.lastRun)),
    h("td", {}, result),
    h("td", {}, when(t.nextRun)),
    h("td", {}, pill(t.registered === true && !failed, state)),
  );
}

function loopRow(campaign, loop, line) {
  return h(
    "tr",
    {},
    h("th", { scope: "row" }, `${campaign} · ${LOOP_LABELS[loop]}`),
    h("td", {}, line ? when(line.at) : "—"),
    h("td", {}, line ? `${line.message}${line.detail ? ` ${line.detail}` : ""}` : "No log line yet"),
    h("td", {}, pill(!line || line.level !== "ERROR", line?.level === "ERROR" ? "Error" : "OK")),
  );
}

function clockText(clock) {
  if (!clock) return { text: "Couldn't check the clock (offline?)", ok: true };
  const s = clock.skewSeconds;
  const text = Math.abs(s) <= 1 ? "Right on time" : `${Math.abs(s)} s ${s < 0 ? "behind" : "ahead"}`;
  return { text: `${text} · checked ${when(clock.checkedAt)}`, ok: Math.abs(s) <= CLOCK_SKEW_SECONDS };
}

function machineSections(data) {
  const clock = clockText(data.clock);
  const free = data.disk?.freeGb;
  return [
    section(
      "Scheduled tasks",
      table(
        ["Task", "Last run", "Last result", "Next run", "Status"],
        data.tasks.map(taskRow),
      ),
    ),
    section(
      "Loops",
      table(
        ["Loop", "At", "Last log line", "Status"],
        data.loops.flatMap((l) => Object.keys(LOOP_LABELS).map((loop) => loopRow(l.campaign, loop, l[loop]))),
      ),
    ),
    section(
      "Tokens, clock and disk",
      table(
        ["Check", "Detail", "Status"],
        [
          ...data.tokens.map((t) =>
            t.instagramAgeDays === null ? row(`${t.campaign} · Instagram token`, "No issue date", true) : row(`${t.campaign} · Instagram token`, `${days(t.instagramAgeDays)} old`, !t.warn),
          ),
          row("Clock", clock.text, clock.ok),
          typeof free === "number" ? row("Disk C:", `${free} GB free`, free >= LOW_DISK_GB) : row("Disk C:", "Couldn't read it", true),
        ],
      ),
    ),
    section(
      "Recent console actions",
      data.actions.length
        ? table(
            ["When", "Action", "Result"],
            data.actions.map((a) =>
              h(
                "tr",
                {},
                h("td", {}, when(a.at)),
                h("th", { scope: "row" }, `${a.campaign} · ${a.message.replace(/^dashboard /, "")}`),
                h("td", {}, a.detail ?? (a.level === "ERROR" ? "Failed" : "Done")),
              ),
            ),
          )
        : h("p", { className: "muted" }, "No console actions logged yet."),
    ),
  ];
}

export function healthScreen({ status, health }) {
  const checks = status.health ?? {};
  const ages = checks.tokenAgeDays ?? {};
  const last = status.lastRun;
  return h(
    "div",
    { className: "screen" },
    h("div", { className: "screen-head" }, h("h1", {}, "Health")),
    health?.error ? h("p", { className: "banner banner-err" }, `Can't read the machine's health: ${health.error}`) : null,
    health?.data ? machineSections(health.data) : health?.error ? null : h("p", { className: "muted" }, "Loading…"),
    section(
      "Posting checks",
      table(
        ["Check", "Detail", "Status"],
        [
          row("Last run", last ? `${last.at}: ${last.summary}` : "No run logged yet", Boolean(last) && !/crashed|failed/.test(last.summary)),
          row("Ready to post", `${checks.readyCount ?? 0} · ${rhythmLabel(checks.rhythm)}`, (checks.readyCount ?? 0) > 0),
          row("Runs dry", checks.runDry ? dayLabel(checks.runDry, status.today) : "Nothing floating is ready", Boolean(checks.runDry)),
          tokenRow("YouTube", ages.youtube),
        ],
      ),
    ),
  );
}
