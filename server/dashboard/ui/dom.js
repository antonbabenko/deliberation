// dom.js - element builders and formatters. Every string becomes a text node or an
// attribute value; nothing is ever parsed as HTML.

const SVG_NS = "http://www.w3.org/2000/svg";

function fill(el, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(typeof kid === "object" ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** HTML element. */
export const h = (tag, attrs, ...kids) => fill(document.createElement(tag), attrs, kids);
/** Replace an element's children, skipping null/false like h() does. */
export const put = (el, ...kids) => {
  el.replaceChildren();
  return fill(el, {}, kids);
};

/** SVG element. */
export const s = (tag, attrs, ...kids) => fill(document.createElementNS(SVG_NS, tag), attrs, kids);

export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Duration: 840ms, 12.34s, 4m 12.3s. */
export function fmtMs(ms) {
  const v = num(ms);
  if (v === null) return "-";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}s`;
  const m = Math.floor(v / 60000);
  return `${m}m ${((v % 60000) / 1000).toFixed(1).padStart(4, "0")}s`;
}

/** Elapsed clock: 00:42.3 or 1:04:12. */
export function fmtClock(ms) {
  const v = Math.max(0, num(ms) || 0);
  const t = Math.floor(v / 100);
  const tenths = t % 10;
  const sec = Math.floor(t / 10) % 60;
  const min = Math.floor(t / 600) % 60;
  const hr = Math.floor(t / 36000);
  const p = (n) => String(n).padStart(2, "0");
  return hr ? `${hr}:${p(min)}:${p(sec)}` : `${p(min)}:${p(sec)}.${tenths}`;
}

export function fmtInt(n) {
  const v = num(n);
  return v === null ? "-" : Math.round(v).toLocaleString("en-US");
}

/** Compact count: 950, 12.4k, 3.1M. */
export function fmtK(n) {
  const v = num(n);
  if (v === null) return "-";
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
  return `${(v / 1e6).toFixed(1)}M`;
}

/** Local wall time: 2026-09-28 14:03:07. */
export function fmtTime(epoch) {
  const v = num(epoch);
  if (!v) return "-";
  const d = new Date(v);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A run id cut in the middle so the unique tail survives: 3f2a91c4...9e0b1d77. */
export function midId(id, max = 20) {
  if (typeof id !== "string" || !id) return "-";
  if (id.length <= max) return id;
  const tail = Math.ceil((max - 3) / 2);
  return `${id.slice(0, max - 3 - tail)}...${id.slice(-tail)}`;
}

/** Verdict token as the decode row prints it. */
export function verdictLabel(v) {
  if (typeof v !== "string" || !v) return null;
  const u = v.toUpperCase().replace(/\s+/g, "_");
  return u === "REQUEST_CHANGES" ? "REQ_CHANGES" : u;
}

/** Status/state class suffix for CSS. */
export const stateClass = (st) => `st-${st || "pending"}`;
