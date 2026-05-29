#!/usr/bin/env node
"use strict";

/**
 * Claude Delegator - OpenRouter MCP Bridge
 *
 * Zero-dependency MCP server (JSON-RPC 2.0 over stdio) calling the OpenAI-compatible
 * POST {apiBase}/chat/completions endpoint. Config in ~/.claude/claude-delegator/config.json
 * (stat-gated hot-reload). Advisory-only. Tools: openrouter, openrouter-reply, openrouter-list.
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
    "HTTP-Referer": "https://github.com/antonbabenko/claude-delegator",
    "X-Title": "claude-delegator",
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

module.exports = { buildMessages, classifyError, parseCompletion, callOpenRouter, DEFAULT_TIMEOUT_MS, MAX_MS, isNonEmptyString, truncate };
