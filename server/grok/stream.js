"use strict";

/**
 * server/grok/stream.js - xAI Responses-API event semantics over the generic SSE
 * reader in `core/sse.js`.
 *
 * WHY the bridge streams at all: xAI sends nothing until a non-streaming answer is
 * complete, and Node's fetch gives up after undici's 300s `headersTimeout` with no
 * public API to raise it. So every call that thought for longer than five minutes died
 * at exactly 300s, and a configured timeout above 300s was unreachable. Streaming puts
 * the first byte on the wire in seconds and each chunk resets the body timeout, leaving
 * the bridge's own AbortController as the real ceiling.
 *
 * This module only INTERPRETS events. Framing lives in core/sse.js so the OpenRouter
 * bridge can stream later without a second copy of the parser.
 */

const { readSseStream } = require("../../core/sse.js");

/**
 * @typedef {Object} StreamOutcome
 * @property {(any|null)} final  the terminal `response` object, when one arrived. It is
 *   the SAME shape a non-streaming call returns, so the caller's existing parser,
 *   usage normalization and `output` capture apply unchanged.
 * @property {string} deltas  concatenated `output_text` deltas - the fallback when no
 *   terminal object arrives, and the safety net when one arrives unparseable.
 * @property {(any|null)} failure  a generation the upstream itself aborted.
 * @property {boolean} sawEvent  true when ANY recognized event arrived. Distinguishes
 *   "the model produced nothing" from "we did not understand this stream at all",
 *   which is what lets the caller fall back to a non-streaming request.
 */

/**
 * Read an xAI Responses SSE body.
 *
 * Event names are taken from the JSON payload's `type` when present and from the SSE
 * `event:` line otherwise. Relying on `type` alone meant that a server naming events
 * only on the frame - which the SSE spec is built around - matched nothing at all, and
 * every call failed as an empty stream.
 * @param {AsyncIterable<Uint8Array>} body
 * @returns {Promise<StreamOutcome>}
 */
async function readResponsesStream(body) {
  let deltas = "";
  /** @type {(any|null)} */
  let final = null;
  /** @type {(any|null)} */
  let failure = null;
  let sawEvent = false;

  await readSseStream(body, (ev) => {
    /** @type {any} */
    let payload = null;
    try { payload = JSON.parse(ev.data); } catch { payload = null; }
    const type = (payload && typeof payload.type === "string" && payload.type) || ev.event;
    if (!type) return;
    if (type === "response.output_text.delta") {
      const d = payload && payload.delta;
      // The delta rides `delta` as a string on the Responses API; tolerate the nested
      // `{delta:{text}}` shape rather than silently dropping the answer.
      const text = typeof d === "string" ? d : (d && typeof d.text === "string" ? d.text : null);
      if (text !== null) { deltas += text; sawEvent = true; }
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      // `incomplete` is a TRUNCATED answer (max tokens, content filter), not a failure:
      // the non-streaming path returned its partial output happily, and throwing here
      // would discard a usable answer the caller already paid for.
      if (payload && payload.response) { final = payload.response; sawEvent = true; }
      return;
    }
    if (type === "response.failed" || type === "error") {
      failure = (payload && (payload.response || payload.error)) || payload || { type };
      sawEvent = true;
      return;
    }
    // Any other recognized lifecycle event (created, in_progress, ...) still proves we
    // are reading a stream we understand.
    if (typeof type === "string" && type.startsWith("response.")) sawEvent = true;
  });

  return { final, deltas, failure, sawEvent };
}

module.exports = { readResponsesStream };
