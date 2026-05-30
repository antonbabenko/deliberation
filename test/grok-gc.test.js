"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const admin = require("../server/grok/files-admin.js");
const cache = require("../server/grok/cache.js");

function tmpCachePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-gc-")), "cache.json");
}

test("gc prunes local rows whose fileId is absent from remote list", async () => {
  const p = tmpCachePath();
  const keyFp = require("node:crypto").createHash("sha256").update("xai-A").digest("hex").slice(0, 16);
  const apiBase = cache.normalize("https://api.x.ai/v1");
  cache.writeCache(p, {
    version: 1,
    entries: {
      "K1": { fileId: "file_alive", size: 1, filename: "a", uploadedAt: 1, expiresAt: 9999999999, apiBase, keyFp },
      "K2": { fileId: "file_gone",  size: 1, filename: "b", uploadedAt: 1, expiresAt: 9999999999, apiBase, keyFp },
    },
  });

  const fakeFetch = async () => ({ ok: true, text: async () => JSON.stringify({ data: [{ id: "file_alive", filename: "deliberation-foo", created_at: 1 }] }) });

  const result = await admin.gc({
    cacheFile: p,
    apiKey: "xai-A",
    apiBase: "https://api.x.ai/v1",
    fetchImpl: fakeFetch,
  });

  assert.equal(result.prunedLocal, 1);
  const data = cache.readCache(p);
  assert.ok(data.entries["K1"]);
  assert.ok(!data.entries["K2"]);
});

test("gc aborts when list fails and leaves cache untouched", async () => {
  const p = tmpCachePath();
  const keyFp = require("node:crypto").createHash("sha256").update("xai-A").digest("hex").slice(0, 16);
  cache.writeCache(p, {
    version: 1,
    entries: { "K": { fileId: "file_x", size: 1, filename: "a", uploadedAt: 1, expiresAt: 99, apiBase: cache.normalize("https://api.x.ai/v1"), keyFp } },
  });
  const fakeFetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(
    admin.gc({ cacheFile: p, apiKey: "xai-A", apiBase: "https://api.x.ai/v1", fetchImpl: fakeFetch }),
    /gc aborted/,
  );
  const data = cache.readCache(p);
  assert.ok(data.entries["K"]);
});

test("gc default skips foreign keyFp rows", async () => {
  const p = tmpCachePath();
  const apiBase = cache.normalize("https://api.x.ai/v1");
  const myKeyFp = require("node:crypto").createHash("sha256").update("xai-CURRENT").digest("hex").slice(0, 16);
  cache.writeCache(p, {
    version: 1,
    entries: {
      "MINE":    { fileId: "file_alive", size: 1, filename: "a", uploadedAt: 1, expiresAt: 9999999999, apiBase, keyFp: myKeyFp },
      "FOREIGN": { fileId: "file_other", size: 1, filename: "b", uploadedAt: 1, expiresAt: 9999999999, apiBase, keyFp: "00000000beefbeef" },
    },
  });
  const fakeFetch = async () => ({ ok: true, text: async () => JSON.stringify({ data: [{ id: "file_alive", filename: "deliberation-x", created_at: 1 }] }) });
  const result = await admin.gc({
    cacheFile: p,
    apiKey: "xai-CURRENT",
    apiBase: "https://api.x.ai/v1",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.prunedLocal, 0);
  const data = cache.readCache(p);
  assert.ok(data.entries["FOREIGN"]);
});

test("gc --all-keys leaves foreign row when fileId absent (conservative)", async () => {
  const p = tmpCachePath();
  const apiBase = cache.normalize("https://api.x.ai/v1");
  cache.writeCache(p, {
    version: 1,
    entries: { "FOREIGN": { fileId: "file_other", size: 1, filename: "b", uploadedAt: 1, expiresAt: 9999999999, apiBase, keyFp: "00000000beefbeef" } },
  });
  const fakeFetch = async () => ({ ok: true, text: async () => JSON.stringify({ data: [] }) });
  const result = await admin.gc({
    cacheFile: p, apiKey: "xai-CURRENT", apiBase: "https://api.x.ai/v1",
    fetchImpl: fakeFetch, allKeys: true, forceLocalPrune: false,
  });
  assert.equal(result.prunedLocal, 0);
  assert.ok(cache.readCache(p).entries["FOREIGN"]);
});

test("gc --all-keys --force-local-prune drops foreign rows whose fileId is absent", async () => {
  const p = tmpCachePath();
  const apiBase = cache.normalize("https://api.x.ai/v1");
  cache.writeCache(p, {
    version: 1,
    entries: { "FOREIGN": { fileId: "file_other", size: 1, filename: "b", uploadedAt: 1, expiresAt: 9999999999, apiBase, keyFp: "00000000beefbeef" } },
  });
  const fakeFetch = async () => ({ ok: true, text: async () => JSON.stringify({ data: [] }) });
  const result = await admin.gc({
    cacheFile: p, apiKey: "xai-CURRENT", apiBase: "https://api.x.ai/v1",
    fetchImpl: fakeFetch, allKeys: true, forceLocalPrune: true,
  });
  assert.equal(result.prunedLocal, 1);
});
