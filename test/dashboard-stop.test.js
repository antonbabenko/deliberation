"use strict";
// `deliberation-mcp dashboard --stop`: signal a PID only when it is provably this dashboard.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { matchArgv, parseLstart, parseProcStat, stopDashboard } = require("../server/dashboard/stop.js");

const NODE = "/usr/local/bin/node";

test("ST1: the launcher must sit at the script position, followed by `dashboard`", () => {
  assert.equal(matchArgv([NODE, "/x/server/mcp/index.js", "dashboard", "--no-open"]), true);
  assert.equal(matchArgv([NODE, "/n/lib/node_modules/@antonbabenko/deliberation-mcp/dist/index.js", "dashboard"]), true);
  assert.equal(matchArgv(["/n/bin/deliberation-mcp", "dashboard"]), true);
  assert.equal(matchArgv([NODE, "/n/bin/deliberation-mcp", "dashboard"]), true);
  assert.equal(matchArgv([NODE, "/weird/place.js", "dashboard"], "/weird/place.js"), true, "the recorded argv[1] matches exactly");
  assert.equal(matchArgv([NODE, "app.js", "/x/server/mcp/index.js", "dashboard"]), false, "a launcher later in argv is not the script");
  assert.equal(matchArgv([NODE, "/x/dist/index.js.bak", "dashboard"]), false);
  assert.equal(matchArgv([NODE, "app.js", "dashboard.json"]), false);
  assert.equal(matchArgv([NODE, "/x/server/mcp/index.js"]), false);
  assert.equal(matchArgv([NODE, "/x/myserver/mcp/index.js", "dashboard"]), false, "segment boundary");
  assert.equal(matchArgv([]), false);
});

test("ST2: start-time parsers: macOS lstart and Linux /proc stat with btime", () => {
  const t = parseLstart("Wed Oct  8 12:00:05 2026");
  assert.equal(new Date(/** @type {number} */ (t)).getSeconds(), 5);
  assert.equal(parseLstart("garbage"), null);
  // field 22 = 500 ticks after boot, CLK_TCK 100, btime 1_800_000_000 s
  const stat = "1234 (node (x) y) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 11 0 500 1000 100";
  assert.equal(parseProcStat(stat, 1_800_000_000, 100), 1_800_000_005_000);
  assert.equal(parseProcStat("nonsense", 1, 100), null);
});

/** Injectable process probes; `procs` maps pid -> {argv, startedAt}. */
function fakeDeps(/** @type {Record<number, any>} */ procs, opts = /** @type {any} */ ({})) {
  /** @type {any[]} */
  const signals = [];
  return {
    signals,
    deps: {
      platform: opts.platform || "darwin",
      alive: (/** @type {number} */ pid) => !!procs[pid],
      argvOf: (/** @type {number} */ pid) => (procs[pid] ? procs[pid].argv : null),
      startedAtOf: (/** @type {number} */ pid) => (procs[pid] ? procs[pid].startedAt : null),
      kill: (/** @type {number} */ pid, /** @type {string} */ sig) => {
        signals.push([pid, sig]);
        if (opts.onSignal) opts.onSignal(pid, sig, procs);
        else delete procs[pid];
      },
      sleep: async () => {},
      waitMs: 50,
    },
  };
}

function stateFile(/** @type {any} */ state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-stop-"));
  const file = path.join(dir, "dashboard.json");
  if (state) fs.writeFileSync(file, JSON.stringify(state));
  return file;
}
const ours = { argv: [NODE, "/x/server/mcp/index.js", "dashboard"], startedAt: 1_000_000 };
const pidfile = { pid: 42, port: 4000, token: "t", procStartedAt: 1_000_500, argv: ours.argv };

test("ST3: a provable dashboard is stopped with SIGTERM and the pidfile removed", async () => {
  const file = stateFile(pidfile);
  const { deps, signals } = fakeDeps({ 42: { ...ours } });
  const r = await stopDashboard(file, deps);
  assert.equal(r.code, 0);
  assert.deepEqual(signals, [[42, "SIGTERM"]]);
  assert.equal(fs.existsSync(file), false);
});

test("ST4: a dead pid or no pidfile: nothing to stop, exit 0", async () => {
  const dead = stateFile(pidfile);
  const a = await stopDashboard(dead, fakeDeps({}).deps);
  assert.equal(a.code, 0);
  assert.equal(fs.existsSync(dead), false);
  const none = await stopDashboard(stateFile(null), fakeDeps({}).deps);
  assert.equal(none.code, 0);
});

