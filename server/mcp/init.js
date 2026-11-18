"use strict";

/**
 * `deliberation-mcp init` - first-run setup from the command line, on any host.
 *
 * 1. Detect credentials: codex (CLI + login) and agy via the providers' own stat-only health
 *    checks, plus the XAI / OpenRouter keys. GEMINI_API_KEY / GOOGLE_API_KEY are reported only.
 * 2. Write the config (core/paths.js; DELIBERATION_CONFIG wins): a new file enables each
 *    provider found; an existing file only gains the missing `enabled` flags, shown as a diff.
 * 3. Ping each enabled provider with one tiny prompt; OK or FAIL with the errorKind.
 * 4. Run one short demo consensus through the normal engine (skip with --no-demo).
 * 5. Print the install line for the host.
 *
 * Key values are never printed. The only interactive prompt (apply a merge to an existing
 * config) appears only on a TTY without --yes.
 */

const fs = require("node:fs");
const path = require("node:path");
const paths = require("../../core/paths.js");

const SCHEMA_URL = "https://raw.githubusercontent.com/antonbabenko/deliberation/master/config/config.schema.json";
const CORE = /** @type {const} */ (["codex", "gemini", "grok", "openrouter"]);
/** @type {Record<string,string>} */
const LABEL = { codex: "GPT (codex)", gemini: "Gemini (agy)", grok: "Grok (xAI)", openrouter: "OpenRouter" };
/** @type {Record<string,string>} */
const KEY_ENV = { grok: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const PING_PROMPT = "Reply with the single word OK.";
const PING_TIMEOUT_MS = 60000;
const DEMO_PROMPT = [
  "Plan: store user passwords as bcrypt hashes (cost 12) instead of unsalted SHA-256, and rehash",
  "each old hash at the user's next successful login. Approve or request changes.",
  "Keep the whole review under 80 words.",
].join(" ");
const DEMO_WALL_MS = 180000;

const INSTALL = [
  ["Claude Code", "claude plugin marketplace add antonbabenko/agent-plugins && claude plugin install deliberation@antonbabenko"],
  ["Codex CLI", "codex plugin marketplace add antonbabenko/deliberation  (then install deliberation from /plugins)"],
  ["Gemini CLI", "gemini extensions install https://github.com/antonbabenko/deliberation"],
  ["Any MCP host", "register the server command: npx -y @antonbabenko/deliberation-mcp"],
];

/**
 * The host this runs inside, from env vars the hosts set for their child processes.
 * Unknown hosts get the whole table.
 * @param {Record<string,string|undefined>} env
 * @returns {string|null} a key of INSTALL, or null when unknown
 */
function detectHost(env) {
  if (env.CLAUDECODE === "1") return "Claude Code";
  if (env.GEMINI_CLI === "1") return "Gemini CLI";
  if (env.CODEX_SANDBOX) return "Codex CLI";
  return null;
}

/**
 * Parse init flags. Unknown flags are an error so a typo never runs a paid demo.
 * @param {string[]} argv
 * @returns {{yes:boolean, demo:(boolean|null), help:boolean, error?:string}}
 */
function parseArgs(argv) {
  /** @type {{yes:boolean, demo:(boolean|null), help:boolean, error?:string}} */
  const o = { yes: false, demo: null, help: false };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--no-demo") o.demo = false;
    else if (a === "--demo") o.demo = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else return { ...o, error: `unknown option: ${a}` };
  }
  return o;
}

/**
 * The config init would write. Pure: never touches the input object.
 * - No existing config: a minimal file enabling every provider found. No model records, so
 *   OPENROUTER_API_KEY alone gets the built-in OpenRouter panel.
 * - Existing config: only providers.<name>.enabled is added, and only where it is absent.
 *   An explicit `enabled: false` is the user's choice and is kept (reported in `kept`).
 * @param {any} existing parsed config object, or null when there is no file
 * @param {string[]} found provider names with a working credential
 * @returns {{next:any, changes:string[], kept:string[]}}
 */
function planConfig(existing, found) {
  if (existing == null) {
    const providers = Object.fromEntries(found.map((n) => [n, { enabled: true }]));
    const next = { $schema: SCHEMA_URL, version: 1, providers, consensus: { arbiter: "auto" } };
    return { next, changes: found.map((n) => `providers.${n}.enabled: true`), kept: [] };
  }
  const next = structuredClone(existing);
  /** @type {string[]} */ const changes = [];
  /** @type {string[]} */ const kept = [];
  for (const n of found) {
    const block = next.providers && next.providers[n];
    if (block && typeof block === "object" && block.enabled !== undefined) {
      if (block.enabled === false) kept.push(`providers.${n}.enabled: false`);
      continue;
    }
    if (!next.providers || typeof next.providers !== "object") next.providers = {};
    next.providers[n] = { ...(block && typeof block === "object" ? block : {}), enabled: true };
    changes.push(`providers.${n}.enabled: true`);
  }
  return { next, changes, kept };
}

