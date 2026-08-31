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

test("HT7: a mid-body socket failure on an OK status is `network`, not `parse`", async () => {
  // Swallowing the body error left an empty body that then failed JSON.parse as
  // `parse` - non-retryable - so the network retry never ran.
  const fakeRes = {
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => { const e = new TypeError("terminated"); throw e; },
  };
  await assert.rejects(
    () => callOpenRouter({
      apiBase: "http://x/v1", apiKey: "k", model: "m",
      messages: buildMessages([{ role: "user", text: "q" }]),
      fetchImpl: async () => fakeRes,
    }),
    (e) => e.code === "network"
  );
});

test("HT8: a body failure on an ERROR status keeps the status (body is only diagnostic)", async () => {
  const fakeRes = {
    ok: false, status: 500,
    headers: { get: () => null },
    text: async () => { throw new TypeError("terminated"); },
  };
  await assert.rejects(
    () => callOpenRouter({
      apiBase: "http://x/v1", apiKey: "k", model: "m",
      messages: buildMessages([{ role: "user", text: "q" }]),
      fetchImpl: async () => fakeRes,
    }),
    (e) => e.status === 500 && e.code === undefined
  );
});

test("HT9: an overflowing Retry-After is dropped rather than forwarded as Infinity", async () => {
  const fakeRes = {
    ok: false, status: 429,
    headers: { get: (h) => (h === "retry-after" ? "1".repeat(400) : null) },
    text: async () => "{}",
  };
  await assert.rejects(
    () => callOpenRouter({
      apiBase: "http://x/v1", apiKey: "k", model: "m",
      messages: buildMessages([{ role: "user", text: "q" }]),
      fetchImpl: async () => fakeRes,
    }),
    (e) => e.status === 429 && e.retryAfterMs === undefined
  );
});

// --- undici's own ceilings -------------------------------------------------
// Node's fetch gives up after headersTimeout (300s) waiting for response headers and
// after bodyTimeout (300s) between chunks, and there is no public API to raise them.
// Both arrive as a bare `TypeError: fetch failed` whose only signal is `cause.code`.
// They used to be classified `network` - which callProvider RETRIES - so a provider
// that merely thought for over five minutes was billed for a second five-minute wait
// and still failed. They are timeouts, and a timeout is never retried.
const undiciFailure = (code) => {
  const e = new TypeError("fetch failed");
  e.cause = Object.assign(new Error(code), { code });
  return e;
};

for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
  test(`HT10: OpenRouter maps ${code} to timeout, not network`, async () => {
    await assert.rejects(
      () => callOpenRouter({
        apiBase: "http://127.0.0.1:1/v1", apiKey: "k", model: "m",
        messages: buildMessages([{ role: "user", text: "q" }]),
        fetchImpl: () => Promise.reject(undiciFailure(code)),
      }),
      (e) => e.code === "timeout" && e.transportCode === code
    );
  });

  test(`HT11: Grok maps ${code} to timeout, not network`, async () => {
    await assert.rejects(
      () => runGrok({
        turns: [{ role: "user", text: "q" }], apiKey: "k", apiBase: "http://127.0.0.1:1/v1",
        fetchImpl: () => Promise.reject(undiciFailure(code)),
      }),
      (e) => e.code === "timeout" && e.transportCode === code
    );
  });
}

test("HT12: a genuine transport fault stays `network` and carries its cause code", async () => {
  await assert.rejects(
    () => callOpenRouter({
      apiBase: "http://127.0.0.1:1/v1", apiKey: "k", model: "m",
      messages: buildMessages([{ role: "user", text: "q" }]),
      fetchImpl: () => Promise.reject(undiciFailure("ECONNRESET")),
    }),
    (e) => e.code === "network" && e.transportCode === "ECONNRESET"
  );
});

test("HT13: an abort is still a timeout even though it carries no undici cause", async () => {
  await assert.rejects(
    () => runGrok({
      turns: [{ role: "user", text: "q" }], apiKey: "k", apiBase: "http://127.0.0.1:1/v1",
      timeoutMs: 5000,
      fetchImpl: () => Promise.reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
    }),
    (e) => e.code === "timeout" && /timed out after 5s/.test(e.message)
  );
});
