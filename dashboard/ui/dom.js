// The one way the console builds DOM. Every string child becomes a text node, so a
// caption or a log line can never turn into markup, and only the props below can be
// set: never `style` (the page CSP refuses inline styles) and never HTML.
//
//   h(tag, props, ...children)
//     props: className, on<Event> (a listener), aria-*, href, src, type, and the
//            plain attributes in ATTRS and BOOLEANS
//     children: strings, numbers, nodes, arrays of them; null and false are skipped
//   icon(paths, { fill, size })  a decorative inline SVG
//   fill(el, ...children)        replaces el's children
//   markBusy(el) -> restore      shows el busy and disabled while an action runs

const ATTRS = new Set(["type", "title", "id", "role", "alt", "value", "preload", "target", "rel", "tabindex", "for", "scope", "placeholder", "loading", "min", "maxlength", "rows", "autocomplete"]);
const BOOLEANS = new Set(["disabled", "hidden", "controls", "playsinline", "selected", "download"]);
// URL attributes take a same-site path, a fragment or an https link; never javascript:.
const URL_ATTRS = new Set(["href", "src", "poster"]);
const SAFE_URL = /^(\/(?![/\\])|#|https:\/\/)/i;

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null) continue;
    if (key === "className") {
      el.className = value;
    } else if (/^on[A-Z]/.test(key) && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key.startsWith("aria-") || ATTRS.has(key)) {
      el.setAttribute(key, String(value));
    } else if (BOOLEANS.has(key)) {
      if (value === true) el.setAttribute(key, "");
    } else if (URL_ATTRS.has(key)) {
      if (!SAFE_URL.test(String(value))) throw new Error(`h: refusing ${key} ${JSON.stringify(String(value))}`);
      el.setAttribute(key, String(value));
    } else {
      throw new Error(`h: can't set "${key}"`);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (typeof child === "object") el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

// A 24×24 decorative icon drawn from path data: stroked, or filled with `fill`.
export function icon(paths, { fill = false, size = 22 } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attrs = {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: fill ? "currentColor" : "none",
    stroke: fill ? "none" : "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// Replaces `el`'s children with `children` (built the same way as h's).
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// Shows `el` (a button, or a card) busy and disabled; the returned function puts it back.
export function markBusy(el) {
  if (!el) return () => {};
  const wasDisabled = el.disabled;
  el.classList.add("is-busy");
  el.setAttribute("aria-busy", "true");
  if ("disabled" in el) el.disabled = true;
  return () => {
    el.classList.remove("is-busy");
    el.removeAttribute("aria-busy");
    if ("disabled" in el) el.disabled = wasDisabled;
  };
}
