import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addQuery, dayLabel, longDate, typeLabel } from "../ui/lib/format.js";
import { isFloatingInstagram, nextFloating } from "../ui/lib/queue.js";

const UI = fileURLToPath(new URL("../ui/", import.meta.url));

// Every file under dashboard/ui, as paths relative to it with forward slashes.
function uiFiles(dir = UI) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? uiFiles(full) : [path.relative(UI, full).split(path.sep).join("/")];
  });
}

test("ui: no file under dashboard/ui contains innerHTML, outerHTML, insertAdjacentHTML, document.write or a style= attribute in HTML", () => {
  const files = uiFiles();
  assert.ok(files.includes("index.html") && files.includes("app.js"), "the UI is there");
  for (const rel of files) {
    const text = fs.readFileSync(path.join(UI, rel), "utf8");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      assert.ok(!text.includes(banned), `${rel} uses ${banned}`);
    }
    assert.doesNotMatch(text, /setAttribute\(\s*["']style["']/, `${rel} sets a style attribute`);
    if (rel.endsWith(".html")) {
      assert.doesNotMatch(text, /\sstyle\s*=/i, `${rel} has a style= attribute`);
      assert.doesNotMatch(text, /<style/i, `${rel} has an inline <style>`);
      assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>/i, `${rel} has an inline <script>`);
      assert.doesNotMatch(text, /\son[a-z]+\s*=/i, `${rel} has an inline event handler`);
      assert.doesNotMatch(text, /https?:\/\//i, `${rel} loads something external`);
    }
  }
});

test("ui: every dashboard/ui/**/*.js parses as a module", () => {
  const scripts = uiFiles().filter((f) => f.endsWith(".js"));
  assert.ok(scripts.length >= 8);
  for (const rel of scripts) {
    // Throws, failing the test, when a file doesn't parse.
    execFileSync(process.execPath, ["--check", path.join(UI, rel)], { stdio: "pipe" });
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(UI, "package.json"), "utf8")), { type: "module" });
});

test("format: dayLabel(\"2026-10-25\", today \"2026-10-25\") is \"Today\"; \"2026-10-26\" is \"Mon 26 Oct\"", () => {
  assert.equal(dayLabel("2026-10-25", "2026-10-25"), "Today");
  assert.equal(dayLabel("2026-10-26", "2026-10-25"), "Mon 26 Oct");
  assert.equal(dayLabel("2026-11-01", "2026-10-25"), "Sun 1 Nov");
  assert.equal(dayLabel(null, "2026-10-25"), "No date");
  assert.equal(longDate("2026-10-25"), "Sunday 25 October");
});

test("format: addQuery keeps the URL's own query", () => {
  assert.equal(addQuery("/media/ep-01/clip.mp4", { variant: "preview" }), "/media/ep-01/clip.mp4?variant=preview");
  assert.equal(addQuery("/media/b1/clip.mp4?campaign=beta", { download: "1" }), "/media/b1/clip.mp4?campaign=beta&download=1");
  assert.equal(addQuery("/api/status", { campaign: "a b" }), "/api/status?campaign=a%20b");
});

test("format: typeLabel names a piece's type", () => {
  assert.equal(typeLabel("participation"), "Participation");
  assert.equal(typeLabel(null), "Piece");
});

test("queue: Post now's target is the next floating Instagram item, not a pinned one", () => {
  const queue = [
    { date: "2026-10-25", id: "special-nov1", platform: "instagram", why: "pinned" },
    { date: "2026-10-25", id: "ep-04", platform: "youtube", why: "queue" },
    { date: "2026-10-26", id: "ep-05", platform: "instagram", why: "queue" },
    { date: "2026-10-27", id: "ep-06", platform: "instagram", why: "queue" },
  ];
  assert.deepEqual(nextFloating(queue), queue[2]);
  assert.equal(nextFloating([queue[0]]), null);
  assert.equal(nextFloating([]), null);
  assert.equal(nextFloating(undefined), null);
  assert.equal(isFloatingInstagram(queue[0]), false);
  assert.equal(isFloatingInstagram(queue[1]), false);
  assert.equal(isFloatingInstagram(queue[2]), true);
  assert.equal(isFloatingInstagram(null), false);
});

// A tiny stand-in for the browser's document, enough for dom.js's h().
function fakeDocument() {
  const node = (props) => ({ childNodes: [], append(...c) { this.childNodes.push(...c); }, ...props });
  return {
    createTextNode: (data) => ({ nodeType: 3, data }),
    createElement: (tag) =>
      node({
        nodeType: 1,
        tagName: tag.toUpperCase(),
        attributes: {},
        listeners: {},
        setAttribute(k, v) { this.attributes[k] = String(v); },
        addEventListener(type, fn) { this.listeners[type] = fn; },
      }),
  };
}

test("dom: h sets text children as text nodes and never sets style or HTML", async () => {
  globalThis.document = fakeDocument();
  try {
    const { h } = await import("../ui/dom.js");
    const evil = "<img src=x onerror=alert(1)>";
    const click = () => {};
    const el = h("button", { className: "ghost", onClick: click, "aria-label": evil, type: "button" }, evil, 7, null, false);
    assert.equal(el.tagName, "BUTTON");
    assert.equal(el.className, "ghost");
    assert.equal(el.listeners.click, click);
    assert.equal(el.attributes["aria-label"], evil);
    assert.equal(el.attributes.type, "button");
    assert.deepEqual(el.childNodes, [{ nodeType: 3, data: evil }, { nodeType: 3, data: "7" }]);

    assert.throws(() => h("div", { style: "color: red" }), /style/);
    assert.throws(() => h("div", { innerHTML: evil }), /innerHTML/);
    assert.throws(() => h("a", { href: "javascript:alert(1)" }), /href/);
    assert.equal(h("a", { href: "https://www.instagram.com/reel/r1/" }).attributes.href, "https://www.instagram.com/reel/r1/");
    assert.equal(h("img", { src: "/media/ep-01/c.png" }).attributes.src, "/media/ep-01/c.png");
  } finally {
    delete globalThis.document;
  }
});

