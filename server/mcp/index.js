#!/usr/bin/env node
"use strict";
/** Minimal stdio JSON-RPC MCP server over deliberation-core. Zero deps. */
/** @typedef {import("../../core/types.js").Provider} Provider */
/** @typedef {import("../../core/types.js").DelegationRequest} DelegationRequest */

const { makeRegistry, pinAlias } = require("../../core/registry.js");
const { askAll, askOne, consensus } = require("../../core/orchestrate.js");
const { PROMPTS } = require("../../core/prompts/index.js");

const ADVISORY = { readOnlyHint: true };
/** @type {Record<string, string>} */
const ASK_PROVIDER = { "ask-gpt": "codex", "ask-gemini": "gemini", "ask-grok": "grok", "ask-openrouter": "openrouter" };
const EXPERTS = ["architect", "plan-reviewer", "scope-analyst", "code-reviewer", "security-analyst", "researcher", "debugger"];

/**
 * One-line guidance per expert, surfaced in tools/list. Non-Claude hosts read
 * these descriptions to pick a tool, so each states the persona + when to use it.
 * @type {Record<string, string>}
 */
const EXPERT_DESCRIPTIONS = {
  "architect": "Software architect for system design, tradeoff analysis, and complex decisions. Use for architecture, API/schema design, multi-service interactions, or when a fix has failed twice and needs a fresh perspective.",
  "plan-reviewer": "Work-plan reviewer that verifies a plan is executable before anyone builds. Use to validate an implementation plan for clarity, completeness, and gaps before starting significant work.",
  "scope-analyst": "Pre-planning consultant that catches ambiguities, hidden requirements, and pitfalls before planning begins. Use when a request is vague or could be interpreted multiple ways.",
  "code-reviewer": "Senior engineer doing code review for bugs, security holes, and maintainability - not style nitpicks. Use to review a diff or file before merging.",
  "security-analyst": "Security engineer for threat modeling and vulnerability assessment. Use for auth/authorization changes, untrusted input handling, new endpoints, or a focused security audit.",
  "researcher": "Research specialist for external libraries, frameworks, APIs, and open-source code. Use for 'how do I use X', best-practice, or 'why does this dependency behave this way' questions, with evidence and honest unverified flags.",
  "debugger": "Debugging specialist that produces ranked root-cause hypotheses and the smallest safe fix from a bug report, logs, and code - or says honestly that the evidence shows no bug. Use for crashes, failing tests, or wrong output.",
};

function inputSchema() {
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      expert: { type: "string" },
      developerInstructions: { type: "string" },
      cwd: { type: "string" },
      reasoningEffort: { type: "string", enum: ["low", "medium", "high", "none"] },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            dir: { type: "string" },
            file_id: { type: "string" },
            file_url: { type: "string" },
            mode: { type: "string", enum: ["auto", "inline", "upload"] },
          },
        },
      },
    },
  };
}

function toolList() {
  const tools = [
    { name: "ask-all", description: "Fan out one question to GPT, Gemini, Grok, and any configured OpenRouter models in parallel for independent second opinions, then return all results (advisory, no cross-contamination). Pass `expert` to apply a persona to every delegate.", inputSchema: inputSchema(), annotations: ADVISORY },
    { name: "consensus", description: "Fan out one question to all enabled providers, then run a single arbiter pass that cross-reviews the independent opinions and returns one synthesized verdict (advisory). Pass `expert` to apply a persona to the fan-out and arbiter.", inputSchema: inputSchema(), annotations: ADVISORY },
  ];
  for (const t of Object.keys(ASK_PROVIDER)) {
    tools.push({ name: t, description: `Single-provider second opinion via ${ASK_PROVIDER[t]} (advisory, single-shot). Pass \`expert\` to apply one of the expert personas.`, inputSchema: inputSchema(), annotations: ADVISORY });
  }
  for (const e of EXPERTS) {
    tools.push({ name: e, description: EXPERT_DESCRIPTIONS[e], inputSchema: inputSchema(), annotations: ADVISORY });
  }
  return tools;
}

/** @typedef {{ mode: "host"|"server", provider: (Provider|null), warning?: string }} ArbiterResolution */

const BUILTIN_NAMES = new Set(["codex", "gemini", "grok"]);

/**
 * Resolve the configured arbiter spec into an execution decision. Host-agnostic:
 * any host can name a concrete arbiter instead of relying on the implicit
 * providers[0]. Soft-degrade only - an unusable spec falls back to "auto" with a
 * warning rather than failing the consensus call.
 *
 * - "host"   -> { mode:"host", provider:null }. The handler SKIPS the arbiter
 *               pass entirely (verdict:null); the host (e.g. Claude) arbitrates.
 * - "auto"   -> first provider in `selected` whose health() is ok, PREFERRING an
 *               openrouter:* one; falls back to selected[0] if none report ok.
 * - builtin  -> registry.get(name) if registered, else degrade to auto + warning.
 * - openrouter:<alias> -> pinAlias on the openrouter provider for that alias,
 *               else degrade to auto + warning. The alias need NOT be
 *               consensus:true - arbiter eligibility != voting-panel membership.
 *
 * @param {string} spec
 * @param {Provider[]} selected  the consensus voting panel
 * @param {{get:(n:string)=>(Provider|undefined)}} registry
 * @param {() => any} getConfig
 * @returns {Promise<ArbiterResolution>}
 */
