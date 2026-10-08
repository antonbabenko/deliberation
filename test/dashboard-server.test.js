// test/dashboard-server.test.js
"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const { createDashboardServer } = require("../server/dashboard/server.js");
const { createRunIndex } = require("../server/dashboard/runs.js");

const TOKEN = "a".repeat(64);
const SENTINEL = "xai-sentinel-value-0123456789";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-dashsrv-"));
}

const runsDir = tmpDir();
fs.writeFileSync(
  path.join(runsDir, "run-1.jsonl"),
  JSON.stringify({ v: 1, kind: "run_start", runId: "run-1", at: 1_700_000_000_000, seq: 0, tool: "ask-all", workflow: "single", pid: 999999, procStartedAt: 1, providers: ["grok"], prompt: "mail x@y.io please" }) + "\n",
);
// uiDir has real files just outside it, so a traversal test fails if a check is removed.
const uiBase = tmpDir();
const uiDir = path.join(uiBase, "ui");
fs.mkdirSync(uiDir);
fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>stub</title>");
fs.writeFileSync(path.join(uiDir, "app.js"), "export {};");
fs.writeFileSync(path.join(uiBase, "secret.js"), "SECRET_OUTSIDE");
fs.mkdirSync(path.join(uiBase, "ui-evil"));
fs.writeFileSync(path.join(uiBase, "ui-evil", "p.js"), "SECRET_SIBLING");
if (process.platform !== "win32") fs.symlinkSync("../secret.js", path.join(uiDir, "link.js"));

/** @type {any} */
const cfg = { dashboard: { enabled: true, showPII: false, capture: "content" }, providers: { grok: { enabled: true } }, openrouter: { apiKeyEnv: "OPENROUTER_API_KEY" } };
const tail = { since: /** @type {any} */ (undefined), unsubscribed: false };
const tailer = {
  subscribe(/** @type {Function} */ fn, /** @type {string} */ since) {
    tail.since = since;
    setImmediate(() => fn({ id: "run-1:42", event: { kind: "call_end", note: "to x@y.io" } }));
    return () => { tail.unsubscribed = true; };
  },
  close() {},
};

const server = createDashboardServer({
  port: 0,
  token: TOKEN,
  uiDir,
  index: createRunIndex({ runsDir, isAlive: () => false }),
  tailer,
  getConfig: () => cfg,
  health: async () => ({ providers: [] }),
  stats: () => ({ daily: [] }),
});
/** @type {number} */
let port = 0;
const ready = new Promise((resolve) => server.listen(0, "127.0.0.1", () => { port = /** @type {any} */ (server.address()).port; resolve(undefined); }));
after(() => { server.closeAllConnections(); server.close(); });

/**
 * @param {string} p
 * @param {{method?: string, headers?: Record<string,string>, cookie?: boolean, host?: string}} [o]
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: string}>}
 */
async function req(p, o = {}) {
  await ready;
  const headers = { Host: o.host || `127.0.0.1:${port}`, ...(o.cookie ? { Cookie: `dlb_dash=${TOKEN}` } : {}), ...(o.headers || {}) };
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method: o.method || "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: /** @type {number} */ (res.statusCode), headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("S1: wrong Host or foreign Origin -> 403", async () => {
  assert.equal((await req("/api/runs", { cookie: true, host: "evil.com" })).status, 403);
  assert.equal((await req("/api/runs", { cookie: true, host: `evil.com:${port}` })).status, 403);
  assert.equal((await req("/api/runs", { cookie: true, headers: { Origin: "http://evil.com" } })).status, 403);
  assert.equal((await req("/api/runs", { cookie: true, headers: { Origin: "null" } })).status, 403);
  assert.equal((await req("/api/runs", { cookie: true, headers: { Origin: `http://localhost:${port}` } })).status, 200);
  assert.equal((await req("/api/runs", { cookie: true, host: `localhost:${port}` })).status, 200);
});

