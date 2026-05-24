#!/usr/bin/env node

/**
 * Claude Delegator - Grok (xAI) MCP Bridge
 *
 * A zero-dependency MCP server that calls the xAI OpenAI-compatible Chat
 * Completions API. Speaks JSON-RPC 2.0 over stdio.
 *
 * Unlike the Gemini bridge (which wraps a one-shot CLI and recovers answers
 * from disk), this bridge owns the conversation state directly, so multi-turn
 * (grok-reply) is an in-memory threadId -> messages map.
 *
 * Auth: XAI_API_KEY (env). Model: GROK_DEFAULT_MODEL (env) or grok-4.3.
 * Endpoint: XAI_API_BASE (env) or https://api.x.ai/v1.
 */

const crypto = require("node:crypto");

const DEFAULT_MODEL = process.env.GROK_DEFAULT_MODEL || "grok-4.3";
const DEFAULT_API_BASE = process.env.XAI_API_BASE || "https://api.x.ai/v1";
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const MAX_MS = 600_000;
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);

// In-memory session store: threadId -> messages[]. Lives for the MCP process
// lifetime only; lost on restart (grok-reply then returns unknown-thread).
const sessions = new Map();

// NOTE: multi-turn assumes serial use per threadId. Two concurrent grok-reply
// calls on the same thread would race on the read-then-set below (last write
// wins). Acceptable for v1 -- every shipped caller (/ask-*, /consensus) is
// single-shot and never replies to one thread in parallel.

// --- MCP Protocol Helpers ---

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result
  }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  }) + "\n");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRequestId(request) {
  return isObject(request) && Object.prototype.hasOwnProperty.call(request, "id");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function truncate(str, max) {
  const s = String(str == null ? "" : str);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// F3: one structured stderr line per dispatched call. stderr ONLY -- stdout is
// the JSON-RPC channel. Never logs payloads, the API key, or prompt text.
function logCall(cid, tool, outcome, ms) {
  process.stderr.write(`[grok] ${cid} ${tool} -> ${outcome} in ${ms}ms\n`);
}

// --- Error Classification ---

// Pure helper: given an HTTP status (or null) and a thrown error's `.code`,
// produce the structured error fields the orchestrator consumes. Exported for
// tests. `.code` is checked first (transport-level), then HTTP status.
function classifyGrokError(status, errCode) {
  switch (errCode) {
    case "missing-auth":   return { errorKind: "missing-auth",   retryable: false };
    case "unknown-thread": return { errorKind: "unknown-thread", retryable: false };
    case "timeout":        return { errorKind: "timeout",        retryable: true };
    case "network":        return { errorKind: "network",        retryable: true };
    case "parse":          return { errorKind: "parse",          retryable: false };
  }
  const s = Number(status);
  if (s === 401 || s === 403) return { errorKind: "auth", retryable: false };
  if (s === 429)              return { errorKind: "rate-limit", retryable: true };
  if (s >= 500 && s <= 599)   return { errorKind: "upstream", retryable: true };
  return { errorKind: "unknown", retryable: false };
}

// --- Pure helpers (exported for tests) ---

// Build the OpenAI-style messages array. developer-instructions become a
// leading system message; the prompt is the user turn.
function buildMessages(developerInstructions, prompt) {
  const messages = [];
  if (isNonEmptyString(developerInstructions)) {
    messages.push({ role: "system", content: developerInstructions });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

// Extract the assistant text from a chat/completions response body. Throws a
// `.code = "parse"` error on a malformed shape.
function parseChatCompletion(data) {
  const fail = (why) => {
    const e = new Error(`Parse error: ${why}`);
    e.code = "parse";
    return e;
  };
  if (!isObject(data)) throw fail("response was not a JSON object");
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw fail("no choices in response");
  const message = choices[0] && choices[0].message;
  const content = message && message.content;
  if (typeof content !== "string") throw fail("choices[0].message.content missing");
  return content;
}

// --- xAI API Call ---

// Performs one chat/completions call and returns the assistant text. Errors
// carry `.code` (transport: timeout/network/parse/missing-auth) and/or `.status`
// (HTTP) so classifyGrokError can map them. `fetchImpl` is injectable for tests.
async function runGrok({ messages, model, timeoutMs, apiKey, apiBase, fetchImpl }) {
  if (!isNonEmptyString(apiKey)) {
    const e = new Error("XAI_API_KEY is not set. Export it (export XAI_API_KEY=xai-...) or rerun /claude-delegator:setup.");
    e.code = "missing-auth";
    throw e;
  }
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== "function") {
    const e = new Error("global fetch is unavailable; Node 18+ is required for the Grok bridge.");
    e.code = "network";
    throw e;
  }

  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);

  let res;
  try {
    res = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, messages, stream: false }),
      signal: controller.signal,
    });
  } catch (err) {
    const name = err && err.name;
    const msg = String((err && err.message) || err);
    if (name === "AbortError" || /abort/i.test(msg)) {
      const e = new Error(`Grok timed out after ${Math.round(t / 1000)}s`);
      e.code = "timeout";
      throw e;
    }
    const e = new Error(`Network error: ${msg}`);
    e.code = "network";
    throw e;
  } finally {
    clearTimeout(timer);
  }

  let bodyText = "";
  try { bodyText = await res.text(); } catch (_) { bodyText = ""; }

  if (!res.ok) {
    const e = new Error(`xAI API error ${res.status}: ${truncate(bodyText, 500)}`);
    e.status = res.status;
    throw e;
  }

  let data;
  try { data = JSON.parse(bodyText); }
  catch (e2) {
    const e = new Error(`Parse error: invalid JSON body: ${e2.message}`);
    e.code = "parse";
    throw e;
  }
  return parseChatCompletion(data);
}