async function resolveArbiter(spec, selected, registry, getConfig) {
  if (spec === "host") return { mode: "host", provider: null };

  /** @param {string|undefined} warning @returns {Promise<ArbiterResolution>} pick first healthy, prefer openrouter:* */
  async function auto(warning) {
    const checked = await Promise.all(
      selected.map(async (p) => ({ p, ok: await isHealthy(p) }))
    );
    const healthy = checked.filter((c) => c.ok).map((c) => c.p);
    const pool = healthy.length ? healthy : selected;
    const preferred = pool.find((p) => p.name.startsWith("openrouter:")) || pool[0] || null;
    const base = `auto-selected arbiter '${preferred ? preferred.name : "none"}'; set consensus.arbiter to choose`;
    return { mode: "server", provider: preferred, warning: warning ? `${warning}; ${base}` : base };
  }

  if (spec === "auto") return auto(undefined);

  if (BUILTIN_NAMES.has(spec)) {
    const p = registry.get(spec);
    if (p) return { mode: "server", provider: p };
    return auto(`configured arbiter '${spec}' is not available`);
  }

  const orMatch = /^openrouter:([a-z0-9-]+)$/.exec(spec);
  if (orMatch) {
    const alias = orMatch[1];
    const orProvider = registry.get("openrouter");
    const cfg = getConfig() || {};
    const models = (cfg.openrouter && cfg.openrouter.models) || [];
    const model = models.find((/** @type {any} */ m) => m && m.alias === alias);
    if (orProvider && model) return { mode: "server", provider: pinAlias(orProvider, model) };
    return auto(`configured arbiter '${spec}' is not available`);
  }

  // Unrecognized spec (config validation should have degraded it already; this
  // is a defensive second guard so the handler never trusts a raw spec).
  return auto(`configured arbiter '${spec}' is not recognized`);
}

/**
 * Best-effort health probe. A provider whose health() throws is treated as not
 * healthy rather than crashing arbiter selection.
 * @param {Provider} p
 * @returns {Promise<boolean>}
 */
async function isHealthy(p) {
  try {
    const h = await p.health();
    return !!(h && h.ok);
  } catch {
    return false;
  }
}

/**
 * @param {Object} deps
 * @param {Provider[]} deps.providers
 * @param {() => any} deps.getConfig
 */