test("S2: token and cookie flow", async () => {
  const none = await req("/");
  assert.equal(none.status, 401);
  assert.deepEqual(JSON.parse(none.body), { error: "unauthorized" });
  assert.equal((await req("/?t=bad")).status, 401);
  assert.equal((await req(`/?t=${"b".repeat(64)}`)).status, 401);
  assert.equal((await req("/", { headers: { Cookie: "dlb_dash=nope" } })).status, 401);
  const ok = await req(`/?t=${TOKEN}`);
  // 200 + same-origin refresh, not 302: a redirect out of the file:// opener page is
  // cross-site, and Chrome withholds the Strict cookie from the redirected GET /.
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.location, undefined);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.match(ok.body, /http-equiv="refresh" content="0;url=\/"/);
  const cookie = String((ok.headers["set-cookie"] || [])[0]);
  assert.match(cookie, /^dlb_dash=a{64};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  const page = await req("/", { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(page.status, 200);
  assert.match(page.body, /stub/);
});

test("S3: non-GET/HEAD -> 405; HEAD has no body", async () => {
  const post = await req("/api/runs", { method: "POST", cookie: true });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal((await req("/api/runs", { method: "DELETE", cookie: true })).status, 405);
  const head = await req("/api/runs", { method: "HEAD", cookie: true });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("S4: /assets traversal rejected; in-dir asset served", async () => {
  assert.equal((await req("/assets/..%2f..%2fpackage.json", { cookie: true })).status, 404);
  assert.equal((await req("/assets/%2e%2e/%2e%2e/package.json", { cookie: true })).status, 404);
  assert.equal((await req("/assets/..%5c..%5cpackage.json", { cookie: true })).status, 404);
  assert.equal((await req("/assets/%E0%A4%A", { cookie: true })).status, 404);
  // Each of these targets an EXISTING file outside uiDir.
  const outside = ["/assets/..%2fsecret.js", "/assets/..%2fui-evil%2fp.js", "/assets/%2e%2e%2fsecret.js"];
  if (process.platform !== "win32") outside.push("/assets/link.js");
  for (const p of outside) {
    const r = await req(p, { cookie: true });
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes("SECRET_"), p);
  }
  const js = await req("/assets/app.js", { cookie: true });
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
});

test("S5: /api/config never carries a key value", async () => {
  process.env.XAI_API_KEY = SENTINEL;
  try {
    const r = await req("/api/config", { cookie: true });
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes(SENTINEL));
    assert.match(r.body, /"set":true/);
    const body = JSON.parse(r.body);
    assert.equal(body.serverVersion,require('../server/mcp/package.json').version);
    assert.deepEqual(body.providers.grok.apiKeyEnv, { env: "XAI_API_KEY", set: true });
    assert.equal(body.openrouter.apiKeyEnv.env, "OPENROUTER_API_KEY");
  } finally {
    delete process.env.XAI_API_KEY;
  }
});

test("S6: showPII toggles redaction per request", async () => {
  cfg.dashboard.showPII = false;
  const red = await req("/api/runs/run-1", { cookie: true });
  assert.equal(red.status, 200);
  assert.ok(!red.body.includes("x@y.io"));
  assert.match(red.body, /\[email\]/);
  cfg.dashboard.showPII = true;
  try {
    const raw = await req("/api/runs/run-1", { cookie: true });
    assert.match(raw.body, /x@y\.io/);
  } finally {
    cfg.dashboard.showPII = false;
  }
  assert.equal((await req("/api/runs/nope", { cookie: true })).status, 404);
});

test("S7: security headers on / and /api/runs", async () => {
  for (const p of ["/", "/api/runs"]) {
    const r = await req(p, { cookie: true });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-security-policy"], "default-src 'self'; frame-ancestors 'none'");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
  }
  assert.equal((await req("/api/runs", { cookie: true })).headers["cache-control"], "no-store");
  const runs = JSON.parse((await req("/api/runs?tool=ask-all", { cookie: true })).body);
  assert.equal(runs.runs.length, 1);
  assert.equal(JSON.parse((await req("/api/runs?tool=consensus", { cookie: true })).body).runs.length, 0);
  // Rejections carry the headers too.
  assert.equal((await req("/api/runs")).headers["x-content-type-options"], "nosniff");
});

test("S8: SSE stream carries id + data, passes Last-Event-ID, unsubscribes on close", async () => {
  await ready;
  const got = await new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `127.0.0.1:${port}`, Cookie: `dlb_dash=${TOKEN}`, "Last-Event-ID": "run-1:7" } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        if (buf.includes("\n\n")) { resolve({ headers: res.headers, buf }); r.destroy(); }
      });
    });
    r.on("error", (e) => { if (/** @type {any} */ (e).code !== "ECONNRESET") reject(e); });
    r.end();
  });
  const g = /** @type {any} */ (got);
  assert.equal(g.headers["content-type"], "text/event-stream");
  assert.equal(g.headers["cache-control"], "no-store");
  assert.equal(tail.since, "run-1:7");
  assert.match(g.buf, /^id: run-1:42\ndata: \{.*\}\n\n/);
  assert.ok(!/event:/.test(g.buf));
  assert.match(g.buf, /\[email\]/);
  for (let i = 0; i < 50 && !tail.unsubscribed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(tail.unsubscribed, true);
});

