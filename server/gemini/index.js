#!/usr/bin/env node
// @ts-nocheck -- legacy bridge; predates the strict typecheck gate (core-only). Opt-in is a separate pass.

/**
 * Claude Delegator - Gemini MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Antigravity CLI (agy).
 * Speaks JSON-RPC 2.0 over stdio.
 *
 * Public surface is unchanged from the legacy gemini-CLI bridge: the MCP server
 * is still "gemini", the tools are still "gemini" / "gemini-reply", and the env
 * vars GEMINI_DEFAULT_MODEL / GEMINI_DISABLE_TIMEOUT_RECOVERY still apply. Only
 * the underlying CLI, flags, output parsing, and timeout recovery changed.
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AGY_BIN = process.env.AGY_BIN || "agy";
const DEFAULT_MODEL = process.env.GEMINI_DEFAULT_MODEL || "auto-gemini-3";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes (Gemini 3 deep prompts run 200-260s)
const DEFAULT_RECOVERY_GRACE_MS = 120_000; // extra drain budget after the soft timeout
const MAX_MS = 600_000;
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);

// agy's --print-timeout takes a Go duration string ("420s"). Convert ms.
function goDuration(ms) {
  return Math.ceil(ms / 1000) + "s";
}

// Build the agy argv for a one-shot (non-reply) run. MUST end with
// "-p <prompt>" - runGemini does args.lastIndexOf("-p") to splice in
// --print-timeout before the prompt tail. The live `gemini` handler uses this
// so the server path and the core adapter share one assembly. model is accepted
// but never reaches argv (agy reads the model from ~/.gemini/settings.json).
// developerInstructions, when present, is folded into the prompt (agy print mode
// has no system channel). The --conversation reply flag is NOT built here; that
// stays in the gemini-reply handler branch.
/**
 * @param {{prompt:string, model?:string, includeDirs?:string[], sandbox?:string, developerInstructions?:string}} req
 * @returns {string[]}
 */
function buildAgyArgs(req) {
  const args = [];
  // Sandbox / permissions mapping (default read-only -> --sandbox).
  if (req.sandbox === "workspace-write") args.push("--dangerously-skip-permissions");
  else args.push("--sandbox");
  // Extra workspace dirs.
  for (const d of req.includeDirs || []) args.push("--add-dir", d);
  // Fold expert instructions into the prompt (no system channel in print mode).
  let prompt = req.prompt;
  if (req.developerInstructions) prompt = `${req.developerInstructions}\n\n${prompt}`;
  args.push("-p", prompt); // "-p <prompt>" MUST be the tail
  return args;
}

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

// agy reports failures as "Error: <msg>" on stdout at exit 0. Any stdout LINE
// starting with "Error:" is a failure even when the process exits 0 - the
// sentinel can arrive after streamed partial output, so match line-anchored
// (multiline), not just at the very start of the buffer.
function stdoutIsError(s) {
  return /^\s*Error:\s/m.test(s);
}

// --- Error Classification ---

// Pure helper: given a runGemini rejection's message and code, produce the
// structured error fields the orchestrator consumes. Exported for tests.
function classifyGeminiError(errMsg, errCode) {
  const msg = String(errMsg || "");
  const lower = msg.toLowerCase();
  if (errCode === "timeout") return { errorKind: "timeout", retryable: true };
  if (errCode === "parse")   return { errorKind: "parse",   retryable: false };
  if (msg.includes("(agy) not found")) return { errorKind: "missing-cli", retryable: false };
  if (lower.includes("aborterror") || lower.includes("aborted")) {
    return { errorKind: "upstream-abort", retryable: true };
  }
  return { errorKind: "unknown", retryable: false };
}