// --- Request Handlers ---

const GROK_PROPERTIES = {
  prompt: { type: "string", description: "The delegation prompt" },
  "developer-instructions": { type: "string", description: "Expert system instructions (sent as a system message)" },
  model: { type: "string", description: "xAI model id. Defaults to GROK_DEFAULT_MODEL or grok-4.3.", default: DEFAULT_MODEL },
  timeout: { type: "number", description: "Soft timeout in ms. 1..600000. Default 180000.", default: DEFAULT_TIMEOUT_MS },
  sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only", description: "Accepted for call-shape parity with other providers; ignored (the HTTP API has no filesystem access)." },
  cwd: { type: "string", description: "Accepted for parity; ignored." },
};

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-delegator-grok", version: "1.7.0" }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: [
        {
          name: "grok",
          description: "Start a new Grok (xAI) expert session. Advisory only (no filesystem access).",
          inputSchema: {
            type: "object",
            properties: GROK_PROPERTIES,
            required: ["prompt"]
          }
        },
        {
          name: "grok-reply",
          description: "Continue an existing Grok session (in-memory; lost if the MCP server restarts).",
          inputSchema: {
            type: "object",
            properties: {
              threadId: { type: "string", description: "Session ID returned by a previous grok call" },
              prompt: { type: "string", description: "Follow-up prompt" },
              model: { type: "string", default: DEFAULT_MODEL },
              timeout: { type: "number", default: DEFAULT_TIMEOUT_MS }
            },
            required: ["threadId", "prompt"]
          }
        }
      ]
    });
  },

  "tools/call": async (id, params, shouldRespond) => {
    if (!isObject(params)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: expected an object");
      return;
    }

    const { name, arguments: args } = params;
    if (!isNonEmptyString(name)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'name' must be a non-empty string");
      return;
    }
    if (!isObject(args)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'arguments' must be an object");
      return;
    }
    if (args.sandbox !== undefined && !VALID_SANDBOX_VALUES.has(args.sandbox)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'sandbox' must be 'read-only' or 'workspace-write'");
      return;
    }
    if (args.cwd !== undefined && !isNonEmptyString(args.cwd)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'cwd' must be a non-empty string when provided");
      return;
    }
    if (args.model !== undefined && !isNonEmptyString(args.model)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'model' must be a non-empty string when provided");
      return;
    }
    if (args.timeout !== undefined) {
      if (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > MAX_MS) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'timeout' must be a number > 0 and <= 600000 milliseconds");
        return;
      }
    }
    if (!isNonEmptyString(args.prompt)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
      return;
    }

    let messages;
    let threadId;

    if (name === "grok") {
      if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'developer-instructions' must be a string when provided");
        return;
      }
      messages = buildMessages(args["developer-instructions"], args.prompt);
      threadId = crypto.randomUUID();
    } else if (name === "grok-reply") {
      if (!isNonEmptyString(args.threadId)) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' is required for grok-reply");
        return;
      }
      threadId = args.threadId.trim();
      const prior = sessions.get(threadId);
      if (!prior) {
        // Structured error (not a JSON-RPC error) so the orchestrator can react.
        const { errorKind, retryable } = classifyGrokError(null, "unknown-thread");
        logCall((id != null) ? id : threadId, "grok-reply", errorKind, 0);
        if (shouldRespond) {
          sendResponse(id, {
            content: [{ type: "text", text: `Error: unknown threadId "${threadId}". Start a fresh grok call (in-memory sessions do not survive an MCP restart).` }],
            isError: true,
            errorKind,
            retryable,
          });
        }
        return;
      }
      messages = [...prior, { role: "user", content: args.prompt }];
    } else {
      if (shouldRespond) sendError(id, -32601, `Tool not found: ${name}`);
      return;
    }

    const startedAt = Date.now();
    let outcome = "ok";
    try {
      const text = await runGrok({
        messages,
        model: args.model,
        timeoutMs: args.timeout,
        apiKey: process.env.XAI_API_KEY,
        apiBase: DEFAULT_API_BASE,
      });

      // Persist the turn so grok-reply can continue this thread.
      sessions.set(threadId, [...messages, { role: "assistant", content: text }]);

      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text }],
          threadId,
        });
      }
    } catch (e) {
      const errMsg = (e && e.message) || String(e);
      const { errorKind, retryable } = classifyGrokError(e && e.status, e && e.code);
      outcome = errorKind;
      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
          errorKind,
          retryable,
        });
      }
    } finally {
      const cid = (id != null) ? id : (threadId != null ? threadId : "-");
      const toolName = isNonEmptyString(name) ? name : "unknown";
      logCall(cid, toolName, outcome, Date.now() - startedAt);
    }
  },

  "notifications/initialized": () => {}
};

