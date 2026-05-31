"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const cache = require("../server/grok/cache.js");

test("normalize(apiBase) lowercases scheme+host, preserves pathname, strips trailing slash", () => {
  assert.equal(cache.normalize("https://API.x.ai/v1/"), "https://api.x.ai/v1");
  assert.equal(cache.normalize("http://Example.com/Path/"), "http://example.com/Path");
  assert.equal(cache.normalize("https://api.x.ai/v1"), "https://api.x.ai/v1");
});

test("normalize(apiBase) falls back to prepending https:// when scheme is missing", () => {
  assert.equal(cache.normalize("api.x.ai/v1"), "https://api.x.ai/v1");
});

test("normalize(apiBase) throws on garbage input", () => {
  assert.throws(() => cache.normalize("::not a url::"));
});

test("buildCacheKey separates rows on filename, content, key, apiBase", () => {
  const bytes = Buffer.from("hello world");
  const otherBytes = Buffer.from("HELLO WORLD");
  const k1 = cache.buildCacheKey({ bytes, apiKey: "xai-A", apiBase: "https://api.x.ai/v1", filename: "a.tf" });
  const k2 = cache.buildCacheKey({ bytes, apiKey: "xai-A", apiBase: "https://api.x.ai/v1", filename: "b.tf" });
  const k3 = cache.buildCacheKey({ bytes, apiKey: "xai-B", apiBase: "https://api.x.ai/v1", filename: "a.tf" });
  const k4 = cache.buildCacheKey({ bytes, apiKey: "xai-A", apiBase: "https://API.x.ai/v1/", filename: "a.tf" });
  const k5 = cache.buildCacheKey({ bytes: otherBytes, apiKey: "xai-A", apiBase: "https://api.x.ai/v1", filename: "a.tf" });

  assert.notEqual(k1, k2, "different filename → different key");
  assert.notEqual(k1, k3, "different API key → different key");
  assert.equal(k1, k4, "normalised apiBase → same key");
  assert.notEqual(k1, k5, "different content → different key");
});

test("buildCacheKey shape is sha256@keyfp@apibase@filename", () => {
  const bytes = Buffer.from("x");
  const k = cache.buildCacheKey({ bytes, apiKey: "xai-A", apiBase: "https://api.x.ai/v1", filename: "a.tf" });
  const parts = k.split("@");
  assert.equal(parts.length, 4);
  assert.match(parts[0], /^[0-9a-f]{64}$/);
  assert.match(parts[1], /^[0-9a-f]{16}$/);
  assert.equal(parts[2], "https://api.x.ai/v1");
  assert.equal(parts[3], "a.tf");
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tmpCachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-"));
  return path.join(dir, "grok-files.json");
}

test("readCache returns empty object when file missing", () => {
  const p = tmpCachePath();
  const data = cache.readCache(p);
  assert.deepEqual(data, { version: 1, entries: {} });
});

test("readCache treats corrupt JSON as empty (no throw)", () => {
  const p = tmpCachePath();
  fs.writeFileSync(p, "{ not json");
  const data = cache.readCache(p);
  assert.deepEqual(data, { version: 1, entries: {} });
});

test("writeCache then readCache round-trips entries", () => {
  const p = tmpCachePath();
  const payload = { version: 1, entries: { "k1@k2@k3@k4": { fileId: "file_abc", size: 5, filename: "a.tf", uploadedAt: 1, expiresAt: 999, apiBase: "https://api.x.ai/v1", keyFp: "abc" } } };
  cache.writeCache(p, payload);
  assert.deepEqual(cache.readCache(p), payload);
});

test("writeCache is atomic — tmp file does not linger on success", () => {
  const p = tmpCachePath();
  cache.writeCache(p, { version: 1, entries: {} });
  const dir = path.dirname(p);
  const tmps = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
  assert.deepEqual(tmps, [], "no .tmp.* leftover");
});

test("withInflight runs the worker once for concurrent same-key callers", async () => {
  let calls = 0;
  const work = () => new Promise((r) => setTimeout(() => { calls += 1; r("file_xyz"); }, 25));

  const [a, b] = await Promise.all([
    cache.withInflight("k1", work),
    cache.withInflight("k1", work),
  ]);

  assert.equal(a, "file_xyz");
  assert.equal(b, "file_xyz");
  assert.equal(calls, 1, "worker ran exactly once");
});

test("withInflight removes the entry on rejection so next call retries", async () => {
  let attempts = 0;
  const failOnce = () => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok");
  };

  await assert.rejects(cache.withInflight("k2", failOnce), /boom/);
  const ok = await cache.withInflight("k2", failOnce);
  assert.equal(ok, "ok");
  assert.equal(attempts, 2);
});

