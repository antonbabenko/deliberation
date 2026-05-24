#!/usr/bin/env node

/**
 * Claude Delegator - Grok (xAI) MCP Bridge
 *
 * A zero-dependency MCP server that calls the xAI **Responses API**
 * (`POST /v1/responses`). Speaks JSON-RPC 2.0 over stdio.
 *
 * The Responses endpoint (not chat/completions) is required to attach uploaded
 * files (`{type:"input_file", file_id}`). The bridge owns conversation state
 * directly, so multi-turn (grok-reply) is an in-memory threadId -> turns map and
 * we resend the full `input` each turn (no reliance on previous_response_id).
 *
 * Auth: XAI_API_KEY (env). Model: GROK_DEFAULT_MODEL (env) or grok-4.3.
 * Endpoint: XAI_API_BASE (env) or https://api.x.ai/v1.
 * File TTL: GROK_FILE_TTL_SECONDS (env) or 604800 (7 days).
 * Reasoning effort: GROK_REASONING_EFFORT (env) or "high"; per-call reasoning_effort overrides.
 */

const crypto = require("node:crypto");
const path = require("node:path");
const { stat, readFile } = require("node:fs/promises");

const DEFAULT_MODEL = process.env.GROK_DEFAULT_MODEL || "grok-4.3";
const DEFAULT_API_BASE = process.env.XAI_API_BASE || "https://api.x.ai/v1";
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const MAX_MS = 600_000;
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);

// xAI accepts expires_after between 1 hour and 30 days. Default 7 days.
const FILE_TTL_MIN = 3600;
const FILE_TTL_MAX = 2_592_000;
function resolveFileTtl() {
  const raw = Number(process.env.GROK_FILE_TTL_SECONDS);
  const v = Number.isFinite(raw) && raw > 0 ? raw : 604_800;
  return Math.min(FILE_TTL_MAX, Math.max(FILE_TTL_MIN, Math.round(v)));
}
const FILE_TTL_SECONDS = resolveFileTtl();
// Stay safely under the documented ~50 MB upload cap.
const MAX_FILE_BYTES = 48 * 1024 * 1024;
// Filename prefix marks bridge-owned uploads so cleanup never touches the
// user's own xAI files. Flat (no slashes/colons) to avoid filename mangling.
const FILE_PREFIX = "claude-delegator-";
const UPLOAD_PURPOSE = "assistants";

// Reasoning effort: per-call value wins, then GROK_REASONING_EFFORT, then the
// default. "", "none", or "off" omit the field so the model uses its own default.
const DEFAULT_REASONING_EFFORT = "high";
function resolveReasoningEffort(perCall) {
  let raw = perCall;
  if (raw === undefined || raw === null) raw = process.env.GROK_REASONING_EFFORT;
  if (raw === undefined || raw === null) raw = DEFAULT_REASONING_EFFORT;
  const v = String(raw).trim();
  if (v === "" || v.toLowerCase() === "none" || v.toLowerCase() === "off") return null;
  return v;
}

// In-memory session store: threadId -> turns[]. Lives for the MCP process
// lifetime only; lost on restart (grok-reply then returns unknown-thread).
const sessions = new Map();

// NOTE: multi-turn assumes serial use per threadId. Two concurrent grok-reply
// calls on the same thread would race on the read-then-set below (last write
// wins). Acceptable for v1 -- every shipped caller (/ask-*, /consensus) is
// single-shot and never replies to one thread in parallel.