// --- Conversation id resolution ---
//
// agy persists a cwd -> conversation-id map at
// ~/.gemini/antigravity-cli/cache/last_conversations.json. After an agy -p run
// in a cwd, that cwd's value is the run's conversation id. Resume uses
// --conversation <id>. There is no id on stderr; we read it from this map.
function resolveConversationId(cwd) {
  try {
    const mapPath = process.env.AGY_LAST_CONVERSATIONS ||
      path.join(os.homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json");
    const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    if (!map || typeof map !== "object") return null;
    const resolved = path.resolve(cwd);
    let real = resolved;
    try { real = fs.realpathSync(resolved); } catch (_) { /* ignore */ }
    return map[real] ?? map[resolved] ?? map[cwd] ?? null;
  } catch (_) {
    return null;
  }
}

// --- agy CLI Wrapper ---

async function runGemini(args, cwd, timeoutMs, recoveryGraceMs) {
  return new Promise((resolve, reject) => {
    const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const effCwd = cwd || process.cwd();
    const spawnStartMs = Date.now();
    const disableRecovery = process.env.GEMINI_DISABLE_TIMEOUT_RECOVERY === "1";
    const grace = disableRecovery
      ? 0
      : (typeof recoveryGraceMs === "number" && recoveryGraceMs >= 0
          ? recoveryGraceMs
          : DEFAULT_RECOVERY_GRACE_MS);

    let killed = false;   // legacy hard-kill path (grace === 0)
    let draining = false; // soft timeout fired, buffering streamed stdout
    let settled = false;
    let graceTimer = null;

    // agy streams stdout incrementally; we buffer it. The agy print-timeout is
    // set generously past the bridge soft timeout + grace so the BRIDGE owns
    // timing (agy should not error out before we drain).
    // args already end with "-p <prompt>"; prepend --print-timeout before them
    // so flags stay together and -p <prompt> remains the tail.
    const ptIdx = args.lastIndexOf("-p");
    const head = ptIdx >= 0 ? args.slice(0, ptIdx) : args;
    const tail = ptIdx >= 0 ? args.slice(ptIdx) : [];
    const agyArgs = [...head, "--print-timeout", goDuration(t + grace + 30_000), ...tail];
    const agyProcess = spawn(AGY_BIN, agyArgs, {
      env: process.env,
      shell: false,
      cwd: effCwd,
      // agy -p (print mode) waits for stdin EOF before returning; if the stdin
      // pipe is left open it hangs until the timeout. Give it /dev/null so it
      // sees EOF immediately and runs to completion.
      stdio: ["ignore", "pipe", "pipe"]
    });

    function clearTimers() { clearTimeout(killTimer); if (graceTimer) clearTimeout(graceTimer); }
    function destroyStreams() {
      try { agyProcess.stdout.destroy(); } catch (_) {}
      try { agyProcess.stderr.destroy(); } catch (_) {}
    }
    function timeoutError() {
      const tail = stderr && stderr.trim() ? "; last agy stderr: " + stderr.trim().slice(-500) : "";
      const err = new Error("Gemini (agy) timed out after " + Math.round(t / 1000) + "s" + tail);
      err.code = "timeout";
      return err;
    }
    function finishTimeout() {
      if (settled) return;
      settled = true;
      clearTimers();
      try { agyProcess.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => { try { agyProcess.kill("SIGKILL"); } catch (_) {} }, 1_000);
      destroyStreams();
      reject(timeoutError());
    }

    const killTimer = setTimeout(() => {
      if (settled) return;
      if (grace > 0) {
        // Drain: keep agy alive and keep buffering streamed stdout. If agy
        // exits cleanly (exit 0, non-empty stdout, no Error: sentinel) within
        // the grace budget the close handler resolves recovered:true. If the
        // grace expires first, finishTimeout() fails hard.
        draining = true;
        graceTimer = setTimeout(() => finishTimeout(), grace);
        return;
      }
      // Legacy hard-kill path.
      killed = true;
      try { agyProcess.kill("SIGTERM"); } catch (_) {}
      graceTimer = setTimeout(() => {
        try { agyProcess.kill("SIGKILL"); } catch (_) {}
      }, 1_000);
    }, t);

    agyProcess.on("close", clearTimers);
    agyProcess.on("error", clearTimers);

    // exit fires when the process itself exits even if child pipes are still
    // open. Surface the legacy timeout early without waiting for pipe drain.
    agyProcess.on("exit", () => {
      if (killed && !settled) {
        settled = true;
        clearTimers();
        destroyStreams();
        reject(timeoutError());
      }
    });

    let stdout = "";
    let stderr = "";

    agyProcess.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (err.code === "ENOENT") {
        reject(new Error("Antigravity CLI (agy) not found. Install from https://antigravity.google and run `agy` once to sign in."));
      } else {
        reject(err);
      }
    });

    agyProcess.stdout.on("data", (data) => { stdout += data.toString(); });
    agyProcess.stderr.on("data", (data) => { stderr += data.toString(); });

    agyProcess.on("close", (code) => {
      if (settled) return; // already resolved/rejected elsewhere
      if (killed) {        // legacy soft-timeout kill
        settled = true;
        clearTimers();
        return reject(timeoutError());
      }

      const out = stdout.trim();
      const trimmedErr = stderr.trim();
      const success = code === 0 && out && !stdoutIsError(out);

      if (draining) {
        // Soft timeout already fired. Only a clean exit meeting the success
        // contract recovers; anything else is a hard timeout. NEVER return
        // partial buffered stdout as success.
        if (success) {
          settled = true;
          clearTimers();
          process.stderr.write(
            "[deliberation] recovered agy answer via stdout drain after soft timeout (" +
            Math.round((Date.now() - spawnStartMs) / 1000) + "s)\n"
          );
          return resolve({ response: out, threadId: resolveConversationId(effCwd) || "unknown", recovered: true });
        }
        return finishTimeout();
      }

      settled = true;
      clearTimers();

      if (success) {
        const threadId = resolveConversationId(effCwd);
        if (threadId == null) {
          process.stderr.write(
            "[deliberation] no conversation id found for cwd " + effCwd +
            "; returning threadId:\"unknown\" (resume will be unavailable)\n"
          );
        }
        return resolve({ response: out, threadId: threadId || "unknown" });
      }

      // Failure. Prefer stderr so it is not masked by an stdout banner; then an
      // stdout Error: sentinel; then a generic message.
      let message;
      if (trimmedErr) message = trimmedErr;
      else if (stdoutIsError(out)) message = out;
      else if (!out) message = `No output from agy`;
      else message = `agy exited with code ${code}`;

      const err = new Error(message);
      if (/timed out/i.test(message)) {
        err.code = "timeout";
      } else if (!trimmedErr && !out) {
        // Clean exit, nothing on either stream: empty/garbage output.
        err.code = "parse";
      }
      // Otherwise leave err.code undefined and let classifyGeminiError map the
      // message text (trust / abort / unknown).
      reject(err);
    });
  });
}

