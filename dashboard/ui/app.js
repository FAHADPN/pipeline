// The console shell: the router, the header (campaign switcher, alert pill, next post,
// sign-in), the navigation (a sidebar, or bottom tabs under 760 px), the toasts and the
// actions. Screens are functions from a context to a node (screens/*.js).
//
// Routes: #/needs, #/pipeline, #/calendar, #/library, #/review, #/review/<id>,
// #/connections, #/health, #/campaigns, and #/more (the phone's list of the other
// screens). The campaign shown is ?campaign= in the page's address; the first campaign
// in folder order when there is none. The status refreshes every 30 s, on return to the
// tab, and right after any action. While the piece shown on Review builds, its progress
// is polled every 5 s; while it, or a piece on the Pipeline or the review list, waits in
// the build queue, every 15 s.

import { getBuild, getCalendar, getCampaigns, getHealth, getLibrary, getPipeline, getReview, getReviews, getStatus, postAction } from "./api.js";
import { fill, h, icon, markBusy } from "./dom.js";
import { dayLabel, PLATFORMS } from "./lib/format.js";
import { nextFloating } from "./lib/queue.js";
import { closePlayer, openPlayer } from "./player.js";
import { calendarScreen } from "./screens/calendar.js";
import { campaignsScreen } from "./screens/campaigns.js";
import { connectionsScreen } from "./screens/connections.js";
import { healthScreen } from "./screens/health.js";
import { libraryScreen } from "./screens/library.js";
import { needsScreen } from "./screens/needs.js";
import { pipelineScreen } from "./screens/pipeline.js";
import { openIdeaForm } from "./screens/idea-form.js";
import { reviewScreen } from "./screens/review.js";

const REFRESH_MS = 30000;
const TOAST_MS = 10000;
const BUILD_POLL_MS = 5000;
// A queued piece waits for a build or the posting window: minutes, not seconds.
const QUEUE_POLL_MS = 15000;
// The longest a Build now or Recheck shows as starting when the piece's state never moves
// on (a run that stops before its piece shows building).
const BUILD_START_MS = 10 * 60000;