// fakeDocument plus the SVG elements icon() makes.
function fakeDocumentWithSvg() {
  const doc = fakeDocument();
  doc.createElementNS = (ns, tag) => doc.createElement(tag);
  return doc;
}

// Every node under `node`, depth first.
function nodes(node, out = []) {
  out.push(node);
  for (const child of node.childNodes ?? []) nodes(child, out);
  return out;
}

const textOf = (node) => nodes(node).filter((n) => n.nodeType === 3).map((n) => n.data).join("");
const byClass = (node, name) => nodes(node).filter((n) => n.nodeType === 1 && ` ${n.className} `.includes(` ${name} `));
const buttonLabels = (node) => nodes(node).filter((n) => n.tagName === "BUTTON" || (n.tagName === "A" && ` ${n.className} `.includes(" btn "))).map(textOf);

const EVIL = "<img src=x onerror=alert(1)>";

// A Review (/api/review) whose every reviewer and client text is markup.
function evilReview(over = {}) {
  return {
    id: "p1",
    title: EVIL,
    type: "teach",
    status: "awaiting-approval",
    reason: EVIL,
    note: EVIL,
    attempts: 0,
    canBuild: false,
    checks: { caption_py: { verdict: EVIL }, detect_caption: { verdict: "PASS", human_score: 81.7 }, detect_onscreen: null, hook_caption: null, hook_onscreen: { verdict: "WEAK", score: 30 } },
    review: { verdict: "FIX", scores: { director: 70, copy_art_ui: EVIL }, skills: null, must_fix: [EVIL, "Second item."], nice_to_have: [EVIL], summary: EVIL },
    caption: EVIL,
    youtubeTitle: EVIL,
    video: "/media/p1/clip.mp4",
    cover: "/media/p1/clip-cover.png",
    ...over,
  };
}

const reviewCtx = (review, over = {}) => ({ id: review.id, review: { data: review, error: null }, build: null, canAct: true, today: "2026-10-25", play() {}, act() {}, ...over });

test("ui: the review screen renders a must-fix item \"<img src=x onerror=alert(1)>\" as text", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { reviewScreen } = await import("../ui/screens/review.js");
    const screen = reviewScreen(reviewCtx(evilReview(), { build: { status: "building", elapsedSeconds: 75, lines: [EVIL] } }));

    const [mustFix] = byClass(screen, "review-mustfix");
    assert.ok(mustFix, "the must-fix list is shown");
    const items = mustFix.childNodes.filter((n) => n.tagName === "LI");
    assert.deepEqual(items.map((li) => li.childNodes), [[{ nodeType: 3, data: EVIL }], [{ nodeType: 3, data: "Second item." }]]);

    // Everywhere else it shows, it's a text node too: title, summary, scores, checks,
    // caption, YouTube title, nice-to-have and the build log.
    const texts = nodes(screen).filter((n) => n.nodeType === 3 && n.data.includes(EVIL));
    assert.ok(texts.length >= 8, `${texts.length} text nodes carry it`);
    // The only image is the cover, from the media path.
    assert.deepEqual(nodes(screen).filter((n) => n.tagName === "IMG").map((n) => n.attributes.src), ["/media/p1/clip-cover.png"]);
    for (const n of nodes(screen)) {
      if (n.nodeType !== 1) continue;
      for (const [k, v] of Object.entries(n.attributes)) assert.ok(!/^on/i.test(k), `${n.tagName} has ${k}=${v}`);
    }
  } finally {
    delete globalThis.document;
  }
});

// The cards on a piece's page, in order, by their heading.
const cardTitles = (screen) => byClass(screen, "review-card").map((card) => textOf(card.childNodes[0]));
const REASON = "session exited 1: render failed";

test("ui: a failed piece shows why it stopped first, as text, and its earlier review and checks as Last review and Last checks", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { reviewScreen } = await import("../ui/screens/review.js");
    // Attempt 1 was reviewed FIX; attempt 2 stopped before its review, for another reason.
    const screen = reviewScreen(reviewCtx(evilReview({ status: "failed", attempts: 2, canBuild: false, reason: `${REASON} ${EVIL}`, note: null })));
    const [why] = byClass(screen, "review-why");
    assert.ok(why, "the Why it stopped card is shown");
    assert.deepEqual(why.childNodes[1].childNodes, [{ nodeType: 3, data: `${REASON} ${EVIL}` }], "the reason, as one text node");
    assert.deepEqual(cardTitles(screen), ["Why it stopped", "Last checks", "Last review", "Caption"]);
    assert.match(textOf(byClass(screen, "review-pills")[0]), /Last review: FIX/);
    assert.ok(nodes(byClass(screen, "review-verdict")[0]).includes(byClass(screen, "review-mustfix")[0]), "the must-fix list sits in the Last review card");

    // Back for a redo: why first, then the owner's note.
    const redo = reviewScreen(reviewCtx(evilReview({ status: "redo", reason: null, note: "Slower ending." })));
    assert.deepEqual(cardTitles(redo).slice(0, 2), ["Why it stopped", "Your note"]);

    // Awaiting approval: the review is this attempt's.
    assert.deepEqual(cardTitles(reviewScreen(reviewCtx(evilReview({ note: null })))), ["Your /ig skill checks", "Reviewer", "Caption"]);
    assert.equal(byClass(reviewScreen(reviewCtx(evilReview())), "review-why").length, 0);
  } finally {
    delete globalThis.document;
  }
});

