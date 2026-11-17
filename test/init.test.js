// test/init.test.js - `deliberation-mcp init`: config plan/merge, idempotence, detection,
// ping and demo paths.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runInit, planConfig, parseArgs, detectHost } = require("../server/mcp/init.js");
const { buildServer, probeHealth } = require("../server/mcp/index.js");
const { makeConfigReader } = require("../server/openrouter/config.js");

const SECRET = "sk-or-v1-test-secret-value";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "delib-init-"));

/** A fake provider: health ok/unhealthy, ask returns `reply` or an error kind. */
function fake(name, { healthy = true, needsLogin = false, fail = null, reply = "**Verdict**: APPROVE\nLooks fine." } = {}) {
  const calls = [];
  return {
    name, calls,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return healthy ? { ok: true, ...(needsLogin ? { needsLogin: true } : {}) } : { ok: false, reason: "missing" }; },
    async ask(req) {
      calls.push(req);
      if (fail) return { provider: name, model: "m", isError: true, errorKind: fail, retryable: false, ms: 1 };
      return { provider: name, model: "m", isError: false, text: reply, ms: 1 };
    },
  };
}

/** runInit deps around a temp HOME, fake providers and the real config reader + engine. */
function setup(home, providers, extraEnv = {}) {
  const env = { HOME: home, OPENROUTER_API_KEY: SECRET, ...extraEnv };
  const file = path.join(home, ".config", "deliberation", "config.json");
  const reader = makeConfigReader(file, env);
  const lines = [];
  const deps = {
    env, home, isTTY: false,
    out: (l) => lines.push(l),
    makeRuntime: () => ({ providers, getConfig: () => reader.get().resolved }),
    buildServer, probeHealth,
  };
  return { deps, lines, file, text: () => lines.join("\n") };
}

test("planConfig: fresh config enables only what was found and writes no model records", () => {
  const { next, changes, kept } = planConfig(null, ["openrouter"]);
  assert.deepEqual(next.providers, { openrouter: { enabled: true } });
  assert.equal(next.models, undefined);
  assert.deepEqual(changes, ["providers.openrouter.enabled: true"]);
  assert.deepEqual(kept, []);
});

test("planConfig: merge adds missing enables, keeps enabled:false and other keys, never mutates input", () => {
  const existing = { version: 1, providers: { openrouter: { enabled: false, apiBase: "x" }, grok: { model: "g" } }, models: { a: { model: "m" } } };
  const snapshot = JSON.stringify(existing);
  const { next, changes, kept } = planConfig(existing, ["openrouter", "grok", "codex"]);
  assert.equal(JSON.stringify(existing), snapshot);
  assert.deepEqual(next.providers.openrouter, { enabled: false, apiBase: "x" });
  assert.deepEqual(next.providers.grok, { model: "g", enabled: true });
  assert.deepEqual(next.providers.codex, { enabled: true });
  assert.deepEqual(next.models, existing.models);
  assert.deepEqual(changes, ["providers.grok.enabled: true", "providers.codex.enabled: true"]);
  assert.deepEqual(kept, ["providers.openrouter.enabled: false"]);
  // Planning the result again changes nothing.
  assert.deepEqual(planConfig(next, ["openrouter", "grok", "codex"]).changes, []);
});

test("parseArgs / detectHost", () => {
  assert.deepEqual(parseArgs(["--yes", "--no-demo"]), { yes: true, demo: false, help: false });
  assert.match(String(parseArgs(["--bogus"]).error), /unknown option/);
  assert.equal(detectHost({ CLAUDECODE: "1" }), "Claude Code");
  assert.equal(detectHost({ GEMINI_CLI: "1" }), "Gemini CLI");
  assert.equal(detectHost({}), null);
});

test("unknown flag exits 2 before touching anything", async () => {
  const home = tmp();
  const { deps, file } = setup(home, [fake("openrouter")]);
  assert.equal(await runInit(["--nope"], deps), 2);
  assert.equal(fs.existsSync(file), false);
});