// --- MCP Protocol Helpers ---

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
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
    case "missing-auth":    return { errorKind: "missing-auth",    retryable: false };
    case "unknown-thread":  return { errorKind: "unknown-thread",  retryable: false };
    case "timeout":         return { errorKind: "timeout",         retryable: true };
    case "network":         return { errorKind: "network",         retryable: true };
    case "parse":           return { errorKind: "parse",           retryable: false };
    case "file-too-large":  return { errorKind: "file-too-large",  retryable: false };
    case "file-read":       return { errorKind: "file-read",       retryable: false };
    case "file-upload":     return { errorKind: "file-upload",     retryable: true };
  }
  const s = Number(status);
  if (s === 401 || s === 403) return { errorKind: "auth", retryable: false };
  if (s === 429)              return { errorKind: "rate-limit", retryable: true };
  if (s >= 500 && s <= 599)   return { errorKind: "upstream", retryable: true };
  return { errorKind: "unknown", retryable: false };
}

// --- Pure helpers (exported for tests) ---

// A "turn" is { role, text, fileRefs? } where fileRefs is an array of
// { file_id } | { file_url }. buildInitialTurns seeds a fresh conversation.
function buildInitialTurns(developerInstructions, prompt, fileRefs) {
  const turns = [];
  if (isNonEmptyString(developerInstructions)) {
    turns.push({ role: "system", text: developerInstructions });
  }
  turns.push({ role: "user", text: prompt, fileRefs: fileRefs || [] });
  return turns;
}

// Convert internal turns into the /v1/responses `input` array. User content uses
// input_text + input_file parts; system stays text. Assistant turns replay the
// server's own `output` items verbatim when we captured them (documented stateless
// chaining - a server always accepts the shape it emitted); otherwise fall back to
// a minimal text item.
function turnsToInput(turns) {
  const input = [];
  for (const turn of turns) {
    if (turn.role === "assistant") {
      if (Array.isArray(turn.items) && turn.items.length) {
        for (const item of turn.items) input.push(item);
      } else {
        input.push({ role: "assistant", content: [{ type: "output_text", text: turn.text }] });
      }
      continue;
    }
    if (turn.role === "system") {
      input.push({ role: "system", content: [{ type: "input_text", text: turn.text }] });
      continue;
    }
    const content = [{ type: "input_text", text: turn.text }];
    for (const ref of turn.fileRefs || []) {
      if (ref.file_id) content.push({ type: "input_file", file_id: ref.file_id });
      else if (ref.file_url) content.push({ type: "input_file", file_url: ref.file_url });
    }
    input.push({ role: "user", content });
  }
  return input;
}

// Extract the assistant text from a /v1/responses body. Throws `.code="parse"`
// on a malformed shape. Tolerates the convenience `output_text` field and the
// nested output[].content[].text shape.
function parseResponsesOutput(data) {
  const fail = (why) => {
    const e = new Error(`Parse error: ${why}`);
    e.code = "parse";
    return e;
  };
  if (!isObject(data)) throw fail("response was not a JSON object");
  if (isNonEmptyString(data.output_text)) return data.output_text;
  const output = data.output;
  if (!Array.isArray(output) || output.length === 0) throw fail("no output in response");
  // Prefer the last message item that carries text content; concatenate all of its
  // text parts (a message may interleave multiple text segments).
  for (let i = output.length - 1; i >= 0; i--) {
    const item = output[i];
    const parts = item && item.content;
    if (!Array.isArray(parts)) continue;
    const texts = parts
      .filter((p) => p && typeof p.text === "string" && (p.type === "output_text" || p.type === "text" || p.type === undefined))
      .map((p) => p.text);
    if (texts.length) return texts.join("");
  }
  throw fail("no text part found in output");
}

// --- xAI Files API ---