test("ui: a failed piece with no saved review shows its reason once, under Why it stopped; an awaiting one without a review shows Last result", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { reviewScreen } = await import("../ui/screens/review.js");
    const failed = reviewScreen(reviewCtx(evilReview({ status: "failed", attempts: 1, canBuild: true, review: null, checks: null, note: null })));
    assert.deepEqual(cardTitles(failed), ["Why it stopped", "Last checks", "Caption"]);
    assert.equal(byClass(failed, "review-last").length, 0);
    assert.equal(byClass(failed, "review-mustfix").length, 0);

    const awaiting = reviewScreen(reviewCtx(evilReview({ review: null, note: null })));
    const [last] = byClass(awaiting, "review-last");
    assert.match(textOf(last), /^Last result/);
    assert.ok(last.childNodes.some((n) => n.nodeType === 1 && n.childNodes.length === 1 && n.childNodes[0].data === EVIL), "the reason, as text");
  } finally {
    delete globalThis.document;
  }
});

test("ui: Build again now and Recheck are disabled while a build or recheck of the piece is starting", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { reviewScreen } = await import("../ui/screens/review.js");
    const disabled = (over, ctx) =>
      nodes(byClass(reviewScreen(reviewCtx(evilReview(over), ctx)), "review-actions")[0])
        .filter((n) => n.tagName === "BUTTON" || n.tagName === "A")
        .map((b) => `${textOf(b)}${b.attributes?.disabled === "" ? " (disabled)" : ""}`);
    const failed = { status: "failed", attempts: 1, canBuild: true };
    assert.deepEqual(disabled(failed), ["Build again now", "Recheck", "Keep parked"]);
    assert.deepEqual(disabled(failed, { starting: "buildNow" }), ["Build again now (disabled)", "Recheck (disabled)", "Keep parked"]);
    assert.deepEqual(disabled(failed, { starting: "recheck" }), ["Build again now (disabled)", "Recheck (disabled)", "Keep parked"]);
    assert.deepEqual(disabled({ status: "redo", canBuild: true }, { starting: "buildNow" }), ["Build again now (disabled)", "Keep parked"]);
    // While it builds there is nothing to start.
    assert.equal(byClass(reviewScreen(reviewCtx(evilReview({ status: "building" }))), "review-actions").length, 0);
    // The progress card says what is starting.
    const head = (starting) => textOf(byClass(reviewScreen(reviewCtx(evilReview(failed), { starting })), "review-progress")[0].childNodes[0]);
    assert.equal(head("buildNow"), "Starting the build…");
    assert.equal(head("recheck"), "Rechecking…");
  } finally {
    delete globalThis.document;
  }
});

test("ui: the review actions follow the piece's status, and only when canAct", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { reviewScreen } = await import("../ui/screens/review.js");
    const labels = (over, ctx) => buttonLabels(byClass(reviewScreen(reviewCtx(evilReview(over), ctx)), "review-actions")[0] ?? { childNodes: [] });
    assert.deepEqual(labels({}), ["Approve", "Redo with a note"]);
    assert.deepEqual(labels({ status: "failed", attempts: 1, canBuild: true }), ["Build again now", "Recheck", "Keep parked"]);
    assert.deepEqual(labels({ status: "failed", attempts: 1, canBuild: true, video: null }), ["Build again now", "Keep parked"]);
    // Parked after two failed builds: the nightly run won't build it until it has a note.
    assert.deepEqual(labels({ status: "failed", attempts: 2, canBuild: false }), ["Redo with a note", "Recheck", "Keep parked"]);
    assert.deepEqual(labels({ status: "redo", canBuild: true }), ["Build again now", "Keep parked"]);
    assert.deepEqual(labels({ status: "building" }), []);
    assert.deepEqual(labels({}, { canAct: false }), []);
  } finally {
    delete globalThis.document;
  }
});

