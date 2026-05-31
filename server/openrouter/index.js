#!/usr/bin/env node
// @ts-nocheck -- legacy bridge; predates the strict typecheck gate (core-only). Opt-in is a separate pass.
"use strict";

/**
 * Claude Delegator - OpenRouter MCP Bridge
 *
 * Zero-dependency MCP server (JSON-RPC 2.0 over stdio) calling the OpenAI-compatible
 * POST {apiBase}/chat/completions endpoint. Config in ~/.config/deliberation/config.json
 * (override with DELIBERATION_CONFIG; stat-gated hot-reload). Advisory-only.
 * Tools: openrouter, openrouter-reply, openrouter-list.
 */

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_MS = 600_000;

function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function truncate(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "..." : s; }

// A "turn" is { role: 'system'|'user'|'assistant', text, inlineBlocks?: string[] }.
// Build the OpenAI chat `messages` array; inline blocks are appended to the user text.
function buildMessages(turns) {
  return (turns || []).map((t) => {
    if (t.role === "user" && Array.isArray(t.inlineBlocks) && t.inlineBlocks.length) {
      return { role: "user", content: [t.text, ...t.inlineBlocks].join("\n\n") };
    }
    return { role: t.role, content: t.text };
  });
}

function classifyError(status, code) {
  switch (code) {
    case "missing-auth": return { errorKind: "auth", retryable: false };
    case "unknown-thread": return { errorKind: "unknown-thread", retryable: false };
    case "timeout": return { errorKind: "timeout", retryable: true };
    case "network": return { errorKind: "network", retryable: true };
    case "parse": return { errorKind: "parse", retryable: false };
    case "config": return { errorKind: "config", retryable: false };
    case "model-not-allowed": return { errorKind: "model-not-allowed", retryable: false };
  }
  const s = Number(status);
  if (s === 401 || s === 403) return { errorKind: "auth", retryable: false };
  if (s === 429) return { errorKind: "rate-limit", retryable: true };
  if (s >= 500 && s <= 599) return { errorKind: "upstream", retryable: true };
  return { errorKind: "unknown", retryable: false };
}

// Parse the assistant text out of a chat/completions body. Throws .code="parse" on bad shape.
function parseCompletion(data) {
  const fail = (why) => { const e = new Error(`Parse error: ${why}`); e.code = "parse"; return e; };
  if (!data || typeof data !== "object") throw fail("body was not a JSON object");
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message && choice.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.filter((p) => p && typeof p.text === "string").map((p) => p.text).join("");
    if (text) return text;
  }
  throw fail("no assistant message content in choices[0]");
}