test("lookup returns null on cache miss", () => {
  const p = tmpCachePath();
  const hit = cache.lookup(p, "missing-key");
  assert.equal(hit, null);
});

test("lookup returns entry on hit when not stale and apiBase+keyFp match", () => {
  const p = tmpCachePath();
  const entry = { fileId: "file_1", size: 5, filename: "a.tf", uploadedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600, apiBase: "https://api.x.ai/v1", keyFp: "abcd" };
  cache.writeCache(p, { version: 1, entries: { "K": entry } });
  const hit = cache.lookup(p, "K", { apiBase: "https://api.x.ai/v1", keyFp: "abcd" });
  assert.deepEqual(hit, entry);
});

test("lookup returns null when expiresAt is within 60s of now (stale)", () => {
  const p = tmpCachePath();
  const entry = { fileId: "file_1", size: 5, filename: "a.tf", uploadedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 30, apiBase: "https://api.x.ai/v1", keyFp: "abcd" };
  cache.writeCache(p, { version: 1, entries: { "K": entry } });
  const hit = cache.lookup(p, "K", { apiBase: "https://api.x.ai/v1", keyFp: "abcd" });
  assert.equal(hit, null);
});

test("lookup returns null when apiBase mismatches", () => {
  const p = tmpCachePath();
  const entry = { fileId: "file_1", size: 5, filename: "a.tf", uploadedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600, apiBase: "https://api.x.ai/v1", keyFp: "abcd" };
  cache.writeCache(p, { version: 1, entries: { "K": entry } });
  const hit = cache.lookup(p, "K", { apiBase: "https://other.example.com/v1", keyFp: "abcd" });
  assert.equal(hit, null);
});

test("store writes an entry under lock", async () => {
  const p = tmpCachePath();
  await cache.store(p, "K2", { fileId: "file_2", size: 8, filename: "b.tf", uploadedAt: 2, expiresAt: 999, apiBase: "https://api.x.ai/v1", keyFp: "abcd" });
  const data = cache.readCache(p);
  assert.equal(data.entries["K2"].fileId, "file_2");
});

test("uploadFile with cache hit returns cached fileId and skips fetch", async () => {
  const idx = require("../server/grok/index.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-up-"));
  const file = path.join(root, "a.tf");
  fs.writeFileSync(file, "content");

  const cacheFile = tmpCachePath();
  const bytes = Buffer.from("content");
  const apiBase = "https://api.x.ai/v1";
  const apiBaseNorm = cache.normalize(apiBase);
  const key = cache.buildCacheKey({ bytes, apiKey: "xai-A", apiBase, filename: "a.tf" });
  const keyFp = require("node:crypto").createHash("sha256").update("xai-A").digest("hex").slice(0, 16);
  const entry = { fileId: "file_CACHED", size: 7, filename: "a.tf", uploadedAt: 1, expiresAt: Math.floor(Date.now()/1000) + 3600, apiBase: apiBaseNorm, keyFp };
  await cache.store(cacheFile, key, entry);

  let fetchCalls = 0;
  const fakeFetch = async () => { fetchCalls += 1; return { ok: true, text: async () => JSON.stringify({ id: "file_NEW" }) }; };

  const result = await idx.uploadFile({
    filePath: "a.tf",
    apiKey: "xai-A",
    apiBase,
    ttl: 86400,
    roots: [root],
    fetchImpl: fakeFetch,
    cacheFile,
  });
  assert.equal(result.id, "file_CACHED");
  assert.equal(fetchCalls, 0, "cache hit avoids network");
});

test("evict removes all rows holding a given fileId", async () => {
  const p = tmpCachePath();
  cache.writeCache(p, {
    version: 1,
    entries: {
      "K1": { fileId: "file_X", size: 1, filename: "a", uploadedAt: 1, expiresAt: 9, apiBase: "x", keyFp: "y" },
      "K2": { fileId: "file_X", size: 1, filename: "b", uploadedAt: 1, expiresAt: 9, apiBase: "x", keyFp: "y" },
      "K3": { fileId: "file_OTHER", size: 1, filename: "c", uploadedAt: 1, expiresAt: 9, apiBase: "x", keyFp: "y" },
    },
  });
  await cache.evict(p, "file_X");
  const data = cache.readCache(p);
  assert.ok(!data.entries["K1"]);
  assert.ok(!data.entries["K2"]);
  assert.ok(data.entries["K3"]);
});