test("ui: a queued piece shows \"Queued #2\" and \"Remove from queue\" as text, and hides Build again", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { reviewScreen } = await import("../ui/screens/review.js");
    const { pipelineScreen } = await import("../ui/screens/pipeline.js");
    const queued = { queued: { position: 2 } };
    const sent = [];
    const ctx = { act: (name, piece) => sent.push([name, piece.id]) };
    const labels = (over, more = {}) => buttonLabels(byClass(reviewScreen(reviewCtx(evilReview(over), { ...ctx, ...more })), "review-actions")[0] ?? { childNodes: [] });

    const failed = reviewScreen(reviewCtx(evilReview({ status: "failed", attempts: 1, canBuild: true, ...queued }), ctx));
    const pills = byClass(failed, "review-pills")[0];
    assert.ok(nodes(pills).some((n) => n.nodeType === 3 && n.data === "Queued #2"), "the pill is a text node");
    assert.deepEqual(labels({ status: "failed", attempts: 1, canBuild: true, ...queued }), ["Remove from queue", "Keep parked"]);
    assert.deepEqual(labels({ status: "redo", canBuild: true, ...queued }), ["Remove from queue", "Keep parked"]);
    // A parked piece queued for a recheck keeps its redo, loses its Recheck.
    assert.deepEqual(labels({ status: "failed", attempts: 2, canBuild: false, ...queued }), ["Redo with a note", "Remove from queue", "Keep parked"]);
    assert.deepEqual(labels({ ...queued }), ["Approve", "Redo with a note", "Remove from queue"]);
    // A never-built piece queued from the list: just the way out.
    assert.deepEqual(labels({ status: "todo", ...queued }), ["Remove from queue"]);
    assert.deepEqual(labels({ status: "failed", attempts: 1, canBuild: true, ...queued }, { canAct: false }), []);
    nodes(byClass(failed, "review-actions")[0]).find((n) => n.tagName === "BUTTON" && textOf(n) === "Remove from queue").listeners.click();
    assert.deepEqual(sent, [["unqueue", "p1"]]);
    // Not queued: as before.
    assert.deepEqual(labels({ status: "failed", attempts: 1, canBuild: true, queued: null }), ["Build again now", "Recheck", "Keep parked"]);

    // The list says it too.
    const list = reviewScreen({ id: null, list: { data: [{ id: "p1", title: EVIL, type: "teach", status: "failed", reason: EVIL, at: null, cover: null, queued: { position: 2 } }], error: null }, today: "2026-10-25" });
    assert.match(textOf(list), /Queued #2/);
    assert.ok(textOf(list).includes(EVIL));

    // Pipeline: the card of a queued piece, with Remove from queue when the owner can act.
    const pipeCtx = (canAct, calls = []) => ({
      ...ideasCtx(canAct),
      builds: {
        data: {
          builds: [
            { id: "f1", title: EVIL, type: "teach", status: "failed", reason: "checks failed", date: "2026-11-01" },
            { id: "f2", title: "Not queued", type: "teach", status: "redo", reason: "slower", date: "2026-11-02" },
          ],
          formats: ["episode"],
          types: ["teach"],
          queue: [{ id: "x0", kind: "build", position: 1 }, { id: "f1", kind: "build", position: 2 }],
        },
        error: null,
      },
      unqueue: (c) => calls.push(c.id),
    });
    const calls = [];
    const owner = pipelineScreen(pipeCtx(true, calls));
    assert.equal(nodes(owner).filter((n) => n.nodeType === 3 && n.data === "Queued #2").length, 1);
    const remove = nodes(owner).filter((n) => n.tagName === "BUTTON" && textOf(n) === "Remove from queue");
    assert.equal(remove.length, 1);
    remove[0].listeners.click({ currentTarget: {} });
    assert.deepEqual(calls, ["f1"]);
    const viewer = pipelineScreen(pipeCtx(false));
    assert.match(textOf(viewer), /Queued #2/);
    assert.ok(!buttonLabels(viewer).includes("Remove from queue"));
  } finally {
    delete globalThis.document;
  }
});

test("ui: the redo note has a live counter, at most 500 characters, and an empty note can't be sent", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { redoForm } = await import("../ui/screens/review.js");
    const sent = [];
    const form = redoForm({ onSend: (note) => sent.push(note), onCancel() {} });
    const [area] = nodes(form).filter((n) => n.tagName === "TEXTAREA");
    const [counter] = byClass(form, "note-count");
    const [send] = nodes(form).filter((n) => n.tagName === "BUTTON" && textOf(n) === "Send for redo");
    assert.equal(area.attributes.maxlength, "500");
    assert.equal(textOf(counter), "0 / 500");
    assert.equal(send.attributes.disabled, "", "starts disabled");

    area.value = "   ";
    area.listeners.input();
    assert.equal(send.disabled, true);
    send.listeners.click();
    assert.deepEqual(sent, [], "a blank note isn't sent");

    area.value = " Fix it ";
    area.listeners.input();
    assert.equal(counter.textContent, "8 / 500");
    assert.equal(send.disabled, false);
    send.listeners.click();
    assert.deepEqual(sent, ["Fix it"]);
  } finally {
    delete globalThis.document;
  }
});

// A pipeline with one idea, one idea being built and the canAct flag as given.
function ideasCtx(canAct, calls = []) {
  const builds = [
    { id: "i1", title: EVIL, type: "teach", status: "todo", reason: null, date: "2026-11-01", idea: { premise: EVIL, format: "episode", targetDate: "2026-11-01" } },
    { id: "b1", title: "Building", type: null, status: "building", reason: null, date: null },
  ];
  return {
    status: { today: "2026-10-25", canAct },
    library: { pieces: [], counts: {} },
    builds: { data: { builds, formats: ["episode"], types: ["teach"] }, error: null },
    play() {},
    reorder() {},
    addIdea: () => calls.push(["add"]),
    editIdea: (c) => calls.push(["edit", c.id]),
    removeIdea: (c) => calls.push(["remove", c.id]),
  };
}

test("ui: Pipeline shows + Idea and Edit/Remove on Ideas cards only when the owner can act; titles stay text", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { pipelineScreen } = await import("../ui/screens/pipeline.js");
    const calls = [];
    const owner = pipelineScreen(ideasCtx(true, calls));
    const labels = buttonLabels(owner);
    assert.ok(labels.includes("+ Idea"));
    assert.equal(labels.filter((l) => l === "Edit").length, 1, "only the todo idea, not the one being built");
    assert.equal(labels.filter((l) => l === "Remove").length, 1);
    assert.equal(textOf(owner).includes(EVIL), true);
    assert.equal(nodes(owner).some((n) => n.tagName === "IMG"), false);
    const click = (label) => nodes(owner).find((n) => n.tagName === "BUTTON" && textOf(n) === label).listeners.click({ currentTarget: {} });
    click("+ Idea");
    click("Edit");
    click("Remove");
    assert.deepEqual(calls, [["add"], ["edit", "i1"], ["remove", "i1"]]);

    const viewer = buttonLabels(pipelineScreen(ideasCtx(false)));
    assert.deepEqual(viewer.filter((l) => ["+ Idea", "Edit", "Remove"].includes(l)), []);
  } finally {
    delete globalThis.document;
  }
});