test("fresh run: writes config, pings, runs the demo, prints the install line; second run changes nothing", async () => {
  const home = tmp();
  const or = fake("openrouter");
  const grok = fake("grok", { fail: "auth" });
  const providers = [fake("codex", { healthy: false }), fake("gemini", { healthy: false }), grok, or];
  const first = setup(home, providers, { XAI_API_KEY: "xai-secret" });
  assert.equal(await runInit([], first.deps), 0);
  const out1 = first.text();
  const cfg = JSON.parse(fs.readFileSync(first.file, "utf8"));
  assert.deepEqual(cfg.providers, { grok: { enabled: true }, openrouter: { enabled: true } });
  assert.equal(cfg.models, undefined);
  assert.match(out1, /ping OpenRouter: OK/);
  assert.match(out1, /ping Grok \(xAI\): FAIL auth/);
  assert.match(out1, /demo verdict: APPROVE/);
  assert.match(out1, /openrouter:glm-5-3-flashx|openrouter:gpt-6-1-sol/); // built-in panel voices answered
  assert.match(out1, /install for your host:/);
  assert.ok(!out1.includes(SECRET) && !out1.includes("xai-secret"), "key values must never be printed");
  // The demo is one round, low effort.
  const demoCall = or.calls.find((c) => c.prompt !== "Reply with the single word OK.");
  assert.ok(demoCall, "demo reached the OpenRouter provider");

  const bytes = fs.readFileSync(first.file, "utf8");
  const mtime = fs.statSync(first.file).mtimeMs;
  const second = setup(home, providers, { XAI_API_KEY: "xai-secret" });
  assert.equal(await runInit([], second.deps), 0);
  const out2 = second.text();
  assert.match(out2, /existing setup/);
  assert.match(out2, /config: no changes/);
  assert.match(out2, /demo: skipped/);
  assert.equal(fs.readFileSync(first.file, "utf8"), bytes);
  assert.equal(fs.statSync(first.file).mtimeMs, mtime);
});

test("existing config: diff shown, not applied without --yes off a TTY, user's enabled:false kept", async () => {
  const home = tmp();
  const file = path.join(home, ".config", "deliberation", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ version: 1, providers: { openrouter: { enabled: false } }, routing: { maxFanout: 3 } }, null, 2);
  fs.writeFileSync(file, original);
  const or = fake("openrouter");
  const providers = [fake("codex", { healthy: false }), fake("gemini", { healthy: false }), fake("grok"), or];

  const a = setup(home, providers, { XAI_API_KEY: "k" });
  assert.equal(await runInit(["--no-demo"], a.deps), 0);
  assert.match(a.text(), /keeping your providers\.openrouter\.enabled: false/);
  assert.match(a.text(), /\+ providers\.grok\.enabled: true/);
  assert.match(a.text(), /not changed \(rerun with --yes/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(or.calls.length, 0, "a disabled provider is not pinged");

  const b = setup(home, providers, { XAI_API_KEY: "k" });
  b.deps.isTTY = true;
  b.deps.confirm = async () => false;
  await runInit(["--no-demo"], b.deps);
  assert.equal(fs.readFileSync(file, "utf8"), original);

  const c = setup(home, providers, { XAI_API_KEY: "k" });
  assert.equal(await runInit(["--yes", "--no-demo"], c.deps), 0);
  const merged = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(merged.providers, { openrouter: { enabled: false }, grok: { enabled: true } });
  assert.deepEqual(merged.routing, { maxFanout: 3 });

  const d = setup(home, providers, { XAI_API_KEY: "k" });
  await runInit(["--yes", "--no-demo"], d.deps);
  assert.match(d.text(), /config: no changes/);
});

test("invalid existing config is left alone and init exits 1", async () => {
  const home = tmp();
  const file = path.join(home, ".config", "deliberation", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const s = setup(home, [fake("openrouter")]);
  assert.equal(await runInit(["--yes"], s.deps), 1);
  assert.match(s.text(), /not valid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("no provider answers the ping: exit 1, no demo", async () => {
  const home = tmp();
  const or = fake("openrouter", { fail: "auth" });
  const s = setup(home, [fake("codex", { healthy: false }), fake("gemini", { healthy: false }), fake("grok", { healthy: false }), or]);
  assert.equal(await runInit([], s.deps), 1);
  assert.match(s.text(), /ping OpenRouter: FAIL auth/);
  assert.doesNotMatch(s.text(), /demo verdict/);
  assert.equal(or.calls.length, 1);
});

test("detection with a fake env and PATH (real runtime, child process)", { skip: process.platform === "win32" }, () => {
  const home = tmp();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(__dirname, "fixtures", "fake-agy.sh"), path.join(bin, "agy"));
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(bin, "agy"), 0o755);
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "server", "mcp", "index.js"), "init", "--no-demo"], {
    encoding: "utf8", timeout: 60000,
    env: {
      HOME: home, PATH: `${bin}:/usr/bin:/bin`, CODEX_HOME: path.join(home, ".codex"),
      GEMINI_API_KEY: "gem-secret-value", DELIBERATION_DISABLE_OS_SANDBOX: "1", GEMINI_MIN_ANSWER_CHARS: "0",
      CDG_ARGV_LOG: path.join(home, "argv.log"),
    },
  });
  const out = r.stdout;
  assert.equal(r.status, 0, out + r.stderr);
  assert.match(out, /found: Gemini \(agy\)/);
  assert.match(out, /GPT \(codex\): installed, not logged in/);
  assert.match(out, /XAI_API_KEY not set/);
  assert.match(out, /GEMINI_API_KEY is set/);
  assert.match(out, /ping Gemini \(agy\): OK/);
  assert.ok(!out.includes("gem-secret-value"));
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".config", "deliberation", "config.json"), "utf8"));
  assert.deepEqual(cfg.providers, { gemini: { enabled: true } });
});
