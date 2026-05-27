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