test("runWithFiles with cached fileId that's gone on xAI evicts and retries", async () => {
  const idx = require("../server/grok/index.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-404-"));
  const file = path.join(root, "a.tf");
  fs.writeFileSync(file, "tfcontent");
  const cacheFile = tmpCachePath();

  const bytes = Buffer.from("tfcontent");
  const apiBase = "https://api.x.ai/v1";
  const apiBaseNorm = cache.normalize(apiBase);
  const keyFp = require("node:crypto").createHash("sha256").update("xai-A").digest("hex").slice(0, 16);
  const key = cache.buildCacheKey({ bytes, apiKey: "xai-A", apiBase, filename: "a.tf" });
  await cache.store(cacheFile, key, {
    fileId: "file_STALE",
    size: 9, filename: "a.tf",
    uploadedAt: 1, expiresAt: Math.floor(Date.now()/1000) + 3600,
    apiBase: apiBaseNorm, keyFp,
  });

  let responsesCalls = 0;
  let uploadCalls = 0;
  const fakeFetch = async (url) => {
    const s = String(url);
    if (s.endsWith("/responses")) {
      responsesCalls += 1;
      if (responsesCalls === 1) {
        const e = new Error(`xAI API error 400: ${JSON.stringify({ error: { message: "Invalid file id: file_STALE" } })}`);
        e.status = 400;
        throw e;
      }
      return { ok: true, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }) };
    }
    if (s.endsWith("/files")) {
      uploadCalls += 1;
      return { ok: true, text: async () => JSON.stringify({ id: "file_FRESH" }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  const result = await idx.runWithFiles({
    prompt: "do thing",
    files: [{ path: "a.tf" }],
    apiKey: "xai-A",
    apiBase,
    roots: [root],
    cacheFile,
    fetchImpl: fakeFetch,
  });
  assert.equal(result.text, "ok");
  assert.equal(responsesCalls, 2, "retried once after stale-file 4xx");
  assert.equal(uploadCalls, 1, "re-uploaded the stale file");
  assert.ok(result.ownedIds.includes("file_FRESH"), "fresh re-uploaded id surfaces in ownedIds for MCP response");
});

test("same content + two different filenames produces two cache rows and two uploads", async () => {
  const idx = require("../server/grok/index.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-thrash-"));
  fs.writeFileSync(path.join(root, "a.tf"), "shared");
  fs.writeFileSync(path.join(root, "b.tf"), "shared");
  const cacheFile = tmpCachePath();

  let uploadCount = 0;
  const fakeFetch = async (url) => {
    const s = String(url);
    if (s.endsWith("/files")) {
      uploadCount += 1;
      return { ok: true, text: async () => JSON.stringify({ id: `file_${uploadCount}` }) };
    }
    if (s.endsWith("/responses")) {
      return { ok: true, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "done" }] }] }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  await idx.runWithFiles({
    prompt: "go",
    files: [{ path: "a.tf" }, { path: "b.tf" }],
    apiKey: "xai-A",
    apiBase: "https://api.x.ai/v1",
    roots: [root],
    cacheFile, fetchImpl: fakeFetch,
  });
  assert.equal(uploadCount, 2, "two uploads (different filenames)");

  await idx.runWithFiles({
    prompt: "go again",
    files: [{ path: "a.tf" }, { path: "b.tf" }],
    apiKey: "xai-A",
    apiBase: "https://api.x.ai/v1",
    roots: [root],
    cacheFile, fetchImpl: fakeFetch,
  });
  assert.equal(uploadCount, 2, "no new uploads on second call (all cached)");
});