// One chat/completions call. Returns { text }. Errors carry .status and/or .code.
async function callOpenRouter({ apiBase, apiKey, model, messages, reasoningEffort, temperature, timeoutMs, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== "function") { const e = new Error("global fetch unavailable; Node 18+ required"); e.code = "network"; throw e; }
  const base = (apiBase || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const payload = { model, messages, stream: false };
  if (isNonEmptyString(reasoningEffort)) payload.reasoning = { effort: reasoningEffort };
  if (typeof temperature === "number") payload.temperature = temperature;

  const headers = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/antonbabenko/deliberation",
    "X-Title": "deliberation",
  };
  if (isNonEmptyString(apiKey)) headers["Authorization"] = `Bearer ${apiKey}`;

  const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  let res;
  try {
    res = await f(url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if ((err && err.name === "AbortError") || /abort/i.test(msg)) { const e = new Error(`OpenRouter timed out after ${Math.round(t / 1000)}s`); e.code = "timeout"; throw e; }
    const e = new Error(`Network error: ${msg}`); e.code = "network"; throw e;
  } finally { clearTimeout(timer); }

  let bodyText = "";
  try { bodyText = await res.text(); } catch (_) { bodyText = ""; }
  if (!res.ok) { const e = new Error(`OpenRouter API error ${res.status}: ${truncate(bodyText, 500)}`); e.status = res.status; throw e; }
  let data;
  try { data = JSON.parse(bodyText); } catch (e2) { const e = new Error(`Parse error: invalid JSON: ${e2.message}`); e.code = "parse"; throw e; }
  return { text: parseCompletion(data) };
}

const crypto = require("node:crypto");
const { makeConfigReader } = require("./config.js");
const { resolveAlias, RESERVED_ALIAS, askAllDelegates, consensusDelegates } = require("./routing.js");
const { inlineFiles } = require("./files.js");

const CONFIG_PATH = require("../../core/paths.js").resolveConfigPath();
const configReader = makeConfigReader(CONFIG_PATH);

// threadId -> { turns, model, apiBase, reasoningEffort, temperature }. In-memory,
// process-lifetime only (lost on restart; openrouter-reply then returns unknown-thread).
// Grows unbounded across distinct threads - acceptable: advisory sessions are short-lived
// and the bridge is restarted on plugin upgrade. Mirrors server/grok/index.js sessions.
const sessions = new Map();

function sendResponse(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function sendError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function hasRequestId(r) { return isObject(r) && Object.prototype.hasOwnProperty.call(r, "id"); }
function logCall(cid, tool, outcome, ms) { process.stderr.write(`[openrouter] ${cid} ${tool} -> ${outcome} in ${ms}ms\n`); }

// Precedence chain (spec 3.5): explicit call arg > per-model override > defaults.
function pick(callArg, modelOverride, defaultsVal) {
  if (callArg !== undefined) return callArg;
  if (modelOverride !== undefined) return modelOverride;
  return defaultsVal;
}

function errorResult(id, e, tool, startedAt) {
  const { errorKind, retryable } = classifyError(e && e.status, e && e.code);
  logCall(id, tool, errorKind, Date.now() - startedAt);
  return { content: [{ type: "text", text: `Error: ${(e && e.message) || String(e)}` }], isError: true, errorKind, retryable };
}

function buildInitialTurns(developerInstructions, prompt, blocks) {
  const turns = [];
  if (isNonEmptyString(developerInstructions)) turns.push({ role: "system", text: developerInstructions });
  turns.push({ role: "user", text: prompt, inlineBlocks: blocks || [] });
  return turns;
}

// Resolve args -> delegate {model, ...overrides} or { _error: 'model-not-allowed' }.
function resolveDelegate(or, args) {
  if (isNonEmptyString(args.alias)) {
    return resolveAlias(or, args.alias) || { _error: "model-not-allowed" };
  }
  if (isNonEmptyString(args.model)) {
    if (!or.allowRawModel) return { _error: "model-not-allowed" };
    return { model: args.model.trim() };
  }
  return resolveAlias(or, RESERVED_ALIAS) || { _error: "model-not-allowed" };
}

const TOOL_PROPS = {
  prompt: { type: "string", description: "The delegation prompt" },
  "developer-instructions": { type: "string", description: "Expert system instructions" },
  alias: { type: "string", description: "Configured delegate alias (preferred)" },
  model: { type: "string", description: "Raw OpenRouter model slug; honored only when allowRawModel:true" },
  reasoning_effort: { type: "string", description: "low|medium|high (provider-dependent)" },
  temperature: { type: "number" },
  timeout: { type: "number", description: "Soft timeout ms, 1..600000" },
  files: { type: "array", description: "Text-inline files: each item has path or dir (file_id/file_url rejected)" },
  roots: { type: "array", items: { type: "string" }, description: "Absolute dirs to resolve files[].path/dir" },
  cwd: { type: "string" },
  sandbox: { type: "string", description: "Accepted for parity; ignored." },
};

const handlers = {
  initialize: (id, _p, respond) => {
    if (!respond) return;
    sendResponse(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "deliberation-openrouter", version: "1.0.0" } });
  },
  "notifications/initialized": () => {},
  "tools/list": (id, _p, respond) => {
    if (!respond) return;
    sendResponse(id, { tools: [
      { name: "openrouter", description: "Start an OpenRouter expert session (advisory only). Pick a configured `alias`.", inputSchema: { type: "object", properties: TOOL_PROPS, required: ["prompt"] } },
      { name: "openrouter-reply", description: "Continue an OpenRouter session by threadId (in-memory; lost on restart).", inputSchema: { type: "object", properties: { threadId: { type: "string" }, prompt: { type: "string" }, files: TOOL_PROPS.files, roots: TOOL_PROPS.roots, alias: TOOL_PROPS.alias, model: TOOL_PROPS.model, reasoning_effort: TOOL_PROPS.reasoning_effort, temperature: TOOL_PROPS.temperature, timeout: TOOL_PROPS.timeout, cwd: TOOL_PROPS.cwd }, required: ["threadId", "prompt"] } },
      { name: "openrouter-list", description: "List configured OpenRouter delegates and settings. Pass mode ('ask-all'|'consensus') + optional expert to also get the resolved `selected` delegate set (selection applied server-side from the live config).", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["ask-all", "consensus"] }, expert: { type: "string" } } } },
    ] });
  },
  "tools/call": async (id, params, respond) => {
    const startedAt = Date.now();
    if (!isObject(params) || !isNonEmptyString(params.name)) { if (respond) sendError(id, -32602, "Invalid params"); return; }
    const { name, arguments: args } = params;
    if (!isObject(args)) { if (respond) sendError(id, -32602, "Invalid params: arguments must be an object"); return; }

    const cfg = configReader.get();
    if (!cfg.ok) {
      if (name === "openrouter-list") {
        // When a broken config is paired with a mode request, still echo an empty `selected`
        // so the caller dispatches nothing (never a stale set) rather than missing the field.
        const errPayload = { delegates: [], defaultModelSet: false, maxFanout: 3, maxFanoutHigh: false, error: cfg.error };
        if (isObject(args) && (args.mode === "ask-all" || args.mode === "consensus")) {
          errPayload.mode = args.mode;
          if (typeof args.expert === "string") errPayload.expert = args.expert;
          errPayload.selected = [];
          if (args.mode === "ask-all") errPayload.omitted = [];
        }
        if (respond) sendResponse(id, { content: [{ type: "text", text: JSON.stringify(errPayload) }] });
        logCall(id, name, "config", Date.now() - startedAt);
        return;
      }
      if (respond) sendResponse(id, errorResult(id, { code: "config", message: cfg.error }, name, startedAt));
      return;
    }
    const or = cfg.resolved.openrouter;

    if (name === "openrouter-list") {
      if (!respond) return;
      // Shape a resolved model into the wire form (matches `delegates` entries below).
      const shape = (m) => ({
        alias: m.alias, model: m.model, experts: m.experts, askAll: m.askAll, consensus: m.consensus,
        // Resolved effort the bridge would use absent a per-call override: per-model > defaults > null.
        reasoning_effort: pick(undefined, m.reasoning_effort, or.defaults.reasoning_effort) ?? null,
      });
      const payload = {
        delegates: or.models.map(shape),
        defaultModelSet: !!or.defaultModel, maxFanout: or.maxFanout, maxFanoutHigh: or.maxFanout > 10,
        // Per-entry validation failures (kept-valid delegates above; these were skipped).
        // Each: { index, alias, reason, suggestedAlias? }. Empty when the config is clean.
        invalidModels: or.invalidModels || [],
      };
      // Server-side selection: when a mode is requested, return the resolved `selected` set
      // (and `omitted` for ask-all's maxFanout overflow) from the canonical routing selectors.
      // This is the single source of selection truth; callers MUST dispatch exactly `selected`
      // instead of re-deriving askAll/consensus/expert eligibility in command prose.
      const mode = args.mode;
      if (mode === "ask-all" || mode === "consensus") {
        const expert = typeof args.expert === "string" ? args.expert : undefined;
        payload.mode = mode;
        if (expert !== undefined) payload.expert = expert;
        if (mode === "ask-all") {
          const out = askAllDelegates(or, expert);
          payload.selected = out.selected.map(shape);
          payload.omitted = out.omitted.map(shape);
        } else {
          payload.selected = consensusDelegates(or, expert).map(shape);
        }
      }
      sendResponse(id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
      logCall(id, name, "ok", Date.now() - startedAt);
      return;
    }

    if (name !== "openrouter" && name !== "openrouter-reply") { if (respond) sendError(id, -32601, `Tool not found: ${name}`); return; }
    if (!isNonEmptyString(args.prompt)) { if (respond) sendError(id, -32602, "Invalid params: 'prompt' is required"); return; }
    if (args.timeout !== undefined && (typeof args.timeout !== "number" || args.timeout <= 0 || args.timeout > MAX_MS)) { if (respond) sendError(id, -32602, "Invalid params: 'timeout' must be 1..600000"); return; }
    if (args.alias !== undefined && args.model !== undefined) { if (respond) sendResponse(id, errorResult(id, { code: "config", message: "pass at most one of alias/model" }, name, startedAt)); return; }
    if (args.roots !== undefined && (!Array.isArray(args.roots) || args.roots.some((r) => typeof r !== "string"))) {
      if (respond) sendError(id, -32602, "Invalid params: 'roots' must be an array of strings");
      return;
    }

    let delegate = null, priorSession = null, threadId;
    if (name === "openrouter-reply") {
      if (!isNonEmptyString(args.threadId)) { if (respond) sendError(id, -32602, "Invalid params: 'threadId' required"); return; }
      threadId = args.threadId.trim();
      priorSession = sessions.get(threadId);
      if (!priorSession) { if (respond) sendResponse(id, errorResult(id, { code: "unknown-thread", message: `unknown threadId "${threadId}"` }, name, startedAt)); return; }
      delegate = (args.alias || args.model) ? resolveDelegate(or, args) : { model: priorSession.model };
    } else {
      threadId = crypto.randomUUID();
      delegate = resolveDelegate(or, args);
    }
    if (delegate && delegate._error) { if (respond) sendResponse(id, errorResult(id, { code: delegate._error, message: "alias/model not in allowlist" }, name, startedAt)); return; }
    if (!delegate || !delegate.model) { if (respond) sendResponse(id, errorResult(id, { code: "model-not-allowed", message: "no alias/model resolved and no defaultModel set" }, name, startedAt)); return; }

    let blocks = [], notes = [];
    if (args.files) {
      try {
        const roots = Array.isArray(args.roots) && args.roots.length ? args.roots : [args.cwd || process.cwd()];
        ({ blocks, notes } = inlineFiles(args.files, { roots }));
      } catch (e) { if (respond) sendResponse(id, errorResult(id, { code: "config", message: e.message }, name, startedAt)); return; }
    }

    const reasoningEffort = pick(args.reasoning_effort, delegate.reasoning_effort, or.defaults.reasoning_effort);
    const temperature = pick(args.temperature, delegate.temperature, or.defaults.temperature);
    const timeoutMs = pick(args.timeout, delegate.timeout, or.defaults.timeout);
    const apiBase = delegate.apiBase || or.apiBase;
    const apiKey = process.env[or.apiKeyEnv] || "";

    const turns = priorSession
      ? [...priorSession.turns, { role: "user", text: args.prompt, inlineBlocks: blocks }]
      : buildInitialTurns(args["developer-instructions"], args.prompt, blocks);

    try {
      const out = await callOpenRouter({ apiBase, apiKey, model: delegate.model, messages: buildMessages(turns), reasoningEffort, temperature, timeoutMs });
      sessions.set(threadId, { turns: [...turns, { role: "assistant", text: out.text }], model: delegate.model, apiBase, reasoningEffort, temperature });
      if (respond) {
        const text = notes.length ? `${out.text}\n\n[files] ${notes.join("; ")}` : out.text;
        sendResponse(id, { content: [{ type: "text", text }], threadId });
      }
      logCall(id, name, "ok", Date.now() - startedAt);
    } catch (e) {
      if (respond) sendResponse(id, errorResult(id, e, name, startedAt));
    }
  },
};

