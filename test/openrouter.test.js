"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { callOpenRouter, classifyError, buildMessages, isNonEmptyString } = require("../server/openrouter/index.js");

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}
function reply(res, status, obj) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

test("O1: buildMessages emits system + user with inline blocks appended", () => {
  const msgs = buildMessages([
    { role: "system", text: "sys" },
    { role: "user", text: "hi", inlineBlocks: ["=== a.txt ===\nAAA"] },
  ]);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.match(msgs[1].content, /hi/);
  assert.match(msgs[1].content, /AAA/);
});

test("O2: callOpenRouter posts chat/completions and returns assistant text", async () => {
  let received = null;
  const { server, base } = await startMock((req, res, body) => {
    received = { url: req.url, auth: req.headers["authorization"], body: JSON.parse(body) };
    return reply(res, 200, { choices: [{ message: { role: "assistant", content: "the answer" } }] });
  });
  try {
    const out = await callOpenRouter({
      apiBase: base, apiKey: "sk-test", model: "openai/gpt-5.5",
      messages: buildMessages([{ role: "user", text: "q" }]),
    });
    assert.equal(out.text, "the answer");
    assert.equal(received.url, "/v1/chat/completions");
    assert.equal(received.auth, "Bearer sk-test");
    assert.equal(received.body.model, "openai/gpt-5.5");
  } finally { server.close(); }
});

test("O3: empty key sends NO Authorization header (keyless local endpoints)", async () => {
  let auth = "unset";
  const { server, base } = await startMock((req, res) => {
    auth = req.headers["authorization"] || null;
    return reply(res, 200, { choices: [{ message: { content: "ok" } }] });
  });
  try {
    await callOpenRouter({ apiBase: base, apiKey: "", model: "m", messages: buildMessages([{ role: "user", text: "q" }]) });
    assert.equal(auth, null);
  } finally { server.close(); }
});

test("O4: classifyError maps HTTP status and error codes", () => {
  assert.equal(classifyError(401, null).errorKind, "auth");
  assert.equal(classifyError(429, null).errorKind, "rate-limit");
  assert.equal(classifyError(503, null).errorKind, "upstream");
  assert.equal(classifyError(null, "timeout").errorKind, "timeout");
  assert.equal(classifyError(null, "timeout").retryable, true);
});

test("O5: non-2xx surfaces a status-tagged error", async () => {
  const { server, base } = await startMock((req, res) => reply(res, 429, { error: "slow down" }));
  try {
    await assert.rejects(
      () => callOpenRouter({ apiBase: base, apiKey: "k", model: "m", messages: buildMessages([{ role: "user", text: "q" }]) }),
      (e) => e.status === 429
    );
  } finally { server.close(); }
});