test("pipeline: renders while the build list and the library are still loading (no throw; counts show \"…\")", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { pipelineScreen } = await import("../ui/screens/pipeline.js");
    const screen = pipelineScreen({ ...ideasCtx(true), builds: null, library: null });
    const counts = byClass(screen, "pipe-head").map((n) => textOf(byClass(n, "mono")[0]));
    assert.deepEqual(counts.slice(0, 2), ["…", "…"]);
  } finally {
    delete globalThis.document;
  }
});

test("pipeline: renders with the build list loaded and the library loading", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { pipelineScreen } = await import("../ui/screens/pipeline.js");
    const screen = pipelineScreen({ ...ideasCtx(true), library: null });
    const counts = byClass(screen, "pipe-head").map((n) => textOf(byClass(n, "mono")[0]));
    assert.deepEqual(counts.slice(0, 2), ["1", "1"]);
  } finally {
    delete globalThis.document;
  }
});

// fakeDocumentWithSvg plus what the idea form touches: body, focus and the document's listeners.
function formDocument() {
  const doc = fakeDocumentWithSvg();
  const make = doc.createElement;
  doc.createElement = (tag) => {
    const el = make(tag);
    const classes = new Set();
    el.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c) };
    el.removeAttribute = (k) => delete el.attributes[k];
    el.focus = () => {};
    el.remove = () => { el.removed = true; };
    return el;
  };
  doc.body = { childNodes: [], append(...c) { this.childNodes.push(...c); }, classList: { add() {}, remove() {} } };
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.contains = () => false;
  doc.getElementById = () => ({ focus() {} });
  doc.activeElement = null;
  return doc;
}

test("ui: Health shows tasks, loops, clock, disk and console actions as text, a log line included", async () => {
  globalThis.document = fakeDocumentWithSvg();
  try {
    const { healthScreen } = await import("../ui/screens/health.js");
    const data = {
      tasks: [
        { name: "Pipeline Publisher", registered: true, lastRun: "2026-10-25T18:15:00.000Z", lastResult: 0, nextRun: "2026-10-25T19:00:00.000Z", status: "Ready" },
        { name: "Pipeline Telegram", registered: false, lastRun: null, lastResult: null, nextRun: null, status: null },
        { name: "Pipeline Creation", registered: true, lastRun: null, lastResult: 1, nextRun: null, status: "Ready" },
        { name: "Pipeline Dashboard", registered: null, lastRun: null, lastResult: null, nextRun: null, status: null },
      ],
      loops: [{ campaign: "acme", publish: { at: "2026-10-25T18:15:00.000Z", level: "ERROR", message: "publish tick crashed", detail: `{"error":"${EVIL}"}` }, create: null, telegram: null }],
      tokens: [{ campaign: "acme", instagramAgeDays: 52, warn: true }],
      clock: { skewSeconds: -42420, checkedAt: "2026-10-25T18:20:00.000Z" },
      disk: { freeGb: 3.5 },
      actions: [{ campaign: "acme", at: "2026-10-25T18:00:00.000Z", level: "INFO", message: "dashboard hold", detail: `{"id":"${EVIL}"}` }],
    };
    const status = { today: "2026-10-25", health: { readyCount: 3, rhythm: "daily", tokenAgeDays: { youtube: null } }, lastRun: null };
    const view = healthScreen({ status, health: { data, error: null } });
    const all = textOf(view);
    assert.match(all, /Pipeline Publisher.*0.*Ready/s);
    assert.match(all, /Pipeline Telegram.*Missing/s);
    assert.match(all, /Pipeline Creation.*Failed/s);
    assert.match(all, /Pipeline Dashboard.*Unknown/s);
    assert.match(all, /acme · Posting.*publish tick crashed/s);
    assert.match(all, /No log line yet/);
    assert.match(all, /acme · Instagram token52 days old/);
    assert.match(all, /42420 s behind/);
    assert.match(all, /3\.5 GB free/);
    assert.match(all, /acme · hold/);
    assert.ok(all.includes(EVIL), "a log line is text");
    assert.equal(nodes(view).filter((n) => n.tagName === "IMG").length, 0);
    // Still loading, and a failed read, show no machine tables.
    assert.match(textOf(healthScreen({ status, health: null })), /Loading/);
    assert.match(textOf(healthScreen({ status, health: { data: null, error: "HTTP 500" } })), /Can't read the machine's health: HTTP 500/);
  } finally {
    delete globalThis.document;
  }
});

