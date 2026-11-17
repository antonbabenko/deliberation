"use strict";
/**
 * The `doctor` health check: config, provider CLIs and keys, sessions/debug, path drift and
 * stale registrations, as a list of findings. Read-only: it reads files, env and stat-only
 * provider probes, runs `codex --version` (a local CLI, no login), writes nothing and calls no
 * provider API. `/deliberation:doctor` renders these findings; any MCP host can call the tool.
 */
/** @typedef {import("../../core/types.js").Provider} Provider */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** @typedef {"ok"|"warn"|"fail"|"info"} Status */
/** @typedef {{check: string, status: Status, message: string, fix?: string}} Finding */

/** The warning for a Gemini path that runs through the Antigravity CLI (agy) OAuth login. */
const AGY_TERMS_WARNING = "The Antigravity terms (https://antigravity.google/terms, section 6, read 2026-11-17) list \"Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth)\" as a breach that \"may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts\". Prefer a Gemini API key.";

/** Provider ceilings the host cap is compared against (ms). */
const PROVIDER_CEILING_MS = 600000;

/**
 * True when Gemini is enabled and this process would answer it through the agy CLI.
 * Kept to one predicate so another Gemini transport only has to change what it returns.
 * @param {Provider|undefined} gemini
 * @param {any} config  resolved config
 * @param {boolean} healthy
 */
function geminiUsesAgy(gemini, config, healthy) {
  const enabled = ((config.providers || {}).gemini || {}).enabled !== false;
  return !!gemini && /** @type {any} */ (gemini).transport === "agy" && enabled && healthy;
}

/**
 * Read and validate the config file. Never throws: a bad file is a finding.
 * @param {string} configPath
 * @param {Finding[]} out
 * @returns {any} the resolved config, or {} when it is missing or invalid
 */
function checkConfig(configPath, out) {
  const { validateConfig } = /** @type {any} */ (require("../openrouter/config.js"));
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    if (/** @type {any} */ (e).code === "ENOENT") {
      out.push({ check: "config", status: "warn", message: `no config at ${configPath}`, fix: "run /deliberation:setup (or npx -y --package @antonbabenko/deliberation-mcp deliberation-setup)" });
    } else {
      out.push({ check: "config", status: "fail", message: `config not readable (${configPath}): ${/** @type {any} */ (e).message}` });
    }
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    out.push({ check: "config", status: "fail", message: `config is not valid JSON (${configPath}): ${/** @type {any} */ (e).message}`, fix: "correct the JSON, or move it aside and run /deliberation:setup" });
    return {};
  }
  const r = validateConfig(parsed);
  if (!r.ok) {
    out.push({ check: "config", status: "fail", message: `config rejected (${configPath}): ${r.error}`, fix: "correct the value; config/config.schema.json documents every key" });
    return {};
  }
  out.push({ check: "config", status: "ok", message: `config valid (${configPath})` });
  // The runtime validator ignores unknown keys; the schema rejects them (a typo silently does nothing).
  const known = Object.keys(require("../../config/config.schema.json").properties);
  for (const k of Object.keys(parsed)) {
    if (!known.includes(k)) out.push({ check: "config", status: "warn", message: `unknown top-level key "${k}" is ignored`, fix: "remove or rename it; config/config.schema.json lists the valid keys" });
  }
  const res = r.resolved;
  for (const w of res.consensusWarnings || []) out.push({ check: "config", status: "warn", message: w });
  for (const m of (res.openrouter && res.openrouter.invalidModels) || []) {
    out.push({ check: "config", status: "warn", message: `models["${m.alias}"] dropped: ${m.reason}` });
  }
  const persist = !!(res.sessions && res.sessions.persist);
  const debug = !!(res.debug && res.debug.enabled);
  out.push(persist
    ? { check: "sessions.persist", status: "ok", message: "sessions.persist: true" }
    : { check: "sessions.persist", status: "warn", message: "sessions.persist: false", fix: "set sessions.persist:true for /analyze Lens B" });
  out.push(debug
    ? { check: "debug.enabled", status: "ok", message: "debug.enabled: true" }
    : { check: "debug.enabled", status: "warn", message: "debug.enabled: false", fix: "set debug.enabled:true for /analyze Lens A" });
  return res;
}

/**
 * The host tool-call cap this server sees (MCP_TOOL_TIMEOUT).
 * @param {Record<string,string|undefined>} env
 * @returns {Finding}
 */