// Upload one local file and return its file object. Errors carry `.code`
// (file-too-large/file-read/file-upload/missing-auth) and/or `.status`.
// `fetchImpl` is injectable for tests.
async function uploadFile({ filePath, filename, apiKey, apiBase, ttl, cwd, fetchImpl }) {
  if (!isNonEmptyString(apiKey)) {
    const e = new Error("XAI_API_KEY is not set; cannot upload files.");
    e.code = "missing-auth";
    throw e;
  }
  const f = fetchImpl || globalThis.fetch;
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  // Containment: the resolved path must stay within the base dir. Blocks absolute
  // paths and `../` escapes from exfiltrating arbitrary local files to xAI.
  const root = path.resolve(cwd || process.cwd());
  const resolved = path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const e = new Error(`File "${filePath}" resolves outside the working directory (${root}); refused.`);
    e.code = "file-read";
    throw e;
  }

  let info;
  try {
    info = await stat(resolved);
  } catch (err) {
    const e = new Error(`Cannot read file "${filePath}": ${(err && err.message) || err}`);
    e.code = "file-read";
    throw e;
  }
  if (!info.isFile()) {
    const e = new Error(`Not a regular file: "${filePath}"`);
    e.code = "file-read";
    throw e;
  }
  if (info.size > MAX_FILE_BYTES) {
    const e = new Error(`File "${filePath}" is ${info.size} bytes; exceeds the ${MAX_FILE_BYTES}-byte cap.`);
    e.code = "file-too-large";
    throw e;
  }

  let buf;
  try {
    buf = await readFile(resolved);
  } catch (err) {
    const e = new Error(`Cannot read file "${filePath}": ${(err && err.message) || err}`);
    e.code = "file-read";
    throw e;
  }

  const baseName = path.basename(filename || resolved);
  const storedName = `${FILE_PREFIX}${Date.now()}-${baseName}`;
  // Append scalar fields BEFORE the (potentially large, streamed) file part so a
  // streaming multipart parser sees expires_after/purpose regardless of body size.
  const form = new FormData();
  form.append("expires_after", String(ttl != null ? ttl : FILE_TTL_SECONDS));
  form.append("purpose", UPLOAD_PURPOSE);
  form.append("file", new Blob([buf]), storedName);

  let res;
  try {
    res = await f(`${base}/files`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` }, // no Content-Type: fetch sets the multipart boundary
      body: form,
    });
  } catch (err) {
    const e = new Error(`File upload network error: ${(err && err.message) || err}`);
    e.code = "file-upload";
    throw e;
  }

  let bodyText = "";
  try { bodyText = await res.text(); } catch (_) { bodyText = ""; }
  if (!res.ok) {
    const e = new Error(`xAI file upload error ${res.status}: ${truncate(bodyText, 300)}`);
    e.status = res.status;
    if (res.status < 400 || res.status >= 500) e.code = "file-upload";
    throw e;
  }
  try {
    return JSON.parse(bodyText);
  } catch (e2) {
    const e = new Error(`File upload parse error: ${e2.message}`);
    e.code = "parse";
    throw e;
  }
}

// Resolve a `files` param into { refs, ownedIds }. `path` entries are uploaded
// (bridge-owned); `file_id`/`file_url` pass through untouched.
async function resolveFiles(files, opts) {
  const refs = [];
  const ownedIds = [];
  for (const entry of files || []) {
    if (entry.file_id) {
      refs.push({ file_id: entry.file_id });
    } else if (entry.file_url) {
      refs.push({ file_url: entry.file_url });
    } else if (entry.path) {
      const uploaded = await uploadFile({ filePath: entry.path, filename: entry.filename, ...opts });
      if (!isNonEmptyString(uploaded && uploaded.id)) {
        const e = new Error("File upload returned no file id");
        e.code = "parse";
        throw e;
      }
      refs.push({ file_id: uploaded.id });
      ownedIds.push(uploaded.id);
    }
  }
  return { refs, ownedIds };
}

// --- xAI Responses API Call ---

// One /v1/responses call returning the assistant text. Errors carry `.code`
// and/or `.status`. `fetchImpl` is injectable for tests.
async function runGrok({ turns, model, timeoutMs, apiKey, apiBase, fetchImpl, reasoningEffort }) {
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
  const url = `${base}/responses`;
  const payload = { model: model || DEFAULT_MODEL, input: turnsToInput(turns), stream: false };
  if (isNonEmptyString(reasoningEffort)) payload.reasoning_effort = reasoningEffort;
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
      body: JSON.stringify(payload),
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
  const text = parseResponsesOutput(data);
  // `output` is captured so grok-reply can replay the server's own items verbatim.
  return { text, output: Array.isArray(data.output) ? data.output : null };
}

// --- Request Handlers ---

const FILES_SCHEMA = {
  type: "array",
  description: "Optional files to attach. Each item has EXACTLY ONE of: path (local file the bridge uploads), file_id (an already-uploaded xAI file id), or file_url (a public URL). Optional filename overrides the stored upload name.",
  items: {
    type: "object",
    properties: {
      path: { type: "string", description: "Local file path; bridge uploads it (resolved against cwd)" },
      file_id: { type: "string", description: "Existing xAI file id" },
      file_url: { type: "string", description: "Public URL to a file" },
      filename: { type: "string", description: "Override stored filename for a path upload" },
    },
  },
};

const GROK_PROPERTIES = {
  prompt: { type: "string", description: "The delegation prompt" },
  "developer-instructions": { type: "string", description: "Expert system instructions (sent as a system message)" },
  model: { type: "string", description: "xAI model id. Defaults to GROK_DEFAULT_MODEL or grok-4.3.", default: DEFAULT_MODEL },
  reasoning_effort: { type: "string", description: "Reasoning effort (e.g. low, medium, high). Defaults to GROK_REASONING_EFFORT or high. Use 'none' to omit the field.", default: DEFAULT_REASONING_EFFORT },
  timeout: { type: "number", description: "Soft timeout in ms. 1..600000. Default 180000.", default: DEFAULT_TIMEOUT_MS },
  files: FILES_SCHEMA,
  sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only", description: "Accepted for call-shape parity with other providers; ignored (Grok cannot edit files)." },
  cwd: { type: "string", description: "Base directory for resolving relative file `path` uploads. Defaults to the server's cwd." },
};

// Validate a `files` param. Returns an error string, or null when valid/absent.
function validateFiles(files) {
  if (files === undefined) return null;
  if (!Array.isArray(files)) return "'files' must be an array when provided";
  for (const entry of files) {
    if (!isObject(entry)) return "each 'files' entry must be an object";
    const keys = ["path", "file_id", "file_url"].filter((k) => entry[k] !== undefined);
    if (keys.length !== 1) return "each 'files' entry needs exactly one of path, file_id, or file_url";
    if (!isNonEmptyString(entry[keys[0]])) return `'files' entry ${keys[0]} must be a non-empty string`;
    if (entry.filename !== undefined && !isNonEmptyString(entry.filename)) return "'files' entry filename must be a non-empty string when provided";
  }
  return null;
}

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-delegator-grok", version: "1.8.0" }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: [
        {
          name: "grok",
          description: "Start a new Grok (xAI) expert session. Advisory only (no filesystem editing). Supports attaching files.",
          inputSchema: { type: "object", properties: GROK_PROPERTIES, required: ["prompt"] }
        },
        {
          name: "grok-reply",
          description: "Continue an existing Grok session (in-memory; lost if the MCP server restarts).",
          inputSchema: {
            type: "object",
            properties: {
              threadId: { type: "string", description: "Session ID returned by a previous grok call" },
              prompt: { type: "string", description: "Follow-up prompt" },
              files: FILES_SCHEMA,
              model: { type: "string", default: DEFAULT_MODEL },
              reasoning_effort: { type: "string", default: DEFAULT_REASONING_EFFORT, description: "Reasoning effort; defaults to GROK_REASONING_EFFORT or high. Use 'none' to omit." },
              timeout: { type: "number", default: DEFAULT_TIMEOUT_MS },
              cwd: { type: "string", description: "Base directory for relative file path uploads" },
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
    if (args.reasoning_effort !== undefined && typeof args.reasoning_effort !== "string") {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'reasoning_effort' must be a string when provided");
      return;
    }
    if (args.timeout !== undefined) {
      if (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > MAX_MS) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'timeout' must be a number > 0 and <= 600000 milliseconds");
        return;
      }
    }
    const filesErr = validateFiles(args.files);
    if (filesErr) {
      if (shouldRespond) sendError(id, -32602, `Invalid params: ${filesErr}`);
      return;
    }
    if (!isNonEmptyString(args.prompt)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
      return;
    }

    let priorTurns = null;
    let threadId;

    if (name === "grok") {
      if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'developer-instructions' must be a string when provided");
        return;
      }
      threadId = crypto.randomUUID();
    } else if (name === "grok-reply") {
      if (!isNonEmptyString(args.threadId)) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' is required for grok-reply");
        return;
      }
      threadId = args.threadId.trim();
      priorTurns = sessions.get(threadId);
      if (!priorTurns) {
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
    } else {
      if (shouldRespond) sendError(id, -32601, `Tool not found: ${name}`);
      return;
    }

    const startedAt = Date.now();
    let outcome = "ok";
    try {
      // Upload/resolve any attached files first (so an upload failure short-circuits).
      const { refs, ownedIds } = await resolveFiles(args.files, {
        apiKey: process.env.XAI_API_KEY,
        apiBase: DEFAULT_API_BASE,
        ttl: FILE_TTL_SECONDS,
        cwd: args.cwd,
      });

      const turns = priorTurns
        ? [...priorTurns, { role: "user", text: args.prompt, fileRefs: refs }]
        : buildInitialTurns(args["developer-instructions"], args.prompt, refs);

      const { text, output } = await runGrok({
        turns,
        model: args.model,
        timeoutMs: args.timeout,
        reasoningEffort: resolveReasoningEffort(args.reasoning_effort),
        apiKey: process.env.XAI_API_KEY,
        apiBase: DEFAULT_API_BASE,
      });

      // Persist the turn so grok-reply can continue this thread. `items` holds the
      // server's raw output for verbatim replay (falls back to `text` if absent).
      sessions.set(threadId, [...turns, { role: "assistant", text, items: output || undefined }]);

      if (shouldRespond) {
        const result = { content: [{ type: "text", text }], threadId };
        if (ownedIds.length) result.uploadedFileIds = ownedIds;
        sendResponse(id, result);
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

if (require.main === module) {
  let buffer = "";
  let chain = Promise.resolve();

  // Serialize processing so responses are emitted in request order even when a
  // chunk carries multiple messages.
  const enqueue = (line) => { chain = chain.then(() => processLine(line)); };

  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) enqueue(line);
  });

  process.stdin.on("end", () => {
    if (buffer) { enqueue(buffer); buffer = ""; }
  });

  // Startup check: the bridge needs global fetch (Node 18+). The API key is NOT
  // required at startup so the initialize handshake and missing-auth error path
  // both stay reachable; it is validated per-call.
  if (typeof globalThis.fetch !== "function") {
    console.error("Grok bridge requires Node 18+ (global fetch unavailable).");
    process.exit(1);
  }
  if (!isNonEmptyString(process.env.XAI_API_KEY)) {
    console.error("[claude-delegator] warning: XAI_API_KEY is not set; grok calls will return errorKind:missing-auth until it is.");
  }
}

// Test-only exports
if (typeof module !== "undefined" && module.exports) {
  module.exports.classifyGrokError = classifyGrokError;
  module.exports.resolveReasoningEffort = resolveReasoningEffort;
  module.exports.buildInitialTurns = buildInitialTurns;
  module.exports.turnsToInput = turnsToInput;
  module.exports.parseResponsesOutput = parseResponsesOutput;
  module.exports.runGrok = runGrok;
  module.exports.uploadFile = uploadFile;
  module.exports.resolveFiles = resolveFiles;
  module.exports.validateFiles = validateFiles;
  module.exports.FILE_PREFIX = FILE_PREFIX;
  module.exports.FILE_TTL_SECONDS = FILE_TTL_SECONDS;
}