test("ui: the idea form labels every field, counts the premise to 1000, sends the fields and shows a refusal", async () => {
  globalThis.document = formDocument();
  try {
    const { openIdeaForm } = await import("../ui/screens/idea-form.js");
    const sent = [];
    let result = { ok: false, error: "a build is running for Acme Coffee; try again when it finishes" };
    const handle = openIdeaForm({
      idea: { id: "i1", title: "Old", type: "teach", idea: { premise: "Old premise", format: "episode", targetDate: "2026-11-01", notAfter: "2026-11-09" } },
      formats: ["episode", "greeting"],
      types: ["teach", "story"],
      today: "2026-10-25",
      onSave: async (entry) => {
        sent.push(entry);
        return result;
      },
    });
    const backdrop = document.body.childNodes[0];
    const controls = nodes(backdrop).filter((n) => ["INPUT", "SELECT", "TEXTAREA"].includes(n.tagName));
    const labelled = new Set(nodes(backdrop).filter((n) => n.tagName === "LABEL").map((n) => n.attributes.for));
    assert.equal(controls.length, 7);
    for (const c of controls) assert.ok(labelled.has(c.attributes.id), `${c.attributes.id} has a label`);

    const byId = (id) => controls.find((c) => c.attributes.id === id);
    const premise = byId("idea-premise");
    assert.equal(premise.attributes.maxlength, "1000");
    assert.equal(byId("idea-title").attributes.maxlength, "80");
    assert.equal(byId("idea-date").attributes.min, undefined, "an edit keeps its date, past or not");
    const [counter] = byClass(backdrop, "note-count");
    assert.equal(counter.textContent, "11 / 1000");
    premise.value = "x".repeat(250);
    premise.listeners.input();
    assert.equal(counter.textContent, "250 / 1000");

    const form = nodes(backdrop).find((n) => n.tagName === "FORM");
    const submit = () => form.listeners.submit({ preventDefault() {} });
    await submit();
    assert.deepEqual(sent[0], { id: "i1", title: "Old", premise: "x".repeat(250), format: "episode", type: "teach", targetDate: "2026-11-01", notAfter: "2026-11-09" });
    const [problem] = byClass(backdrop, "idea-error");
    assert.equal(problem.hidden, false);
    assert.equal(problem.textContent, result.error);
    assert.notEqual(backdrop.removed, true, "stays open on a refusal");

    byId("idea-title").value = "   ";
    await submit();
    assert.equal(sent.length, 1, "a blank title isn't sent");

    byId("idea-title").value = "New title";
    result = { ok: true };
    await submit();
    assert.equal(sent.length, 2);
    assert.equal(backdrop.removed, true, "closes on success");
    handle.close();

    // A new idea aims at today or later.
    openIdeaForm({ formats: ["episode"], types: ["teach"], today: "2026-10-25", onSave: async () => ({ ok: true }) });
    const fresh = nodes(document.body.childNodes.at(-1)).find((n) => n.attributes?.id === "idea-date");
    assert.equal(fresh.attributes.min, "2026-10-25");
  } finally {
    delete globalThis.document;
  }
});

// A status.connections with Instagram connected 3 days ago, an own bot, one approver
// and one stranger whose name is markup.
const CONNECTIONS_STATUS = {
  generatedAt: "2026-10-25T10:00:00.000Z",
  connections: {
    secrets: {
      IG_ACCESS_TOKEN: { set: true, updatedAt: "2026-10-22T09:00:00.000Z" },
      TELEGRAM_BOT_TOKEN: { set: true, updatedAt: "2026-10-25T08:00:00.000Z" },
      ANTHROPIC_API_KEY: { set: false, updatedAt: null },
    },
    instagram: { username: "acme.coffee", tokenAgeDays: 3 },
    youtube: { connected: false, channel: null },
    telegram: { approvers: ["4242"], ownBot: true, seenChats: [{ chatId: "-100555", name: EVIL, at: "2026-10-24T10:00:00.000Z" }] },
  },
};

test("ui: Connections shows each secret as set N days ago or not set, and no form without canAct", async () => {
  globalThis.document = formDocument();
  try {
    const { connectionsScreen, secretAge } = await import("../ui/screens/connections.js");
    assert.equal(secretAge({ set: true, updatedAt: "2026-10-22T09:00:00.000Z" }, "2026-10-25T10:00:00.000Z"), "set, 3 days ago");
    assert.equal(secretAge({ set: true, updatedAt: "2026-10-24T09:00:00.000Z" }, "2026-10-25T10:00:00.000Z"), "set, 1 day ago");
    assert.equal(secretAge({ set: true, updatedAt: "2026-10-25T08:00:00.000Z" }, "2026-10-25T10:00:00.000Z"), "set today");
    assert.equal(secretAge({ set: false, updatedAt: null }, "2026-10-25T10:00:00.000Z"), "not set");
    assert.equal(secretAge(undefined, "2026-10-25T10:00:00.000Z"), "not set");

    const view = connectionsScreen({ status: CONNECTIONS_STATUS, canAct: false });
    const all = textOf(view);
    assert.match(all, /Access token: set, 3 days ago/);
    assert.match(all, /Bot token: set today/);
    assert.match(all, /API key: not set/);
    assert.match(all, /Google keeps uploads private until your API project passes its audit\. Connect a channel with node publishing\/publish\.mjs auth youtube --campaign <id>\./);
    assert.ok(all.includes(EVIL), "a chat's name is shown as text");
    assert.equal(nodes(view).filter((n) => n.tagName === "INPUT" || n.tagName === "FORM").length, 0);
    assert.deepEqual(buttonLabels(view), []);
  } finally {
    delete globalThis.document;
  }
});

test("ui: Connections token fields are password, autocomplete off, never pre-filled, and cleared once sent", async () => {
  globalThis.document = formDocument();
  try {
    const { connectionsScreen } = await import("../ui/screens/connections.js");
    const sent = [];
    let result = { ok: false, error: "Instagram didn't accept that token: Invalid OAuth access token" };
    const view = connectionsScreen({
      status: CONNECTIONS_STATUS,
      canAct: true,
      act: async (name, args) => {
        sent.push([name, args]);
        return result;
      },
      confirm: () => true,
    });
    const inputs = nodes(view).filter((n) => n.tagName === "INPUT");
    const labelled = new Set(nodes(view).filter((n) => n.tagName === "LABEL").map((n) => n.attributes.for));
    for (const input of inputs) assert.ok(labelled.has(input.attributes.id), `${input.attributes.id} has a label`);
    const secretsIn = inputs.filter((n) => n.attributes.type === "password");
    assert.deepEqual(secretsIn.map((n) => n.attributes.id), ["conn-ig-token", "conn-tg-bot", "conn-api-key"]);
    for (const input of inputs) {
      assert.equal(input.attributes.autocomplete, "off");
      assert.equal(input.attributes.value, undefined, "never pre-filled");
      assert.equal(input.value, undefined, "never pre-filled");
    }

    const formOf = (id) => nodes(view).find((n) => n.tagName === "FORM" && nodes(n).some((c) => c.attributes?.id === id));
    const submit = (id) => formOf(id).listeners.submit({ preventDefault() {} });
    const ig = inputs.find((n) => n.attributes.id === "conn-ig-token");
    ig.value = "";
    await submit("conn-ig-token");
    assert.deepEqual(sent, [], "an empty token isn't sent");

    ig.value = "  IGAA-pasted  ";
    await submit("conn-ig-token");
    assert.deepEqual(sent, [["setInstagramToken", { token: "IGAA-pasted" }]]);
    assert.equal(ig.value, "", "cleared even when refused");
    const [problem] = byClass(formOf("conn-ig-token"), "conn-error");
    assert.equal(problem.textContent, result.error);
    assert.equal(problem.hidden, false);

    result = { ok: true, message: "Saved ANTHROPIC_API_KEY." };
    const key = inputs.find((n) => n.attributes.id === "conn-api-key");
    key.value = "sk-ant-key";
    await submit("conn-api-key");
    assert.deepEqual(sent.at(-1), ["setSecret", { name: "ANTHROPIC_API_KEY", value: "sk-ant-key" }]);
    assert.equal(key.value, "");

    const bot = inputs.find((n) => n.attributes.id === "conn-tg-bot");
    bot.value = "123:AA-bot";
    await submit("conn-tg-bot");
    assert.deepEqual(sent.at(-1), ["setTelegram", { botToken: "123:AA-bot" }]);
    assert.equal(bot.value, "");
  } finally {
    delete globalThis.document;
  }
});