// --- Request Handlers ---

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "deliberation-gemini", version: "1.6.0" }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: [
        {
          name: "gemini",
          description: "Start a new Gemini expert session",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "The delegation prompt" },
              "developer-instructions": { type: "string", description: "Expert system instructions" },
              sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
              cwd: { type: "string", description: "Current working directory" },
              model: { type: "string", default: DEFAULT_MODEL, description: "Advisory only; agy reads the model from ~/.gemini/settings.json (default auto-gemini-3)." },
              "include-directories": {
                type: "array",
                items: { type: "string" },
                description: "Additional workspace dirs; maps to repeated --add-dir on the Antigravity CLI (agy)."
              },
              timeout: { type: "number", description: "Soft timeout in ms. 1..600000. Default 300000. On expiry the bridge drains the streamed stdout and recovers a late answer instead of failing.", default: DEFAULT_TIMEOUT_MS },
              "recovery-grace": { type: "number", description: "Extra ms to keep agy alive after the soft timeout to drain a late answer from streamed stdout. 0..600000. Default 120000. 0 disables drain.", default: DEFAULT_RECOVERY_GRACE_MS }
            },
            required: ["prompt"]
          }
        },
        {
          name: "gemini-reply",
          description: "Continue an existing Gemini session",
          inputSchema: {
            type: "object",
            properties: {
              threadId: { type: "string", description: "Conversation ID returned by a previous gemini call" },
              prompt: { type: "string", description: "Follow-up prompt" },
              sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
              cwd: { type: "string" },
              "include-directories": {
                type: "array",
                items: { type: "string" },
                description: "Additional workspace dirs; maps to repeated --add-dir on the Antigravity CLI (agy)."
              },
              timeout: { type: "number", description: "Soft timeout in ms. 1..600000. Default 300000. On expiry the bridge drains the streamed stdout and recovers a late answer instead of failing.", default: DEFAULT_TIMEOUT_MS },
              "recovery-grace": { type: "number", description: "Extra ms to keep agy alive after the soft timeout to drain a late answer from streamed stdout. 0..600000. Default 120000. 0 disables drain.", default: DEFAULT_RECOVERY_GRACE_MS }
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
    if (args.timeout !== undefined) {
      if (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > MAX_MS) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'timeout' must be a number > 0 and <= 600000 milliseconds");
        return;
      }
    }
    if (args["recovery-grace"] !== undefined) {
      const g = args["recovery-grace"];
      if (typeof g !== "number" || !Number.isFinite(g) || g < 0 || g > MAX_MS) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'recovery-grace' must be a number >= 0 and <= 600000 milliseconds");
        return;
      }
    }
    if (args["include-directories"] !== undefined) {
      if (!Array.isArray(args["include-directories"]) || args["include-directories"].length === 0) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'include-directories' must be a non-empty array of strings when provided");
        return;
      }
      for (const dir of args["include-directories"]) {
        if (!isNonEmptyString(dir)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: each entry in 'include-directories' must be a non-empty string");
          return;
        }
      }
    }

    try {
      const agyArgs = [];

      // Sandbox / permissions mapping is common to both tools.
      const sandboxFlags = [];
      if (args.sandbox === "workspace-write") sandboxFlags.push("--dangerously-skip-permissions");
      else sandboxFlags.push("--sandbox");

      const addDirFlags = [];
      if (args["include-directories"]) {
        for (const dir of args["include-directories"]) addDirFlags.push("--add-dir", dir);
      }

      if (name === "gemini") {
        // model is accepted + validated but never reaches argv (agy reads the
        // model from ~/.gemini/settings.json).
        if (args.model !== undefined && !isNonEmptyString(args.model)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'model' must be a non-empty string when provided");
          return;
        }
        if (!isNonEmptyString(args.prompt)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
          return;
        }
        if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'developer-instructions' must be a string when provided");
          return;
        }

        agyArgs.push(...buildAgyArgs({
          prompt: args.prompt,
          model: args.model,
          includeDirs: args["include-directories"],
          sandbox: args.sandbox,
          developerInstructions: args["developer-instructions"],
        }));
      } else if (name === "gemini-reply") {
        if (!isNonEmptyString(args.threadId)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' is required for gemini-reply");
          return;
        }
        const threadId = args.threadId.trim();
        if (threadId === "" || threadId === "latest" || threadId === "unknown") {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' must be an explicit conversation id, not '" + threadId + "'");
          return;
        }
        if (!isNonEmptyString(args.prompt)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
          return;
        }

        agyArgs.push("--conversation", threadId, ...sandboxFlags, ...addDirFlags);
        agyArgs.push("-p", args.prompt);
      } else {
        if (shouldRespond) sendError(id, -32601, `Tool not found: ${name}`);
        return;
      }

      const timeoutMs = (typeof args.timeout === "number" && args.timeout > 0) ? args.timeout : DEFAULT_TIMEOUT_MS;
      const recoveryGraceMs = (typeof args["recovery-grace"] === "number" && args["recovery-grace"] >= 0)
        ? args["recovery-grace"]
        : DEFAULT_RECOVERY_GRACE_MS;
      const { response, threadId, recovered } = await runGemini(agyArgs, args.cwd, timeoutMs, recoveryGraceMs);

      // Return metadata (threadId) at the top level for orchestration rules,
      // and standard content array for the UI.
      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: response }],
          threadId: threadId,
          ...(recovered ? { recovered: true } : {})
        });
      }
    } catch (e) {
      const errMsg = (e && e.message) || String(e);
      const errCode = e && e.code;
      const { errorKind, retryable } = classifyGeminiError(errMsg, errCode);

      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
          errorKind,
          retryable,
        });
      }
    }
  },

  "notifications/initialized": () => {}
};