test("S12: /api/config strips URL credentials", async () => {
  cfg.openrouter.apiBase = "https://user:pass@host.example/v1";
  try {
    const r = await req("/api/config", { cookie: true });
    assert.ok(!r.body.includes("user:pass"));
    assert.ok(!r.body.includes("pass@"));
    assert.equal(JSON.parse(r.body).openrouter.apiBase, "https://host.example/v1");
  } finally {
    delete cfg.openrouter.apiBase;
  }
});

/**
 * A second server with its own tailer, listening on a random port.
 * @param {any} t
 */
async function startWith(t) {
  const s = createDashboardServer({ port: 0, token: TOKEN, uiDir, index: createRunIndex({ runsDir }), tailer: t, getConfig: () => cfg, health: async () => ({}), stats: () => ({}) });
  await new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)));
  return { s, p: /** @type {any} */ (s.address()).port };
}

test("S13: SSE drops a client whose buffer never drains", async () => {
  const st = { unsubscribed: false };
  const big = "z".repeat(256 * 1024);
  const { s, p } = await startWith({
    subscribe(/** @type {Function} */ fn) {
      // Far more than the kernel socket buffer plus the 1 MiB cap, written in one tick.
      setImmediate(() => { for (let i = 0; i < 200; i++) fn({ id: `run-1:${i}`, event: { big } }); });
      return () => { st.unsubscribed = true; };
    },
    close() {},
  });
  try {
    const ended = await new Promise((resolve) => {
      const r = http.get({ host: "127.0.0.1", port: p, path: "/api/events", headers: { Host: `127.0.0.1:${p}`, Cookie: `dlb_dash=${TOKEN}` } }, (res) => {
        res.pause(); // never read: the server-side buffer only grows
        res.on("close", () => resolve(true));
        res.on("error", () => resolve(true));
      });
      r.on("error", () => resolve(true));
      setTimeout(() => resolve(false), 5000);
    });
    assert.equal(ended, true);
    for (let i = 0; i < 50 && !st.unsubscribed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(st.unsubscribed, true);
  } finally {
    s.closeAllConnections();
    s.close();
  }
});

test("S14: close() ends open SSE streams and closes the tailer", async () => {
  const st = { closed: false };
  const { s, p } = await startWith({ subscribe: () => () => {}, close() { st.closed = true; } });
  const streamEnded = new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: p, path: "/api/events", headers: { Host: `127.0.0.1:${p}`, Cookie: `dlb_dash=${TOKEN}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(true));
      setImmediate(() => s.close());
    });
  });
  const closed = new Promise((resolve) => s.on("close", () => resolve(true)));
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 3000));
  assert.equal(await Promise.race([Promise.all([streamEnded, closed]).then(() => true), timeout]), true);
  assert.equal(st.closed, true);
});

test("S9: unsafe run id -> 400; unknown route -> 404", async () => {
  const r = await req("/api/runs/..%2Fx", { cookie: true });
  assert.equal(r.status, 400);
  assert.ok(typeof JSON.parse(r.body).error === "string");
  assert.equal((await req("/api/nope", { cookie: true })).status, 404);
});

test("S10: /api/health and /api/stats come from the injected functions", async () => {
  assert.deepEqual(JSON.parse((await req("/api/health", { cookie: true })).body), { providers: [] });
  assert.deepEqual(JSON.parse((await req("/api/stats", { cookie: true })).body), { daily: [] });
});

test("S11: missing UI dir -> 503", async () => {
  const s = createDashboardServer({ port: 0, token: TOKEN, uiDir: path.join(uiDir, "missing"), index: createRunIndex({ runsDir }), tailer, getConfig: () => cfg, health: async () => ({}), stats: () => ({}) });
  await new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)));
  const p = /** @type {any} */ (s.address()).port;
  try {
    const res = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: p, path: "/", headers: { Host: `127.0.0.1:${p}`, Cookie: `dlb_dash=${TOKEN}` } }, (x) => {
        let b = "";
        x.on("data", (c) => { b += c; });
        x.on("end", () => resolve({ status: x.statusCode, body: b }));
      });
    });
    assert.equal(/** @type {any} */ (res).status, 503);
    assert.deepEqual(JSON.parse(/** @type {any} */ (res).body), { error: "dashboard UI not found" });
  } finally {
    s.close();
  }
});

test("S15: a run id whose last UUID group is all digits survives redaction on every route", async () => {
  const id = "0b9f3c1e-8d2a-4c5b-9e7f-123456789012";
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    { v: 1, kind: "run_start", runId: id, at: 1_700_000_000_000, seq: 0, tool: "ask-gpt", workflow: "single", pid: 1, providers: ["codex"] },
    { v: 1, kind: "call_end", runId: id, at: 1_700_000_000_100, seq: 1, callId: "codex-123456789012", provider: "codex", isError: false },
    { v: 1, kind: "run_end", runId: id, at: 1_700_000_000_200, seq: 2, status: "done" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const s = createDashboardServer({
    port: 0, token: TOKEN, uiDir, index: createRunIndex({ runsDir: dir }), getConfig: () => cfg, health: async () => ({}), stats: () => ({}),
    tailer: { subscribe(/** @type {Function} */ fn) { setImmediate(() => fn({ id: `${id}:99`, event: { kind: "call_end", runId: id, callId: "codex-123456789012", seq: 1 } })); return () => {}; }, close() {} },
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)));
  const p = /** @type {any} */ (s.address()).port;
  /** @param {string} u @returns {Promise<{status: number, body: string}>} */
  const get = (u) => new Promise((resolve, reject) => {
    const r = http.get({ host: "127.0.0.1", port: p, path: u, headers: { Host: `127.0.0.1:${p}`, Cookie: `dlb_dash=${TOKEN}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
        if (u === "/api/events" && body.includes("\n\n")) { resolve({ status: /** @type {number} */ (res.statusCode), body }); r.destroy(); }
      });
      res.on("end", () => resolve({ status: /** @type {number} */ (res.statusCode), body }));
    });
    r.on("error", (e) => { if (/** @type {any} */ (e).code !== "ECONNRESET") reject(e); });
  });
  try {
    cfg.dashboard.showPII = false;
    const list = JSON.parse((await get("/api/runs")).body);
    assert.equal(list.runs[0].runId, id);
    const one = await get(`/api/runs/${id}`);
    assert.equal(one.status, 200);
    const detail = JSON.parse(one.body);
    assert.equal(detail.summary.runId, id);
    assert.ok(detail.events.every((/** @type {any} */ e) => e.runId === id));
    assert.equal(detail.events[1].callId, "codex-123456789012");
    const sse = await get("/api/events");
    assert.match(sse.body, new RegExp(`^id: ${id}:99\\n`));
    const data = JSON.parse(sse.body.split("\n").find((l) => l.startsWith("data: ")).slice(6));
    assert.equal(data.runId, id);
    assert.equal(data.callId, "codex-123456789012");
  } finally {
    s.closeAllConnections();
    s.close();
  }
});

