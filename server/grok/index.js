#!/usr/bin/env node

/**
 * Claude Delegator - Grok (xAI) MCP Bridge
 *
 * Zero-dependency MCP server speaking JSON-RPC 2.0 over stdio that calls the
 * xAI Responses API (POST /v1/responses). The Responses endpoint is required
 * to attach uploaded files. Multi-turn state is held in-memory; the bridge
 * resends the full `input` each turn rather than relying on previous_response_id.
 *
 * File access (v2):
 *   - files: [{ path | file_id | file_url | dir }]; paths and dirs resolve under
 *     roots: string[] (top-level), or [cwd] if roots is omitted.
 *   - dir entries are expanded by the bundled glob walker (./glob.js) with
 *     prune-before-descend, symlink-safe containment, and maxFiles/maxBytes caps.
 *   - Uploads are SHA-256 deduplicated via the local cache at
 *     ~/.claude/cache/claude-delegator/grok-files.json (./cache.js). Cache key
 *     scopes by content + API key + normalised apiBase + effective filename.
 *   - Cross-process cache safety via mkdir-based lock with token-specific
 *     owner markers and heartbeat (./lock.js).
 *   - 4xx mid-/v1/responses whose body names a known file_/file- id triggers
 *     evict + re-upload + retry once.
 *
 * Auth: XAI_API_KEY (env). Model: GROK_DEFAULT_MODEL (env) or grok-4.3.
 * Endpoint: XAI_API_BASE (env) or https://api.x.ai/v1.
 * File TTL: GROK_FILE_TTL_SECONDS (env) or 604800 (7 days).
 * Cache off switch: XAI_DISABLE_FILE_CACHE=1.
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

const cacheModule = require("./cache.js");
const DEFAULT_CACHE_FILE = cacheModule.CACHE_FILE;
const globMod = require("./glob.js");

const DEFAULT_INCLUDE = ["**/*"];
const DEFAULT_EXCLUDE = [
  // VCS (bare = any-depth via (?:^|/) anchor in glob.js compile())
  ".git",
  // JS / Node ecosystems
  "node_modules",
  "**/dist/**", "**/build/**", "**/out/**",
  "**/.next/**", "**/.svelte-kit/**", "**/.nuxt/**",
  "**/.turbo/**", "**/.cache/**", "**/.parcel-cache/**",
  "**/.pnpm-store/**",
  // Yarn Berry caches (can run into thousands of files)
  "**/.yarn/cache/**", "**/.yarn/unplugged/**", "**/.yarn/install-state.gz",
  // Lockfiles
  "**/*.lock",
  // Python
  "**/.venv/**", "**/venv/**",
  "**/__pycache__/**",
  "**/.tox/**", "**/.pytest_cache/**", "**/.mypy_cache/**", "**/.ruff_cache/**",
  "**/.ipynb_checkpoints/**",
  "**/.eggs/**", "**/htmlcov/**",
  // Coverage
  "**/coverage/**", "**/.nyc_output/**",
  // Rust / Java / Gradle
  "**/target/**", "**/.gradle/**",
  // Go / PHP
  "**/vendor/**",
  // Terraform
  "**/.terraform/**", "**/.terragrunt-cache/**",
  // Security: Terraform state holds plaintext credentials and resource ARNs
  "**/*.tfstate*", "**/.terraform.tfstate.lock.info",
  // Security: dotenv (granular - keeps .env.example/.env.sample/.env.template readable)
  "**/.env", "**/.env.local",
  "**/.env.development", "**/.env.development.local", "**/.env.dev", "**/.env.dev.local",
  "**/.env.production", "**/.env.production.local", "**/.env.prod", "**/.env.prod.local",
  "**/.env.test", "**/.env.test.local",
  "**/.env.staging", "**/.env.staging.local", "**/.env.stage", "**/.env.stage.local",
  // Security: SSH config + private keys
  "**/.ssh/**",
  "**/id_rsa", "**/id_rsa.pub", "**/id_ed25519", "**/id_ed25519.pub",
  "**/id_ecdsa", "**/id_ecdsa.pub", "**/id_dsa", "**/id_dsa.pub",
  "**/*.pem", "**/*.key",
];
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DIR_UPLOAD_CONCURRENCY = 4;

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
      if (ref.inline_text != null) {
        // Inline file content as input_text so Grok reads it fully line-by-line.
        // input_file references are treated as searchable attachments and may not
        // be fully expanded into the model's working context.
        const name = ref.inline_filename || "file";
        content.push({ type: "input_text", text: `=== ${name} ===\n${ref.inline_text}` });
      } else if (ref.file_id) content.push({ type: "input_file", file_id: ref.file_id });
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

