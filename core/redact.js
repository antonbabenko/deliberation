"use strict";

/**
 * core/redact.js - PII masking for the dashboard when `dashboard.showPII` is
 * false. Zero runtime dependencies (node builtins only).
 *
 * Extends the email-only `stripPII` in core/sessions.js (same bounded email
 * pattern, so both stay ReDoS-safe on provider-controlled text) with path
 * (home dir / home paths of the OS username), IPv4, IPv6, and 12-digit account-id masking.
 *
 * Every regex here is either a fixed-width lookaround or a flat sequence of
 * bounded quantifiers (no quantifier nests inside another quantifier), so
 * matching stays linear in input length.
 */

const os = require("node:os");

/** @typedef {{home?: string, username?: string}} RedactOptions */

// Same bounded email pattern as core/sessions.js stripPII.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g;

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

// Compressed + full-form IPv6. Lookaround boundaries (not \b) so a match
// can't stop short at a "::" that has more hex after it - see the near-miss
// forms this guards against below.
const HEX4 = "[0-9A-Fa-f]{1,4}";
const IPV6_ALTS = [
  `(?:${HEX4}:){7}${HEX4}`,
  `(?:${HEX4}:){1,7}:`,
  `(?:${HEX4}:){1,6}:${HEX4}`,
  `(?:${HEX4}:){1,5}(?::${HEX4}){1,2}`,
  `(?:${HEX4}:){1,4}(?::${HEX4}){1,3}`,
  `(?:${HEX4}:){1,3}(?::${HEX4}){1,4}`,
  `(?:${HEX4}:){1,2}(?::${HEX4}){1,5}`,
  `${HEX4}:(?:(?::${HEX4}){1,6})`,
  `:(?:(?::${HEX4}){1,7}|:)`,
].join("|");
const IPV6_RE = new RegExp(`(?<![0-9A-Fa-f:])(?:${IPV6_ALTS})(?![0-9A-Fa-f:])`, "g");

// 12 digits, not part of a longer run - keeps 13-digit epoch-ms timestamps
// and 10-digit phone numbers unchanged.
const ACCOUNT_ID_RE = /(?<!\d)\d{12}(?!\d)/g;

// Structural ids the UI routes and joins on. A UUID whose last group is all digits
// would otherwise match ACCOUNT_ID_RE and break every lookup by that id.
const ID_KEYS = new Set(["runId", "callId", "sessionId", "loopSessionId", "id"]);

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @returns {RedactOptions} */
function resolveDefaults() {
  /** @type {RedactOptions} */
  const out = {};
  try {
    out.home = os.homedir();
  } catch {
    // no-op: leave home undefined, path masking just skips this pass.
  }
  try {
    out.username = os.userInfo().username;
  } catch {
    // no-op: leave username undefined.
  }
  return out;
}

/**
 * @param {string} s
 * @param {RedactOptions} [opts]
 * @returns {string}
 */
function redactString(s, opts) {
  const { home, username } = { ...resolveDefaults(), ...opts };
  let out = s;

  // Home dir first, then any other home path for the same username (/home/<u>,
  // /Users/<u>, C:\Users\<u>, either slash). The username alone is left as is:
  // "root cause" must survive a user named root.
  if (home) {
    const homeRe = new RegExp(`${escapeRegExp(home)}(?=[\\\\/]|$)`, "g");
    out = out.replace(homeRe, "~");
  }
  if (username) {
    const userRe = new RegExp(`(?:[A-Za-z]:)?[\\\\/](?:home|[Uu]sers)[\\\\/]${escapeRegExp(username)}(?![A-Za-z0-9._-])`, "g");
    out = out.replace(userRe, "~");
  }

  out = out.replace(EMAIL_RE, "[email]");
  out = out.replace(IPV6_RE, "[ip]");
  out = out.replace(IPV4_RE, "[ip]");
  out = out.replace(ACCOUNT_ID_RE, "[account-id]");

  return out;
}

/**
 * Deep-copies `value`, masking every string it contains except a string under
 * an id key (ID_KEYS). Non-string,
 * non-container values (numbers, booleans, null, Date, etc.) pass through
 * unchanged. Never mutates the input.
 *
 * @param {unknown} value
 * @param {RedactOptions} [opts]
 * @returns {unknown}
 */
function redact(value, opts) {
  if (typeof value === "string") return redactString(value, opts);
  if (Array.isArray(value)) return value.map((v) => redact(v, opts));
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = ID_KEYS.has(k) && typeof v === "string" ? v : redact(v, opts);
    return out;
  }
  return value;
}

module.exports = { redact, redactString };