test("S16: with showPII off, ?q= matches the redacted prompt, so a search cannot confirm a masked value", async () => {
  cfg.dashboard.showPII = false;
  assert.equal(JSON.parse((await req("/api/runs?q=x%40y.io", { cookie: true })).body).runs.length, 0);
  assert.equal(JSON.parse((await req("/api/runs?q=%5Bemail%5D", { cookie: true })).body).runs.length, 1);
  cfg.dashboard.showPII = true;
  try {
    assert.equal(JSON.parse((await req("/api/runs?q=x%40y.io", { cookie: true })).body).runs.length, 1);
  } finally {
    cfg.dashboard.showPII = false;
  }
});

/**
 * A server over one content-bearing journal run and one legacy session record, with its own
 * mutable config so a test can flip `capture` between requests.
 * @param {string} capture
 */
async function captureFixture(capture) {
  const runs = tmpDir();
  const sessions = tmpDir();
  const jid = "run-cap-1";
  fs.writeFileSync(path.join(runs, `${jid}.jsonl`), [
    { v: 1, kind: "run_start", runId: jid, at: 1_700_000_000_000, seq: 0, tool: "consensus", workflow: "consensus-step", pid: 1, providers: ["codex"], prompt: "SECRETPROMPT" },
    { v: 1, kind: "call_start", runId: jid, at: 1_700_000_000_050, seq: 1, callId: "c1", provider: "codex", role: "peer", round: 1, request: "SECRETREQUEST" },
    { v: 1, kind: "call_end", runId: jid, at: 1_700_000_000_100, seq: 2, callId: "c1", provider: "codex", isError: false, verdict: "REQUEST_CHANGES", response: "SECRETRESPONSE", criticalIssues: [{ category: "bug", description: "SECRETISSUE" }] },
    { v: 1, kind: "arbiter", runId: jid, at: 1_700_000_000_150, seq: 3, action: "adjudicate", round: 1, text: "SECRETARBITER" },
    { v: 1, kind: "run_end", runId: jid, at: 1_700_000_000_200, seq: 4, status: "done", finalReport: "SECRETREPORT" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const lid = "legacy-cap-1";
  fs.writeFileSync(path.join(sessions, `${lid}.json`), JSON.stringify({
    id: lid, parentId: null, schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", tool: "consensus",
    question: "SECRETQUESTION", synthesis: "SECRETSYNTHESIS", blindVerdict: "BLIND_SECRET_TEXT", converged: false, rounds: 1,
    opinions: [{ provider: "grok", text: "SECRETOPINION", verdict: "REJECT", criticalIssues: [{ category: "bug", description: "SECRETLEGACYISSUE" }] }],
  }));
  /** @type {any} */
  const c = { dashboard: { enabled: true, showPII: false, capture } };
  const eventBody = { kind: "call_end", callId: "c1", response: "SECRETRESPONSE", criticalIssues: [{ category: "bug", description: "SECRETISSUE" }] };
  const s = createDashboardServer({
    port: 0, token: TOKEN, uiDir, index: createRunIndex({ runsDir: runs, sessionsDir: sessions, isAlive: () => false }), getConfig: () => c,
    health: async () => ({}), stats: () => ({}),
    tailer: { subscribe(/** @type {Function} */ fn) { setImmediate(() => fn({ id: `${jid}:9`, event: eventBody })); return () => {}; }, close() {} },
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)));
  const p = /** @type {any} */ (s.address()).port;
  /** @param {string} u @returns {Promise<string>} */
  const get = (u) => new Promise((resolve, reject) => {
    const r = http.get({ host: "127.0.0.1", port: p, path: u, headers: { Host: `127.0.0.1:${p}`, Cookie: `dlb_dash=${TOKEN}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; if (u === "/api/events" && body.includes("\n\n")) { resolve(body); r.destroy(); } });
      res.on("end", () => resolve(body));
    });
    r.on("error", (e) => { if (/** @type {any} */ (e).code !== "ECONNRESET") reject(e); });
  });
  return { jid, lid, cfg: c, get, close: () => { s.closeAllConnections(); s.close(); } };
}

test("S17: capture metadata serves no content on /api/runs/:id or SSE, for journal and legacy runs", async () => {
  const f = await captureFixture("metadata");
  try {
    const journal = await f.get(`/api/runs/${f.jid}`);
    const legacy = await f.get(`/api/runs/${f.lid}`);
    const sse = await f.get("/api/events");
    for (const body of [journal, legacy, sse]) assert.ok(!/SECRET/.test(body), body);
    // Verify blindVerdict is stripped in metadata mode.
    assert.ok(!/BLIND_SECRET_TEXT/.test(legacy), "blindVerdict should be stripped in metadata mode");
    // Metadata survives.
    const events = JSON.parse(journal).events;
    assert.equal(events[2].verdict, "REQUEST_CHANGES");
    assert.equal(events[2].criticalIssues[0].category, "bug");
    const rec = JSON.parse(legacy).legacy;
    assert.equal(rec.opinions[0].verdict, "REJECT");
    assert.equal(rec.opinions[0].criticalIssues[0].category, "bug");
    assert.match(sse, /"callId":"c1"/);
    // Hot reload: the very next request serves it once capture is "content".
    f.cfg.dashboard.capture = "content";
    assert.match(await f.get(`/api/runs/${f.jid}`), /SECRETPROMPT/);
    f.cfg.dashboard.capture = "metadata";
    assert.ok(!/SECRET/.test(await f.get(`/api/runs/${f.jid}`)));
  } finally {
    f.close();
  }
});

test("S18: capture content keeps content on /api/runs/:id and SSE, for journal and legacy runs", async () => {
  const f = await captureFixture("content");
  try {
    const journal = await f.get(`/api/runs/${f.jid}`);
    for (const w of ["SECRETPROMPT", "SECRETREQUEST", "SECRETRESPONSE", "SECRETISSUE", "SECRETARBITER", "SECRETREPORT"]) assert.match(journal, new RegExp(w));
    const legacy = await f.get(`/api/runs/${f.lid}`);
    for (const w of ["SECRETQUESTION", "SECRETSYNTHESIS", "SECRETOPINION", "SECRETLEGACYISSUE"]) assert.match(legacy, new RegExp(w));
    // Verify blindVerdict is present in content mode.
    assert.match(legacy, /BLIND_SECRET_TEXT/, "blindVerdict should be present in content mode");
    const sse = await f.get("/api/events");
    assert.match(sse, /SECRETRESPONSE/);
    assert.match(sse, /SECRETISSUE/);
  } finally {
    f.close();
  }
});

test("S19: with capture metadata, ?q= does not match stripped prompt or question text, only tool, provider and runId", async () => {
  const f = await captureFixture("metadata");
  /** @param {string} q */
  const hits = async (q) => JSON.parse(await f.get(`/api/runs?q=${encodeURIComponent(q)}`)).runs.map((/** @type {any} */ r) => r.runId);
  try {
    assert.deepEqual(await hits("SECRETPROMPT"), []);
    assert.deepEqual(await hits("SECRETQUESTION"), []);
    assert.deepEqual(await hits("codex"), [f.jid]);
    assert.deepEqual(await hits("grok"), [f.lid]);
    assert.deepEqual((await hits("cap-1")).sort(), [f.jid, f.lid].sort());
    f.cfg.dashboard.capture = "content";
    assert.deepEqual(await hits("SECRETPROMPT"), [f.jid]);
  } finally {
    f.close();
  }
});

test("S-sh: dashboard.sh names an install that predates the dashboard instead of exiting silently", () => {
  const { spawnSync } = require("node:child_process");
  const old = tmpDir();
  fs.mkdirSync(path.join(old, "server/mcp"), { recursive: true });
  fs.mkdirSync(path.join(old, ".claude-plugin"));
  fs.writeFileSync(path.join(old, "server/mcp/index.js"), "process.exit(1)\n");
  fs.writeFileSync(path.join(old, ".claude-plugin/plugin.json"), '{\n  "name": "deliberation",\n  "version": "3.18.0"\n}\n');
  try {
    const r = spawnSync("bash", [path.join(__dirname, "../scripts/commands/dashboard.sh")], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: old, CLAUDE_CODE_REMOTE: "" }, encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /deliberation 3\.18\.0 at .* has no dashboard; update it/);
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test("S-AN1: /api/analyzer is guarded, masks the project root, and filters by project id", async () => {
  const home = os.homedir();
  const project = { id: "bbbbbbbbbbbb", name: "app", root: path.join(home, "work", "app") };
  const at = Date.now() - 1000;
  const ev = (/** @type {any} */ e, /** @type {number} */ i) => JSON.stringify({ v: 1, runId: "run-an", at: at + i, seq: i, ...e });
  fs.writeFileSync(path.join(runsDir, "run-an.jsonl"), [
    { kind: "run_start", tool: "ask-one", workflow: "single", pid: 999999, procStartedAt: 1, providers: ["grok"], project },
    { kind: "call_start", callId: "c1", provider: "grok", role: "single", promptChars: 10, fileCount: 0, fileBytes: 0, grantedMs: 1000, ceilingSource: "own" },
    { kind: "call_end", callId: "c1", provider: "grok", model: "g", ms: 5, isError: false },
    { kind: "run_end", status: "done" },
  ].map(ev).join("\n") + "\n");
  assert.equal((await req("/api/analyzer")).status, 401);
  cfg.dashboard.showPII = false;
  const body = JSON.parse((await req("/api/analyzer", { cookie: true })).body);
  const row = body.projects.find((/** @type {any} */ r) => r.id === project.id);
  assert.ok(row, "the project row is served");
  assert.ok(!row.root.includes(home), "home dir masked");
  assert.equal(body.window.days, 30);
  const only = JSON.parse((await req(`/api/analyzer?project=${project.id}`, { cookie: true })).body);
  assert.equal(only.runs, 1);
  assert.equal((await req("/api/analyzer?project=..%2Fx", { cookie: true })).status, 400);
  assert.equal((await req("/api/analyzer?days=abc", { cookie: true })).status, 400);
  const runs = JSON.parse((await req(`/api/runs?project=${project.id}`, { cookie: true })).body).runs;
  assert.deepEqual(runs.map((/** @type {any} */ r) => r.runId), ["run-an"]);
});