test("ST5: alive but not provably ours is never signalled, keeps the pidfile, exits 2", async () => {
  for (const proc of [
    { argv: [NODE, "other.js"], startedAt: 1_000_000 },
    { argv: ours.argv, startedAt: 9_000_000 },
  ]) {
    const file = stateFile(pidfile);
    const { deps, signals } = fakeDeps({ 42: proc });
    const r = await stopDashboard(file, deps);
    assert.equal(r.code, 2);
    assert.deepEqual(signals, []);
    assert.equal(fs.existsSync(file), true);
  }
  const old = stateFile({ pid: 42, port: 1, token: "t", startedAt: 1 });
  const r = await stopDashboard(old, fakeDeps({ 42: { ...ours } }).deps);
  assert.equal(r.code, 2, "an old pidfile without procStartedAt cannot be proven");
});

test("ST6: a hung dashboard gets SIGKILL after SIGTERM, only while identity still holds", async () => {
  const file = stateFile(pidfile);
  const { deps, signals } = fakeDeps({ 42: { ...ours } }, { onSignal: (/** @type {number} */ pid, /** @type {string} */ sig, /** @type {any} */ procs) => { if (sig === "SIGKILL") delete procs[pid]; } });
  const r = await stopDashboard(file, deps);
  assert.equal(r.code, 0);
  assert.deepEqual(signals.map((s) => s[1]), ["SIGTERM", "SIGKILL"]);

  const file2 = stateFile(pidfile);
  const swap = fakeDeps({ 42: { ...ours } }, { onSignal: (/** @type {number} */ pid, /** @type {string} */ sig, /** @type {any} */ procs) => { if (sig === "SIGTERM") procs[pid] = { argv: [NODE, "someone-else.js"], startedAt: 5 }; } });
  const r2 = await stopDashboard(file2, swap.deps);
  assert.equal(r2.code, 2, "the pid changed hands after SIGTERM: no SIGKILL");
  assert.deepEqual(swap.signals.map((s) => s[1]), ["SIGTERM"]);
  assert.equal(fs.existsSync(file2), true);
});

test("ST7: Windows is unsupported, exit 1, no signal", async () => {
  const { deps, signals } = fakeDeps({ 42: { ...ours } }, { platform: "win32" });
  const r = await stopDashboard(stateFile(pidfile), deps);
  assert.equal(r.code, 1);
  assert.deepEqual(signals, []);
});

// The real probes need `ps` (macOS) or /proc (Linux); a sandbox without them skips this.
const probesWork = (() => {
  if (process.platform === "linux") return fs.existsSync(`/proc/${process.pid}/cmdline`);
  try { return require("node:child_process").execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { stdio: ["ignore", "pipe", "ignore"] }).length > 0; } catch { return false; }
})();

test("ST8: a real child process launched as the dashboard is stopped with the real probes", { skip: process.platform === "win32" || !probesWork }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-stop-real-")));
  const script = path.join(dir, "server", "mcp", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [script, "dashboard"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const file = path.join(dir, "dashboard.json");
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, port: 1, token: "t", procStartedAt: Date.now() - 300, argv: [process.execPath, script, "dashboard"] }));
  const exited = new Promise((r) => child.once("exit", r));
  try {
    const r = await stopDashboard(file);
    assert.equal(r.code, 0, r.message);
    await exited;
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ST9: macOS: a path with spaces is proven by the exact recorded line, not by a whitespace split", async () => {
  const spaced = [NODE, "/Users/me/My Projects/deliberation/server/mcp/index.js", "dashboard", "--no-open"];
  const file = stateFile({ ...pidfile, argv: spaced });
  const psSplit = spaced.join(" ").split(/\s+/);
  const { deps, signals } = fakeDeps({ 42: { argv: psSplit, startedAt: 1_000_000 } });
  const r = await stopDashboard(file, deps);
  assert.equal(r.code, 0, r.message);
  assert.deepEqual(signals, [[42, "SIGTERM"]]);
  const other = stateFile({ ...pidfile, argv: spaced });
  const odd = await stopDashboard(other, fakeDeps({ 42: { argv: [NODE, "/Users/me/My", "Projects/x.js", "dashboard"], startedAt: 1_000_000 } }).deps);
  assert.equal(odd.code, 2);
  assert.match(odd.message, /remove .*dashboard\.json/);
});
