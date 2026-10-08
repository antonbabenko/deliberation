"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const idx = require("../server/grok/index.js");
const cache = require("../server/grok/cache.js");

test("validateFiles accepts {dir} with Windows-style backslash path", () => {
  const err = idx.validateFiles([{ dir: "C:\\project\\modules", include: ["**/*.tf"] }]);
  assert.equal(err, null, `expected null, got ${err}`);
});

test("validateFiles rejects include pattern containing backslashes", () => {
  const err = idx.validateFiles([{ dir: ".", include: ["src\\*.tf"] }]);
  assert.match(err || "", /backslash/i);
});

test("normalize(apiBase) without scheme uses https:// fallback", () => {
  assert.equal(cache.normalize("api.x.ai/v1"), "https://api.x.ai/v1");
});

test("normalize(apiBase) throws clear error on truly invalid input", () => {
  assert.throws(() => cache.normalize("::not a url::"), /Invalid|URL/i);
});

test("validateFiles: headBytes allowed on path entries only, positive integer, not with mode upload", () => {
  assert.equal(idx.validateFiles([{ path: "a.md", headBytes: 100 }]), null);
  assert.equal(idx.validateFiles([{ path: "a.md", headBytes: 100, mode: "inline" }]), null);
  assert.match(idx.validateFiles([{ dir: ".", headBytes: 100 }]) || "", /only to path/);
  assert.match(idx.validateFiles([{ file_id: "f", headBytes: 100 }]) || "", /only to path/);
  assert.match(idx.validateFiles([{ file_url: "https://x", headBytes: 100 }]) || "", /only to path/);
  for (const v of [0, -5, 1.5, "100"]) assert.match(idx.validateFiles([{ path: "a.md", headBytes: v }]) || "", /positive integer/);
  assert.match(idx.validateFiles([{ path: "a.md", headBytes: 100, mode: "upload" }]) || "", /upload/);
  assert.equal(idx.validateFiles([{ dir: ".", maxBytes: 1000 }]), null, "dir maxBytes is unchanged");
});

test("uploadFile: headBytes reads only the head and returns it inline, never uploading", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-head-"));
  fs.writeFileSync(path.join(dir, "big.md"), "line\n".repeat(20000));
  const fetchImpl = async () => { throw new Error("must not upload"); };
  const out = await idx.uploadFile({ filePath: "big.md", apiKey: "k", roots: [fs.realpathSync(dir)], fetchImpl, headBytes: 1000 });
  assert.equal(out._inline, true);
  assert.match(out.inline_text, /^line\n[\s\S]*\n\[truncated: first \d+ of 100000 bytes\]$/);
  assert.ok(out._bytes <= 1000 + 64);
  await assert.rejects(idx.uploadFile({ filePath: "big.md", apiKey: "k", roots: [fs.realpathSync(dir)], fetchImpl, headBytes: 10, mode: "upload" }), /upload/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runWithFiles validates files itself (the unified adapter skips the tool handler)", async () => {
  await assert.rejects(idx.runWithFiles({ files: [{ dir: ".", headBytes: 10 }], prompt: "p", apiKey: "k" }), /only to path/);
});