/**
 * Read the existing config. `null` when absent; `{error}` when it cannot be merged safely.
 * @param {string} file
 * @returns {{config:any}|{error:string}}
 */
function readExisting(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (/** @type {any} */ (e).code === "ENOENT") return { config: null };
    return { error: `cannot read ${file}: ${/** @type {any} */ (e).message}` };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${file} is not a JSON object` };
    const pv = parsed.providers;
    if (pv !== undefined && (!pv || typeof pv !== "object" || Array.isArray(pv))) return { error: `${file}: "providers" must be an object` };
    return { config: parsed };
  } catch (e) {
    return { error: `${file} is not valid JSON (${/** @type {any} */ (e).message}); fix or move it, then rerun init` };
  }
}

/**
 * Write via a temp file + rename, so a failed write never leaves a truncated config.
 * @param {string} file
 * @param {any} obj
 */
function writeConfig(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.init-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * True when deliberation ran here before: a config file, or a saved session or run record.
 * @param {string} configFile
 * @param {{env:Record<string,string|undefined>, home?:string}} o
 */
function priorUse(configFile, o) {
  if (fs.existsSync(configFile)) return true;
  for (const dir of [paths.resolveSessionsDir(/** @type {any} */ (o)), paths.resolveRunsDir(/** @type {any} */ (o))]) {
    try { if (fs.readdirSync(dir).some((f) => /\.jsonl?$/.test(f))) return true; } catch { /* absent */ }
  }
  return false;
}

/**
 * Ask a yes/no question on the TTY. Default yes.
 * @param {string} q
 * @returns {Promise<boolean>}
 */
function askYesNo(q) {
  const rl = require("node:readline").createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(!/^\s*n/i.test(a)); }));
}

/**
 * Run init. Every side channel is injectable for tests.
 * @param {string[]} argv arguments after `init`
 * @param {Object} deps
 * @param {(o?:any) => {providers:any[], getConfig:() => any, sessionsDir?:string}} deps.makeRuntime
 * @param {(o:any) => {handle:(m:any)=>Promise<any>, close?:()=>void}} deps.buildServer
 * @param {(p:any[]) => Promise<{unhealthy:Map<string,string>, needsLogin:Set<string>}>} deps.probeHealth
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {string} [deps.home]
 * @param {(line:string) => void} [deps.out]
 * @param {boolean} [deps.isTTY]
 * @param {(q:string) => Promise<boolean>} [deps.confirm]
 * @param {() => number} [deps.now]
 * @returns {Promise<number>} exit code
 */
async function runInit(argv, deps) {
  const env = deps.env || process.env;
  const out = deps.out || ((/** @type {string} */ l) => process.stdout.write(l + "\n"));
  const now = deps.now || Date.now;
  const isTTY = deps.isTTY !== undefined ? deps.isTTY : !!(process.stdin.isTTY && process.stdout.isTTY);
  const confirm = deps.confirm || askYesNo;
  const started = now();

  const args = parseArgs(argv);
  if (args.error || args.help) {
    if (args.error) out(`init: ${args.error}`);
    out("usage: deliberation-mcp init [--yes] [--no-demo | --demo]");
    out("  --yes      apply config changes without asking (non-interactive)");
    out("  --no-demo  skip the demo consensus");
    out("  --demo     run the demo even when deliberation was used here before");
    return args.error ? 2 : 0;
  }

  const ropts = { env, home: deps.home };
  const configFile = paths.resolveConfigPath(/** @type {any} */ (ropts));
  const returning = priorUse(configFile, ropts);
  out(returning ? "deliberation init (existing setup)" : "deliberation init");

  // 1. Detect. Health checks are stat/env only: nothing is spawned and no key is read out.
  const rt = deps.makeRuntime();
  const core = rt.providers.filter((p) => /** @type {readonly string[]} */ (CORE).includes(p.name));
  const { unhealthy, needsLogin } = await deps.probeHealth(core);
  /** @type {string[]} */ const found = [];
  /** @type {string[]} */ const notes = [];
  for (const n of CORE) {
    if (!core.some((p) => p.name === n)) continue;
    if (needsLogin.has(n)) { notes.push(`${LABEL[n]}: installed, not logged in (run: codex login)`); continue; }
    if (unhealthy.has(n)) { notes.push(`${LABEL[n]}: ${KEY_ENV[n] ? `${KEY_ENV[n]} not set` : "not found"}`); continue; }
    found.push(n);
  }
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    if (env[k]) notes.push(`${k} is set; this version reaches Gemini through agy only, so the key is not used`);
  }
  out(`found: ${found.length ? found.map((n) => LABEL[n]).join(", ") : "none"}`);
  if (!returning) for (const n of notes) out(`  ${n}`);
  if (!found.length) {
    out("No provider credential found. Set one of OPENROUTER_API_KEY or XAI_API_KEY, or log in to");
    out("the codex or agy CLI, then rerun init.");
    printInstall(out, env, returning);
    return 1;
  }

  // 2. Config.
  const ex = readExisting(configFile);
  if ("error" in ex) { out(`config: ${ex.error}`); return 1; }
  const plan = planConfig(ex.config, found);
  for (const k of plan.kept) out(`config: keeping your ${k}`);
  if (!plan.changes.length) {
    out(`config: no changes (${configFile})`);
  } else {
    out(`config: ${ex.config ? "would update" : "writing"} ${configFile}`);
    for (const c of plan.changes) out(`  + ${c}`);
    let apply = ex.config == null || args.yes;
    if (!apply && isTTY) apply = await confirm("Apply these changes? [Y/n] ");
    if (!apply) {
      out("config: not changed (rerun with --yes to apply)");
    } else {
      try { writeConfig(configFile, plan.next); } catch (e) {
        out(`config: write failed: ${/** @type {any} */ (e).message}`);
        return 1;
      }
      out("config: saved");
    }
  }

  // 3. Ping. Enabled = the providers on disk now (a kept enabled:false is skipped).
  const cfg = rt.getConfig() || {};
  const enabled = found.filter((n) => !(cfg.providers && cfg.providers[n] && cfg.providers[n].enabled === false)
    && !(n === "openrouter" && cfg.openrouter && cfg.openrouter.enabled === false));
  if (!enabled.length) {
    out(`All providers found are turned off in ${configFile}.`);
    out(`Set ${found.map((n) => `providers.${n}.enabled`).join(", ")} to true to use them, then rerun init.`);
    printInstall(out, env, returning);
    return 1;
  }
  const pings = await Promise.all(enabled.map(async (n) => {
    const p = core.find((x) => x.name === n);
    let r;
    try { r = await p.ask({ prompt: PING_PROMPT, reasoningEffort: "low", timeoutMs: PING_TIMEOUT_MS }); } catch (e) {
      r = { isError: true, errorKind: "internal", message: String(/** @type {any} */ (e).message || e) };
    }
    return { n, r };
  }));
  let okCount = 0;
  for (const { n, r } of pings) {
    if (r && !r.isError) okCount++;
    const secs = r && typeof r.ms === "number" ? ` ${(r.ms / 1000).toFixed(1)}s` : "";
    out(`ping ${LABEL[n]}: ${r && !r.isError ? "OK" : `FAIL ${(r && r.errorKind) || "unknown"}`}${secs}`);
  }
  if (!okCount) {
    out("No provider answered. Check the keys and logins above, then rerun init.");
    printInstall(out, env, returning);
    return 1;
  }

  // 4. Demo: one small consensus through the normal engine.
  const runDemo = args.demo === null ? !returning : args.demo;
  if (!runDemo) {
    out(returning ? "demo: skipped (already set up; --demo runs it)" : "demo: skipped");
  } else {
    out("demo: one short consensus (about a minute)...");
    const getConfig = () => {
      const c = rt.getConfig() || {};
      const cons = c.consensus || {};
      // A host arbiter needs an agent driving the loop; init has none, so fall back to auto.
      return { ...c, consensus: { ...cons, arbiter: cons.arbiter === "host" ? "auto" : (cons.arbiter || "auto"), maxWallMs: DEMO_WALL_MS } };
    };
    const srv = deps.buildServer({ providers: rt.providers, getConfig });
    const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "consensus", arguments: { prompt: DEMO_PROMPT, maxRounds: 1, reasoningEffort: "low" } } });
    if (srv.close) srv.close();
    printDemo(out, res);
  }

  printInstall(out, env, returning);
  out(`done in ${((now() - started) / 1000).toFixed(1)}s`);
  return 0;
}

/**
 * @param {(l:string)=>void} out
 * @param {any} res JSON-RPC response from the consensus tool
 */
function printDemo(out, res) {
  let p;
  try { p = JSON.parse(res.result.content[0].text); } catch { out("demo: no result"); return; }
  if (p.error) { out(`demo: FAIL ${p.error}`); return; }
  const arb = p.arbiter && p.arbiter.provider;
  const voices = (p.opinions || []).map((/** @type {any} */ o) => `${o.source}${o.isError ? ` (FAIL ${o.errorKind || "error"})` : o.verdict ? ` ${o.verdict}` : ""}`);
  out(`demo verdict: ${p.verdict || "none"}${p.converged ? " (converged)" : p.converged === false ? " (not converged in 1 round)" : ""}`);
  out(`  arbiter: ${arb || "none"}`);
  out(`  voices: ${voices.length ? voices.join(", ") : "none"}`);
}

/**
 * @param {(l:string)=>void} out
 * @param {Record<string,string|undefined>} env
 * @param {boolean} short
 */
function printInstall(out, env, short) {
  const host = detectHost(env);
  const row = host && INSTALL.find((r) => r[0] === host);
  if (row) { out(`install (${row[0]}): ${row[1]}`); return; }
  if (short) { out("install: see https://github.com/antonbabenko/deliberation#install"); return; }
  out("install for your host:");
  for (const [h, line] of INSTALL) out(`  ${h.padEnd(12)} ${line}`);
}

module.exports = { runInit, planConfig, parseArgs, detectHost, readExisting, INSTALL, DEMO_PROMPT };
