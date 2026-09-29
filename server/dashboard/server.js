"use strict";

/**
 * server/dashboard/server.js - the dashboard's HTTP surface: security checks,
 * routing, JSON/static responses, and the SSE stream. Zero runtime deps.
 *
 * Threat model: the server exposes prompt content on localhost, so every
 * request passes `guard()` before routing - Host/Origin pinned to the bound
 * port (DNS rebinding), GET/HEAD only, and a per-start token exchanged for an
 * HttpOnly SameSite=Strict cookie. PII is redacted per request unless
 * `dashboard.showPII` is on; secrets were already scrubbed at write time.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { redact } = require("../../core/redact.js");
const { isSafeId, JOURNAL_KEYS } = require("../../core/journal.js");

const COOKIE = "dlb_dash";
const KEEPALIVE_MS = 15000;
// A client this far behind is dropped; it reconnects with Last-Event-ID and resumes.
const SSE_MAX_BUFFERED = 1 << 20;
const BASE_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
});
// Providers whose key env name is fixed in code rather than carried in the resolved config.
const FIXED_KEY_ENVS = Object.freeze({ grok: "XAI_API_KEY" });

// Free-text fields of the legacy core/sessions.js record that JOURNAL_KEYS does not name.
const LEGACY_CONTENT_KEYS = ["question", "synthesis", "note", "blindVerdict"];
/** Content field names, derived from the journal whitelist so there is no second list.
 * `a[].b` entries (criticalIssues[].description) become a nested drop. */
const CONTENT_KEYS = new Set(LEGACY_CONTENT_KEYS);
/** @type {Map<string, Set<string>>} parent key -> element fields to drop */
const NESTED_CONTENT_KEYS = new Map();
for (const spec of Object.values(JOURNAL_KEYS)) {
  for (const k of spec.content) {
    const m = /^(\w+)\[\]\.(\w+)$/.exec(k);
    if (!m) CONTENT_KEYS.add(k);
    else NESTED_CONTENT_KEYS.set(m[1], (NESTED_CONTENT_KEYS.get(m[1]) || new Set()).add(m[2]));
  }
}

/**
 * A copy of `v` with every content field removed at any depth: journal events, and the
 * legacy session record (question, synthesis, opinion text, critical-issue descriptions,
 * annotation notes). Applied before redaction whenever `dashboard.capture` is not "content".
 * @param {any} v @returns {any}
 */
function stripContent(v) {
  if (Array.isArray(v)) return v.map(stripContent);
  if (!v || typeof v !== "object") return v;
  /** @type {Record<string, any>} */ const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (CONTENT_KEYS.has(k)) continue;
    const drop = NESTED_CONTENT_KEYS.get(k);
    out[k] = drop && Array.isArray(x)
      ? x.map((e) => (e && typeof e === "object" ? Object.fromEntries(Object.entries(e).filter(([f]) => !drop.has(f))) : e))
      : stripContent(x);
  }
  return out;
}

/**
 * Constant-time token check. Length is not secret (always 64 hex chars).
 * @param {unknown} given
 * @param {Buffer} expected
 */
function tokenMatches(given, expected) {
  if (typeof given !== "string") return false;
  const buf = Buffer.from(given, "utf8");
  return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
}

/** @param {string|undefined} header @returns {string|undefined} */
function readCookie(header) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * An http(s) URL string with its userinfo removed; any other string unchanged.
 * @param {string} s
 */
function stripUserinfo(s) {
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    if (!u.username && !u.password) return s;
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return s;
  }
}

/**
 * The effective config with every `apiKeyEnv` replaced by `{env, set}` and URL
 * credentials stripped; never a key value.
 * @param {any} cfg
 * @param {NodeJS.ProcessEnv} env
 */
function publicConfig(cfg, env) {
  /** @param {any} v @returns {any} */
  const walk = (v) => {
    if (typeof v === "string") return stripUserinfo(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    /** @type {Record<string, any>} */ const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = k === "apiKeyEnv" && typeof x === "string" ? { env: x, set: !!env[x] } : walk(x);
    }
    return out;
  };
  const out = walk(cfg || {});
  if (out.providers && typeof out.providers === "object") {
    for (const [name, envName] of Object.entries(FIXED_KEY_ENVS)) {
      const p = out.providers[name];
      if (p && typeof p === "object" && !p.apiKeyEnv) p.apiKeyEnv = { env: envName, set: !!env[envName] };
    }
  }
  return out;
}

/**
 * @param {{
 *   port: number, token: string, uiDir: string,
 *   index: {list: (f?: any) => any[], get: (id: string) => any},
 *   tailer: {subscribe: (fn: (m: {id: string, event: object}) => void, since?: string) => () => void, close?: () => void},
 *   getConfig: () => any,
 *   health: () => (object|Promise<object>),
 *   stats: () => (object|Promise<object>),
 * }} opts
 * @returns {http.Server} not listening
 */
