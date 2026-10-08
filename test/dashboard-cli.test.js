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

const { main, dailyStats, healthReport, openBrowser, analysisOf } = require("../server/dashboard/index.js");

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

/**
 * Spawn `index.js dashboard --no-open --port 0` and resolve with its URL line.
 * @returns {Promise<{child: import("node:child_process").ChildProcess, port: number, token: string}>}
 */
function spawnDashboard() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "mcp", "index.js"), "dashboard", "--no-open", "--port", "0"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  /** @type {any} */ (child.stderr).on("data", (/** @type {any} */ c) => { err += c; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no URL line; stderr: ${err}`)), 10000);
    const onExit = (/** @type {any} */ code) => { clearTimeout(t); reject(new Error(`exited ${code}; stderr: ${err}`)); };
    child.on("exit", onExit);
    /** @type {any} */ (child.stdout).on("data", (/** @type {any} */ c) => {
      out += c;
      if (!out.includes("\n")) return;
      clearTimeout(t);
      child.removeListener("exit", onExit);
      const m = /^Deliberation dashboard: http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})\n$/.exec(out);
      if (!m) return reject(new Error(`unexpected line: ${out}`));
      resolve({ child, port: Number(m[1]), token: m[2] });
    });
  });
}

/** @param {import("node:child_process").ChildProcess} child @param {NodeJS.Signals} sig */
async function stop(child, sig) {
  const exited = new Promise((r) => child.on("exit", r));
  child.kill(sig);
  await exited;
}

test("C4: `index.js dashboard --no-open` prints the URL line, writes a 0600 pidfile, removes it on SIGTERM", async () => {
  writeConfig({ enabled: true });
  const { child, port, token } = await spawnDashboard();
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.pid, child.pid);
    assert.equal(state.port, port);
    assert.equal(state.token, token);
    if (process.platform !== "win32") assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);

    // C3: a live instance -> a second launch prints ITS url, exit 0, no new listener.
    const out = sink();
    assert.equal(await main(["--no-open"], { stdout: out, stderr: sink() }), 0);
    assert.equal(out.text, `Deliberation dashboard: http://127.0.0.1:${port}/?t=${token}\n`);
  } finally {
    await stop(child, "SIGTERM");
  }
  assert.ok(!fs.existsSync(statePath));
});

test("C5: a pidfile whose live pid is not our dashboard is stale -> a new server starts; SIGHUP cleans up", async () => {
  writeConfig({ enabled: true });
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", () => r(undefined)));
  const deadPort = /** @type {any} */ (probe.address()).port;
  await new Promise((r) => probe.close(() => r(undefined)));
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: deadPort, token: "e".repeat(64), startedAt: 1 }));
  const { child, token } = await spawnDashboard();
  try {
    assert.notEqual(token, "e".repeat(64));
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).pid, child.pid);
  } finally {
    await stop(child, "SIGHUP");
  }
  assert.ok(!fs.existsSync(statePath));
});

test("openBrowser never puts the token on argv; the redirect page is 0600 and carries the URL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delib-dashopen-"));
  const token = "c".repeat(64);
  const url = `http://127.0.0.1:7717/?t=${token}`;
  for (const platform of /** @type {const} */ (["linux", "darwin", "win32"])) {
    /** @type {any[]} */ const calls = [];
    const fake = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      calls.push([cmd, ...args]);
      return { on() {}, unref() {} };
    };
    openBrowser(url, { statePath: path.join(dir, "dashboard.json"), spawn: /** @type {any} */ (fake), platform });
    assert.equal(calls.length, 1);
    for (const a of calls[0]) assert.ok(!String(a).includes(token), `${platform}: ${a}`);
    assert.ok(calls[0].some((/** @type {string} */ a) => a.startsWith("file://")), platform);
  }
  const page = path.join(dir, "dashboard-open.html");
  if (process.platform !== "win32") assert.equal(fs.statSync(page).mode & 0o777, 0o600);
  const html = fs.readFileSync(page, "utf8");
  assert.ok(html.includes(`content="0;url=${url}"`));
  assert.ok(html.includes(`href="${url}"`));
});

