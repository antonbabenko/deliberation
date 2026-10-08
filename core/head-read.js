"use strict";
const fs = require("node:fs");

// Bytes kept free under a per-file cap for the truncation marker, so content plus
// marker never exceeds the cap a bridge enforces.
const MARKER_RESERVE = 64;

/** @param {unknown} v @returns {boolean} */
function isValidHeadBytes(v) {
  return Number.isInteger(v) && /** @type {number} */ (v) > 0;
}

/**
 * Cut a head buffer at its last newline; with none, back off to the last complete
 * UTF-8 code point so a multi-byte sequence is never split.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function cutHead(buf) {
  const nl = buf.lastIndexOf(0x0a);
  if (nl > 0) return buf.subarray(0, nl);
  let j = buf.length - 1;
  while (j > 0 && (buf[j] & 0xc0) === 0x80) j--;
  if (j < 0) return buf;
  const lead = buf[j];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return j + need > buf.length ? buf.subarray(0, j) : buf;
}

/**
 * Read at most `headBytes` from an ALREADY-AUTHORIZED path (callers resolve it under
 * their roots first). Opens non-blocking so a FIFO cannot hang the open, refuses
 * non-regular files via fstat on the fd, and never reads past
 * min(headBytes, size, perFileCap - MARKER_RESERVE). A cut file ends in
 * "\n[truncated: first N of M bytes]"; an uncut file gets no marker. Throws on an
 * invalid headBytes, a cap too small to hold the marker, a non-regular file, or an
 * fs error.
 * @param {string} abs
 * @param {number} headBytes
 * @param {number} perFileCap
 * @returns {{buf: Buffer, truncated: boolean, size: number}}
 */
function readHead(abs, headBytes, perFileCap) {
  if (!isValidHeadBytes(headBytes)) throw new Error("headBytes must be a positive integer");
  if (!(perFileCap > MARKER_RESERVE)) throw new Error(`per-file cap ${perFileCap} is too small for a truncated read (needs more than ${MARKER_RESERVE} bytes)`);
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    const want = Math.max(0, Math.min(headBytes, st.size, perFileCap - MARKER_RESERVE));
    const buf = Buffer.alloc(want);
    let n = 0;
    while (n < want) {
      const r = fs.readSync(fd, buf, n, want - n, n);
      if (r === 0) break;
      n += r;
    }
    const head = buf.subarray(0, n);
    if (n >= st.size) return { buf: head, truncated: false, size: st.size };
    const cut = cutHead(head);
    const marker = Buffer.from(`\n[truncated: first ${cut.length} of ${st.size} bytes]`);
    return { buf: Buffer.concat([cut, marker]), truncated: true, size: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readHead, cutHead, isValidHeadBytes, MARKER_RESERVE };
