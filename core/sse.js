"use strict";

/**
 * core/sse.js - Server-Sent Events framing, provider-agnostic.
 *
 * Zero runtime dependencies. CommonJS. JSDoc-typed so it passes strict `tsc`.
 *
 * This is the TRANSPORT half of streaming only: it splits a byte stream into events
 * and hands back `{ event, data }`. What an event MEANS is the caller's business, so a
 * second provider (OpenRouter, which is still non-streaming and subject to the same
 * transport ceiling) can reuse this without inheriting xAI's event vocabulary.
 *
 * The two things worth knowing:
 *
 *   - **Delimiters are CRLF-tolerant.** The SSE spec allows CR, LF, or CRLF line
 *     endings, and a proxy is free to rewrite them. Splitting on `"\n\n"` alone meant a
 *     CRLF stream never split at all: the buffer grew to hold the whole response and
 *     the end-of-stream flush handed every concatenated `data:` payload to one JSON
 *     parse, which failed - so a perfectly good answer surfaced as an empty stream.
 *   - **The event name lives in two places.** Some servers put it only on the `event:`
 *     line, others repeat it inside the JSON payload (OpenAI-style `type`). Returning
 *     both lets the caller prefer the payload and fall back to the frame, instead of
 *     silently matching nothing.
 */

/** Frame delimiter: a blank line, with any of the spec's line endings. */
const FRAME_DELIMITER = /\r?\n\r?\n|\r\r/;
/** Line splitter inside one frame. */
const LINE_DELIMITER = /\r?\n|\r/;

/**
 * @typedef {Object} SseEvent
 * @property {(string|null)} event  the `event:` field, or null when absent
 * @property {string} data  the concatenated `data:` payload (raw text, may be JSON)
 */

/**
 * Parse ONE frame into its event name and data payload. Comment lines (`:` prefix,
 * used for keepalives) and unknown fields are ignored. Returns null when the frame
 * carries no data at all, or carries the `[DONE]` sentinel.
 * @param {string} frame
 * @returns {(SseEvent|null)}
 */
function parseSseFrame(frame) {
  let event = null;
  let data = "";
  for (const line of String(frame == null ? "" : frame).split(LINE_DELIMITER)) {
    if (!line || line.startsWith(":")) continue; // keepalive comment
    if (line.startsWith("data:")) data += line.slice(5).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim() || null;
  }
  if (!data || data === "[DONE]") return null;
  return { event, data };
}

/**
 * Consume a fetch response body as SSE, invoking `onEvent` per frame.
 *
 * Malformed frames are skipped rather than thrown: a stray keepalive must not kill a
 * stream that is otherwise fine. A TRANSPORT failure (socket reset, abort) propagates
 * to the caller, which classifies it exactly like a failed `res.text()`.
 * @param {AsyncIterable<Uint8Array>} body
 * @param {(ev: SseEvent) => void} onEvent
 * @returns {Promise<void>}
 */
async function readSseStream(body, onEvent) {
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (/** @type {string} */ frame) => {
    const ev = parseSseFrame(frame);
    if (ev) onEvent(ev);
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    for (;;) {
      const m = FRAME_DELIMITER.exec(buf);
      if (!m) break;
      flush(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  }
  buf += decoder.decode();
  // A well-behaved stream ends with a delimiter, but a truncated one may not - the
  // trailing partial frame is still worth parsing rather than discarding.
  if (buf.trim()) flush(buf);
}

module.exports = { parseSseFrame, readSseStream, FRAME_DELIMITER, LINE_DELIMITER };