function buildServer({ providers, getConfig }) {
  const registry = makeRegistry(providers);

  /**
   * Inject the bundled persona for `expert` when the caller did not supply its
   * own developerInstructions. Caller-supplied instructions ALWAYS win, so the
   * Claude Code path (which passes its own persona) is unchanged. Returns a new
   * request - never mutates the input.
   * @param {DelegationRequest} request
   * @param {string|undefined} expert
   * @returns {DelegationRequest}
   */
  function withPersona(request, expert) {
    if (!expert) return request;
    if (request.developerInstructions) return request;
    // Own-property check: an untrusted args.expert could be an inherited key
    // ("constructor", "__proto__", "toString"), which would otherwise resolve up
    // the prototype chain to a truthy non-string and corrupt developerInstructions.
    const persona = Object.prototype.hasOwnProperty.call(PROMPTS, expert) ? PROMPTS[expert] : undefined;
    if (!persona) return request;
    return { ...request, developerInstructions: persona };
  }

  /**
   * @param {string} name
   * @param {any} args  // untrusted JSON-RPC tool arguments
   */
  async function call(name, args) {
    // The named expert tools (architect, etc.) carry the expert in the TOOL
    // NAME, not in args.expert. For a named expert tool the tool name MUST win
    // (otherwise args.expert could pick a contradictory persona vs. the selected
    // providers). args.expert is only honored on non-named tools (ask-*), and is
    // type-guarded since it is untrusted JSON-RPC input.
    const namedExpert = EXPERTS.includes(name) ? name : undefined;
    const argExpert = typeof args.expert === "string" ? args.expert : undefined;
    const expert = namedExpert || argExpert;
    /** @type {DelegationRequest} */
    const req = {
      prompt: args.prompt,
      expert: args.expert,
      developerInstructions: args.developerInstructions,
      cwd: args.cwd,
      reasoningEffort: args.reasoningEffort,
      files: args.files,
    };
    if (name === "ask-all") {
      // selectForAskAll returns a FLAT provider list: enabled built-ins + per-alias OR wrappers.
      const { providers: selected, omitted } = registry.selectForAskAll({ config: getConfig(), expert: expert || "" });
      const results = await askAll(selected, withPersona(req, expert));
      return { content: [{ type: "text", text: JSON.stringify({ results, omitted }) }] };
    }
    if (name === "consensus") {
      // selectForConsensus returns a FLAT, uncapped voting panel. The arbiter is
      // resolved from config (host/auto/builtin/openrouter:<alias>) instead of the
      // implicit providers[0], so any host can synthesize a real verdict.
      const cfg = getConfig() || {};
      const { providers: selected } = registry.selectForConsensus({ config: cfg, expert: expert || "" });
      const arbiterSpec = (cfg.consensus && cfg.consensus.arbiter) || "auto";
      const warnings = Array.isArray(cfg.consensusWarnings) ? cfg.consensusWarnings.slice() : [];

      const resolved = await resolveArbiter(arbiterSpec, selected, registry, getConfig);
      if (resolved.warning) warnings.push(resolved.warning);

      if (resolved.mode === "host" || !resolved.provider) {
        // Host arbitrates: return opinions only, no server-side arbiter pass.
        const opinions = await askAll(selected, withPersona(req, expert));
        return { content: [{ type: "text", text: JSON.stringify({ opinions, verdict: null, arbiter: { mode: "host" }, warnings }) }] };
      }

      const arbiter = resolved.provider;
      // Exclude the arbiter from the peer panel so it does not review its own
      // opinion. Floor of 2: never shrink the panel below two voices - if removing
      // the arbiter would, keep it in and note it.
      let peers = selected.filter((p) => p.name !== arbiter.name);
      if (peers.length < 2) {
        peers = selected;
        warnings.push(`panel too small to exclude arbiter '${arbiter.name}'; kept it in the peer panel (floor of 2)`);
      }
      const out = await consensus(peers, withPersona(req, expert), { arbiter, arbiterInstructions: PROMPTS.arbiter });
      return { content: [{ type: "text", text: JSON.stringify({ opinions: out.opinions, verdict: out.verdict, error: out.error, arbiter: { mode: "server", provider: arbiter.name }, warnings }) }] };
    }
    if (Object.prototype.hasOwnProperty.call(ASK_PROVIDER, name)) {
      const p = registry.get(ASK_PROVIDER[name]);
      if (!p) return { content: [{ type: "text", text: JSON.stringify({ error: `provider ${ASK_PROVIDER[name]} not registered` }) }] };
      const result = await askOne(p, withPersona(req, expert));
      return { content: [{ type: "text", text: JSON.stringify({ result }) }] };
    }
    if (EXPERTS.includes(name)) {
      const { providers: selected } = registry.selectForAskAll({ config: getConfig(), expert: name });
      const results = await askAll(selected, withPersona({ ...req, expert: name }, expert));
      return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
    }
    throw new Error(`unknown tool: ${name}`);
  }

  /** @param {any} msg */
  async function handle(msg) {
    try {
      if (msg.method === "initialize") {
        return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "deliberation-mcp", version: "0.1.0" } } };
      }
      if (msg.method === "tools/list") return { jsonrpc: "2.0", id: msg.id, result: { tools: toolList() } };
      if (msg.method === "tools/call") {
        const result = await call(msg.params.name, msg.params.arguments || {});
        return { jsonrpc: "2.0", id: msg.id, result };
      }
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    } catch (e) {
      const err = /** @type {any} */ (e);
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String((err && err.message) || err) } };
    }
  }

  return { handle, toolList };
}

function startStdio() {
  const { makeOpenAICompatibleProvider } = require("../../core/providers/openai-compatible.js");
  const { makeGrokProvider } = require("../../core/providers/grok.js");
  const { makeAntigravityProvider } = require("../../core/providers/antigravity.js");
  const { makeCodexProvider } = require("../../core/providers/codex.js");
  const configMod = /** @type {any} */ (require("../openrouter/config.js"));
  const { makeConfigReader, DEFAULT_API_BASE, DEFAULT_API_KEY_ENV } = configMod;
  const reader = makeConfigReader(require("../../core/paths.js").resolveConfigPath());
  /** @returns {any} */
  const getConfig = () => (reader.get().resolved || { providers: {}, openrouter: {} });

  const initialOr = (getConfig().openrouter) || {};
  /** @type {Provider[]} */
  // Composition root: core is transport-agnostic, so wire each adapter to its
  // bridge here. Codex spawns the `codex` CLI directly and needs no bridge.
  const providers = [
    makeCodexProvider({}),
    makeAntigravityProvider({ bridge: require("../gemini/index.js") }),
    makeGrokProvider({ bridge: require("../grok/index.js") }),
    makeOpenAICompatibleProvider({
      name: "openrouter",
      apiBase: initialOr.apiBase || DEFAULT_API_BASE,
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      resolveModel: (req) => req.model || (getConfig().openrouter && getConfig().openrouter.defaultModel) || "",
      bridge: require("../openrouter/index.js"),
    }),
  ];
  const srv = buildServer({ providers, getConfig });

  if (typeof globalThis.fetch !== "function") {
    console.error("deliberation-mcp requires Node 18+ (global fetch unavailable).");
    process.exit(1);
  }

  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      let msg;
      try { msg = JSON.parse(l); } catch { continue; }
      const res = await srv.handle(msg);
      if (msg.id !== undefined) process.stdout.write(JSON.stringify(res) + "\n");
    }
  });
}

if (require.main === module) startStdio();

module.exports = { buildServer, toolList };