test("ui: Telegram approvers: Add checks the chat id, Remove and Add as approver send the new list, Send test runs the test", async () => {
  globalThis.document = formDocument();
  try {
    const { connectionsScreen } = await import("../ui/screens/connections.js");
    const sent = [];
    const view = connectionsScreen({
      status: CONNECTIONS_STATUS,
      canAct: true,
      act: async (name, args) => {
        sent.push([name, args]);
        return { ok: true };
      },
      confirm: () => true,
    });
    const buttons = nodes(view).filter((n) => n.tagName === "BUTTON");
    const button = (label) => buttons.find((b) => b.attributes["aria-label"] === label || textOf(b) === label);

    const add = nodes(view).find((n) => n.attributes?.id === "conn-tg-approver");
    const form = nodes(view).find((n) => n.tagName === "FORM" && nodes(n).includes(add));
    for (const bad of ["12a", "4242", ""]) {
      add.value = bad;
      await form.listeners.submit({ preventDefault() {} });
    }
    assert.deepEqual(sent, [], "a bad or repeated chat id isn't sent");
    add.value = "-100777";
    await form.listeners.submit({ preventDefault() {} });

    button("Remove approver 4242").listeners.click({ currentTarget: null });
    button("Add -100555 as an approver").listeners.click({ currentTarget: null });
    button("Send test").listeners.click({ currentTarget: null });
    assert.deepEqual(sent, [
      ["setTelegram", { approvers: ["4242", "-100777"] }],
      ["setTelegram", { approvers: [] }],
      ["setTelegram", { approvers: ["4242", "-100555"] }],
      ["testTelegram", {}],
    ]);
  } finally {
    delete globalThis.document;
  }
});

const CAMPAIGN_SETTINGS = {
  name: "Acme Coffee",
  slot: "19:30",
  lateLimitMinutes: 120,
  bufferMin: 7,
  fallbackDays: ["Sun", "Mon", "Wed", "Fri"],
  "platforms.instagram.enabled": true,
  "platforms.youtube.enabled": false,
  approvers: ["4242"],
  "checks.captionPy": true,
  "checks.detect": true,
  "checks.detectOnScreen": false,
  "checks.hookscore": true,
  "checks.guardrails": true,
};
const CAMPAIGNS = [
  { id: "acme", name: "Acme Coffee", paused: false, health: "ok", next: "2026-10-26", settings: CAMPAIGN_SETTINGS },
  { id: "evil", name: EVIL, paused: true, health: "problems", next: null, settings: { ...CAMPAIGN_SETTINGS, name: EVIL } },
  { id: "broken", name: "broken", paused: false, health: "error" },
];