async function processLine(line) {
  if (!line.trim()) return;
  let request; try { request = JSON.parse(line); } catch (_) { return; }
  const respond = hasRequestId(request);
  if (!isObject(request) || typeof request.method !== "string") { if (respond) sendError(request.id, -32600, "Invalid Request"); return; }
  const handler = handlers[request.method];
  if (!handler) { if (respond) sendError(request.id, -32601, `Method not found: ${request.method}`); return; }
  try { await handler(request.id, request.params, respond); }
  catch (e) { if (respond) sendError(request.id, -32603, `Internal error: ${e.message}`); }
}

if (require.main === module) {
  let buffer = "";
  // Dispatch each request CONCURRENTLY (do not await/chain). processLine awaits its handler
  // and catches internally; JSON-RPC correlates replies by id and Node serializes stdout
  // writes, so parallel tool calls overlap without reordering or frame-interleaving hazard.
  const enqueue = (line) => { void processLine(line); };
  process.stdin.on("data", (chunk) => { buffer += chunk.toString(); const lines = buffer.split("\n"); buffer = lines.pop(); for (const l of lines) enqueue(l); });
  process.stdin.on("end", () => { if (buffer) { enqueue(buffer); buffer = ""; } });
  if (typeof globalThis.fetch !== "function") { console.error("OpenRouter bridge requires Node 18+ (global fetch unavailable)."); process.exit(1); }
}

module.exports = { buildMessages, classifyError, parseCompletion, callOpenRouter, buildInitialTurns, resolveDelegate, DEFAULT_TIMEOUT_MS, MAX_MS, isNonEmptyString, truncate };