function checkHostCap(env) {
  const v = env.MCP_TOOL_TIMEOUT;
  if (!v) return { check: "host-cap", status: "ok", message: "no host tool-call cap (MCP_TOOL_TIMEOUT unset)" };
  if (!/^\d+$/.test(v)) return { check: "host-cap", status: "warn", message: `MCP_TOOL_TIMEOUT=${v} is not a number; deliberation ignores it (no host cap assumed)` };
  if (Number(v) < PROVIDER_CEILING_MS) {
    return { check: "host-cap", status: "warn", message: `MCP_TOOL_TIMEOUT=${v} ms is below the provider ceilings (codex 600000, gemini 300000, grok/openrouter 180000); calls are trimmed to fit`, fix: "raise the host's per-server tool timeout (Claude Code plugin: update the plugin, its manifest sets 1800000)" };
  }
  return { check: "host-cap", status: "ok", message: `MCP_TOOL_TIMEOUT=${v} ms (host cap at or above every provider ceiling)` };
}

/**
 * Which codex credential is in use, and its version. Stat/env only plus `codex --version`.
 * @param {Record<string,string|undefined>} env
 * @param {string} home
 */
function codexDetail(env, home) {
  const codex = require("../../core/providers/codex.js");
  let version = "";
  try {
    const plan = codex.buildSpawnPlan({ env, args: ["--version"] });
    const r = spawnSync(plan.cmd, plan.argv, { encoding: "utf8", timeout: 5000, env: /** @type {any} */ (env), windowsHide: true });
    version = String(r.stdout || "").split("\n")[0].trim();
  } catch { /* version is cosmetic */ }
  const cred = env.CODEX_ACCESS_TOKEN ? "CODEX_ACCESS_TOKEN set"
    : codex.codexHasLogin({ env, home }) ? "codex login (auth.json)"
      : env.CODEX_API_KEY ? "CODEX_API_KEY set" : "";
  return { version, cred };
}

/**
 * Provider CLIs and keys, from the same stat-only probes `panel` uses.
 * @param {Provider[]} providers
 * @param {any} config
 * @param {{env: Record<string,string|undefined>, home: string}} ctx
 * @param {Finding[]} out
 */
async function checkProviders(providers, config, ctx, out) {
  const { probeHealth } = require("./index.js");
  const { unhealthy, needsLogin } = await probeHealth(providers);
  const pcfg = config.providers || {};
  const byName = new Map(providers.map((p) => [p.name, p]));
  /** @type {Record<string, {label: string, fix: string}>} */
  const meta = {
    codex: { label: "codex (GPT)", fix: "install the Codex CLI or set CODEX_BIN; ignore if you do not use GPT" },
    gemini: { label: "agy (Gemini)", fix: "install the Antigravity CLI or set AGY_BIN; ignore if you do not use Gemini" },
    grok: { label: "Grok", fix: "set XAI_API_KEY in the server env; ignore if you do not use Grok" },
    openrouter: { label: "OpenRouter", fix: "set OPENROUTER_API_KEY in the server env; ignore if you do not use OpenRouter" },
  };
  for (const name of Object.keys(meta)) {
    const p = byName.get(name);
    if (!p) continue;
    const { label, fix } = meta[name];
    if (name !== "openrouter" && (pcfg[name] || {}).enabled === false) {
      out.push({ check: `provider:${name}`, status: "info", message: `${label} disabled in config (providers.${name}.enabled: false)` });
      continue;
    }
    const reason = unhealthy.get(name);
    if (reason) {
      out.push({ check: `provider:${name}`, status: "warn", message: `${label} unavailable: ${reason}`, fix });
    } else if (name === "codex") {
      const d = codexDetail(ctx.env, ctx.home);
      if (needsLogin.has(name)) {
        out.push({ check: "provider:codex", status: "warn", message: `codex CLI on PATH${d.version ? ` (${d.version})` : ""} but has no credential yet`, fix: "call the codex-login tool (or /deliberation:codex-login) for a ChatGPT link + code, or run `codex login`, or set CODEX_ACCESS_TOKEN / CODEX_API_KEY (OPENAI_API_KEY is never used)" });
      } else {
        out.push({ check: "provider:codex", status: "ok", message: `codex CLI on PATH${d.version ? ` (${d.version})` : ""}, credential: ${d.cred || "present"}` });
      }
    } else {
      out.push({ check: `provider:${name}`, status: "ok", message: name === "gemini" ? "agy CLI on PATH (Gemini)" : `${label} key set` });
    }
  }
  if (geminiUsesAgy(byName.get("gemini"), config, !unhealthy.has("gemini"))) {
    out.push({ check: "gemini-agy-terms", status: "warn", message: AGY_TERMS_WARNING });
  }
  // Local providers serve model records; their endpoints are not probed (no network calls).
  const local = ((config.openrouter && config.openrouter.models) || []).filter((/** @type {any} */ m) => m.provider === "ollama" || m.provider === "lmstudio");
  for (const name of ["ollama", "lmstudio"]) {
    const n = local.filter((/** @type {any} */ m) => m.provider === name).length;
    if (n) out.push({ check: `provider:${name}`, status: "info", message: `${name}: ${n} model record(s) configured; the local endpoint is not probed (doctor makes no network calls)` });
  }
}