// Inline vs upload heuristics. xAI's input_file references are treated as
// searchable attachments and may not be fully expanded into the model's working
// context; for source code review at line level, prefer input_text (inline).
const INLINE_MAX_BYTES_DEFAULT = 256 * 1024; // 256 KB
function resolveInlineMaxBytes() {
  const raw = Number(process.env.GROK_INLINE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : INLINE_MAX_BYTES_DEFAULT;
}

// Cheap text vs binary sniff. Checks the first 4 KB: any NUL byte → binary;
// >5% non-printable (outside tab/LF/CR/printable ASCII/UTF-8 continuations) → binary.
function isProbablyText(buf) {
  if (!buf || buf.length === 0) return true;
  const slice = buf.subarray(0, Math.min(buf.length, 4096));
  if (slice.includes(0)) return false;
  let np = 0;
  for (const b of slice) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b >= 0x20 && b <= 0x7e) continue;
    if (b >= 0x80) continue;
    np++;
  }
  return np / slice.length < 0.05;
}

// Decide whether a (already-read) file buffer should be inlined as input_text
// rather than uploaded via the Files API. `mode` is one of:
//   "upload" - never inline (default; preserves legacy behavior)
//   "inline" - always inline (caller asserts the content is fit for input_text)
//   "auto"   - inline when buffer is probably text AND size <= INLINE_MAX_BYTES
function shouldInline(buf, mode) {
  if (mode === "inline") return true;
  if (mode === "auto") {
    return buf.length <= resolveInlineMaxBytes() && isProbablyText(buf);
  }
  return false;
}