function createDashboardServer(opts) {
  const { token, uiDir, index, tailer, getConfig, health, stats } = opts;
  const expected = Buffer.from(token, "utf8");
  /** @type {Set<http.ServerResponse>} */
  const streams = new Set();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(req, res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  // server.close() waits for every open connection, and an SSE stream never ends on its
  // own, so end the streams first; 'close' then fires and releases the tailer.
  const baseClose = server.close.bind(server);
  server.close = (/** @type {any} */ cb) => {
    for (const r of streams) r.end();
    streams.clear();
    return baseClose(cb);
  };
  server.on("close", () => {
    if (tailer && typeof tailer.close === "function") tailer.close();
  });

  const boundPort = () => {
    const a = server.address();
    return (a && typeof a === "object" && a.port) || opts.port;
  };
  const showPII = () => {
    try {
      const d = (getConfig() || {}).dashboard;
      return !!(d && d.showPII === true);
    } catch {
      return false;
    }
  };
  /** @param {unknown} v */
  const outward = (v) => (showPII() ? v : redact(v));
  // Read per request (hot reload). Anything but "content" serves no prompt/response text, whatever is on disk.
  const capturesContent = () => {
    try {
      const d = (getConfig() || {}).dashboard;
      return !!(d && d.capture === "content");
    } catch {
      return false;
    }
  };
  /** @param {unknown} v */
  const served = (v) => outward(capturesContent() ? v : stripContent(v));

  /**
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res
   * @param {number} status @param {unknown} body
   */
  function sendJson(req, res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
    res.end(req.method === "HEAD" ? undefined : text);
  }

  /**
   * Every check that must pass before routing. Sends the rejection and returns
   * false, or returns true to continue.
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {URL} url
   */
  function guard(req, res, url) {
    const port = boundPort();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = String(req.headers.host || "").toLowerCase();
    if (!hosts.includes(host)) return sendJson(req, res, 403, { error: "forbidden host" }), false;
    const origin = req.headers.origin;
    if (origin !== undefined && !hosts.some((h) => origin.toLowerCase() === `http://${h}`)) {
      return sendJson(req, res, 403, { error: "forbidden origin" }), false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return sendJson(req, res, 405, { error: "method not allowed" }), false;
    }
    const t = url.searchParams.get("t");
    if (t !== null) {
      if (!tokenMatches(t, expected)) return sendJson(req, res, 401, { error: "unauthorized" }), false;
      res.writeHead(302, { Location: "/", "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
      res.end();
      return false;
    }
    if (!tokenMatches(readCookie(req.headers.cookie), expected)) return sendJson(req, res, 401, { error: "unauthorized" }), false;
    return true;
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} file */
  function sendFile(req, res, file) {
    const type = /** @type {Record<string,string>} */ (CONTENT_TYPES)[path.extname(file).toLowerCase()];
    if (!type) return sendJson(req, res, 404, { error: "not found" });
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      return sendJson(req, res, 404, { error: "not found" });
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} encoded */
  function sendAsset(req, res, encoded) {
    let rel;
    try {
      rel = decodeURIComponent(encoded);
    } catch {
      return sendJson(req, res, 404, { error: "not found" });
    }
    // Resolve symlinks on both sides so a link inside the UI dir cannot point out of it.
    let root;
    let file;
    try {
      root = fs.realpathSync(uiDir);
      file = fs.realpathSync(path.resolve(root, rel));
    } catch {
      return sendJson(req, res, 404, { error: "not found" });
    }
    if (rel.includes("\0") || !file.startsWith(root + path.sep)) return sendJson(req, res, 404, { error: "not found" });
    return sendFile(req, res, file);
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function sendEvents(req, res) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    if (req.method === "HEAD") return res.end();
    res.flushHeaders();
    streams.add(res);
    /** @param {string} chunk */
    const send = (chunk) => {
      if (res.destroyed) return;
      res.write(chunk);
      if (res.writableLength > SSE_MAX_BUFFERED) res.destroy();
    };
    const since = req.headers["last-event-id"];
    const unsubscribe = tailer.subscribe(({ id, event }) => {
      send(`id: ${id}\ndata: ${JSON.stringify(served(event))}\n\n`);
    }, typeof since === "string" ? since : undefined);
    const ka = setInterval(() => send(": ka\n\n"), KEEPALIVE_MS);
    res.on("close", () => {
      streams.delete(res);
      clearInterval(ka);
      unsubscribe();
    });
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    if (!guard(req, res, url)) return;

    const p = url.pathname;
    if (p === "/") {
      if (!fs.existsSync(path.join(uiDir, "index.html"))) return sendJson(req, res, 503, { error: "dashboard UI not found" });
      return sendFile(req, res, path.join(uiDir, "index.html"));
    }
    if (p.startsWith("/assets/")) return sendAsset(req, res, p.slice("/assets/".length));
    if (p === "/api/runs") {
      const q = url.searchParams;
      const sinceRaw = q.get("since");
      const filter = {
        q: q.get("q") || undefined,
        tool: q.get("tool") || undefined,
        provider: q.get("provider") || undefined,
        status: q.get("status") || undefined,
        since: sinceRaw && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : sinceRaw || undefined,
        redacted: !showPII(),
        metadataOnly: !capturesContent(),
      };
      return sendJson(req, res, 200, outward({ runs: index.list(filter) }));
    }
    if (p.startsWith("/api/runs/")) {
      const id = p.slice("/api/runs/".length);
      if (!isSafeId(id)) return sendJson(req, res, 400, { error: "invalid run id" });
      const run = index.get(id);
      if (!run) return sendJson(req, res, 404, { error: "run not found" });
      return sendJson(req, res, 200, served(run));
    }
    if (p === "/api/config") return sendJson(req, res, 200, outward(publicConfig(getConfig(), process.env)));
    if (p === "/api/health") return sendJson(req, res, 200, outward(await health()));
    if (p === "/api/stats") return sendJson(req, res, 200, outward(await stats()));
    if (p === "/api/events") return sendEvents(req, res);
    return sendJson(req, res, 404, { error: "not found" });
  }

  return server;
}

module.exports = { createDashboardServer, publicConfig };
