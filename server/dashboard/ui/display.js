"use strict";
/** Canonical IDs remain on the wire; this helper is only for human labels. @param {string} id */
function providerLabel(id) { return id.replace(/^openrouter:/,'or:'); }
/** @param {number|null|undefined} ms */
function formatDuration(ms) {
  if(typeof ms!=='number'||!Number.isFinite(ms))return '-';
  if(ms<1000)return `${Math.round(ms)}ms`;
  const t=Math.round(ms/1000),s=t%60,m=Math.floor(t/60)%60,h=Math.floor(t/3600);
  return h?`${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`:t>=60?`${Math.floor(t/60)}m ${String(s).padStart(2,'0')}s`:`${t}s`;
}
if(typeof module!=="undefined")module.exports={providerLabel,formatDuration};
else /** @type {any} */ (globalThis).deliberationDisplay={providerLabel,formatDuration};
