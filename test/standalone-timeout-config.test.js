// test/standalone-timeout-config.test.js
"use strict";
// `/ask-grok`, `/ask-gemini` and `/ask-openrouter` call the STANDALONE bridges, not the
// unified MCP server. Wiring the timeout only into the unified server's composition root
// left those three pinned to their built-ins (grok 180s, gemini 300s, openrouter 180s)
// no matter what `providers.defaults.timeout` said - so the one knob that is supposed to
// cover every provider silently missed half the surface.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withConfig(raw, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-cfg-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  const prev = process.env.DELIBERATION_CONFIG;
  process.env.DELIBERATION_CONFIG = file;
  // The bridges resolve the config path at require time, so load them fresh.
  for (const k of Object.keys(require.cache)) {
    if (k.includes("/server/") || k.includes("/core/paths.js")) delete require.cache[k];
  }
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.DELIBERATION_CONFIG; else process.env.DELIBERATION_CONFIG = prev;
    for (const k of Object.keys(require.cache)) {
      if (k.includes("/server/") || k.includes("/core/paths.js")) delete require.cache[k];
    }
  }
}

test("ST1: the config layer merges providers.defaults.timeout onto every provider", () => {
  withConfig({ version: 1, providers: { defaults: { timeout: 600000 } } }, () => {
    const { validateConfig } = require("../server/openrouter/config.js");
    const { resolved } = validateConfig({ version: 1, providers: { defaults: { timeout: 600000 } } });
    // This is what each standalone bridge reads to find its ceiling.
    for (const name of ["codex", "gemini", "grok", "openrouter"]) {
      assert.equal(resolved.providers[name].timeout, 600000, `${name} carries the shared ceiling`);
    }
  });
});

test("ST2: the Grok bridge sends the configured ceiling when the call passes none", async () => {
  await withConfig({ version: 1, providers: { defaults: { timeout: 600000 }, grok: { enabled: true } } }, async () => {
    const grok = require("../server/grok/index.js");
    let seenTimeout = null;
    const fetchImpl = async (_url, init) => {
      // runGrok arms an AbortController with the resolved ceiling; assert via the value
      // the bridge resolved rather than by racing the timer.
      seenTimeout = init && init.signal ? "armed" : "none";
      return { ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ output_text: "ok" }) };
    };
    // configuredTimeout() is what feeds the handler; verify it reads the merged value.
    assert.equal(typeof grok.configuredTimeout, "function", "bridge exposes configuredTimeout for this check");
    assert.equal(grok.configuredTimeout(), 600000);
    await grok.runGrok({ turns: [{ role: "user", text: "q" }], apiKey: "k", apiBase: "http://x/v1", fetchImpl });
    assert.equal(seenTimeout, "armed");
  });
});

test("ST3: the Gemini bridge reads the configured ceiling", () => {
  withConfig({ version: 1, providers: { defaults: { timeout: 600000 }, gemini: { enabled: true } } }, () => {
    const gem = require("../server/gemini/index.js");
    assert.equal(typeof gem.configuredTimeout, "function", "bridge exposes configuredTimeout for this check");
    assert.equal(gem.configuredTimeout(), 600000);
  });
});

test("ST4: a per-provider timeout still beats the shared default in the resolved config", () => {
  const { validateConfig } = require("../server/openrouter/config.js");
  const { resolved } = validateConfig({
    version: 1,
    providers: { defaults: { timeout: 600000 }, gemini: { enabled: true, timeout: 90000 } },
  });
  assert.equal(resolved.providers.gemini.timeout, 90000);
  assert.equal(resolved.providers.grok.timeout, 600000);
});
