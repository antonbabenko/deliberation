"use strict";

/**
 * server/dashboard/index.js - `deliberation-mcp dashboard [--port N] [--no-open]`.
 * CLI parsing, single-instance pidfile, and wiring of the run index, tailer,
 * health and stats into the HTTP server (server.js). Zero runtime deps.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createDashboardServer } = require("./server.js");
const { createRunIndex } = require("./runs.js");
const { createTailer } = require("./tail.js");
const { createJournal } = require("../../core/journal.js");
const { makeRegistry } = require("../../core/registry.js");
const { resolveRunsDir, resolveDashboardStatePath, resolveConfigPath } = require("../../core/paths.js");

// The npm bundle copies the UI next to dist/index.js as dashboard-ui/; the repo serves ui/.
const UI_DIR = [path.join(__dirname, "ui"), path.join(__dirname, "dashboard-ui")].find((d) => fs.existsSync(d)) || path.join(__dirname, "ui");

/**
 * @param {string[]} argv
 * @returns {{port?: number, open: boolean}|{error: string}}
 */
function parseArgs(argv) {
  /** @type {{port?: number, open: boolean}} */ const out = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") out.open = false;
    else if (a === "--port") {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v) || Number(v) > 65535) return { error: "--port needs an integer 0-65535" };
      out.port = Number(v);
    } else return { error: `unknown argument: ${a}` };
  }
  return out;
}

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e).code === "EPERM";
  }
}

/** @param {string} file @returns {any} */
function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** @param {number} port @param {string} token */
const urlLine = (port, token) => `Deliberation dashboard: http://127.0.0.1:${port}/?t=${token}\n`;

/** Best effort; the URL line is already printed. @param {string} url */
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no opener on this machine
  }
}

/**
 * Runs, tokens and errors per UTC day, oldest first.
 * @param {{startedAt: number, tokens: number, errors: number}[]} summaries
 */