test("apiBase port difference produces separate cache rows for same bytes", async () => {
  const idx = require("../server/grok/index.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-port-"));
  fs.writeFileSync(path.join(root, "a.tf"), "content");
  const cacheFile = tmpCachePath();

  let uploadCount = 0;
  const fakeFetch = async (url) => {
    const s = String(url);
    if (s.includes("/files")) {
      uploadCount += 1;
      return { ok: true, text: async () => JSON.stringify({ id: `file_${uploadCount}` }) };
    }
    if (s.includes("/responses")) {
      return { ok: true, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  await idx.runWithFiles({
    prompt: "p", files: [{ path: "a.tf" }],
    apiKey: "xai-A", apiBase: "http://localhost:8080",
    roots: [root], cacheFile, fetchImpl: fakeFetch,
  });
  await idx.runWithFiles({
    prompt: "p", files: [{ path: "a.tf" }],
    apiKey: "xai-A", apiBase: "https://localhost:9000",
    roots: [root], cacheFile, fetchImpl: fakeFetch,
  });

  assert.equal(uploadCount, 2, "different apiBase ports → separate uploads");
});

test("mode:inline embeds file content as input_text, never hits /files", async () => {
  const idx = require("../server/grok/index.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-inline-"));
  const body = "line one\nline two\nline three\n";
  fs.writeFileSync(path.join(root, "routes.py"), body);
  const cacheFile = tmpCachePath();

  let filesHits = 0;
  let lastResponsesInput = null;
  const fakeFetch = async (url, init) => {
    const s = String(url);
    if (s.endsWith("/files")) {
      filesHits += 1;
      return { ok: true, text: async () => JSON.stringify({ id: "file_should_not_appear" }) };
    }
    if (s.endsWith("/responses")) {
      lastResponsesInput = JSON.parse(init.body).input;
      return { ok: true, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  const result = await idx.runWithFiles({
    prompt: "review",
    files: [{ path: "routes.py", mode: "inline" }],
    apiKey: "xai-A",
    apiBase: "https://api.x.ai/v1",
    roots: [root],
    cacheFile, fetchImpl: fakeFetch,
  });

  assert.equal(result.text, "ok");
  assert.equal(filesHits, 0, "inline path must not touch xAI Files API");

  const userTurn = lastResponsesInput.find((t) => t.role === "user");
  const inlinePart = userTurn.content.find((p) => p.type === "input_text" && p.text.includes("=== routes.py ==="));
  assert.ok(inlinePart, "inline content present as input_text part");
  assert.ok(inlinePart.text.includes("line one"), "full file body inlined");
  assert.ok(inlinePart.text.includes("line three"), "no truncation");

  assert.deepEqual(result.ownedIds, [], "inline mode produces no uploads → empty ownedIds");
});

test("mode:auto inlines small text files and uploads binary content", async () => {
  const idx = require("../server/grok/index.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auto-"));
  fs.writeFileSync(path.join(root, "small.tf"), "resource \"x\" {}\n".repeat(3000));
  const binBuf = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from("padding".repeat(200))]);
  fs.writeFileSync(path.join(root, "blob.bin"), binBuf);
  const cacheFile = tmpCachePath();

  let filesHits = 0;
  let lastInput = null;
  const fakeFetch = async (url, init) => {
    const s = String(url);
    if (s.endsWith("/files")) { filesHits += 1; return { ok: true, text: async () => JSON.stringify({ id: `file_${filesHits}` }) }; }
    if (s.endsWith("/responses")) {
      lastInput = JSON.parse(init.body).input;
      return { ok: true, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  await idx.runWithFiles({
    prompt: "audit",
    files: [
      { path: "small.tf", mode: "auto" },
      { path: "blob.bin", mode: "auto" },
    ],
    apiKey: "xai-A",
    apiBase: "https://api.x.ai/v1",
    roots: [root],
    cacheFile, fetchImpl: fakeFetch,
  });

  assert.equal(filesHits, 1, "auto: only binary uploaded; text inlined");
  const userTurn = lastInput.find((t) => t.role === "user");
  const parts = userTurn.content;
  assert.ok(parts.some((p) => p.type === "input_text" && p.text.includes("=== small.tf ===")), "text file inlined");
  assert.ok(parts.some((p) => p.type === "input_file" && p.file_id === "file_1"), "binary file uploaded");
});

test("inline dedup is order-independent — {dir} before {path} does not duplicate", async () => {
  const idx = require("../server/grok/index.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-dedup-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export const b = 2;\n");
  const cacheFile = tmpCachePath();

  let lastInput = null;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/responses")) {
      lastInput = JSON.parse(init.body).input;
      return { ok: true, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  await idx.runWithFiles({
    prompt: "go",
    files: [
      { dir: "src", include: ["**/*.ts"], maxFiles: 10, mode: "inline" },
      { path: "src/a.ts", mode: "inline" }, // duplicate of one of the walked files
    ],
    apiKey: "xai-A",
    apiBase: "https://api.x.ai/v1",
    roots: [root],
    cacheFile, fetchImpl: fakeFetch,
  });

  const userTurn = lastInput.find((t) => t.role === "user");
  const aParts = userTurn.content.filter((p) => p.type === "input_text" && p.text.includes("=== a.ts ==="));
  assert.equal(aParts.length, 1, "a.ts inlined exactly once despite dir + path overlap");
});

test("mode:auto falls back to upload when text file exceeds GROK_INLINE_MAX_BYTES", async () => {
  const idx = require("../server/grok/index.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-thresh-"));
  // Force a low threshold to exercise the fallback without writing a huge file.
  const prev = process.env.GROK_INLINE_MAX_BYTES;
  process.env.GROK_INLINE_MAX_BYTES = "1024"; // 1 KB

  // 2 KB of plain text — text + over threshold → must upload.
  fs.writeFileSync(path.join(root, "big.txt"), "a".repeat(2048));
  const cacheFile = tmpCachePath();

  let filesHits = 0;
  const fakeFetch = async (url) => {
    const s = String(url);
    if (s.endsWith("/files")) {
      filesHits += 1;
      return { ok: true, text: async () => JSON.stringify({ id: "file_big" }) };
    }
    if (s.endsWith("/responses")) {
      return { ok: true, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  try {
    const result = await idx.runWithFiles({
      prompt: "audit",
      files: [{ path: "big.txt", mode: "auto" }],
      apiKey: "xai-A",
      apiBase: "https://api.x.ai/v1",
      roots: [root],
      cacheFile, fetchImpl: fakeFetch,
    });
    assert.equal(filesHits, 1, "auto: text >threshold falls back to upload");
    assert.deepEqual(result.ownedIds, ["file_big"], "uploaded id surfaces in ownedIds");
  } finally {
    if (prev === undefined) delete process.env.GROK_INLINE_MAX_BYTES;
    else process.env.GROK_INLINE_MAX_BYTES = prev;
  }
});

test("validateFiles rejects mode on file_id/file_url entries", () => {
  const idx = require("../server/grok/index.js");
  const err1 = idx.validateFiles([{ file_id: "file_xyz", mode: "inline" }]);
  assert.match(err1 || "", /applies only to path\/dir/);
  const err2 = idx.validateFiles([{ file_url: "https://example.com/x", mode: "auto" }]);
  assert.match(err2 || "", /applies only to path\/dir/);
});

test("validateFiles rejects unknown mode values", () => {
  const idx = require("../server/grok/index.js");
  const err = idx.validateFiles([{ path: "x.tf", mode: "yolo" }]);
  assert.match(err || "", /one of: auto, inline, upload/);
});

test("evict is a no-op when cacheFile is null (XAI_DISABLE_FILE_CACHE path)", async () => {
  // Should not throw.
  await cache.evict(null, "file_x");
  await cache.store(null, "K", { fileId: "x", size: 0, filename: "f", uploadedAt: 0, expiresAt: 9, apiBase: "x", keyFp: "y" });
  assert.ok(true);
});

test("runWithFiles 404 recovery is safe when cacheFile is null", async () => {
  const idx = require("../server/grok/index.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-nocache-"));
  fs.writeFileSync(path.join(root, "a.tf"), "tfcontent");

  let responsesCalls = 0;
  let uploadCalls = 0;
  const fakeFetch = async (url) => {
    const s = String(url);
    if (s.endsWith("/responses")) {
      responsesCalls += 1;
      if (responsesCalls === 1) {
        const e = new Error(`xAI API error 400: Invalid file id: file_STALE_NULL`);
        e.status = 400;
        throw e;
      }
      return { ok: true, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }) };
    }
    if (s.endsWith("/files")) {
      uploadCalls += 1;
      return { ok: true, text: async () => JSON.stringify({ id: uploadCalls === 1 ? "file_STALE_NULL" : "file_FRESH" }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  const result = await idx.runWithFiles({
    prompt: "do",
    files: [{ path: "a.tf" }],
    apiKey: "xai-A",
    apiBase: "https://api.x.ai/v1",
    roots: [root],
    cacheFile: null, // simulate XAI_DISABLE_FILE_CACHE=1
    fetchImpl: fakeFetch,
  });
  assert.equal(result.text, "ok");
  assert.equal(responsesCalls, 2);
  assert.equal(uploadCalls, 2, "uploaded once initially + once after eviction");
});
