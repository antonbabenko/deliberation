"use strict";

/**
 * server/dashboard/index.js - `deliberation-mcp dashboard [--port N] [--no-open]`.
 * CLI parsing, single-instance pidfile, and wiring of the run index, tailer,
 * health and stats into the HTTP server (server.js). Zero runtime deps.
 */

const fs = require("node:fs");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createDashboardServer } = require("./server.js");
const { createRunIndex } = require("./runs.js");
const { stopDashboard } = require("./stop.js");

const INDEX_MAX_RUNS = 2000;
const INDEX_MAX_FILE_BYTES = 5 * 1024 * 1024;
const { createTailer } = require("./tail.js");
const { createJournal } = require("../../core/journal.js");
const { makeRegistry } = require("../../core/registry.js");
const { resolveRunsDir, resolveDashboardStatePath, resolveConfigPath } = require("../../core/paths.js");

// The npm bundle copies the UI next to dist/index.js as dashboard-ui/; the repo serves ui/.
const UI_DIR = [path.join(__dirname, "ui"), path.join(__dirname, "dashboard-ui")].find((d) => fs.existsSync(d)) || path.join(__dirname, "ui");

/**
 * @param {string[]} argv
 * @returns {{port?: number, open: boolean, stop?: boolean}|{error: string}}
 */
function parseArgs(argv) {
  /** @type {{port?: number, open: boolean, stop?: boolean}} */ const out = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") out.open = false;
    else if (a === "--stop") out.stop = true;
    else if (a === "--port") {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v) || Number(v) > 65535) return { error: "--port needs an integer 0-65535" };
      out.port = Number(v);
    } else return { error: `unknown argument: ${a}` };
  }
  if (out.stop && argv.length > 1) return { error: "--stop takes no other flags" };
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

/** @param {string} statePath */
const openerPath = (statePath) => path.join(path.dirname(statePath), "dashboard-open.html");

/**
 * Best effort; the URL line is already printed. The tokenized URL never goes on a child's
 * argv (readable by other local users through ps or /proc): it goes into a 0600 redirect
 * page next to the pidfile, and the opener gets that file's path.
 * @param {string} url  built from an integer port and a hex token, so it needs no escaping
 * @param {{statePath: string, spawn?: typeof spawn, platform?: NodeJS.Platform}} opts
 */
function openBrowser(url, opts) {
  const spawnFn = opts.spawn || spawn;
  const platform = opts.platform || process.platform;
  const file = openerPath(opts.statePath);
  try {
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url}"><title>Deliberation dashboard</title><a href="${url}">Open the dashboard</a>\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    return;
  }
  const target = pathToFileURL(file).href;
  const [cmd, args] = platform === "darwin" ? ["open", [target]]
    : platform === "win32" ? ["cmd", ["/c", "start", "", target]]
    : ["xdg-open", [target]];
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no opener on this machine
  }
}

/**
 * True only when a dashboard answers the token on `port` with its 302: a live pid alone
 * may be an unrelated process that reused it.
 * @param {number} port @param {string} token @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function probeInstance(port, token, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/?t=${token}`, headers: { Host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 && String(res.headers["set-cookie"] || "").startsWith("dlb_dash="));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

/**
 * The `analyze` tool's result as an object; an error result surfaces its own text.
 * @param {any} r  JSON-RPC response from the in-process MCP server
 * @returns {Record<string, unknown>}
 */