function dailyStats(summaries) {
  /** @type {Map<string, {day: string, runs: number, tokens: number, errors: number}>} */
  const days = new Map();
  for (const s of summaries) {
    if (!Number.isFinite(s.startedAt)) continue;
    const day = new Date(s.startedAt).toISOString().slice(0, 10);
    const row = days.get(day) || { day, runs: 0, tokens: 0, errors: 0 };
    row.runs += 1;
    row.tokens += s.tokens || 0;
    row.errors += s.errors || 0;
    days.set(day, row);
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * Provider health as `panel` computes it: the same stat-only probes (never starts a
 * login) and the same registry selection, plus configured model and reasoning effort.
 * @param {{providers: any[], getConfig: () => any}} rt
 */
async function healthReport(rt) {
  const { probeHealth } = require("../mcp/index.js");
  const { unhealthy, needsLogin } = await probeHealth(rt.providers);
  const cfg = rt.getConfig() || {};
  const registry = makeRegistry(rt.providers);
  const sel = { config: cfg, expert: "", unhealthy };
  const askAll = registry.selectForAskAll(sel);
  const consensus = registry.selectForConsensus(sel);
  const askNames = askAll.providers.map((/** @type {any} */ p) => p.name);
  const consNames = consensus.providers.map((/** @type {any} */ p) => p.name);
  const pcfg = cfg.providers || {};
  const providers = rt.providers.map((p) => {
    const c = pcfg[p.name] || {};
    return {
      name: p.name,
      enabled: c.enabled !== false,
      ok: !unhealthy.has(p.name),
      reason: unhealthy.get(p.name) || null,
      needsLogin: needsLogin.has(p.name),
      model: c.model || null,
      reasoningEffort: c.reasoningEffort || null,
      askAll: askNames.includes(p.name),
      consensus: consNames.includes(p.name),
    };
  });
  const models = ((cfg.openrouter && cfg.openrouter.models) || []).map((/** @type {any} */ m) => ({
    name: `openrouter:${m.alias}`,
    model: m.model,
    reasoningEffort: m.reasoning_effort || null,
    askAll: askNames.includes(`openrouter:${m.alias}`),
    consensus: consNames.includes(`openrouter:${m.alias}`),
  }));
  return {
    providers,
    models,
    askAll: askNames,
    consensus: consNames,
    omitted: (askAll.omitted || []).map((/** @type {any} */ o) => (o && o.alias) || String(o)),
    unavailable: askAll.unavailable,
    needsLogin: askNames.filter((n) => needsLogin.has(n)),
  };
}

/**
 * @param {string[]} argv
 * @param {{stdout?: {write: (s: string) => any}, stderr?: {write: (s: string) => any}}} [io]
 * @returns {Promise<number>} exit code; 0 once listening (the server keeps the process alive)
 */
async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const args = parseArgs(argv);
  if ("error" in args) {
    err.write(`${args.error}\nusage: deliberation-mcp dashboard [--port N] [--no-open]\n`);
    return 1;
  }

  const { makeRuntime, buildServer } = require("../mcp/index.js");
  const rt = makeRuntime();
  const cfg = rt.getConfig() || {};
  if (!(cfg.dashboard && cfg.dashboard.enabled === true)) {
    const why = rt.getConfigError();
    err.write(`dashboard is disabled: set dashboard.enabled to true in ${resolveConfigPath()}${why ? ` (config error: ${why})` : ""}\n`);
    return 1;
  }

  const statePath = resolveDashboardStatePath();
  const existing = readState(statePath);
  if (existing && pidAlive(existing.pid) && Number.isInteger(existing.port) && typeof existing.token === "string") {
    out.write(urlLine(existing.port, existing.token));
    return 0;
  }

  const runsDir = resolveRunsDir();
  const dashboardSettings = () => (rt.getConfig() || {}).dashboard || { enabled: false };
  createJournal({ dir: runsDir, getSettings: dashboardSettings }).prune();

  const index = createRunIndex({ runsDir, sessionsDir: rt.sessionsDir });
  const tailer = createTailer({ runsDir });
  // `analyze` reuses the MCP tool handler as-is (debug-log tail + session records);
  // an in-process server with no-op transport, never a provider call.
  const mcp = buildServer({ ...rt, notify: () => {}, write: () => {} });
  const stats = async () => {
    const r = /** @type {any} */ (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "analyze", arguments: {} } }));
    let analysis = {};
    try {
      analysis = JSON.parse(r.result.content[0].text);
    } catch {
      analysis = { error: (r && r.error && r.error.message) || "analyze failed" };
    }
    return { ...analysis, daily: dailyStats(index.list()) };
  };

  const token = crypto.randomBytes(32).toString("hex");
  const port = args.port !== undefined ? args.port : cfg.dashboard.port;
  const server = createDashboardServer({ port, token, uiDir: UI_DIR, index, tailer, getConfig: rt.getConfig, health: () => healthReport(rt), stats });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(undefined));
    });
  } catch (e) {
    tailer.close();
    const code = /** @type {any} */ (e).code;
    err.write(code === "EADDRINUSE" ? `port ${port} is in use; pass --port\n` : `dashboard failed to start: ${String((/** @type {any} */ (e)).message || e)}\n`);
    return 1;
  }
  const bound = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: bound, token, startedAt: Date.now() }), { mode: 0o600 });
  fs.chmodSync(statePath, 0o600); // a stale file keeps its old mode through writeFileSync
  const removeState = () => {
    const s = readState(statePath);
    if (s && s.pid === process.pid) fs.rmSync(statePath, { force: true });
  };
  process.once("exit", removeState);
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    process.once(sig, () => {
      removeState();
      process.exit(0);
    });
  }

  const url = `http://127.0.0.1:${bound}/?t=${token}`;
  out.write(urlLine(bound, token));
  if (args.open) openBrowser(url);
  return 0;
}

module.exports = { main, dailyStats, healthReport };