test("ui: Campaigns lists each campaign's health, paused state and next post as text, and no control without canAct", async () => {
  globalThis.document = formDocument();
  try {
    const { campaignsScreen } = await import("../ui/screens/campaigns.js");
    const view = campaignsScreen({ campaigns: CAMPAIGNS, today: "2026-10-25" });
    const all = textOf(view);
    assert.match(all, /Acme Coffee.*Healthy.*acme · Next post Mon 26 Oct/);
    assert.ok(all.includes(`${EVIL}PausedNeeds a look`), "a name is text");
    assert.match(all, /broken.*Can't read it.*broken · Nothing queued/);
    assert.match(all, /View only/);
    assert.equal(nodes(view).filter((n) => ["INPUT", "FORM", "BUTTON", "SELECT"].includes(n.tagName)).length, 0);
  } finally {
    delete globalThis.document;
  }
});

test("ui: Campaigns: Pause asks first and Resume doesn't; the settings form sends only what changed; New campaign checks the id first", async () => {
  globalThis.document = formDocument();
  try {
    const { campaignsScreen } = await import("../ui/screens/campaigns.js");
    const sent = [];
    let asked = 0;
    let result = { ok: true };
    const view = campaignsScreen({
      campaigns: CAMPAIGNS,
      today: "2026-10-25",
      canAct: true,
      act: async (name, args, id) => {
        sent.push([name, args, id]);
        return result;
      },
      confirm: () => {
        asked++;
        return true;
      },
    });
    const card = (label) => nodes(view).find((n) => n.tagName === "SECTION" && n.attributes["aria-label"] === label);
    const button = (within, label) => nodes(within).find((n) => n.tagName === "BUTTON" && textOf(n) === label);
    assert.equal(nodes(card("broken")).some((n) => n.tagName === "FORM"), false, "no settings form without settings");

    button(card("Acme Coffee"), "Pause").listeners.click({ currentTarget: null });
    button(card(EVIL), "Resume").listeners.click({ currentTarget: null });
    assert.equal(asked, 1, "only Pause asks");
    assert.deepEqual(sent.splice(0), [["setPaused", { paused: true }, "acme"], ["setPaused", { paused: false }, "evil"]]);

    // Every text field is labelled; the settings start as the campaign's.
    const inputs = nodes(view).filter((n) => n.tagName === "INPUT" && n.attributes.type !== "checkbox");
    const labelled = new Set(nodes(view).filter((n) => n.tagName === "LABEL").map((n) => n.attributes.for));
    for (const input of inputs) assert.ok(labelled.has(input.attributes.id), `${input.attributes.id} has a label`);
    const field = (id) => nodes(view).find((n) => n.attributes?.id === id);
    assert.equal(field("cmp-acme-slot").value, "19:30");
    assert.equal(field("cmp-acme-approvers").value, "4242");

    const form = nodes(card("Acme Coffee")).find((n) => n.tagName === "FORM");
    const submit = () => form.listeners.submit({ preventDefault() {} });
    const problem = byClass(form, "conn-error")[0];
    await submit();
    assert.equal(problem.textContent, "Nothing changed.", "days listed out of week order aren't a change");

    field("cmp-acme-buffer").value = "four";
    await submit();
    assert.match(problem.textContent, /whole number/);
    field("cmp-acme-buffer").value = "4";
    field("cmp-acme-approvers").value = "4242, 12a";
    await submit();
    assert.match(problem.textContent, /12a isn't a Telegram chat id/);
    assert.deepEqual(sent, []);

    field("cmp-acme-approvers").value = "4242, -100777";
    field("cmp-acme-slot").value = "20:00";
    const checkboxIn = (label) => nodes(form).find((n) => n.tagName === "LABEL" && textOf(n) === label).childNodes[0];
    checkboxIn("Sat").checked = true;
    checkboxIn("YouTube").checked = true;
    checkboxIn("AI-writing check on screen text").checked = true;
    result = { ok: false, error: "a build is running for Acme Coffee; try again when it finishes" };
    await submit();
    assert.deepEqual(sent.splice(0), [[
      "saveSettings",
      { fields: { slot: "20:00", bufferMin: 4, fallbackDays: ["Mon", "Wed", "Fri", "Sat", "Sun"], "platforms.youtube.enabled": true, approvers: ["4242", "-100777"], "checks.detectOnScreen": true } },
      "acme",
    ]]);
    assert.equal(problem.textContent, result.error);
    assert.equal(problem.hidden, false);

    // New campaign.
    const newForm = nodes(card("New campaign")).find((n) => n.tagName === "FORM");
    const createProblem = byClass(newForm, "conn-error")[0];
    field("cmp-new-id").value = "Acme Studio";
    field("cmp-new-name").value = "Acme";
    await newForm.listeners.submit({ preventDefault() {} });
    assert.match(createProblem.textContent, /lowercase letters, digits and dashes/);
    assert.deepEqual(sent, []);
    field("cmp-new-id").value = " acme-studio ";
    result = { ok: true, message: "Created Acme." };
    await newForm.listeners.submit({ preventDefault() {} });
    assert.deepEqual(sent, [["createCampaign", { id: "acme-studio", name: "Acme", template: "blank" }, null]]);
    assert.equal(field("cmp-new-id").value, "", "cleared once created");
  } finally {
    delete globalThis.document;
  }
});

test("ui: Campaigns: switching Instagram off or moving the posting time asks first; other changes don't", async () => {
  globalThis.document = formDocument();
  try {
    const { campaignsScreen } = await import("../ui/screens/campaigns.js");
    const sent = [];
    const asked = [];
    let answer = false;
    const view = campaignsScreen({
      campaigns: [CAMPAIGNS[0]],
      today: "2026-10-25",
      canAct: true,
      act: async (name, args) => {
        sent.push([name, args]);
        return { ok: true };
      },
      confirm: (text) => {
        asked.push(text);
        return answer;
      },
    });
    const form = nodes(view).find((n) => n.tagName === "FORM");
    const submit = () => form.listeners.submit({ preventDefault() {} });
    const field = (id) => nodes(view).find((n) => n.attributes?.id === id);
    const checkboxIn = (label) => nodes(form).find((n) => n.tagName === "LABEL" && textOf(n) === label).childNodes[0];

    checkboxIn("Instagram").checked = false;
    await submit();
    assert.deepEqual(asked.splice(0), ["Nothing will post to Instagram for Acme Coffee until you switch it back on. Save?"]);
    assert.deepEqual(sent, [], "declined: nothing sent");

    checkboxIn("Instagram").checked = true;
    field("cmp-acme-slot").value = "21:00";
    await submit();
    assert.deepEqual(asked.splice(0), ["Acme Coffee will post at 21:00 instead of 19:30, starting with the next window. Save?"]);
    assert.deepEqual(sent, []);

    answer = true;
    await submit();
    assert.deepEqual(sent.splice(0), [["saveSettings", { fields: { slot: "21:00" } }]]);

    field("cmp-acme-slot").value = "19:30";
    field("cmp-acme-late").value = "90";
    asked.length = 0;
    await submit();
    assert.deepEqual(asked, [], "a late limit change doesn't ask");
    assert.deepEqual(sent, [["saveSettings", { fields: { lateLimitMinutes: 90 } }]]);
  } finally {
    delete globalThis.document;
  }
});
