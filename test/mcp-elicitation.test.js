// test/mcp-elicitation.test.js - the server asking the HOST to show a codex device-login code
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildServer } = require("../server/mcp/index.js");

const config = { providers: {}, openrouter: { maxFanout: 3, models: [] } };
const PROMPT = { url: "https://auth.openai.com/codex/device", code: "ABCD-12345", expiresAt: Date.now() + 15 * 60000 };

/** A server whose outgoing requests land in `sent`. */
function mk() {
  /** @type {any[]} */ const sent = [];
  const srv = /** @type {any} */ (buildServer({ providers: [], getConfig: () => config, write: (/** @type {any} */ m) => sent.push(m) }));
  return { srv, sent };
}

/** @param {any} srv @param {any} capabilities @param {string} [protocolVersion] */
const init = (srv, capabilities, protocolVersion = "2025-11-25") =>
  srv.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities, clientInfo: { name: "t" } } });

test("EL-version: the client's protocol version when supported, the latest when not, the old default when absent", async () => {
  const { srv } = mk();
  for (const v of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) assert.equal((await init(srv, {}, v)).result.protocolVersion, v);
  assert.equal((await init(srv, {}, "2099-01-01")).result.protocolVersion, "2025-11-25");
  const bare = await srv.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  assert.equal(bare.result.protocolVersion, "2024-11-05");
});

test("EL-none: a host without elicitation gets no request - the link rides in the result instead", async () => {
  const { srv, sent } = mk();
  await init(srv, {});
  assert.equal(await srv.confirmLogin(PROMPT, 1000), "none");
  assert.equal(sent.length, 0);
});

test("EL-url: a host that supports URL mode gets the link as a URL elicitation, code in the message", async () => {
  const { srv, sent } = mk();
  await init(srv, { elicitation: { form: {}, url: {} } });
  const pending = srv.confirmLogin(PROMPT, 1000);
  assert.equal(sent.length, 1);
  const req = sent[0];
  assert.equal(req.method, "elicitation/create");
  assert.equal(req.params.mode, "url");
  assert.equal(req.params.url, PROMPT.url);
  assert.match(req.params.message, /ABCD-12345/);
  assert.equal(await srv.handle({ jsonrpc: "2.0", id: req.id, result: { action: "accept" } }), undefined, "a reply is routed, never answered");
  assert.equal(await pending, "accept");
});

test("EL-form: a form-only host gets a dialog carrying link + code; decline means no", async () => {
  const { srv, sent } = mk();
  await init(srv, { elicitation: {} }, "2025-06-18");
  const pending = srv.confirmLogin(PROMPT, 1000);
  const req = sent[0];
  assert.equal(req.params.mode, undefined, "2025-06-18 form requests carry no mode");
  assert.match(req.params.message, /auth\.openai\.com\/codex\/device/);
  assert.match(req.params.message, /ABCD-12345/);
  assert.equal(req.params.requestedSchema.type, "object");
  await srv.handle({ jsonrpc: "2.0", id: req.id, result: { action: "decline" } });
  assert.equal(await pending, "decline");
});

test("EL-error-timeout: an error reply or no reply at all is a no, never a hang", async () => {
  const { srv, sent } = mk();
  await init(srv, { elicitation: { url: {} } });
  const errored = srv.confirmLogin(PROMPT, 1000);
  await srv.handle({ jsonrpc: "2.0", id: sent[0].id, error: { code: -32600, message: "not supported" } });
  assert.equal(await errored, "none");
  const t0 = Date.now();
  assert.equal(await srv.confirmLogin(PROMPT, 50), "none");
  assert.ok(Date.now() - t0 < 1000);
});

test("EL-opinion-message: an errored panel voice carries its (bounded) message, so a login link reaches the host", async () => {
  const codex = {
    name: "codex",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false, walksFilesystem: true },
    async health() { return { ok: true }; },
    async ask() { return { provider: "codex", model: "m", isError: true, errorKind: "auth", retryable: false, message: `\x1b[1mOpen ${PROMPT.url} and enter ${PROMPT.code}\x1b[0m ${"x".repeat(900)}`, ms: 1 }; },
  };
  const srv = /** @type {any} */ (buildServer({ providers: [/** @type {any} */ (codex)], getConfig: () => config }));
  const step = async (/** @type {any} */ args) => JSON.parse((await srv.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "consensus-step", arguments: args } })).result.content[0].text);
  const { sessionId } = await step({ action: "init", prompt: "plan" });
  await step({ action: "record_blind", sessionId, blindVerdict: "VERDICT: APPROVE" });
  const out = await step({ action: "dispatch_peers", sessionId });
  const op = out.opinions.find((/** @type {any} */ o) => o.source === "codex");
  assert.equal(op.isError, true);
  assert.match(op.message, /ABCD-12345/);
  assert.doesNotMatch(op.message, /\x1b/);
  assert.ok(op.message.length <= 503);
});

