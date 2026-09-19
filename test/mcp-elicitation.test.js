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
  assert.equal(await srv.confirmLogin(PROMPT, 1000), false);
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
  assert.equal(await pending, true);
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
  assert.equal(await pending, false);
});

test("EL-error-timeout: an error reply or no reply at all is a no, never a hang", async () => {
  const { srv, sent } = mk();
  await init(srv, { elicitation: { url: {} } });
  const errored = srv.confirmLogin(PROMPT, 1000);
  await srv.handle({ jsonrpc: "2.0", id: sent[0].id, error: { code: -32600, message: "not supported" } });
  assert.equal(await errored, false);
  const t0 = Date.now();
  assert.equal(await srv.confirmLogin(PROMPT, 50), false);
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
