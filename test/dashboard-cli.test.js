// test/dashboard-cli.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

// Point every resolver at a temp tree BEFORE the modules read process.env.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "delib-dashcli-"));
const configPath = path.join(root, "config.json");
process.env.DELIBERATION_CONFIG = configPath;
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.DELIBERATION_RUNS = path.join(root, "runs");
process.env.DELIBERATION_SESSIONS = path.join(root, "sessions");
const statePath = path.join(root, "cache", "deliberation", "dashboard.json");

const { main, dailyStats, healthReport } = require("../server/dashboard/index.js");

/** @param {object} dashboard */
function writeConfig(dashboard) {
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, dashboard }));
}

function sink() {
  const s = { text: "", write(/** @type {string} */ c) { s.text += c; return true; } };
  return s;
}

test("C1: dashboard.enabled false -> exit 1 naming the key", async () => {
  writeConfig({ enabled: false });
  const out = sink();
  const err = sink();
  assert.equal(await main(["--no-open"], { stdout: out, stderr: err }), 1);
  assert.match(err.text, /dashboard\.enabled/);
  assert.equal(out.text, "");
});

test("C1b: bad flags -> exit 1", async () => {
  writeConfig({ enabled: true });
  const err = sink();
  assert.equal(await main(["--port", "nope", "--no-open"], { stdout: sink(), stderr: err }), 1);
  assert.match(err.text, /--port/);
  assert.equal(await main(["--bogus"], { stdout: sink(), stderr: sink() }), 1);
});

test("C2: port in use -> exit 1 with hint", async () => {
  writeConfig({ enabled: true });
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (blocker.address()).port;
  try {
    const out = sink();
    const err = sink();
    assert.equal(await main(["--port", String(port), "--no-open"], { stdout: out, stderr: err }), 1);
    assert.equal(err.text.trim(), `port ${port} is in use; pass --port`);
    assert.equal(out.text, "");
    assert.ok(!fs.existsSync(statePath));
  } finally {
    blocker.close();
  }
});

test("C3: live pidfile -> prints the existing URL, exit 0, no listener", async () => {
  writeConfig({ enabled: true });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: 45678, token: "f".repeat(64), startedAt: 1 }));
  try {
    const out = sink();
    assert.equal(await main(["--no-open"], { stdout: out, stderr: sink() }), 0);
    assert.equal(out.text, `Deliberation dashboard: http://127.0.0.1:45678/?t=${"f".repeat(64)}\n`);
  } finally {
    fs.rmSync(statePath, { force: true });
  }
});

test("C4: `index.js dashboard --no-open` prints the URL line, writes a 0600 pidfile, removes it on SIGTERM", async () => {
  writeConfig({ enabled: true });
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "mcp", "index.js"), "dashboard", "--no-open", "--port", "0"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  const line = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no URL line; stderr: ${err}`)), 10000);
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("\n")) { clearTimeout(t); resolve(out); }
    });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`exited ${code}; stderr: ${err}`)); });
  });
  child.removeAllListeners("exit");
  const m = /^Deliberation dashboard: http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})\n$/.exec(String(line));
  assert.ok(m, `unexpected line: ${line}`);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.pid, child.pid);
  assert.equal(state.port, Number(m[1]));
  assert.equal(state.token, m[2]);
  if (process.platform !== "win32") assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  await exited;
  assert.ok(!fs.existsSync(statePath));
});

test("dailyStats groups run summaries by UTC day", () => {
  const day = Date.UTC(2026, 8, 27, 23, 0, 0);
  const rows = dailyStats([
    { startedAt: day, tokens: 10, errors: 1 },
    { startedAt: day + 30 * 60 * 1000, tokens: 5, errors: 0 },
    { startedAt: day + 2 * 60 * 60 * 1000, tokens: 1, errors: 2 },
  ]);
  assert.deepEqual(rows, [
    { day: "2026-09-27", runs: 2, tokens: 15, errors: 1 },
    { day: "2026-09-28", runs: 1, tokens: 1, errors: 2 },
  ]);
});

test("healthReport marks unhealthy, needsLogin and panel eligibility", async () => {
  const mk = (/** @type {string} */ name, /** @type {any} */ h) => ({ name, capabilities: {}, health: async () => h, ask: async () => { throw new Error("never called"); } });
  const providers = [mk("codex", { ok: true, needsLogin: true }), mk("gemini", { ok: false, reason: "agy not found" }), mk("grok", { ok: true })];
  const cfg = { providers: { grok: { enabled: true, model: "grok-4.6", reasoningEffort: "high" } }, openrouter: { models: [] } };
  const r = await healthReport({ providers, getConfig: () => cfg });
  assert.deepEqual(r.askAll, ["codex", "grok"]);
  assert.deepEqual(r.consensus, ["codex", "grok"]);
  assert.deepEqual(r.needsLogin, ["codex"]);
  assert.deepEqual(r.unavailable, [{ name: "gemini", reason: "agy not found" }]);
  const grok = r.providers.find((/** @type {any} */ p) => p.name === "grok");
  assert.equal(grok.model, "grok-4.6");
  assert.equal(grok.reasoningEffort, "high");
});
