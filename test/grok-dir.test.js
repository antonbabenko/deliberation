"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const idx = require("../server/grok/index.js");

function tmpTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-dir-"));
  for (const [rel, contents] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

test("validateFiles accepts {dir, include, exclude, maxFiles, maxBytes}", () => {
  const err = idx.validateFiles([{ dir: "modules", include: ["**/*.tf"], maxFiles: 10 }]);
  assert.equal(err, null);
});

test("validateFiles rejects {dir} combined with {path}", () => {
  const err = idx.validateFiles([{ dir: "a", path: "b" }]);
  assert.match(err || "", /exactly one of/);
});

test("validateFiles rejects {dir} with backslashes in include pattern", () => {
  const err = idx.validateFiles([{ dir: "a", include: ["src\\*.tf"] }]);
  assert.match(err || "", /backslash/i);
});

module.exports = { tmpTree };

test("resolveFiles expands {dir} to multiple uploads with dedup against {path}", async () => {
  const root = tmpTree({
    "modules/a.tf": "AA",
    "modules/b.tf": "BB",
    "modules/c.md": "ignore me",
    "modules/sub/d.tf": "DD",
  });
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-")), "cache.json");

  let uploads = 0;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/files")) {
      uploads += 1;
      return { ok: true, text: async () => JSON.stringify({ id: `file_${uploads}` }) };
    }
    return { ok: true, text: async () => "{}" };
  };

  const { refs } = await idx.resolveFiles(
    [
      { path: "modules/a.tf" },
      { dir: "modules", include: ["**/*.tf"], maxFiles: 100, maxBytes: 1024 * 1024 },
    ],
    {
      apiKey: "xai-A",
      apiBase: "https://api.x.ai/v1",
      ttl: 86400,
      roots: [root],
      cwd: root,
      cacheFile,
      fetchImpl: fakeFetch,
      cid: "test",
    },
  );

  assert.equal(refs.length, 3, "a.tf + b.tf + sub/d.tf (c.md excluded by include)");
  assert.equal(uploads, 3, "no duplicate uploads even though a.tf appears in both path and dir entries");
});

test("dir expansion errors when maxFiles is exceeded", async () => {
  const root = tmpTree({ "x/a.tf": "1", "x/b.tf": "2", "x/c.tf": "3" });
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-")), "cache.json");
  await assert.rejects(
    idx.resolveFiles([{ dir: "x", maxFiles: 2 }], {
      apiKey: "xai-A", apiBase: "https://api.x.ai/v1", ttl: 86400,
      roots: [root], cwd: root, cacheFile, cid: "test",
      fetchImpl: async () => ({ ok: true, text: async () => "{}" }),
    }),
    /exceeds maxFiles=2/,
  );
});

test("dir expansion picks first root that has the directory", async () => {
  const a = tmpTree({ "modules/from-a.tf": "AA" });
  const b = tmpTree({ "modules/from-b.tf": "BB" });
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-")), "cache.json");

  let uploads = 0;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/files")) { uploads += 1; return { ok: true, text: async () => JSON.stringify({ id: `file_${uploads}` }) }; }
    return { ok: true, text: async () => "{}" };
  };

  const { refs } = await idx.resolveFiles(
    [{ dir: "modules", include: ["**/*.tf"], maxFiles: 50, maxBytes: 1024 * 1024 }],
    { apiKey: "xai-A", apiBase: "https://api.x.ai/v1", ttl: 86400, roots: [a, b], cacheFile, cid: "t", fetchImpl: fakeFetch },
  );

  assert.equal(refs.length, 1, "first root wins -> only from-a.tf");
});

test("default exclude blocks .terraform at walked root", async () => {
  const root = tmpTree({
    "main.tf": "root-content",
    ".terraform/modules/foo/main.tf": "vendored-content",
  });
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-")), "cache.json");
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/files")) return { ok: true, text: async () => JSON.stringify({ id: "f1" }) };
    return { ok: true, text: async () => "{}" };
  };
  const { refs } = await idx.resolveFiles(
    [{ dir: ".", include: ["main.tf"] }],
    { apiKey: "xai-T", apiBase: "https://api.x.ai/v1", ttl: 3600,
      roots: [root], cwd: root, cacheFile, fetchImpl: fakeFetch, cid: "test" },
  );
  assert.equal(refs.length, 1);
  assert.equal(path.basename(refs[0].sourcePath), "main.tf");
  assert.ok(!refs[0].sourcePath.includes(".terraform"), "must not match vendored copy");
});

test("caller exclude is appended to defaults", async () => {
  const root = tmpTree({
    "main.tf": "root-content",
    "node_modules/pkg/main.tf": "pkg-content",
    "custom/main.tf": "custom-content",
  });
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-")), "cache.json");
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/files")) return { ok: true, text: async () => JSON.stringify({ id: "f1" }) };
    return { ok: true, text: async () => "{}" };
  };
  const { refs } = await idx.resolveFiles(
    [{ dir: ".", include: ["**/main.tf"], exclude: ["**/custom/**"] }],
    { apiKey: "xai-T", apiBase: "https://api.x.ai/v1", ttl: 3600,
      roots: [root], cwd: root, cacheFile, fetchImpl: fakeFetch, cid: "test" },
  );
  assert.equal(refs.length, 1);
  assert.equal(path.basename(refs[0].sourcePath), "main.tf");
  assert.ok(!refs[0].sourcePath.includes("node_modules"), "default exclude still applies");
  assert.ok(!refs[0].sourcePath.includes("custom"), "caller exclude appended");
});

test("excludeReset:true disables default exclude", async () => {
  const root = tmpTree({
    "main.tf": "root-content",
    "vendor/foo/main.tf": "vendored-content",
  });
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-")), "cache.json");
  let uploads = 0;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/files")) { uploads++; return { ok: true, text: async () => JSON.stringify({ id: `f${uploads}` }) }; }
    return { ok: true, text: async () => "{}" };
  };
  const { refs } = await idx.resolveFiles(
    [{ dir: ".", include: ["**/main.tf"], excludeReset: true }],
    { apiKey: "xai-T", apiBase: "https://api.x.ai/v1", ttl: 3600,
      roots: [root], cwd: root, cacheFile, fetchImpl: fakeFetch, cid: "test" },
  );
  assert.equal(refs.length, 2);
  const hasVendored = refs.some(r => r.sourcePath.includes(path.join("vendor", "foo")));
  assert.ok(hasVendored, "vendored copy walked because defaults disabled");
});

test("validateFiles rejects non-boolean excludeReset on {dir}", () => {
  const err = idx.validateFiles([{ dir: "a", excludeReset: "true" }]);
  assert.match(err || "", /excludeReset.*boolean/i);
});

test("validateFiles rejects non-boolean excludeReset on {path}", () => {
  const err = idx.validateFiles([{ path: "a.txt", excludeReset: 1 }]);
  assert.match(err || "", /excludeReset.*boolean/i);
});
