"use strict";

/**
 * server/dashboard/stop.js - `deliberation-mcp dashboard --stop`.
 *
 * Signals the PID in the dashboard pidfile only when that PID is provably this dashboard:
 * alive, launched as one of the documented entrypoints with `dashboard` right after it, and
 * started within 2 s of the start time the dashboard recorded. The token probe proves a
 * listener, not a PID, so it never authorizes a signal. Anything unproven is left alone.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Entrypoints, matched as path suffixes at a segment boundary: from source, the npm package,
// and its bin.
const LAUNCHERS = ["server/mcp/index.js", "deliberation-mcp/dist/index.js", "bin/deliberation-mcp"];
const START_TOLERANCE_MS = 2000;
const TERM_WAIT_MS = 5000;
const POLL_MS = 100;

/** @param {string} p @param {string} suffix */
const endsAtSegment = (p, suffix) => p === suffix || p.endsWith(`/${suffix}`);
/** @param {string} p */
const isNode = (p) => /^node/.test(path.basename(p)) || p === process.execPath;

/**
 * True when argv runs a dashboard entrypoint at the script position: `node <script>
 * dashboard ...` or `<bin> dashboard ...`. A launcher path anywhere else does not count.
 * @param {string[]} argv
 * @param {string} [recordedScript]  the dashboard's own process.argv[1], from the pidfile
 * @returns {boolean}
 */
function matchArgv(argv, recordedScript) {
  if (!Array.isArray(argv) || argv.length < 2) return false;
  const at = isNode(argv[0]) ? 1 : 0;
  const script = argv[at];
  if (typeof script !== "string" || argv[at + 1] !== "dashboard") return false;
  return (typeof recordedScript === "string" && script === recordedScript) || LAUNCHERS.some((l) => endsAtSegment(script, l));
}

/**
 * macOS `ps -o lstart=` ("Wed Oct  8 12:00:05 2026", C locale) to epoch ms.
 * @param {string} s
 * @returns {(number|null)}
 */
function parseLstart(s) {
  const t = Date.parse(String(s).trim().replace(/\s+/g, " "));
  return Number.isFinite(t) ? t : null;
}

/**
 * Linux /proc/<pid>/stat to epoch ms: field 22 is ticks since boot. The comm field can hold
 * spaces and parens, so fields are counted after the last ")".
 * @param {string} stat @param {number} btimeSec @param {number} clkTck
 * @returns {(number|null)}
 */
function parseProcStat(stat, btimeSec, clkTck) {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const ticks = Number(stat.slice(close + 1).trim().split(/\s+/)[19]);
  return Number.isFinite(ticks) && clkTck > 0 ? btimeSec * 1000 + Math.round((ticks / clkTck) * 1000) : null;
}

/** @param {string} cmd @param {string[]} args @returns {string} */
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] });

/** The real process probes. Every one returns null instead of throwing. */
const realDeps = {
  platform: process.platform,
  /** @param {number} pid */
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
  },
  /** @param {number} pid @returns {(string[]|null)} */
  argvOf(pid) {
    try {
      if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((a, i, all) => a !== "" || i < all.length - 1);
      // `ps` joins argv with spaces; the caller rejects any shape it cannot split back.
      return run("ps", ["-ww", "-o", "args=", "-p", String(pid)]).trim().split(/\s+/);
    } catch { return null; }
  },
  /** @param {number} pid @returns {(number|null)} */
  startedAtOf(pid) {
    try {
      if (process.platform === "linux") {
        const btime = Number((/^btime\s+(\d+)/m.exec(fs.readFileSync("/proc/stat", "utf8")) || [])[1]);
        let clk = 100;
        try { clk = Number(run("getconf", ["CLK_TCK"]).trim()) || 100; } catch { /* the near-universal default */ }
        return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"), btime, clk);
      }
      return parseLstart(run("ps", ["-o", "lstart=", "-p", String(pid)]));
    } catch { return null; }
  },
  /** @param {number} pid @param {NodeJS.Signals} sig */
  kill(pid, sig) { process.kill(pid, sig); },
  /** @param {number} ms */
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  waitMs: TERM_WAIT_MS,
};

/**
 * Why `pid` is not provably the dashboard the pidfile describes, or null when it is.
 * @param {any} state  the pidfile
 * @param {typeof realDeps} deps
 * @returns {(string|null)}
 */
function unproven(state, deps) {
  if (typeof state.procStartedAt !== "number") return "the pidfile predates --stop (no recorded start time)";
  const argv = deps.argvOf(state.pid);
  if (!argv) return "its command line could not be read";
  const recorded = Array.isArray(state.argv) ? state.argv : null;
  // macOS `ps` splits on spaces: if the recorded argv has an element with whitespace, or the
  // element count differs, the split cannot be trusted.
  if (deps.platform !== "linux" && recorded && (recorded.some((/** @type {any} */ a) => /\s/.test(String(a))) || recorded.length !== argv.length)) return "its command line does not split back into the recorded arguments";
  if (!matchArgv(argv, recorded ? recorded[1] : undefined)) return `it is not running the dashboard (${argv.slice(0, 3).join(" ")})`;
  const started = deps.startedAtOf(state.pid);
  if (started === null) return "its start time could not be read";
  if (Math.abs(started - state.procStartedAt) > START_TOLERANCE_MS) return "it started at a different time than the recorded dashboard (pid reused)";
  return null;
}

/**
 * Stop the dashboard named by the pidfile.
 * @param {string} statePath
 * @param {Partial<typeof realDeps>} [inject]
 * @returns {Promise<{code: number, message: string}>}  0 stopped or nothing running, 1 unsupported, 2 left alone
 */
async function stopDashboard(statePath, inject = {}) {
  const deps = { ...realDeps, ...inject };
  if (deps.platform === "win32") return { code: 1, message: "--stop is not supported on Windows; close the dashboard process (or its terminal) instead" };
  let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* none */ }
  const remove = () => fs.rmSync(statePath, { force: true });
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0) { remove(); return { code: 0, message: "no running dashboard" }; }
  if (!deps.alive(state.pid)) { remove(); return { code: 0, message: "no running dashboard (removed a stale pidfile)" }; }
  const why = unproven(state, deps);
  if (why) return { code: 2, message: `pid ${state.pid} from the pidfile was left alone: ${why}. Stop it yourself if it is the dashboard.` };
  deps.kill(state.pid, "SIGTERM");
  for (let waited = 0; waited < deps.waitMs && deps.alive(state.pid); waited += POLL_MS) await deps.sleep(POLL_MS);
  if (deps.alive(state.pid)) {
    const still = unproven(state, deps);
    if (still) return { code: 2, message: `pid ${state.pid} did not exit on SIGTERM and is no longer provably the dashboard (${still}); not killing it` };
    deps.kill(state.pid, "SIGKILL");
  }
  remove();
  return { code: 0, message: `stopped the dashboard (pid ${state.pid})` };
}

module.exports = { stopDashboard, matchArgv, parseLstart, parseProcStat };