// Upload one local file and return its file object. Errors carry `.code`
// (file-too-large/file-read/file-upload/missing-auth) and/or `.status`.
// `fetchImpl` is injectable for tests.
// Accepts `roots: string[]` for multi-root containment; falls back to
// `[realpathSync(cwd ?? process.cwd())]` so old single-cwd callers still work.
// Cache integration: checks cache.js before uploading; on miss wraps upload in
// withInflight for concurrent dedup and writes the result to the cache.
// Set XAI_DISABLE_FILE_CACHE=1 to bypass the cache layer entirely.
// `mode` controls inline-vs-upload (see shouldInline). Inline refs skip the
// Files API entirely and are emitted as input_text by turnsToInput.
async function uploadFile({ filePath, filename, apiKey, apiBase, ttl, roots, cwd, fetchImpl, cacheFile, mode }) {
  if (!isNonEmptyString(apiKey)) {
    const e = new Error("XAI_API_KEY is not set; cannot upload files.");
    e.code = "missing-auth";
    throw e;
  }
  const f = fetchImpl || globalThis.fetch;
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");

  const rootList = (Array.isArray(roots) && roots.length)
    ? roots
    : [require("node:fs").realpathSync(cwd || process.cwd())];

  let resolved;
  try {
    resolved = resolvePathUnderRoots(filePath.replace(/\\/g, "/"), rootList, "file");
  } catch (err) {
    const e = new Error(`Cannot read file "${filePath}": ${(err && err.message) || err}`);
    e.code = "file-read";
    throw e;
  }

  if (resolved.size > MAX_FILE_BYTES) {
    const e = new Error(`File "${filePath}" is ${resolved.size} bytes; exceeds the ${MAX_FILE_BYTES}-byte cap.`);
    e.code = "file-too-large";
    throw e;
  }

  let buf;
  try { buf = await require("node:fs/promises").readFile(resolved.abs); }
  catch (err) {
    const e = new Error(`Cannot read file "${filePath}": ${(err && err.message) || err}`);
    e.code = "file-read";
    throw e;
  }

  const cacheMod = require("./cache.js");
  const baseName = require("node:path").basename(filename || resolved.abs);
  const effectiveFilename = baseName;

  // Inline branch: render the file as input_text instead of uploading. No xAI
  // network call, no cache row (sha256 dedup is meaningless without a fileId).
  // Returned shape is { _inline: true, inline_text, inline_filename, ... } — the
  // caller routes this into refs and turnsToInput emits an input_text part.
  if (shouldInline(buf, mode)) {
    return {
      _inline: true,
      inline_text: buf.toString("utf8"),
      inline_filename: effectiveFilename,
      _sourcePath: resolved.abs,
      _sourceRoot: resolved.root,
      _bytes: buf.length,
    };
  }

  const apiBaseNorm = cacheMod.normalize(base);
  const cacheKey = cacheMod.buildCacheKey({ bytes: buf, apiKey, apiBase: base, filename: effectiveFilename });
  const keyFp = require("node:crypto").createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  const useCache = !process.env.XAI_DISABLE_FILE_CACHE && cacheFile;

  if (useCache) {
    const hit = cacheMod.lookup(cacheFile, cacheKey, { apiBase: apiBaseNorm, keyFp });
    if (hit) return { id: hit.fileId, _fromCache: true, _cacheKey: cacheKey, _sourcePath: resolved.abs, _sourceRoot: resolved.root };
  }

  const work = async () => {
    const contentHash = require("node:crypto").createHash("sha256").update(buf).digest("hex");
    const storedName = `${FILE_PREFIX}${contentHash.slice(0, 16)}-${baseName}`;
    const form = new FormData();
    form.append("expires_after", String(ttl != null ? ttl : FILE_TTL_SECONDS));
    form.append("purpose", UPLOAD_PURPOSE);
    form.append("file", new Blob([buf]), storedName);

    let res;
    try {
      res = await f(`${base}/files`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
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
    let uploaded;
    try { uploaded = JSON.parse(bodyText); }
    catch (e2) { const e = new Error(`File upload parse error: ${e2.message}`); e.code = "parse"; throw e; }
    if (!isNonEmptyString(uploaded && uploaded.id)) {
      const e = new Error("File upload returned no file id");
      e.code = "parse";
      throw e;
    }

    if (useCache) {
      const entry = {
        fileId: uploaded.id,
        size: buf.length,
        filename: effectiveFilename,
        uploadedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + (ttl != null ? ttl : FILE_TTL_SECONDS),
        apiBase: apiBaseNorm,
        keyFp,
      };
      await cacheMod.store(cacheFile, cacheKey, entry);
    }
    return uploaded;
  };

  const uploaded = useCache
    ? await cacheMod.withInflight(cacheKey, work)
    : await work();
  return { ...uploaded, _cacheKey: cacheKey, _sourcePath: resolved.abs, _sourceRoot: resolved.root };
}

// Resolve a `files` param into { refs, ownedIds }. `path` entries are uploaded
// (bridge-owned); `file_id`/`file_url` pass through untouched; `dir` entries
// are expanded via the glob walker and uploaded with cache-aware dedup.
async function resolveFiles(files, opts) {
  const refs = [];
  const ownedIds = [];
  // Dedup keyed by cacheKey for uploaded files, or absolute sourcePath for
  // inline files (which have no cacheKey). Same file appearing in both an
  // explicit {path} and a {dir} expansion is only attached once.
  const seen = new Set();
  const dedupKey = (single) => single._cacheKey || `inline:${single._sourcePath}`;

  async function handlePath(entry) {
    const uploaded = await uploadFile({
      filePath: entry.path,
      filename: entry.filename,
      mode: entry.mode,
      ...opts,
    });
    if (uploaded && uploaded._inline) {
      const k = dedupKey(uploaded);
      // Order-independent dedup: if this content was already attached by a
      // prior {dir} expansion (or another {path}), skip the duplicate push.
      if (seen.has(k)) return;
      seen.add(k);
      refs.push({
        inline_text: uploaded.inline_text,
        inline_filename: uploaded.inline_filename,
        sourcePath: uploaded._sourcePath,
        sourceRoot: uploaded._sourceRoot,
      });
      return;
    }
    if (!isNonEmptyString(uploaded && uploaded.id)) {
      const e = new Error("File upload returned no file id");
      e.code = "parse";
      throw e;
    }
    if (uploaded._cacheKey) {
      if (seen.has(uploaded._cacheKey)) return;
      seen.add(uploaded._cacheKey);
    }
    refs.push({
      file_id: uploaded.id,
      sourcePath: uploaded._sourcePath,
      sourceRoot: uploaded._sourceRoot,
      sourceCacheKey: uploaded._cacheKey,
    });
    if (!uploaded._fromCache) ownedIds.push(uploaded.id);
  }

  async function handleDir(entry) {
    const rootList = (Array.isArray(opts.roots) && opts.roots.length)
      ? opts.roots
      : [require("node:fs").realpathSync(opts.cwd || process.cwd())];
    const resolved = resolvePathUnderRoots(entry.dir.replace(/\\/g, "/"), rootList, "dir");
    const include = entry.include || DEFAULT_INCLUDE;
    // Caller exclude is APPENDED to bridge defaults. Pass excludeReset: true to
    // replace defaults entirely (e.g., security review of tfstate / private keys).
    const exclude = entry.excludeReset === true
      ? (entry.exclude || [])
      : [...DEFAULT_EXCLUDE, ...(entry.exclude || [])];
    const maxFiles = entry.maxFiles || DEFAULT_MAX_FILES;
    const maxBytes = entry.maxBytes || DEFAULT_MAX_BYTES;

    const { files: walked } = globMod.walk(resolved.abs, { include, exclude, maxFiles, maxBytes });

    let cached = 0, uploaded = 0, skipped = 0;
    const queue = [...walked];
    let inlined = 0;
    async function worker() {
      while (queue.length) {
        const f = queue.shift();
        const single = await uploadFile({
          filePath: f.abs,
          apiKey: opts.apiKey,
          apiBase: opts.apiBase,
          ttl: opts.ttl,
          roots: [resolved.root],
          fetchImpl: opts.fetchImpl,
          cacheFile: opts.cacheFile,
          mode: entry.mode,
        });
        if (single && single._inline) {
          const k = dedupKey(single);
          if (seen.has(k)) { skipped += 1; continue; }
          seen.add(k);
          inlined += 1;
          refs.push({
            inline_text: single.inline_text,
            inline_filename: single.inline_filename,
            sourcePath: single._sourcePath,
            sourceRoot: single._sourceRoot,
          });
          continue;
        }
        if (!isNonEmptyString(single && single.id)) continue;
        if (seen.has(single._cacheKey)) { skipped += 1; continue; }
        seen.add(single._cacheKey);
        if (single._fromCache) cached += 1;
        else { uploaded += 1; ownedIds.push(single.id); }
        refs.push({
          file_id: single.id,
          sourcePath: single._sourcePath,
          sourceRoot: single._sourceRoot,
          sourceCacheKey: single._cacheKey,
        });
      }
    }
    const N = Math.max(1, Math.min(DIR_UPLOAD_CONCURRENCY, walked.length));
    await Promise.all(Array.from({ length: N }, () => worker()));

    process.stderr.write(`[grok] ${opts.cid || "-"} expanded dir=${entry.dir} count=${walked.length} cached=${cached} uploaded=${uploaded} inlined=${inlined} skipped=${skipped}\n`);
  }

  for (const entry of files || []) {
    if (entry.file_id) refs.push({ file_id: entry.file_id, sourcePath: null, sourceRoot: null });
    else if (entry.file_url) refs.push({ file_url: entry.file_url, sourcePath: null, sourceRoot: null });
    else if (entry.path) await handlePath(entry);
    else if (entry.dir) await handleDir(entry);
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

// --- Stale-File Recovery ---

// Non-/g regex for boolean "does the message mention any file_id?" check.
// Using a /g flag here would mutate lastIndex across .test() calls.
const STALE_FILE_ID_TEST = /file[-_][A-Za-z0-9_-]+/;
const STALE_FILE_ID_EXTRACT = /file[-_][A-Za-z0-9_-]+/g;

function isStaleFileError(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  if (!STALE_FILE_ID_TEST.test(msg)) return false;
  if (err.status && err.status >= 400 && err.status < 500) return true;
  return /invalid|not found|missing|expired/i.test(msg);
}

// runWithFiles supports BOTH a fresh `grok` call (no priorTurns) and a
// `grok-reply` continuation (priorTurns provided). The new user turn is
// appended to priorTurns so accumulated conversation context is preserved on
// the actual /v1/responses payload.
async function runWithFiles(args) {
  const { refs, ownedIds } = await resolveFiles(args.files, args);

  const developerInstructions = args["developer-instructions"];
  const prompt = args.prompt;
  const priorTurns = args.priorTurns || null;

  function buildTurns(currentRefs) {
    if (priorTurns) {
      return [...priorTurns, { role: "user", text: prompt, fileRefs: currentRefs }];
    }
    return buildInitialTurns(developerInstructions, prompt, currentRefs);
  }

  async function attempt(currentTurns) {
    return runGrok({
      turns: currentTurns,
      apiKey: args.apiKey,
      apiBase: args.apiBase,
      fetchImpl: args.fetchImpl,
      timeoutMs: args.timeout,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
    });
  }

  try {
    const out = await attempt(buildTurns(refs));
    return { text: out.text, output: out.output, refs, ownedIds };
  } catch (e) {
    if (!isStaleFileError(e)) throw e;
    const matches = (e.message || "").match(STALE_FILE_ID_EXTRACT) || [];
    const matchingRefs = refs.filter((r) => r.sourcePath && matches.includes(r.file_id));
    if (matchingRefs.length === 0) throw e;

    const cacheMod = require("./cache.js");
    if (args.cacheFile) {
      for (const r of matchingRefs) {
        await cacheMod.evict(args.cacheFile, r.file_id);
      }
    }

    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      if (!matchingRefs.includes(r)) continue;
      const reuploaded = await uploadFile({
        filePath: r.sourcePath,
        apiKey: args.apiKey,
        apiBase: args.apiBase,
        ttl: args.ttl || FILE_TTL_SECONDS,
        roots: [r.sourceRoot],
        cacheFile: args.cacheFile,
        fetchImpl: args.fetchImpl,
      });
      refs[i] = {
        ...r,
        file_id: reuploaded.id,
        sourceCacheKey: reuploaded._cacheKey,
      };
      // Track the fresh xAI file_id so uploadedFileIds in the MCP response
      // reflects what this session actually uploaded after stale-id recovery.
      if (!reuploaded._fromCache) ownedIds.push(reuploaded.id);
    }

    const out = await attempt(buildTurns(refs));
    return { text: out.text, output: out.output, refs, ownedIds };
  }
}

// --- Multi-Root Path Resolution ---

function validateRoots(roots) {
  const fsx = require("node:fs");
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error("'roots' must be a non-empty array of absolute directory paths");
  }
  for (const r of roots) {
    if (typeof r !== "string" || r.length === 0) {
      throw new Error("'roots' entries must be non-empty strings");
    }
    if (!path.isAbsolute(r)) {
      throw new Error(`'roots' entry "${r}" must be an absolute path`);
    }
    let st;
    try { st = fsx.statSync(r); }
    catch (e) { throw new Error(`'roots' entry "${r}" does not exist: ${e.message}`); }
    if (!st.isDirectory()) {
      throw new Error(`'roots' entry "${r}" is not a directory`);
    }
  }
}

function resolvePathUnderRoots(p, roots, type) {
  const fsx = require("node:fs");
  const isAbs = path.isAbsolute(p);
  for (const root of roots) {
    const abs = isAbs ? p : path.join(root, p);
    let realRoot, realAbs;
    try { realRoot = fsx.realpathSync(root); } catch (_) { continue; }
    try { realAbs = fsx.realpathSync(abs); } catch (_) { continue; }
    const rel = path.relative(realRoot, realAbs);
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) continue;
    let st;
    try { st = fsx.statSync(realAbs); } catch (_) { continue; }
    if (type === "file") {
      if (!st.isFile()) continue;
      return { root: realRoot, abs: realAbs, size: st.size };
    }
    if (type === "dir") {
      // Multi-root fallback: continue scanning even if this root has a non-dir
      // at that path. Only throw the "wrong type" error if NO root contains a
      // directory there.
      if (!st.isDirectory()) continue;
      return { root: realRoot, abs: realAbs, size: 0 };
    }
  }
  if (isAbs) {
    throw new Error(`"${p}" is outside all declared roots: ${roots.join(", ")}`);
  }
  throw new Error(`"${p}" not found in any root: ${roots.join(", ")}`);
}

// --- Request Handlers ---

const FILES_SCHEMA = {
  type: "array",
  description: "Optional files to attach. Each item has EXACTLY ONE of: path (local file; delivery controlled by mode = upload | inline | auto), file_id (an already-uploaded xAI file id), file_url (a public URL), or dir (recursive directory expansion; delivery controlled by mode). Optional filename overrides the stored upload name (applies only to path entries delivered via upload).",
  items: {
    type: "object",
    properties: {
      path: { type: "string", description: "Local file path; bridge attaches it (resolved against roots[] or cwd). Delivery is controlled by mode: uploaded via the xAI Files API (default) or inlined as input_text." },
      file_id: { type: "string", description: "Existing xAI file id" },
      file_url: { type: "string", description: "Public URL to a file" },
      dir: { type: "string", description: "Local directory to expand recursively (resolved against roots[] or cwd)" },
      include: { type: "array", items: { type: "string" }, description: "POSIX glob patterns to include during dir expansion. Defaults to ['**/*']." },
      exclude: { type: "array", items: { type: "string" }, description: "Additional POSIX glob patterns APPENDED to the bridge's safe defaults (.git, node_modules, .terraform, target, vendor, __pycache__, .yarn caches, *.tfstate, .env*, SSH keys, *.pem, *.key, framework build/cache dirs). To replace defaults entirely instead of appending, set excludeReset: true on the same dir entry." },
      excludeReset: { type: "boolean", description: "If true, caller's exclude REPLACES bridge defaults. If omitted or false (default), caller's exclude is APPENDED to defaults. Use only when reviewing files defaults would block (e.g., Terraform state in a security audit, or *.pem certificates)." },
      maxFiles: { type: "number", description: "Hard cap on files per dir expansion. Default 50." },
      maxBytes: { type: "number", description: "Hard cap on bytes per dir expansion. Default 134217728 (128 MB)." },
      filename: { type: "string", description: "Override stored filename for a path upload" },
      mode: { type: "string", enum: ["auto", "inline", "upload"], default: "upload", description: "How to deliver this file to Grok. 'upload' (default) uses the xAI Files API (input_file); 'inline' embeds the file content directly as input_text (best for source code so Grok reads line-by-line); 'auto' inlines when the file is probably text and <= GROK_INLINE_MAX_BYTES (default 256 KB), otherwise uploads. For {dir} entries the mode is inherited by every walked file. Must NOT be set on file_id/file_url entries (those bypass the upload path; setting mode there returns -32602)." },
    },
  },
};

const GROK_PROPERTIES = {
  prompt: { type: "string", description: "The delegation prompt" },
  "developer-instructions": { type: "string", description: "Expert system instructions (sent as a system message)" },
  model: { type: "string", description: "xAI model id. Defaults to GROK_DEFAULT_MODEL or grok-4.3.", default: DEFAULT_MODEL },
  reasoning_effort: { type: "string", description: "Reasoning effort (low, medium, high). 'none' omits the field.", default: DEFAULT_REASONING_EFFORT },
  timeout: { type: "number", description: "Soft timeout in ms. 1..600000. Default 180000.", default: DEFAULT_TIMEOUT_MS },
  files: FILES_SCHEMA,
  roots: { type: "array", items: { type: "string" }, description: "Optional absolute directory roots for resolving files[].path and files[].dir. Defaults to [cwd]." },
  sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only", description: "Accepted for call-shape parity; ignored." },
  cwd: { type: "string", description: "Base dir for resolving relative paths. Defaults to server cwd." },
};

// Validate a `files` param. Returns an error string, or null when valid/absent.
function validateFiles(files) {
  if (files === undefined) return null;
  if (!Array.isArray(files)) return "'files' must be an array when provided";
  for (const entry of files) {
    if (!isObject(entry)) return "each 'files' entry must be an object";
    const keys = ["path", "file_id", "file_url", "dir"].filter((k) => entry[k] !== undefined);
    if (keys.length !== 1) return "each 'files' entry needs exactly one of path, file_id, file_url, or dir";
    if (!isNonEmptyString(entry[keys[0]])) return `'files' entry ${keys[0]} must be a non-empty string`;
    if (entry.filename !== undefined && !isNonEmptyString(entry.filename)) return "'files' entry filename must be a non-empty string when provided";
    if (entry.mode !== undefined) {
      if (typeof entry.mode !== "string") return "'files' entry mode must be a string when provided";
      if (!["auto", "inline", "upload"].includes(entry.mode)) return `'files' entry mode "${entry.mode}" must be one of: auto, inline, upload`;
      if (entry.file_id !== undefined || entry.file_url !== undefined) return "'files' entry mode applies only to path/dir entries (not file_id/file_url)";
    }
    if (entry.excludeReset !== undefined && typeof entry.excludeReset !== "boolean") {
      return "'excludeReset' must be a boolean";
    }
    if (entry.dir !== undefined) {
      for (const list of [entry.include, entry.exclude]) {
        if (list === undefined) continue;
        if (!Array.isArray(list)) return "'files' entry include/exclude must be arrays";
        for (const p of list) {
          if (typeof p !== "string" || p.length === 0) return "include/exclude patterns must be non-empty strings";
          if (p.includes("\\")) return `glob pattern "${p}" contains backslashes; v1 patterns are POSIX-only (use /)`;
        }
      }
      if (entry.maxFiles !== undefined && (typeof entry.maxFiles !== "number" || entry.maxFiles <= 0)) return "'maxFiles' must be a positive number";
      if (entry.maxBytes !== undefined && (typeof entry.maxBytes !== "number" || entry.maxBytes <= 0)) return "'maxBytes' must be a positive number";
    }
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
              roots: { type: "array", items: { type: "string" }, description: "Optional absolute directory roots for resolving files[].path and files[].dir." },
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
      let rootList;
      if (Array.isArray(args.roots) && args.roots.length) {
        try { validateRoots(args.roots); }
        catch (e) {
          if (shouldRespond) sendError(id, -32602, `Invalid params: ${e.message}`);
          return;
        }
        rootList = args.roots;
      } else {
        rootList = [require("node:fs").realpathSync(args.cwd || process.cwd())];
      }

      const out = await runWithFiles({
        prompt: args.prompt,
        "developer-instructions": args["developer-instructions"],
        files: args.files,
        priorTurns: priorTurns || null,
        apiKey: process.env.XAI_API_KEY,
        apiBase: DEFAULT_API_BASE,
        ttl: FILE_TTL_SECONDS,
        roots: rootList,
        cwd: args.cwd,
        cacheFile: process.env.XAI_DISABLE_FILE_CACHE ? null : DEFAULT_CACHE_FILE,
        model: args.model,
        reasoningEffort: resolveReasoningEffort(args.reasoning_effort),
        timeout: args.timeout,
        cid: id,
      });

      // Persist turn history symmetrically with how runWithFiles built them.
      const turnsForPersist = priorTurns
        ? [...priorTurns, { role: "user", text: args.prompt, fileRefs: out.refs }]
        : buildInitialTurns(args["developer-instructions"], args.prompt, out.refs);
      sessions.set(threadId, [...turnsForPersist, { role: "assistant", text: out.text, items: out.output || undefined }]);

      if (shouldRespond) {
        const result = { content: [{ type: "text", text: out.text }], threadId };
        if (out.ownedIds.length) result.uploadedFileIds = out.ownedIds;
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
  module.exports.runWithFiles = runWithFiles;
  module.exports.uploadFile = uploadFile;
  module.exports.resolveFiles = resolveFiles;
  module.exports.validateFiles = validateFiles;
  module.exports.FILE_PREFIX = FILE_PREFIX;
  module.exports.FILE_TTL_SECONDS = FILE_TTL_SECONDS;
}

// Production exports (used by later tasks as well as tests)
module.exports.validateRoots = validateRoots;
module.exports.resolvePathUnderRoots = resolvePathUnderRoots;