function analysisOf(r) {
  const text = r && r.result && Array.isArray(r.result.content) && r.result.content[0] && r.result.content[0].text;
  if (typeof text !== "string") return { error: (r && r.error && r.error.message) || "analyze returned no result" };
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { error: text };
  } catch {
    return { error: text };
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
  const providers = rt.providers
    .filter((p) => p.name !== "openrouter")
    .map((p) => {
      const c = pcfg[p.name] || {};
      return {
        name: p.name,
        enabled: c.enabled !== false,
        ok: !unhealthy.has(p.name),
        reason: unhealthy.get(p.name) || null,
        needsLogin: needsLogin.has(p.name),
        ...(p.resolveSettings?.({prompt:""})||require("../../core/settings.js").resolveSettings(p.name,cfg)),
        reasoningEffort: c.reasoningEffort || null,
        askAll: askNames.includes(p.name),
        consensus: consNames.includes(p.name),
      };
    });
  const models = ((cfg.openrouter && cfg.openrouter.models) || []).map((/** @type {any} */ m) => ({
    name: `openrouter:${m.alias}`,
    ...require("../../core/settings.js").resolveSettings(`openrouter:${m.alias}`,cfg),
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
    err.write(`${args.error}\nusage: deliberation-mcp dashboard [--port N] [--no-open] | --stop\n`);
    return 1;
  }
  // Works with the dashboard disabled too: stopping must not depend on today's config.
  if (args.stop) {
    const r = await stopDashboard(resolveDashboardStatePath());
    (r.code === 0 ? out : err).write(`${r.message}\n`);
    return r.code;
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
  if (existing && pidAlive(existing.pid) && Number.isInteger(existing.port) && typeof existing.token === "string" && await probeInstance(existing.port, existing.token)) {
    out.write(urlLine(existing.port, existing.token));
    return 0;
  }

  const runsDir = resolveRunsDir();
  const dashboardSettings = () => (rt.getConfig() || {}).dashboard || { enabled: false };
  createJournal({ dir: runsDir, getSettings: dashboardSettings }).prune();

  // Bounded: the newest INDEX_MAX_RUNS journals, and none bigger than INDEX_MAX_FILE_BYTES
  // (counted as truncated). Without this every view re-read every journal ever kept.
  const index = createRunIndex({ runsDir, sessionsDir: rt.sessionsDir, maxRecords: INDEX_MAX_RUNS, maxFileBytes: INDEX_MAX_FILE_BYTES });
  const tailer = createTailer({ runsDir });
  // `analyze` reuses the MCP tool handler as-is (debug-log tail + session records);
  // an in-process server with no-op transport, never a provider call.
  const mcp = buildServer({ ...rt, notify: () => {}, write: () => {} });
  const stats = async (filters={}) => {
    const r = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "analyze", arguments: {...filters,groupBy:"config",configuredOnly:false} } });
    const report=analysisOf(r);return { ...report, daily: dailyStats(/** @type {any} */(report).cohortRuns||[]) };
  };

  const token = crypto.randomBytes(32).toString("hex");
  const port = args.port !== undefined ? args.port : cfg.dashboard.port;
  const server = createDashboardServer({ port, token, uiDir: UI_DIR, index, tailer, getConfig: rt.getConfig, runtimeReport:()=>({dashboardRuntimeId:mcp.history.runtimeId,runtimes:require('../../core/config-history.js').readRuntimes(path.join(runsDir,'..','history')),note:'Only processes with dashboard journaling enabled are discoverable. Heartbeat freshness is observation, not proof of liveness.'}), health: () => healthReport(rt), stats });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(undefined));
    });
  } catch (e) {
    tailer.close();
    const code = /** @type {any} */ (e).code;
    // The pidfile names this port and a live pid, but the probe above failed: most likely an
    // older dashboard (it answers ?t= differently). The pid may also have been reused, so name
    // it without claiming it or telling the user to stop it, and keep --port as the way out.
    const older = code === "EADDRINUSE" && existing && existing.port === port && pidAlive(existing.pid);
    err.write(older ? `port ${port} is in use and did not answer as this dashboard; the pidfile names pid ${existing.pid}, possibly an older dashboard; pass --port, or free the port\n`
      : code === "EADDRINUSE" ? `port ${port} is in use; pass --port\n`
      : `dashboard failed to start: ${String((/** @type {any} */ (e)).message || e)}\n`);
    return 1;
  }
  const bound = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  server.on("error", (e) => err.write(`dashboard server error: ${String((e && e.message) || e)}\n`));

  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  // procStartedAt + argv let --stop prove a pid is this dashboard before signalling it.
  fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: bound, token, startedAt: Date.now(), procStartedAt: Math.round(Date.now() - process.uptime() * 1000), argv: process.argv }), { mode: 0o600 });
  fs.chmodSync(statePath, 0o600); // a stale file keeps its old mode through writeFileSync
  const removeState = () => {
    const s = readState(statePath);
    if (s && s.pid === process.pid) fs.rmSync(statePath, { force: true });
    fs.rmSync(openerPath(statePath), { force: true });
  };
  process.once("exit", removeState);
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.once(sig, () => {
      removeState();mcp.close();
      process.exit(0);
    });
  }

  const url = `http://127.0.0.1:${bound}/?t=${token}`;
  out.write(urlLine(bound, token));
  if (args.open) openBrowser(url, { statePath });
  return 0;
}

module.exports = { main, dailyStats, healthReport, openBrowser, analysisOf };