// --- Main Loop (Robust JSON-RPC stream handling) ---

let buffer = "";

// Process one JSON-RPC line. Awaits its handler and catches internally so callers can
// dispatch lines CONCURRENTLY: replies correlate by id and Node serializes stdout writes,
// so parallel tool calls overlap without reordering or frame-interleaving hazard.
async function processLine(line) {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    return; // Ignore parse errors from noise
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
  // Dispatch concurrently - do NOT await each line - so parallel tool calls overlap.
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep partial line in buffer
    for (const line of lines) void processLine(line);
  });

  // Startup Check
  try {
    execFileSync(AGY_BIN, ["--help"], { stdio: "ignore" });
  } catch (e) {
    console.error("Antigravity CLI (agy) not found. Install from https://antigravity.google and run `agy` once to sign in.");
    process.exit(1);
  }
}

// Test-only exports
if (typeof module !== "undefined" && module.exports) {
  module.exports.classifyGeminiError = classifyGeminiError;
  module.exports.resolveConversationId = resolveConversationId;
  module.exports.goDuration = goDuration;
  module.exports.stdoutIsError = stdoutIsError;

  // Production exports (used by core adapters as well as tests)
  module.exports.runGemini = runGemini;
  module.exports.buildAgyArgs = buildAgyArgs;
}