/**
 * Session store dir, and drift against the dir a shell resolved (when the caller passes it).
 * @param {string} sessionsDir
 * @param {string|undefined} shellSessionsDir
 * @param {Finding[]} out
 */
function checkSessions(sessionsDir, shellSessionsDir, out) {
  let n = -1;
  try { n = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json")).length; } catch { /* missing */ }
  out.push(n >= 0
    ? { check: "sessions-dir", status: "ok", message: `sessions dir exists (${sessionsDir}, ${n} record(s))` }
    : { check: "sessions-dir", status: "warn", message: `sessions dir not found (${sessionsDir}) - nothing persisted there yet` });
  if (typeof shellSessionsDir !== "string" || !shellSessionsDir) return;
  if (path.resolve(shellSessionsDir) === path.resolve(sessionsDir)) {
    out.push({ check: "sessions-path", status: "ok", message: "sessions path: server and shell agree" });
  } else {
    out.push({ check: "sessions-path", status: "fail", message: `sessions path drift: server reads ${sessionsDir}, shell wrote ${shellSessionsDir}. Cause: XDG_CACHE_HOME / DELIBERATION_SESSIONS differs between the shell and the process that launched the MCP server`, fix: "set DELIBERATION_SESSIONS to one path in both places, then restart" });
  }
}

/**
 * Plugin installs only: user-scope MCP entries in ~/.claude.json shadow the plugin manifest.
 * A standalone (npx) server registered there is the intended setup, so it is not checked.
 * @param {string} home
 * @param {Finding[]} out
 */
function checkShadowing(home, out) {
  /** @type {string[]} */ let names = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    names = Object.keys(j.mcpServers || {}).filter((k) => k === "deliberation" || k.startsWith("deliberation-"));
  } catch { /* no file, no entries */ }
  out.push(names.length
    ? { check: "registrations", status: "warn", message: `user-scope MCP entries shadow the plugin manifest: ${names.join(" ")}`, fix: "/deliberation:uninstall (then they load from the plugin)" }
    : { check: "registrations", status: "ok", message: "no shadowing user-scope MCP registrations" });
}

/**
 * Run every check. Never throws for a bad config or a failing probe.
 * @param {Object} o
 * @param {Provider[]} o.providers
 * @param {string} o.configPath
 * @param {string} o.sessionsDir
 * @param {string} [o.shellSessionsDir]  the dir a shell resolved; enables the drift check
 * @param {{sessionsRead?: number, agreementVotes?: number}|null} [o.analyzeMeta]
 * @param {Record<string,string|undefined>} [o.env]
 * @param {string} [o.home]
 * @param {string} [o.serverDir]  where this module lives; decides plugin vs standalone install
 */
async function runDoctor(o) {
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const serverDir = o.serverDir || __dirname;
  /** @type {Finding[]} */ const findings = [];
  const pluginRoot = path.join(serverDir, "..", "..");
  const plugin = fs.existsSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
  const version = require("./package.json").version;
  findings.push({ check: "server", status: "ok", message: plugin ? `plugin found (${pluginRoot}, v${version})` : `standalone server v${version} (${serverDir})` });
  const config = checkConfig(o.configPath, findings);
  findings.push(checkHostCap(env));
  try {
    await checkProviders(o.providers, config, { env, home }, findings);
  } catch (e) {
    findings.push({ check: "providers", status: "fail", message: `provider probes failed: ${/** @type {any} */ (e).message || e}` });
  }
  checkSessions(o.sessionsDir, o.shellSessionsDir, findings);
  const m = o.analyzeMeta;
  if (m && (m.sessionsRead || 0) > 0 && m.agreementVotes === 0) {
    findings.push({ check: "sessions-verdicts", status: "info", message: "session records exist but carry no per-opinion verdicts (old or ask-all runs)", fix: "run a fresh consensus to populate /analyze Lens B" });
  }
  if (plugin) checkShadowing(home, findings);
  /** @type {Record<Status, number>} */ const summary = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const f of findings) summary[f.status] += 1;
  return { findings, summary, paths: { config: o.configPath, sessions: o.sessionsDir } };
}

module.exports = { runDoctor, geminiUsesAgy, AGY_TERMS_WARNING };
