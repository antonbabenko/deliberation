#!/usr/bin/env node
"use strict";
/** Minimal stdio JSON-RPC MCP server over deliberation-core. Zero deps. */
/** @typedef {import("../../core/types.js").Provider} Provider */
/** @typedef {import("../../core/types.js").DelegationRequest} DelegationRequest */

const { makeRegistry } = require("../../core/registry.js");
const { askAll, askOne, consensus } = require("../../core/orchestrate.js");

const ADVISORY = { readOnlyHint: true };
/** @type {Record<string, string>} */
const ASK_PROVIDER = { "ask-gpt": "codex", "ask-gemini": "gemini", "ask-grok": "grok", "ask-openrouter": "openrouter" };
const EXPERTS = ["architect", "plan-reviewer", "scope-analyst", "code-reviewer", "security-analyst", "researcher", "debugger"];

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
    },
  };
}

function toolList() {
  const tools = [
    { name: "ask-all", description: "Fan out one question to all enabled providers in parallel (advisory).", inputSchema: inputSchema(), annotations: ADVISORY },
    { name: "consensus", description: "Fan out then run one arbiter pass for a synthesized verdict (advisory).", inputSchema: inputSchema(), annotations: ADVISORY },
  ];
  for (const t of Object.keys(ASK_PROVIDER)) {
    tools.push({ name: t, description: `Single-provider second opinion via ${ASK_PROVIDER[t]} (advisory).`, inputSchema: inputSchema(), annotations: ADVISORY });
  }
  for (const e of EXPERTS) {
    tools.push({ name: e, description: `Direct ${e} expert (advisory).`, inputSchema: inputSchema(), annotations: ADVISORY });
  }
  return tools;
}

/**
 * @param {Object} deps
 * @param {Provider[]} deps.providers
 * @param {() => any} deps.getConfig
 */
function buildServer({ providers, getConfig }) {
  const registry = makeRegistry(providers);

  /**
   * @param {string} name
   * @param {any} args  // untrusted JSON-RPC tool arguments
   */
  async function call(name, args) {
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
      const { providers: selected, omitted } = registry.selectForAskAll({ config: getConfig(), expert: req.expert || "" });
      const results = await askAll(selected, req);
      return { content: [{ type: "text", text: JSON.stringify({ results, omitted }) }] };
    }
    if (name === "consensus") {
      // selectForConsensus returns a FLAT, uncapped provider list. consensus() fans out
      // then runs ONE arbiter pass (default arbiter = providers[0]).
      const { providers: selected } = registry.selectForConsensus({ config: getConfig(), expert: req.expert || "" });
      const out = await consensus(selected, req);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (ASK_PROVIDER[name]) {
      const p = registry.get(ASK_PROVIDER[name]);
      if (!p) return { content: [{ type: "text", text: JSON.stringify({ error: `provider ${ASK_PROVIDER[name]} not registered` }) }] };
      const result = await askOne(p, req);
      return { content: [{ type: "text", text: JSON.stringify({ result }) }] };
    }
    if (EXPERTS.includes(name)) {
      const { providers: selected } = registry.selectForAskAll({ config: getConfig(), expert: name });
      const results = await askAll(selected, { ...req, expert: name });
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
  const providers = [
    makeCodexProvider({}),
    makeAntigravityProvider({}),
    makeGrokProvider({}),
    makeOpenAICompatibleProvider({
      name: "openrouter",
      apiBase: initialOr.apiBase || DEFAULT_API_BASE,
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      resolveModel: (req) => req.model || (getConfig().openrouter && getConfig().openrouter.defaultModel) || "",
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