test("EL-dedupe: two callers waiting on the same code share ONE dialog", async () => {
  const { srv, sent } = mk();
  await init(srv, { elicitation: { url: {} } });
  const a = srv.confirmLogin(PROMPT, 1000);
  const b = srv.confirmLogin(PROMPT, 1000);
  assert.equal(sent.length, 1);
  await srv.handle({ jsonrpc: "2.0", id: sent[0].id, result: { action: "accept" } });
  assert.deepEqual(await Promise.all([a, b]), ["accept", "accept"]);
  const c = srv.confirmLogin(PROMPT, 1000);
  assert.equal(sent.length, 2, "once answered, a later call may ask again");
  await srv.handle({ jsonrpc: "2.0", id: sent[1].id, result: { action: "decline" } });
  assert.equal(await c, "decline");
});

test("EL-version-gate: elicitation only on a negotiated 2025-06-18+, URL mode only on 2025-11-25+", async () => {
  const old = mk();
  await init(old.srv, { elicitation: { url: {} } }, "2025-03-26");
  assert.equal(await old.srv.confirmLogin(PROMPT, 50), "none");
  assert.equal(old.sent.length, 0, "no elicitation before 2025-06-18");
  const mid = mk();
  await init(mid.srv, { elicitation: { form: {}, url: {} } }, "2025-06-18");
  const pending = mid.srv.confirmLogin(PROMPT, 1000);
  assert.equal(mid.sent[0].params.mode, undefined, "2025-06-18 has no URL mode: form");
  await mid.srv.handle({ jsonrpc: "2.0", id: mid.sent[0].id, result: { action: "decline" } });
  await pending;
});

test("EL-stdin: a reply arriving in a LATER chunk releases the tool call that is waiting on it", async () => {
  const { makeLineReader } = require("../server/mcp/index.js");
  /** @type {any[]} */ const out = [];
  /** @type {any} */ let srv;
  const codex = {
    name: "codex",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false, walksFilesystem: true },
    async health() { return { ok: true }; },
    async ask() {
      const ok = (await srv.confirmLogin(PROMPT, 2000)) === "accept";
      return ok ? { provider: "codex", model: "m", text: "answer", isError: false, ms: 1 } : { provider: "codex", model: "m", isError: true, errorKind: "auth", message: "no", ms: 1 };
    },
  };
  srv = buildServer({ providers: [/** @type {any} */ (codex)], getConfig: () => config, write: (/** @type {any} */ m) => out.push(m) });
  const onData = makeLineReader(srv, (/** @type {any} */ m) => out.push(m));
  await onData(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: { elicitation: { url: {} } } } }) + "\n");
  const call = onData(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask-gpt", arguments: { prompt: "q" } } }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  const req = out.find((m) => m.method === "elicitation/create");
  assert.ok(req, "the dialog request went out");
  await onData(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { action: "accept" } }) + "\n");
  await call;
  const res = out.find((m) => m.id === 2);
  assert.ok(res, "the waiting tool call answered");
  assert.match(res.result.content[0].text, /answer/);
  assert.equal(out.filter((m) => m.id === req.id).length, 1, "the reply itself was never answered");
});

test("EL-cancel: a dismissed dialog (cancel) is neither accept nor decline", async () => {
  const { srv, sent } = mk();
  await init(srv, { elicitation: { url: {} } });
  const pending = srv.confirmLogin(PROMPT, 1000);
  await srv.handle({ jsonrpc: "2.0", id: sent[0].id, result: { action: "cancel" } });
  assert.equal(await pending, "none");
});

test("EL-abandon: when every waiter gives up, the host gets notifications/cancelled for the dialog", async () => {
  const { srv, sent } = mk();
  await init(srv, { elicitation: { url: {} } });
  const a = new AbortController(), b = new AbortController();
  const pa = srv.confirmLogin(PROMPT, 5000, a.signal);
  srv.confirmLogin(PROMPT, 5000, b.signal);
  const reqId = sent[0].id;
  a.abort();
  assert.equal(sent.length, 1, "one waiter left: the dialog stays");
  b.abort();
  const cancel = sent.find((m) => m.method === "notifications/cancelled");
  assert.ok(cancel, "cancelled once nobody waits");
  assert.equal(cancel.params.requestId, reqId);
  assert.equal(await pa, "none");
  assert.equal(await srv.handle({ jsonrpc: "2.0", id: reqId, result: { action: "accept" } }), undefined, "a late reply is dropped");
});

test("EL-timeout-cancel: a dialog that times out is cancelled at the host", async () => {
  const { srv, sent } = mk();
  await init(srv, { elicitation: { url: {} } });
  assert.equal(await srv.confirmLogin(PROMPT, 20), "none");
  const cancel = sent.find((m) => m.method === "notifications/cancelled");
  assert.ok(cancel);
  assert.equal(cancel.params.requestId, sent[0].id);
});