const SCREENS = [
  { id: "needs", label: "Needs you" },
  { id: "pipeline", label: "Pipeline" },
  { id: "calendar", label: "Calendar" },
  { id: "library", label: "Library" },
  { id: "review", label: "Review" },
  { id: "connections", label: "Connections" },
  { id: "health", label: "Health" },
  { id: "campaigns", label: "Campaigns" },
];
const LABELS = Object.fromEntries(SCREENS.map((s) => [s.id, s.label]));
const BRAND_ICON = "M4 12h4l3-8 4 16 3-8h2";
const ICONS = {
  needs: ["M4 13l3-8h10l3 8v5a1 1 0 01-1 1H5a1 1 0 01-1-1z", "M4 13h5l1 2h4l1-2h5"],
  calendar: ["M6 5h12a2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2z", "M4 10h16M9 3v4M15 3v4"],
  library: ["M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  more: ["M5 12h.01M12 12h.01M19 12h.01"],
};
// The phone's bottom tabs; More lists every other screen.
const TABS = [
  { id: "needs", label: "Needs you" },
  { id: "calendar", label: "Calendar" },
  { id: "library", label: "Library" },
  { id: "more", label: "More" },
];
const ON_TABS = new Set(TABS.map((t) => t.id));

const state = {
  // null until the campaign list names the first one (firstCampaign).
  campaign: new URLSearchParams(location.search).get("campaign") || null,
  campaigns: [],
  status: null,
  library: null, // /api/library's { pieces, counts }, as last loaded
  libraryError: null, // why the last library load failed, or null
  calendarFrom: null, // the calendar's first day; null for the weeks holding today
  calendar: null, // { data, error } from /api/calendar, while the calendar is shown
  builds: null, // { data, error } from /api/pipeline, while the pipeline is shown
  health: null, // { data, error } from /api/health, while Health is shown
  reviews: null, // { data, error } from /api/review, while the review list is shown
  review: null, // { id, data, error } from /api/review?id=, while that piece is shown
  build: null, // { id, data } from /api/build, while that piece's build is watched
  starting: null, // { id, until, what, since? }: a Build now or Recheck ("what") of it is starting
  error: null,
  busy: false,
  drawn: null, // what the screen was last drawn from, so an unchanged refresh keeps focus
};

const $ = (id) => document.getElementById(id);

// --- Routing -----------------------------------------------------------------------

// An unknown screen, or an id that isn't valid percent-encoding, is Needs you.
function route() {
  const [, screen = "needs", id = null] = location.hash.split("/");
  const known = screen === "more" || Object.hasOwn(LABELS, screen);
  if (!known) return { screen: "needs", id: null };
  try {
    return { screen, id: id && decodeURIComponent(id) };
  } catch {
    return { screen: "needs", id: null };
  }
}

// --- Actions -----------------------------------------------------------------------

function toast(kind, text) {
  const box = $("toast");
  const close = h("button", { type: "button", className: "toast-close", "aria-label": "Dismiss", onClick: () => box.replaceChildren() }, "×");
  const note = h("div", { className: `toast toast-${kind}` }, h("span", {}, text), close);
  fill(box, note);
  if (kind !== "err") setTimeout(() => note.isConnected && note.remove(), TOAST_MS);
}

// Sends one action for `campaign`, the one shown when the owner asked for it.
async function act(body, campaign) {
  state.busy = true;
  toast("info", "Working… this waits if a scheduled run is going.");
  try {
    return await postAction(body, { campaign, csrf: state.status?.csrf });
  } finally {
    state.busy = false;
  }
}

// One toast with the server's message.
function report(out) {
  const where = PLATFORMS[out.platform] ?? out.platform;
  const link = out.url ? ` ${out.url}` : "";
  if (out.ok && out.outcome === "alreadyLive") toast("ok", `${out.id} was already live on ${where}; recorded it.${link}`);
  else if (out.ok) toast("ok", `Posted ${out.id} to ${where}.${link}`);
  else toast("err", out.id && where ? `${out.id} on ${where}: ${out.error}` : (out.error ?? "Something went wrong."));
}

// Posts `target` = { id, title, platform }, the next floating Instagram item (see
// lib/queue.js). When something already went out today, the server asks for force;
// the owner confirms first.
async function postNow(target) {
  const campaign = state.campaign;
  const title = target.title ?? target.id;
  const where = (platform) => PLATFORMS[platform] ?? platform;
  if (state.busy || !confirm(`Post "${title}" to ${where(target.platform)} now?`)) return;
  let out = await act({ action: "postNow", id: target.id }, campaign);
  if (out.needsForce) {
    const platform = out.platform ?? target.platform;
    if (!confirm(`Something already went out on ${where(platform)} today. Post "${title}" anyway?`)) {
      toast("info", `Didn't post ${out.id ?? target.id}.`);
      return refresh();
    }
    out = await act({ action: "postNow", id: out.id ?? target.id, force: true }, campaign);
  }
  report(out);
  if (out.ok) closePlayer();
  return refresh();
}

// Posts a Ready piece that isn't the next queued one, right away, with the same
// already-live guard; when something already went out today the owner confirms first.
async function postItem(piece) {
  const campaign = state.campaign;
  const title = piece.title ?? piece.id;
  if (state.busy || !confirm(`Post "${title}" to Instagram now?`)) return;
  let out = await act({ action: "postItem", id: piece.id }, campaign);
  if (out.needsForce) {
    if (!confirm(`A post already went out today. Post ${title} now anyway?`)) {
      toast("info", `Didn't post ${piece.id}.`);
      return refresh();
    }
    out = await act({ action: "postItem", id: piece.id, force: true }, campaign);
  }
  report(out);
  if (out.ok) closePlayer();
  return refresh();
}

// Ids of the pieces with a queue action running; a second one on the same piece is ignored.
const pending = new Set();

// Sends action `name` (hold, release, pin, unpin, reorder, drop, approve, redo, recheck,
// buildNow, unqueue) for `piece` with `args`, showing `busyEl` busy meanwhile. On success the
// player closes; either way the toast carries the server's message or error, and the
// screens reload. Returns the server's result.
async function queueAction(name, piece, args = {}, busyEl = null) {
  if (pending.has(piece.id)) return;
  const campaign = state.campaign;
  pending.add(piece.id);
  const done = markBusy(busyEl);
  let out;
  try {
    out = await act({ action: name, id: piece.id, ...args }, campaign);
  } finally {
    pending.delete(piece.id);
    done();
  }
  if (out.ok) {
    closePlayer();
    toast("ok", out.message ?? "Done.");
  } else {
    toast("err", out.error ?? "Something went wrong.");
  }
  await refresh();
  return out;
}

// True while a Build now or Recheck of piece `id` is starting.
const isStarting = (id) => state.starting?.id === id && Date.now() < state.starting.until;

// The Review screen's and the player's creation actions. Build now asks first. An
// approve or redo done from the piece's own Review page goes back to the list. A build
// or recheck is marked starting from the tap, so every redraw meanwhile keeps Build
// again now and Recheck disabled, and the page is watched until the piece moves on.
async function creationAction(name, piece, args = {}, busyEl = null) {
  const starts = name === "buildNow" || name === "recheck";
  if (starts && isStarting(piece.id)) return;
  if (name === "buildNow" && !confirm(`Build "${piece.title ?? piece.id}" again now? It runs on this PC and takes a while.`)) return;
  if (starts) state.starting = { id: piece.id, until: Date.now() + BUILD_START_MS, what: name };
  const out = await queueAction(name, piece, args, busyEl);
  if (starts) {
    // A queued one isn't starting: it shows Queued #n and is watched as queued.
    if (out?.ok && !out.queued) watchBuild();
    else if (state.starting?.id === piece.id) {
      state.starting = null;
      draw();
    }
    return;
  }
  const shown = route();
  if (out?.ok && (name === "approve" || name === "redo") && shown.screen === "review" && shown.id === piece.id) location.hash = "#/review";
}

// The player's actions. Post now posts the next floating item as the scheduler would,
// and any other Ready piece through postItem; Drop asks first.
function pieceAction(name, piece, args) {
  if (pending.has(piece.id)) return;
  if (name === "approve" || name === "redo") return creationAction(name, piece, args);
  if (name === "postNow") {
    const floating = nextFloating(state.status?.queue);
    if (floating?.id === piece.id) return postNow({ id: piece.id, title: piece.title, platform: floating.platform });
    return postItem(piece);
  }
  if (name === "drop") {
    if (!confirm(`Drop ${piece.title ?? piece.id}? It won't be posted.`)) return;
    return queueAction("drop", piece, { platform: "instagram" });
  }
  return queueAction(name, piece, args);
}

async function runTodo(todo) {
  const { action, id, platform } = todo.action;
  if (action !== "retry" || state.busy) return;
  if (!confirm(`Retry ${id} on ${PLATFORMS[platform] ?? platform} now?`)) return;
  report(await act({ action: "retry", id, platform }, state.campaign));
  return refresh();
}

function pieceById(id) {
  return state.library?.pieces.find((p) => p.id === id) ?? null;
}

function play(piece) {
  const { status } = state;
  openPlayer(piece, { canAct: Boolean(status?.canAct), today: status?.today, onAction: pieceAction });
}

// The Pipeline's idea controls. Add and Edit open the form, which shows a refusal under its
// fields; Remove asks first. A saved or removed idea reloads the screens.
async function ideaAction(name, args, busyEl = null) {
  const key = `idea:${args.id ?? args.entry?.id ?? "new"}`;
  if (pending.has(key)) return;
  const campaign = state.campaign;
  pending.add(key);
  const done = markBusy(busyEl);
  let out;
  try {
    out = await act({ action: name, ...args }, campaign);
  } finally {
    pending.delete(key);
    done();
  }
  if (out.ok) toast("ok", out.message ?? "Done.");
  else if (name === "removeIdea") toast("err", out.error ?? "Something went wrong.");
  await refresh();
  return out;
}

const ideas = {
  add: () => openIdea(null),
  edit: (card) => openIdea(card),
  remove: (card, el) => {
    if (confirm(`Remove "${card.title ?? card.id}" from the build list?`)) return ideaAction("removeIdea", { id: card.id }, el);
  },
};

function openIdea(card) {
  const data = state.builds?.data;
  openIdeaForm({
    idea: card,
    formats: data?.formats ?? [],
    types: data?.types ?? [],
    today: state.status?.today,
    onSave: (entry) => ideaAction("saveIdea", { entry }),
  });
}

// The Connections screen's actions (setInstagramToken, setTelegram, testTelegram,
// setSecret), one of each at a time. The toast carries the server's message or error (a
// token saved whose sync failed stays up until dismissed), and the status reloads.
// Returns the server's result.
async function connectionAction(name, args = {}, busyEl = null) {
  const key = `connections:${name}`;
  if (pending.has(key)) return { ok: false, error: "Still working on the last one." };
  const campaign = state.campaign;
  pending.add(key);
  const done = markBusy(busyEl);
  let out;
  try {
    out = await act({ action: name, ...args }, campaign);
  } finally {
    pending.delete(key);
    done();
  }
  if (out.ok) toast(out.synced === false ? "err" : "ok", out.message ?? "Saved.");
  else toast("err", out.error ?? "Something went wrong.");
  await refresh();
  return out;
}

// The Campaigns screen's actions: setPaused and saveSettings for campaign `id`, and
// createCampaign (id null), one of each per campaign at a time. The campaign list reloads
// after, so the switcher shows a new campaign or name at once, then the status.
async function campaignAction(name, args, id, busyEl = null) {
  const key = `campaigns:${name}:${id ?? "new"}`;
  if (pending.has(key)) return { ok: false, error: "Still working on the last one." };
  pending.add(key);
  const done = markBusy(busyEl);
  let out;
  try {
    out = await act({ action: name, ...args }, id ?? state.campaign);
  } finally {
    pending.delete(key);
    done();
  }
  if (out.ok) toast("ok", out.message ?? "Saved.");
  else toast("err", out.error ?? "Something went wrong.");
  await loadCampaigns();
  await refresh();
  return out;
}

// What the screens move with: a calendar drop pins, a pipeline drag or Up/Down reorders,
// and the Needs card holds. `el` shows busy while the action runs.
const moves = {
  pin: (piece, date, el) => queueAction("pin", piece, { date }, el),
  reorder: (piece, before, el) => queueAction("reorder", piece, { before }, el),
  hold: (piece, el) => queueAction("hold", piece, {}, el),
};

// --- Drawing -----------------------------------------------------------------------

function campaignName() {
  return state.campaigns.find((c) => c.id === state.campaign)?.name ?? state.campaign ?? "Pipeline";
}

// The campaign shown when the address names none or names one that has gone: the first
// in folder order, as /api/campaigns lists them; null before the list loads.
function firstCampaign() {
  return state.campaigns[0]?.id ?? null;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function switcher() {
  const name = campaignName();
  const mark = h("span", { className: "campaign-mark", "aria-hidden": "true" }, initials(name));
  if (state.campaigns.length <= 1) return h("div", { className: "campaign" }, mark, h("span", { className: "campaign-name" }, name));
  const select = h(
    "select",
    { className: "campaign-select", "aria-label": "Campaign" },
    state.campaigns.map((c) =>
      h("option", { value: c.id, selected: c.id === state.campaign }, `${c.name}${c.paused ? " (paused)" : ""}${c.health === "ok" ? "" : " · needs a look"}`),
    ),
  );
  select.addEventListener("change", () => switchTo(select.value));
  return h("div", { className: "campaign" }, mark, select);
}

function alertPill() {
  const first = state.status?.todos?.[0];
  if (!state.status) return null;
  if (!first) return h("span", { className: "alert alert-ok" }, h("span", { className: "dot sev-ok", "aria-hidden": "true" }), "All good");
  return h(
    "a",
    { className: `alert alert-${first.severity}`, href: "#/needs", title: first.title },
    h("span", { className: `dot sev-${first.severity}`, "aria-hidden": "true" }),
    h("span", { className: "alert-text" }, first.title),
  );
}

// The signed-in login, or "View only". On a phone the login shrinks to its initial
// (styles.css), still read out by screen readers.
function who(login) {
  if (!login) return h("span", { className: "who" }, "View only");
  return h(
    "span",
    { className: "who who-signed-in", title: `Signed in as ${login}` },
    h("span", { className: "who-initial", "aria-hidden": "true" }, login.charAt(0).toUpperCase()),
    h("span", { className: "who-login" }, login),
  );
}

function drawHeader() {
  const s = state.status;
  const day = s?.next ? dayLabel(s.next.date, s.today) : null;
  const next = day ? `Next post ${day === "Today" ? "today" : day}` : "Nothing queued";
  fill(
    $("top"),
    h("div", { className: "brand" }, h("span", { className: "brand-mark" }, icon([BRAND_ICON], { size: 16 })), h("span", { className: "brand-name" }, "Pipeline")),
    switcher(),
    h("div", { className: "spacer" }),
    alertPill(),
    s ? h("span", { className: "next-post" }, h("span", { className: "dot sev-ok", "aria-hidden": "true" }), next) : null,
    s ? who(s.login) : null,
  );
}

function counts() {
  const s = state.status;
  return { needs: s?.todos?.length ?? 0, review: s?.creation?.awaiting?.length ?? 0 };
}

function drawNav(current) {
  const n = counts();
  fill(
    $("side"),
    SCREENS.map((s) =>
      h(
        "a",
        { className: "nav-item", href: `#/${s.id}`, "aria-current": s.id === current ? "page" : undefined },
        h("span", {}, s.label),
        n[s.id] ? h("span", { className: s.id === "needs" ? "count count-accent" : "count" }, String(n[s.id])) : null,
      ),
    ),
    h("p", { className: "nav-note" }, "Private to your tailnet."),
  );
  const tab = ON_TABS.has(current) ? current : "more";
  fill(
    $("tabs"),
    TABS.map((t) =>
      h(
        "a",
        { className: "tab", href: `#/${t.id}`, "aria-current": t.id === tab ? "page" : undefined },
        h("span", { className: "tab-icon" }, icon(ICONS[t.id], { size: 22 }), t.id === "needs" && n.needs ? h("span", { className: "tab-badge" }, String(n.needs)) : null),
        h("span", {}, t.label),
      ),
    ),
  );
}

function moreScreen() {
  const n = counts();
  const notes = { needs: n.needs ? `${n.needs} to do` : "", review: n.review ? `${n.review} waiting` : "" };
  return h(
    "div",
    { className: "screen" },
    h("div", { className: "screen-head" }, h("h1", {}, "More")),
    h(
      "ul",
      { className: "card more-list" },
      SCREENS.filter((s) => !ON_TABS.has(s.id)).map((s) =>
        h("li", {}, h("a", { className: "more-item", href: `#/${s.id}` }, h("span", {}, s.label), h("span", { className: "muted" }, notes[s.id] ?? ""))),
      ),
    ),
    h("p", { className: "muted small" }, "Opens only on devices signed in to your Tailscale network."),
  );
}

function screenFor({ screen, id }) {
  const s = state.status;
  if (screen === "more") return moreScreen();
  if (!s) {
    return state.error
      ? h("div", { className: "screen" }, h("p", { className: "banner banner-err" }, `Can't load the status: ${state.error}`))
      : h("p", { className: "muted" }, "Loading…");
  }
  if (screen === "needs") return needsScreen({ status: s, campaignName: campaignName(), pieceById, play, postNow, runTodo, hold: moves.hold });
  if (screen === "health") return healthScreen({ status: s, health: state.health });
  if (screen === "connections") return connectionsScreen({ status: s, canAct: Boolean(s.canAct), act: connectionAction, confirm: (text) => confirm(text) });
  if (screen === "calendar") return calendarScreen({ status: s, calendar: state.calendar, pieceById, play, showWeeks, pin: moves.pin });
  if (screen === "library") return libraryScreen({ status: s, library: state.library, libraryError: state.libraryError, play, retry: refresh });
  if (screen === "pipeline") {
    return pipelineScreen({
      status: s,
      library: state.library,
      libraryError: state.libraryError,
      builds: state.builds,
      play,
      reorder: moves.reorder,
      addIdea: ideas.add,
      editIdea: ideas.edit,
      removeIdea: ideas.remove,
      unqueue: (card, el) => creationAction("unqueue", { id: card.id, title: card.title }, {}, el),
    });
  }
  if (screen === "review") {
    return reviewScreen({
      id,
      review: state.review?.id === id ? state.review : null,
      list: state.reviews,
      build: state.build?.id === id ? state.build.data : null,
      starting: id && isStarting(id) ? state.starting.what : null,
      canAct: Boolean(s.canAct),
      today: s.today,
      play,
      act: creationAction,
    });
  }
  return campaignsScreen({ campaigns: state.campaigns, today: s.today, canAct: Boolean(s.canAct), act: campaignAction, confirm: (text) => confirm(text) });
}

// Redraws everything, unless a refresh brought nothing new (so focus stays put).
function draw({ force = false } = {}) {
  const r = route();
  const from = JSON.stringify([
    r,
    state.campaign,
    state.campaigns,
    state.error,
    state.library,
    state.libraryError,
    state.calendar,
    state.builds,
    state.health,
    state.reviews,
    state.review,
    state.build,
    state.starting,
    { ...state.status, generatedAt: null },
  ]);
  if (!force && from === state.drawn) return;
  state.drawn = from;
  drawHeader();
  drawNav(r.screen);
  fill($("main"), state.error && state.status ? h("p", { className: "banner banner-err" }, `Can't refresh: ${state.error}`) : null, screenFor(r));
  document.title = `${r.screen === "more" ? "More" : LABELS[r.screen]} · ${campaignName()}`;
}

// --- Loading -----------------------------------------------------------------------

async function loadCampaigns() {
  try {
    state.campaigns = await getCampaigns();
  } catch {
    // Keep the last list; the status still loads.
  }
}

async function refresh() {
  const asked = state.campaign;
  try {
    // A library that fails to load leaves the status alone: its error shows on Library,
    // and the other screens show ids for titles until it loads.
    const [status, library] = await Promise.all([
      getStatus(asked),
      getLibrary(asked).then(
        (data) => ({ data, error: null }),
        (err) => ({ data: null, error: err.message }),
      ),
    ]);
    if (state.campaign !== asked) return; // Switched while it loaded.
    state.status = status;
    if (library.data) state.library = library.data;
    state.libraryError = library.error;
    state.error = null;
  } catch (err) {
    if (state.campaign !== asked) return;
    if (err.status === 404 && asked && firstCampaign() !== asked) return switchTo(firstCampaign());
    state.error = err.message;
  }
  draw();
  return loadScreen();
}

// The calendar's, the pipeline's or the review's own data, when one of them is shown (for
// Campaigns, the campaign list). A result that comes back after the campaign, the screen,
// the piece or the weeks changed is dropped.
async function loadScreen() {
  watchBuild();
  watchQueue();
  const { screen, id } = route();
  const asked = state.campaign;
  const from = state.calendarFrom;
  if (screen === "campaigns") {
    await loadCampaigns();
    return draw();
  }
  let load;
  if (screen === "calendar") load = () => getCalendar(asked, from);
  else if (screen === "pipeline") load = () => getPipeline(asked);
  else if (screen === "health") load = getHealth;
  else if (screen === "review") load = id ? () => getReview(asked, id) : () => getReviews(asked);
  else return;
  let result;
  try {
    result = { data: await load(), error: null };
  } catch (err) {
    result = { data: null, error: err.message };
  }
  const now = route();
  if (state.campaign !== asked || now.screen !== screen || now.id !== id || state.calendarFrom !== from) return;
  if (screen === "calendar") state.calendar = result;
  else if (screen === "pipeline") state.builds = result;
  else if (screen === "health") state.health = result;
  else if (id) state.review = { id, ...result };
  else state.reviews = result;
  draw();
  watchBuild();
  watchQueue();
}

let buildTimer = null;
let watched = null; // "<campaign>/<id>/<every ms>" while its build is polled

// Polls the build progress of the piece shown on Review every 5 s while it builds, or
// while a Build now or Recheck of it is starting, and every 15 s while it waits in the
// build queue; stops when its status changes or the screen is left. Returns true while
// it watches.
function watchBuild() {
  const { screen, id } = route();
  const shown = screen === "review" && id && state.review?.id === id ? state.review.data : null;
  if (state.starting && Date.now() > state.starting.until) state.starting = null;
  const busy = Boolean(shown) && (shown.status === "building" || state.starting?.id === id);
  const watching = busy || Boolean(shown?.queued);
  const every = busy ? BUILD_POLL_MS : QUEUE_POLL_MS;
  const key = watching ? `${state.campaign}/${id}/${every}` : null;
  if (key === watched) return watching;
  clearInterval(buildTimer);
  buildTimer = null;
  watched = key;
  if (!watching) {
    state.build = null;
    return false;
  }
  const campaign = state.campaign;
  buildTimer = setInterval(() => pollBuild(campaign, id), every);
  pollBuild(campaign, id);
  return true;
}

async function pollBuild(campaign, id) {
  let data;
  try {
    data = await getBuild(campaign, id);
  } catch {
    return; // The next poll tries again.
  }
  if (!watchBuild() || !watched.startsWith(`${campaign}/${id}/`)) return;
  state.build = { id, data };
  // A Build now is under way once the piece shows building; either one is done starting
  // once its state moved on since the first poll (a build that failed fast never shows
  // building here, and a recheck never does).
  const start = state.starting?.id === id ? state.starting : null;
  if (start) {
    if (start.since === undefined) start.since = data.since;
    else if (data.since !== start.since) state.starting = null;
    if (data.status === "building") state.starting = null;
  }
  // The status or its place in the queue moved on: reload the piece; watchBuild then
  // decides whether to go on.
  const place = (queued) => queued?.position ?? null;
  if (data.status !== state.review.data.status || place(data.queued) !== place(state.review.data.queued) || (start && !state.starting)) return refresh();
  draw();
}

let queueTimer = null;
let queueWatched = null; // "<campaign>/<screen>" while it is reloaded for a queued piece

// Reloads the Pipeline or the review list every 15 s while it shows a piece waiting in
// the build queue; stops when none waits or the screen is left.
function watchQueue() {
  const { screen, id } = route();
  let queued = false;
  if (screen === "pipeline") queued = (state.builds?.data?.queue?.length ?? 0) > 0;
  else if (screen === "review" && !id) queued = (state.reviews?.data ?? []).some((p) => p.queued);
  const key = queued ? `${state.campaign}/${screen}` : null;
  if (key === queueWatched) return;
  clearInterval(queueTimer);
  queueTimer = null;
  queueWatched = key;
  if (key) queueTimer = setInterval(() => loadScreen(), QUEUE_POLL_MS);
}

// Shows the calendar's weeks from `from` (null: the weeks holding today).
function showWeeks(from) {
  state.calendarFrom = from;
  state.calendar = null;
  draw();
  return loadScreen();
}

function switchTo(id) {
  closePlayer();
  state.campaign = id;
  state.status = null;
  state.library = null;
  state.libraryError = null;
  state.calendarFrom = null;
  state.calendar = null;
  state.builds = null;
  state.reviews = null;
  state.review = null;
  state.build = null;
  state.starting = null;
  state.error = null;
  const query = id ? `?campaign=${encodeURIComponent(id)}` : "";
  history.replaceState(null, "", `/${query}${location.hash}`);
  draw();
  return refresh();
}

window.addEventListener("hashchange", () => {
  closePlayer();
  draw({ force: true });
  window.scrollTo(0, 0);
  $("main").focus();
  loadScreen();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

if (!location.hash) history.replaceState(null, "", `${location.pathname}${location.search}#/needs`);
draw();
// With no campaign in the address, the status waits for the campaign list, so the first
// one is asked for by name.
const listed = loadCampaigns();
if (state.campaign) {
  listed.then(draw);
  refresh();
} else {
  listed.then(() => {
    state.campaign ??= firstCampaign();
    draw();
    return refresh();
  });
}
setInterval(async () => {
  if (state.campaigns.length > 1) await loadCampaigns();
  refresh();
}, REFRESH_MS);
