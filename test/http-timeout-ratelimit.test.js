// test/http-timeout-ratelimit.test.js
"use strict";
// Two invariants shared by both HTTP bridges (OpenRouter, Grok):
//   1. the per-call timeout covers the RESPONSE BODY, not just the headers. Clearing the
//      timer once headers arrived left res.text() unbounded - a slow body could run tens
//      of minutes past a ceiling that sibling calls died exactly on.
//   2. a 429 forwards the upstream's Retry-After hint so callProvider can honor it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { callOpenRouter, buildMessages } = require("../server/openrouter/index.js");
const { runGrok } = require("../server/grok/index.js");

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

// Send headers + a first chunk, then stall forever without ending the response. The
// client has a complete set of headers, so only a body-covering timeout can break out.
function stallingBody(res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.write('{"choices":');
  // deliberately never res.end()
}

test("HT1: OpenRouter times out on a stalled BODY, not just on headers", async () => {
  const { server } = await startMock((req, res) => stallingBody(res));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await assert.rejects(
      () => callOpenRouter({
        apiBase: base, apiKey: "k", model: "m",
        messages: buildMessages([{ role: "user", text: "q" }]), timeoutMs: 400,
      }),
      (e) => e.code === "timeout"
    );
  } finally { server.close(); }
});

test("HT2: Grok times out on a stalled BODY, not just on headers", async () => {
  const { server } = await startMock((req, res) => stallingBody(res));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await assert.rejects(
      () => runGrok({ turns: [{ role: "user", text: "q" }], apiKey: "k", apiBase: base, timeoutMs: 400 }),
      (e) => e.code === "timeout"
    );
  } finally { server.close(); }
});

test("HT3: an OpenRouter 429 carries the Retry-After hint as retryAfterMs", async () => {
  const { server, base } = await startMock((req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    res.end(JSON.stringify({ error: "slow down" }));
  });
  try {
    await assert.rejects(
      () => callOpenRouter({ apiBase: base, apiKey: "k", model: "m", messages: buildMessages([{ role: "user", text: "q" }]) }),
      (e) => e.status === 429 && e.retryAfterMs === 7000
    );
  } finally { server.close(); }
});

test("HT4: a Grok 429 carries the Retry-After hint as retryAfterMs", async () => {
  const { server, base } = await startMock((req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
    res.end(JSON.stringify({ error: "rate limited" }));
  });
  try {
    await assert.rejects(
      () => runGrok({ turns: [{ role: "user", text: "q" }], apiKey: "k", apiBase: base }),
      (e) => e.status === 429 && e.retryAfterMs === 3000
    );
  } finally { server.close(); }
});

test("HT5: a 429 with no Retry-After sets no hint (caller falls back to its default)", async () => {
  const { server, base } = await startMock((req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "slow down" }));
  });
  try {
    await assert.rejects(
      () => callOpenRouter({ apiBase: base, apiKey: "k", model: "m", messages: buildMessages([{ role: "user", text: "q" }]) }),
      (e) => e.status === 429 && e.retryAfterMs === undefined
    );
  } finally { server.close(); }
});

test("HT6: a non-429 error does NOT pick up a Retry-After hint", async () => {
  const { server, base } = await startMock((req, res) => {
    res.writeHead(500, { "content-type": "application/json", "retry-after": "9" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  try {
    await assert.rejects(
      () => callOpenRouter({ apiBase: base, apiKey: "k", model: "m", messages: buildMessages([{ role: "user", text: "q" }]) }),
      (e) => e.status === 500 && e.retryAfterMs === undefined
    );
  } finally { server.close(); }
});