test("EL-e2e: over real stdio, a login that dies cancels the open dialog (the wiring, not just each side)", async () => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "el-e2e-"));
  const fake = path.join(home, "codex");
  // Prints a device prompt, then dies before anyone approves.
  fs.writeFileSync(fake, "#!/bin/sh\nprintf 'Open this link\\n   https://auth.openai.com/codex/device\\n\\nEnter this one-time code (expires in 15 minutes)\\n   WXYZ-98765\\n\\n'\nsleep 0.3\nexit 1\n", { mode: 0o755 });
  const srv = spawn(process.execPath, [path.resolve(__dirname, "../server/mcp/index.js")], {
    env: { ...process.env, CODEX_HOME: home, CODEX_BIN: fake, CODEX_API_KEY: "", CODEX_ACCESS_TOKEN: "" }, stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    /** @type {any[]} */ const seen = [];
    const done = new Promise((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(seen.map((m) => m.method || m.id))}`)), 15000);
      srv.stdout.on("data", (d) => {
        buf += d; const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const l of lines) {
          if (!l.trim()) continue;
          const m = JSON.parse(l); seen.push(m);
          if (m.id === 1) srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask-gpt", arguments: { prompt: "q" } } }) + "\n");
          if (m.id === 2) { clearTimeout(t); resolve(m); }
        }
      });
    });
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: { elicitation: { url: {} } }, clientInfo: { name: "e2e" } } }) + "\n");
    const res = /** @type {any} */ (await done);
    const ask = seen.find((m) => m.method === "elicitation/create");
    assert.ok(ask, "the dialog was requested");
    assert.equal(ask.params.url, "https://auth.openai.com/codex/device");
    await new Promise((r) => setTimeout(r, 100));
    const cancel = seen.find((m) => m.method === "notifications/cancelled");
    assert.ok(cancel, "the dead code's dialog was cancelled");
    assert.equal(cancel.params.requestId, ask.id);
    assert.match(res.result.content[0].text, /ended before/);
  } finally {
    srv.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- the codex-login tool ----
/** @param {any} loginResult */
function codexWithLogin(loginResult) {
  let calls = 0;
  const p = {
    name: "codex",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false, walksFilesystem: true },
    async health() { return { ok: true }; },
    async ask() { throw new Error("codex-login must not ask"); },
    async login() { calls++; return loginResult; },
  };
  return { p, calls: () => calls };
}
/** @param {any} srv @param {any} [args] */
const callLogin = async (srv, args = {}) => JSON.parse((await srv.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "codex-login", arguments: args } })).result.content[0].text);

test("EL-login-tool: codex-login is listed and returns the provider's login result as-is", async () => {
  const pending = { status: "pending", url: PROMPT.url, code: PROMPT.code, expiresAt: PROMPT.expiresAt, message: `Open ${PROMPT.url} and enter ${PROMPT.code}` };
  const c = codexWithLogin(pending);
  const srv = /** @type {any} */ (buildServer({ providers: [/** @type {any} */ (c.p)], getConfig: () => config }));
  const listed = (await srv.handle({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} })).result.tools.find((/** @type {any} */ t) => t.name === "codex-login");
  assert.ok(listed, "codex-login is advertised");
  assert.match(listed.description, /device/i);
  assert.deepEqual(await callLogin(srv), pending);
  assert.equal(c.calls(), 1);
});

test("EL-login-tool-unavailable: no codex provider, or GPT disabled in config, is an honest 'unavailable'", async () => {
  const none = /** @type {any} */ (buildServer({ providers: [], getConfig: () => config }));
  assert.equal((await callLogin(none)).status, "unavailable");
  const c = codexWithLogin({ status: "pending" });
  const disabled = /** @type {any} */ (buildServer({ providers: [/** @type {any} */ (c.p)], getConfig: () => ({ ...config, providers: { codex: { enabled: false } } }) }));
  const r = await callLogin(disabled);
  assert.equal(r.status, "unavailable");
  assert.match(r.message, /disabled/);
  assert.equal(c.calls(), 0);
});

test("EL-login-tool-no-cli: a codex that fails its health check (no CLI) is unavailable with the reason; login() is not called", async () => {
  const c = codexWithLogin({ status: "pending" });
  c.p.health = async () => ({ ok: false, reason: "codex CLI not found (tried \"codex\")" });
  const srv = /** @type {any} */ (buildServer({ providers: [/** @type {any} */ (c.p)], getConfig: () => config }));
  const r = await callLogin(srv);
  assert.equal(r.status, "unavailable");
  assert.match(r.message, /CLI not found/);
  assert.equal(c.calls(), 0);
});