// --- Main Loop (Robust JSON-RPC stream handling) ---

// Parse and dispatch a single newline-delimited JSON-RPC message. Shared by the
// stdin 'data' loop and the clean-EOF tail flush, so a final line that arrives
// without a trailing newline is still handled.
async function processLine(line) {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    return; // ignore non-JSON noise
  }

  const shouldRespond = hasRequestId(request);
  if (!isObject(request) || typeof request.method !== "string") {
    if (shouldRespond) sendError(request.id, -32600, "Invalid Request");
    return;
  }

  const handler = handlers[request.method];
  if (!handler) {
    if (shouldRespond) sendError(request.id, -32601, `Method not found: ${request.method}`);
    return;
  }

  try {
    await handler(request.id, request.params, shouldRespond);
  } catch (e) {
    if (shouldRespond) sendError(request.id, -32603, `Internal error: ${e.message}`);
  }
}

let buffer = "";

if (require.main === module) {
  // F2: after an uncaught throw / rejection the process is in an undefined state
  // (Node guarantees no safe resumption). Log the stack, then exit non-zero in
  // the write callback (so the line is not truncated) and let the MCP host
  // restart the bridge. In-memory sessions are already ephemeral across restarts.
  process.on("uncaughtException", (e) => {
    process.stderr.write(`[grok] fatal-guard uncaughtException: ${e && e.stack ? e.stack : String((e && e.message) || e)}\n`, () => process.exit(1));
  });
  process.on("unhandledRejection", (e) => {
    process.stderr.write(`[grok] fatal-guard unhandledRejection: ${e && e.stack ? e.stack : String((e && e.message) || e)}\n`, () => process.exit(1));
  });

  // F2: a broken input pipe is terminal -- the bridge can no longer receive
  // requests. Exit 1 after the stderr line flushes (exit from the write callback).
  process.stdin.on("error", (e) => {
    process.stderr.write(`[grok] stdin error (input pipe broken): ${String((e && e.message) || e)}\n`, () => process.exit(1));
  });

  process.stdin.on("data", async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep any partial trailing line
    for (const line of lines) await processLine(line);
  });

  // F2: a clean EOF means the client is done. Flush a final line that arrived
  // without a trailing newline, then let the event loop drain naturally -- any
  // in-flight call finishes and flushes its stdout response, and the process
  // exits 0 once no handles remain. No forced process.exit: that would truncate
  // buffered stdout and could drop sibling lines from the same chunk.
  let ended = false;
  const onEnd = () => {
    if (ended) return; // 'end' and 'close' can both fire; flush at most once
    ended = true;
    const tail = buffer;
    buffer = "";
    if (tail.trim()) processLine(tail);
  };
  process.stdin.on("end", onEnd);
  process.stdin.on("close", onEnd);

  // Startup Check: the bridge needs global fetch (Node 18+). The API key is NOT
  // required at startup so the initialize handshake and missing-auth error path
  // both stay reachable; it is validated per-call in runGrok.
  if (typeof globalThis.fetch !== "function") {
    console.error("Grok bridge requires Node 18+ (global fetch unavailable).");
    process.exit(1);
  }
  if (!isNonEmptyString(process.env.XAI_API_KEY)) {
    console.error("[claude-delegator] warning: XAI_API_KEY is not set; grok calls will return errorKind:missing-auth until it is.");
  }

  // Test-only seams (never triggered in normal operation). They exercise the F2
  // process-level guards from a child process where the real signals are hard to
  // synthesize deterministically.
  if (process.env.GROK_TEST_EMIT_STDIN_ERROR === "1") {
    process.nextTick(() => process.stdin.emit("error", new Error("pipe boom (test seam)")));
  }
  if (process.env.GROK_TEST_THROW_ASYNC === "1") {
    setTimeout(() => { throw new Error("async boom (test seam)"); }, 30);
  }
}

// Test-only exports
if (typeof module !== "undefined" && module.exports) {
  module.exports.classifyGrokError = classifyGrokError;
  module.exports.buildMessages = buildMessages;
  module.exports.parseChatCompletion = parseChatCompletion;
  module.exports.runGrok = runGrok;
}