test("analysisOf surfaces an analyze error result's own text", () => {
  assert.deepEqual(analysisOf({ result: { content: [{ type: "text", text: JSON.stringify({ error: "invalid-since", detail: "bad" }) }] } }), { error: "invalid-since", detail: "bad" });
  assert.deepEqual(analysisOf({ result: { content: [{ type: "text", text: "boom: not json" }] } }), { error: "boom: not json" });
  assert.deepEqual(analysisOf({ error: { code: -32603, message: "analyze exploded" } }), { error: "analyze exploded" });
  assert.deepEqual(analysisOf({ result: { content: [{ type: "text", text: "{\"stats\":[]}" }] } }), { stats: [] });
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

test("healthReport marks unhealthy, needsLogin and panel eligibility, omitting bare openrouter provider", async () => {
  const mk = (/** @type {string} */ name, /** @type {any} */ h) => ({ name, capabilities: {}, health: async () => h, ask: async () => { throw new Error("never called"); } });
  const providers = [mk("codex", { ok: true, needsLogin: true }), mk("gemini", { ok: false, reason: "agy not found" }), mk("grok", { ok: true }), mk("openrouter", { ok: true })];
  const cfg = { providers: { grok: { enabled: true, model: "grok-4.6", reasoningEffort: "high" } }, openrouter: { models: [{ alias: "deepseek-v4", model: "deepseek/v4" }] } };
  const r = await healthReport({ providers, getConfig: () => cfg });
  assert.deepEqual(r.askAll, ["codex", "grok", "openrouter:deepseek-v4"]);
  assert.deepEqual(r.consensus, ["codex", "grok"]);
  assert.deepEqual(r.needsLogin, ["codex"]);
  assert.deepEqual(r.unavailable, [{ name: "gemini", reason: "agy not found" }]);
  assert.equal(r.providers.find((/** @type {any} */ p) => p.name === "openrouter"), undefined);
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0].name, "openrouter:deepseek-v4");
  const grok = r.providers.find((/** @type {any} */ p) => p.name === "grok");
  assert.equal(grok.model, "grok-4.6");
  assert.equal(grok.reasoningEffort, "high");
});

test("C-older: an older dashboard still on the port (answers ?t= with a 302) is named as possibly older, with --port kept", async () => {
  writeConfig({ enabled: true });
  const http = require("node:http");
  const old = http.createServer((_q, s) => { s.writeHead(302, { Location: "/" }); s.end(); });
  await new Promise((r) => old.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (old.address()).port;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port, token: "f".repeat(64), startedAt: 1 }));
  try {
    const err = sink();
    assert.equal(await main(["--no-open", "--port", String(port)], { stdout: sink(), stderr: err }), 1);
    assert.equal(err.text, `port ${port} is in use and did not answer as this dashboard; the pidfile names pid ${process.pid}, possibly an older dashboard; pass --port, or free the port\n`);
  } finally {
    await new Promise((r) => old.close(() => r(undefined)));
    fs.rmSync(statePath, { force: true });
  }
});

test("C-stop: --stop ends a running dashboard (recorded procStartedAt + argv), then reports nothing running", { skip: process.platform === "win32" }, async () => {
  writeConfig({ enabled: true });
  const { child } = await spawnDashboard();
  const exited = new Promise((r) => child.on("exit", r));
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(typeof state.procStartedAt, "number");
    assert.equal(state.argv[2], "dashboard", "node, script, then the subcommand");
    const out = sink();
    const err = sink();
    const code = await main(["--stop"], { stdout: out, stderr: err });
    if (code === 2 && /could not be read/.test(err.text)) return; // no ps//proc in this sandbox
    assert.equal(code, 0, err.text);
    assert.match(out.text, /stopped the dashboard/);
    await exited;
    assert.ok(!fs.existsSync(statePath));
    const again = sink();
    assert.equal(await main(["--stop"], { stdout: again, stderr: sink() }), 0);
    assert.match(again.text, /no running dashboard/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stop(child, "SIGKILL");
  }
});

test("C-stop-args: --stop takes no other flags", async () => {
  const err = sink();
  assert.equal(await main(["--stop", "--port", "1"], { stdout: sink(), stderr: err }), 1);
  assert.match(err.text, /--stop/);
});

test("C-restart: dashboard-restart.sh replaces a running dashboard with a fresh token, then --stop cleans up", { skip: process.platform === "win32" }, async () => {
  writeConfig({ enabled: true });
  const { spawnSync } = require("node:child_process");
  const repo = path.join(__dirname, "..");
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: repo, CLAUDE_CODE_REMOTE: "" };
  const script = path.join(repo, "scripts/commands/dashboard-restart.sh");
  const tokenOf = (/** @type {string} */ s) => (/\?t=([0-9a-f]{64})/.exec(s) || [])[1];
  const first = spawnSync("bash", [script, "--no-open", "--port", "0"], { env, encoding: "utf8", timeout: 30000 });
  try {
    if (first.status === 3 || /could not be read/.test(first.stderr)) return; // no ps//proc in this sandbox
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const t1 = tokenOf(first.stdout);
    assert.ok(t1, first.stdout);
    const second = spawnSync("bash", [script, "--no-open", "--port", "0"], { env, encoding: "utf8", timeout: 30000 });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /stopped the dashboard/);
    const t2 = tokenOf(second.stdout);
    assert.ok(t2 && t2 !== t1, "a restart prints a new token");
  } finally {
    const out = sink();
    await main(["--stop"], { stdout: out, stderr: sink() });
  }
  assert.ok(!fs.existsSync(statePath));
});
