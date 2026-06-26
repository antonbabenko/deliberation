#!/usr/bin/env node
"use strict";
/** Minimal stdio JSON-RPC MCP server over deliberation-core. Zero deps. */
/** @typedef {import("../../core/types.js").Provider} Provider */
/** @typedef {import("../../core/types.js").DelegationRequest} DelegationRequest */

const { makeRegistry, pinAlias } = require("../../core/registry.js");
const { askAll, askOne, consensus, runToConvergence } = require("../../core/orchestrate.js");
const { orientationFilesFor } = require("../../core/orientation.js");
const { PROMPTS } = require("../../core/prompts/index.js");
const analyzeCore = require("../../core/analyze.js");

// MCP tool annotations. readOnlyHint reflects each tool's PRIMARY CONTRACT, not
// whether some opt-in mode can ever write: ask-all/consensus stay read-only (their
// job is advisory) even though they persist a session record when the opt-in
// sessions.persist is ON (default OFF, disclosed in each description) - a strict
// "can ever write" rule would also have to flag ask-one and every expert tool
// (identical opt-in debug telemetry). openWorldHint:true marks tools that reach
// external LLM providers (network, cost, rate limits). destructiveHint:false is
// explicit on all four: it documents additive-only intent and avoids any
// client/Glama misinterpretation (annotations postdate this server's 2024-11-05
// protocol, so no single default is authoritative).
const LOCAL_RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };  // local read-only: panel, analyze, session-get
const EXT_RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };     // advisory + external LLMs: ask-*, experts, ask-one, ask-all, consensus
const LOCAL_RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }; // local additive write: session-annotate
const EXT_RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };    // writes state + calls providers: consensus-step, session-revisit
/** @type {Record<string, string>} */
const ASK_PROVIDER = { "ask-gpt": "codex", "ask-gemini": "gemini", "ask-grok": "grok", "ask-openrouter": "openrouter" };
/** Per-provider auth note for the ask-* tool descriptions. @type {Record<string, string>} */
const ASK_AUTH = { codex: "via the Codex CLI", gemini: "via the Gemini CLI", grok: "needs XAI_API_KEY", openrouter: "needs the OpenRouter API key env" };
const EXPERTS = ["architect", "plan-reviewer", "scope-analyst", "code-reviewer", "security-analyst", "researcher", "debugger"];
/** Appended to every expert tool description: external dispatch + return shape (keeps EXPERT_DESCRIPTIONS focused on purpose/usage). */
const EXPERT_SUFFIX = " Fans out to the configured provider panel with this persona (advisory; each provider needs its key/CLI, rate limits apply) and returns a text-wrapped JSON envelope { results[] }.";

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

/**
 * Shared schema-property descriptions, kept consistent across every tool's input
 * schema. They state role / valid values only - never promising validation the
 * handler does not perform.
 */
const PROP_DESC = {
  prompt: "The question or task for the provider(s)/expert.",
  expert: "Optional persona: architect, plan-reviewer, scope-analyst, code-reviewer, security-analyst, researcher, or debugger. On a named expert tool the tool's own persona wins and this is ignored.",
  developerInstructions: "Optional system/developer instructions injected verbatim; overrides the built-in persona for `expert`.",
  cwd: "Working directory the provider runs in (used to resolve relative file refs). Defaults to the server process directory.",
  reasoningEffort: "Reasoning depth where the provider supports it (Grok, OpenRouter): low, medium, high, or none. CLI providers (Codex, Gemini) ignore it.",
};

/** The shared `files[]` array schema (identical across ask-*, ask-one, consensus). */
function fileItems() {
  return {
    type: "array",
    description: "Optional attachments for providers that read files (Grok/OpenRouter; inlined as context for Codex/Gemini). Each item is EXACTLY ONE of path/dir/file_id/file_url.",
    items: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to a single file to attach (resolved against cwd)." },
        dir: { type: "string", description: "Directory to attach; expanded recursively by providers that support it." },
        file_id: { type: "string", description: "Id of a file already uploaded to the provider (e.g. Grok Files API)." },
        file_url: { type: "string", description: "Public URL for the provider to fetch." },
        mode: { type: "string", enum: ["auto", "inline", "upload"], description: "Delivery: auto (size-based), inline (embed as text), or upload (provider Files API)." },
      },
    },
  };
}

/** Schema for `panel` (discover the active provider set without dispatching). */
function panelInputSchema() {
  return {
    type: "object",
    properties: {
      expert: { type: "string", description: "Optional persona to preview the panel for; affects which providers/aliases are eligible." },
      cwd: { type: "string", description: PROP_DESC.cwd },
    },
  };
}

/** Schema for `analyze` (read-only run analytics over the debug log + sessions). */
function analyzeInputSchema() {
  return {
    type: "object",
    properties: {
      sessions: { type: "integer", description: "How many recent session records to read for the agreement lens (default 50)." },
      limitBytes: { type: "integer", description: "Tail size of the debug log to read, in bytes (default 1048576)." },
    },
  };
}

/** Schema for `ask-one` (single named provider from the active panel). */
function askOneInputSchema() {
  return {
    type: "object",
    required: ["provider", "prompt"],
    properties: {
      provider: { type: "string", description: 'A name from `panel` (e.g. "codex", "gemini", "grok", "openrouter:<alias>").' },
      prompt: { type: "string", description: PROP_DESC.prompt },
      expert: { type: "string", description: PROP_DESC.expert },
      developerInstructions: { type: "string", description: PROP_DESC.developerInstructions },
      cwd: { type: "string", description: PROP_DESC.cwd },
      reasoningEffort: { type: "string", enum: ["low", "medium", "high", "none"], description: PROP_DESC.reasoningEffort },
      files: fileItems(),
    },
  };
}

function inputSchema() {
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: PROP_DESC.prompt },
      expert: { type: "string", description: PROP_DESC.expert },
      developerInstructions: { type: "string", description: PROP_DESC.developerInstructions },
      cwd: { type: "string", description: PROP_DESC.cwd },
      reasoningEffort: { type: "string", enum: ["low", "medium", "high", "none"], description: PROP_DESC.reasoningEffort },
      files: fileItems(),
    },
  };
}

// The unified consensus tool: the fan-out fields plus the loop knobs. maxRounds
// overrides the config default; synthesizeAlways switches to a single synthesis pass.
function consensusInputSchema() {
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: PROP_DESC.prompt },
      expert: { type: "string", description: PROP_DESC.expert },
      developerInstructions: { type: "string", description: PROP_DESC.developerInstructions },
      reasoningEffort: { type: "string", enum: ["low", "medium", "high", "none"], description: PROP_DESC.reasoningEffort },
      maxRounds: { type: "integer", minimum: 1, maximum: 50, description: "Override consensus.maxRounds for this call (loop mode only; ignored when synthesizeAlways is true). Clamped to 50." },
      synthesizeAlways: { type: "boolean", description: "Run ONE arbiter synthesis pass instead of the convergence loop. Returns a free-text `synthesis` (verdict/converged/confidence are null, rounds is 1). Best for open questions." },
      cwd: { type: "string", description: PROP_DESC.cwd },
      files: fileItems(),
    },
  };
}

// Session tools take a sessionId (+ note for annotate), NOT a prompt - so they
// need their OWN input schemas rather than the prompt-required inputSchema().
function sessionGetInputSchema() {
  // `cwd` is advertised (optional) so session-revisit can resolve the original
  // file refs against the caller's workspace, not the server process dir. It
  // flows through req.cwd -> childReq.cwd. session-get ignores it harmlessly.
  return { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string", description: "Id of a persisted session record." }, cwd: { type: "string", description: "session-revisit only: working directory for resolving the original file refs on the re-run; session-get ignores it." } } };
}
function sessionAnnotateInputSchema() {
  return { type: "object", required: ["sessionId", "note"], properties: { sessionId: { type: "string", description: "Id of the persisted session record to annotate." }, note: { type: "string", description: "Freeform text appended to the record's audit trail." } } };
}
// consensus-step is a stateful, client-driven loop tool: one action per call,
// state carried in the loop store by sessionId. Most fields are action-specific.
function consensusStepInputSchema() {
  return {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["init", "record_blind", "dispatch_peers", "submit_adjudication", "submit_revision"], description: "Which loop step to run this call, in order: init -> record_blind -> dispatch_peers -> submit_adjudication -> submit_revision." },
      sessionId: { type: "string", description: "Loop id returned by init; required on every action except init." },
      prompt: { type: "string", description: "init only: the plan/proposal under review." },
      expert: { type: "string", description: "init only: optional persona for the peer panel (see the expert tools)." },
      blindVerdict: { type: "string", description: "record_blind only: your pre-commit verdict text, written before the panel is revealed." },
      verdict: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "REJECT"], description: "submit_adjudication only: your adjudicated verdict after weighing the panel." },
      decisions: { type: "array", description: "submit_adjudication only: per-issue rulings, each { source, category, description, action: accept|dismiss|defer, reason }; dismiss/defer require a reason." },
      revisedPlan: { type: "string", description: "submit_revision only: the full revised plan addressing accepted issues." },
      diffSummary: { type: "string", description: "submit_revision only: one line summarizing what changed." },
      cwd: { type: "string", description: "dispatch_peers only: working directory the peer providers run in." },
    },
  };
}

function toolList() {
  /** @type {any[]} */
  const tools = [
    { name: "ask-all", description: "Fan out one question to GPT, Gemini, Grok, and any configured OpenRouter models in parallel for independent second opinions, then return all results (advisory, no cross-contamination). Pass `expert` to apply a persona to every delegate. Calls external LLM providers (each needs its key/CLI; provider rate limits apply); returns a text-wrapped JSON envelope { results[], omitted[] } and persists a session record only when sessions.persist is enabled (default off).", inputSchema: inputSchema(), annotations: EXT_RO },
    { name: "consensus", description: "Run the FULL multi-round consensus convergence loop server-side with a provider arbiter (blind pass + peer fan-out -> adjudicate -> revise) and return the converged verdict. Default depth is `consensus.maxRounds` (config, default 5); pass `maxRounds` to override. Pass `synthesizeAlways:true` for a SINGLE arbiter synthesis pass instead of the loop (best for open questions, not plan convergence): it returns a free-text `synthesis` and `maxRounds` is ignored. Configure the arbiter via `consensus.arbiter` - a concrete provider/openrouter alias runs server-side; `host` mode returns the opinions for YOU to synthesize. Advisory; pass `expert` to apply a persona. Calls external providers (keys/CLI; rate limits apply); returns a text-wrapped JSON envelope (split verdict/synthesis, loop fields nullable) and persists a session record only when sessions.persist is enabled (default off). NOTE (Claude Code): use the `/consensus` slash command for the transcript-visible host-arbiter loop (it drives `consensus-step`); this tool is the provider-arbiter path for any host.", inputSchema: consensusInputSchema(), annotations: EXT_RO },
    { name: "consensus-step", description: "Client-driven consensus loop where YOU (the host model) are the arbiter, one action per call: init (returns sessionId + blind prompt) -> record_blind (your pre-commit verdict) -> dispatch_peers (server fans out to the providers) -> submit_adjudication (your verdict + per-issue accept/dismiss/defer) -> submit_revision (your revised plan), looping until converged or consensus.maxRounds rounds (default 5). Only the dispatch_peers action calls external providers; the others are local transitions on the ephemeral per-session loop store (keyed by sessionId, lost on server restart). Each call returns a text-wrapped JSON envelope with the next status/round (plus blindPrompt, opinions[], or finalReport by action). Advisory to the outside world, but mutates server loop state on every call.", inputSchema: consensusStepInputSchema(), annotations: EXT_RW },
    { name: "panel", description: "Return the names of the providers `ask-all` WOULD dispatch for the current config + expert (enabled built-ins + eligible OpenRouter aliases, fanout cap applied), WITHOUT calling them. Use this to discover the panel, then issue one `ask-one` call per provider in parallel for visible per-provider progress. Local and read-only (no provider calls); returns a text-wrapped JSON envelope { providers[], omitted[] }.", inputSchema: panelInputSchema(), annotations: LOCAL_RO },
    { name: "ask-one", description: "Second opinion from ONE named provider in the active panel (e.g. `codex`, `gemini`, `grok`, `openrouter:<alias>` - get the names from `panel`). Issue N in parallel (one per panel name) so each renders independently as it lands. Calls one external LLM provider (needs its key/CLI; rate limits apply); returns a text-wrapped JSON envelope { result }, or { error, panel } when the name is not in the panel. Advisory, single-shot.", inputSchema: askOneInputSchema(), annotations: EXT_RO },
    { name: "analyze", description: "Analyze recent runs from the opt-in debug log (latency/tokens/reasoning-effort per model) plus the session store (verdict agreement rate), and return advisory tuning suggestions (disable a slow/redundant model in ask-all, lower an OpenRouter model's reasoning, adjust maxFanout). Two lenses reported side by side - timing and agreement are NOT joined (no shared run id). Requires `debug.enabled` for the timing lens. Local and read-only (no provider calls, writes nothing); returns a text-wrapped JSON envelope with the two lenses + suggestions. The `/deliberation:analyze` slash command renders this for humans.", inputSchema: analyzeInputSchema(), annotations: LOCAL_RO },
  ];
  for (const t of Object.keys(ASK_PROVIDER)) {
    const prov = ASK_PROVIDER[t];
    tools.push({ name: t, description: `Single-provider second opinion via ${prov} (advisory, single-shot). Pass \`expert\` to apply one of the expert personas. Calls the external ${prov} provider (${ASK_AUTH[prov]}; rate limits apply) and returns a text-wrapped JSON envelope { result }.`, inputSchema: inputSchema(), annotations: EXT_RO });
  }
  for (const e of EXPERTS) {
    tools.push({ name: e, description: EXPERT_DESCRIPTIONS[e] + EXPERT_SUFFIX, inputSchema: inputSchema(), annotations: EXT_RO });
  }
  // Session store tools (opt-in; report "disabled" when sessions.persist is off).
  tools.push({ name: "session-get", description: "Fetch a persisted consensus/ask-all session record by id (opinions, verdict, arbiter, annotations). Requires sessions.persist; local and read-only (no provider calls). Returns a text-wrapped JSON envelope { session }, or { error } when persistence is off or the id is unknown.", inputSchema: sessionGetInputSchema(), annotations: LOCAL_RO });
  tools.push({ name: "session-revisit", description: "Re-run a persisted session's ORIGINAL question with the CURRENT providers/config, linking the new run to its source by parentId. Requires sessions.persist; re-runs through the original tool path (which dispatches external providers) and persists a linked child record on success. Returns a text-wrapped JSON envelope (the re-run payload + parentId), or { error } when persistence is off or the id is unknown.", inputSchema: sessionGetInputSchema(), annotations: EXT_RW });
  tools.push({ name: "session-annotate", description: "Append a freeform note to a persisted session's audit trail - an additive local write, no provider calls. Requires sessions.persist. Returns a text-wrapped JSON envelope { session } (the updated record), or { error } when persistence is off or the id is unknown.", inputSchema: sessionAnnotateInputSchema(), annotations: LOCAL_RW });
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
 * The spec is the NORMALIZED arbiter from config (resolveConsensus): either a
 * shorthand string or an object { model: "<id>" }.
 *
 * - "host"          -> { mode:"host", provider:null }. The handler SKIPS the
 *                      arbiter pass entirely (verdict:null); the host arbitrates.
 * - "auto"          -> first provider in `selected` whose health() is ok,
 *                      PREFERRING an openrouter:* one; falls back to selected[0].
 * - builtin         -> registry.get(name) if registered + enabled, else degrade.
 * - { model: id }   -> pinAlias on the openrouter provider for that models id,
 *                      else degrade to auto + warning. The id need NOT be
 *                      consensus:true - arbiter eligibility != panel membership.
 *
 * @param {string|{model:string}} spec
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

  const cfg = getConfig() || {};

  // Object form { model: "<id>" }: pin that models entry as the arbiter.
  if (spec && typeof spec === "object") {
    const id = spec.model;
    const orProvider = registry.get("openrouter");
    const models = (cfg.openrouter && cfg.openrouter.models) || [];
    const model = models.find((/** @type {any} */ m) => m && m.alias === id);
    // OpenRouter must be enabled both as a provider and as the openrouter block.
    const orEnabled = providerEnabled(cfg, "openrouter") && !(cfg.openrouter && cfg.openrouter.enabled === false);
    if (orProvider && model && orEnabled) return { mode: "server", provider: pinAlias(orProvider, model) };
    return auto(`configured arbiter model '${id}' is not available`);
  }

  if (BUILTIN_NAMES.has(spec)) {
    const p = registry.get(spec);
    // Mirror core/registry.js builtinsFor: a provider disabled in config is not
    // a usable arbiter even though the registry still holds it (enablement is
    // applied at selection time, not at registry build). Degrade, never hard-fail.
    if (p && providerEnabled(cfg, spec)) return { mode: "server", provider: p };
    return auto(`configured arbiter '${spec}' is not available`);
  }

  // Unrecognized spec (config validation should have degraded it already; this
  // is a defensive second guard so the handler never trusts a raw spec).
  return auto(`configured arbiter '${spec}' is not recognized`);
}

/**
 * Whether a provider is enabled in config. Mirrors core/registry.js: a missing
 * flag means enabled; only an explicit enabled:false disables it.
 * @param {any} cfg
 * @param {string} name
 * @returns {boolean}
 */
function providerEnabled(cfg, name) {
  const p = cfg && cfg.providers && cfg.providers[name];
  return !p || p.enabled !== false;
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
 * @param {() => (string|null)} [deps.getConfigError]  // last config load error (e.g. JSON parse), or null
 * @param {string} [deps.sessionsDir]  // dir for the opt-in session store; omit to disable persistence
 * @param {(method:string, params:any) => void} [deps.notify]  // server->client JSON-RPC notification sender (Phase 4); no-op if omitted
 */
function buildServer({ providers, getConfig, getConfigError, sessionsDir, notify }) {
  const registry = makeRegistry(providers);
  // Server->client notification sender (Phase 4 spike). Injected by the stdio loop
  // so it can write an unsolicited JSON-RPC notification to stdout; a no-op in tests
  // and any host that did not wire one.
  const sendNotify = typeof notify === "function" ? notify : (/** @type {string} */ _m, /** @type {any} */ _p) => {};
  const sessions = /** @type {any} */ (require("../../core/sessions.js"));
  // Consensus-step (client-driven, host-arbitrated) loop pieces: the pure state
  // machine, the review parser, and an ephemeral per-server store that carries
  // LoopState across the stateless step tool calls (no sessions.persist needed).
  const loop = /** @type {any} */ (require("../../core/consensus-loop.js"));
  const { parseReview } = require("../../core/provider.js");
  const { makeLoopStore } = require("../../core/loop-store.js");
  const loopStore = makeLoopStore();

  // In-session dedup cache (Phase 5) for the ADVISORY paths only (ask-all / ask-one):
  // an identical re-ask returns the prior success instantly. Deliberately NOT used on
  // the consensus loop - each round's plan text changes, and a cached peer verdict
  // must never substitute for a fresh review inside the convergence loop.
  const { makeResultCache } = require("../../core/result-cache.js");
  const resultCache = makeResultCache();

  // Debug logging seam (Phase 2). Build the file sink lazily and memoize it by
  // path so we do not rebuild per call; rebuild only when the config's enabled
  // flag or path changes (hot-reload). Returns NULL_LOGGER when debug is off, so
  // the orchestrate call sites can always pass `logger` unconditionally.
  const debugLog = require("../../core/debug-log.js");
  const { resolveDebugLogPath } = require("../../core/paths.js");
  /** @type {{key:string, logger:import("../../core/debug-log.js").Logger}} */
  let _fileCache = { key: "", logger: debugLog.NULL_LOGGER };
  /** Build (or reuse) the file sink for the current config. NULL when debug off. */
  function fileSink() {
    const dbg = (getConfig() || {}).debug || { enabled: false, path: null };
    if (!dbg.enabled) { _fileCache = { key: "", logger: debugLog.NULL_LOGGER }; return debugLog.NULL_LOGGER; }
    const path = (typeof dbg.path === "string" && dbg.path) || resolveDebugLogPath();
    const key = `file:${path}`;
    if (_fileCache.key !== key) _fileCache = { key, logger: debugLog.createFileLogger(path) };
    return _fileCache.logger;
  }

  // Phase 4 spike: live MCP-notification sink. Emits a `notifications/message`
  // (spec: server/utilities/logging) per core event so the host can render
  // per-provider progress DURING the one blocking tool call. Syslog levels;
  // suppressed when the client raised the min level above "info" via
  // `logging/setLevel`. Carries NO prompt/response text (spec security rule).
  const LEVEL_RANK = Object.freeze({ debug: 0, info: 1, notice: 2, warning: 3, error: 4, critical: 5, alert: 6, emergency: 7 });
  let notifyMinLevel = /** @type {keyof typeof LEVEL_RANK} */ ("info"); // emit info+ by default; a client can raise it
  const notifySink = {
    /** @param {import("../../core/debug-log.js").DebugEvent} e */
    logEvent(e) {
      if (LEVEL_RANK.info < LEVEL_RANK[notifyMinLevel]) return; // client raised the bar
      try {
        sendNotify("notifications/message", {
          level: "info",
          logger: "deliberation",
          data: { event: e.event, tool: e.tool, provider: e.provider, ms: e.ms, round: e.round, verdict: e.verdict, isError: e.isError, errorKind: e.errorKind },
        });
      } catch { /* notifications must never break a call */ }
    },
  };
  /** Set the client's minimum log level (logging/setLevel). */
  function setLogLevel(/** @type {any} */ level) {
    if (typeof level === "string" && Object.prototype.hasOwnProperty.call(LEVEL_RANK, level)) { notifyMinLevel = /** @type {keyof typeof LEVEL_RANK} */ (level); return true; }
    return false;
  }
  /** Composite logger: file sink (when debug on) + live notification sink (always). */
  function currentLogger() {
    return debugLog.composeLoggers([fileSink(), notifySink]);
  }

  // Client identity for arbiter-default selection. Connection-scoped: set from the
  // MCP `initialize` handshake (clientInfo.name) for the life of this stdio session.
  let clientName = /** @type {string|null} */ (null);

  /**
   * Whether this server is running under Claude Code (or another Claude host).
   * Primary signal: Claude Code injects `CLAUDECODE=1` into stdio MCP subprocess
   * env (Claude Code CHANGELOG v2.1.147) - deterministic + documented. Secondary:
   * a `clientInfo.name` containing "claude" (e.g. Claude Desktop). Used ONLY to
   * pick the DEFAULT arbiter when the user has not set `consensus.arbiter`.
   * @returns {boolean}
   */
  function isClaudeHost() {
    if (process.env.CLAUDECODE === "1") return true;
    return typeof clientName === "string" && clientName.toLowerCase().includes("claude");
  }

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
   * Resolve the orientation bundle for a dispatch when config enables it, else undefined.
   * @param {{cwd?:string}} req
   * @returns {(import("../../core/types.js").FileRef[]|undefined)}
   */
  function orient(req) {
    return orientationFilesFor(getConfig(), req && req.cwd);
  }

  // --- session store wiring -------------------------------------------------
  // Persistence is opt-in (sessions.persist) AND requires a configured dir. When
  // either is missing, the session-* tools report "disabled" and the
  // consensus/ask-all paths write nothing / return no sessionId.

  /** @returns {{persist:boolean, maxRecords:number, maxAgeDays:number, captureText:boolean}} */
  function sessionsCfg() {
    const c = getConfig() || {};
    const s = c.sessions || {};
    return {
      persist: !!s.persist,
      maxRecords: typeof s.maxRecords === "number" ? s.maxRecords : sessions.DEFAULT_MAX_RECORDS,
      maxAgeDays: typeof s.maxAgeDays === "number" ? s.maxAgeDays : sessions.DEFAULT_MAX_AGE_DAYS,
      captureText: !!s.captureText,
    };
  }
  /** @returns {boolean} */
  function persistEnabled() {
    return !!sessionsDir && sessionsCfg().persist;
  }

  /** @param {any} obj @returns {{content:{type:string,text:string}[]}} */
  function jsonResult(obj) {
    return { content: [{ type: "text", text: JSON.stringify(obj) }] };
  }
  function disabledMsg() {
    return jsonResult({ error: "session persistence is disabled (set sessions.persist)" });
  }
  /** @param {unknown} id */
  function notFoundMsg(id) {
    return jsonResult({ error: `session not found: ${String(id)}` });
  }

  /** @param {any} files @returns {(any[]|null)} input attachment REFS only (never bodies); preserves path/dir/file_id/file_url/mode so a revisit re-runs with the same context regardless of ref kind */
  function refsFromFiles(files) {
    if (!Array.isArray(files)) return null;
    /** @type {any[]} */
    const refs = [];
    for (const f of files) {
      if (!f || typeof f !== "object") continue;
      /** @type {any} */
      const ref = {};
      if (typeof f.path === "string") ref.path = f.path;
      if (typeof f.dir === "string") ref.dir = f.dir;
      if (typeof f.file_id === "string") ref.file_id = f.file_id;
      if (typeof f.file_url === "string") ref.file_url = f.file_url;
      if (typeof f.mode === "string") ref.mode = f.mode;
      if (Object.keys(ref).length) refs.push(ref);
    }
    return refs.length ? refs : null;
  }
  /**
   * Map raw run results to the persisted opinion shape. Handles both kinds:
   * fan-out provider results ({provider, model, text}) and consensus-auto review
   * results ({source, verdict, criticalIssues}). `source` falls back to provider
   * so a loop opinion keeps its identity; verdict/criticalIssues ride along when
   * present (sanitizeRecord scrubs the issue descriptions on write).
   * @param {any} results
   * @returns {any[]}
   */
  function opinionsFrom(results) {
    if (!Array.isArray(results)) return [];
    return results.map((r) => {
      /** @type {any} */
      const o = {
        provider: r && (r.provider || r.source),
        model: r && r.model,
        text: r && r.isError === false && typeof r.text === "string" ? r.text : undefined,
      };
      if (r && r.verdict !== undefined) o.verdict = r.verdict;
      if (r && Array.isArray(r.criticalIssues)) o.criticalIssues = r.criticalIssues;
      return o;
    });
  }
  /** @param {any} result @returns {(string|null)} the verdict text, or null */
  function textOf(result) {
    if (!result) return null;
    if (typeof result === "string") return result;
    if (result.isError === false && typeof result.text === "string") return result.text;
    return null;
  }

  /**
   * Persist a completed run when persistence is on. Best-effort: a write failure
   * never fails the tool call. Returns the new sessionId, or null when off.
   * @param {("consensus"|"ask-all")} tool
   * @param {DelegationRequest} req
   * @param {string|undefined} expert
   * @param {any} parts  // { opinions, blindVerdict?, verdict?, synthesis?, synthesizeAlways?, arbiter?, warnings?, parentId?, converged?, confidence?, rounds? }
   * @returns {{id:(string|null), errorCode:(string|null)}}  id is the new sessionId on success; on write failure id is null and errorCode is a CONTENT-FREE kind (Node fs errno e.g. EACCES/ENOSPC, or "write_failed"). Persistence off -> {id:null, errorCode:null}.
   */
  function persistRun(tool, req, expert, parts) {
    if (!persistEnabled()) return { id: null, errorCode: null };
    const cfg = sessionsCfg();
    const id = sessions.newSessionId();
    /** @type {any} */
    const record = {
      id,
      parentId: parts.parentId == null ? null : parts.parentId,
      schemaVersion: sessions.SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      tool,
      question: typeof req.prompt === "string" ? req.prompt : "",
      expert: expert || null,
      files: refsFromFiles(req.files),
      // opinionsFrom keeps each provider's raw response `text`. That BODY is stored
      // only under the opt-in sessions.captureText; default OFF drops it here at the
      // single write chokepoint, so every caller (ask-all, consensus, consensus-step,
      // revisit) is gated identically. Verdict/criticalIssues summaries always stay.
      opinions: opinionsFrom(parts.opinions).map((o) => (cfg.captureText ? o : (delete o.text, o))),
      blindVerdict: textOf(parts.blindVerdict),
      verdict: textOf(parts.verdict),
      arbiter: parts.arbiter || null,
      warnings: Array.isArray(parts.warnings) ? parts.warnings : [],
      annotations: [],
    };
    // consensus loop summary (omitted for ask-all / synthesize runs; JSON drops undefined).
    if (typeof parts.converged === "boolean") record.converged = parts.converged;
    if (typeof parts.confidence === "string") record.confidence = parts.confidence;
    if (typeof parts.rounds === "number") record.rounds = parts.rounds;
    // synthesize-mode fields: free-text synthesis + the mode flag (so revisit replays the mode).
    if (typeof parts.synthesis === "string") record.synthesis = parts.synthesis;
    if (typeof parts.synthesizeAlways === "boolean") record.synthesizeAlways = parts.synthesizeAlways;
    try {
      sessions.writeSession(record, { dir: sessionsDir, maxRecords: cfg.maxRecords, maxAgeDays: cfg.maxAgeDays });
      return { id, errorCode: null };
    } catch (e) {
      // Surface ONLY a content-free failure kind (fs errno or a constant) - NEVER
      // the caught error object or its message (which could embed prompt/parts).
      const code = e && typeof /** @type {any} */ (e).code === "string" ? /** @type {any} */ (e).code : "write_failed";
      return { id: null, errorCode: code };
    }
  }

  /**
   * Emit ONE content-free persist-failure event for the consensus-step path.
   * Wrapped so a debug-log I/O error can never throw into the loop step.
   * @param {string} loopSid  the ephemeral loop id (correlation key only - non-sensitive)
   * @param {(string|null)} errorCode  sanitized errno or "write_failed"; never err.message
   */
  function emitPersistFailed(loopSid, errorCode) {
    try {
      currentLogger().logEvent({ event: "persist_failed", at: Date.now(), tool: "consensus", errorCode: errorCode || "write_failed", loopSessionId: loopSid });
    } catch { /* logging must never break the step */ }
  }

  /**
   * Persist a TERMINAL consensus-step loop record (host-arbiter path). Mirrors the
   * `consensus` tool's `parts` shape so session-revisit/analyze treat both record
   * classes identically (opinions are normalized by persistRun's opinionsFrom).
   * Best-effort + gated by sessions.persist: on write failure it emits a
   * content-free persist_failed event and returns persisted:false.
   * @param {any} state  terminal LoopState (status converged|unresolved)
   * @param {string} loopSid  ephemeral loop id, correlation key for a failure event
   * @param {("high"|"medium"|"low"|"none")} confidence
   * @returns {{id:(string|null), persisted:boolean, errorCode:(string|null)}}  errorCode is null when persistence is off; a content-free kind when a write was attempted and failed.
   */
  function persistConsensusStep(state, loopSid, confidence) {
    if (!persistEnabled()) return { id: null, persisted: false, errorCode: null };
    const ex = state.expert || undefined;
    /** @type {DelegationRequest} */
    const req = {
      // ORIGINAL prompt stashed at init - NOT currentPlan (overwritten each round).
      prompt: typeof state.originalPrompt === "string" ? state.originalPrompt : (state.currentPlan || ""),
      expert: ex,
    };
    const parts = {
      opinions: Array.isArray(state.results) ? state.results : [],
      blindVerdict: state.blindVerdict || null,
      verdict: state.hostVerdict ? state.hostVerdict.verdict : null,
      arbiter: { mode: "host", provider: null },
      warnings: [],
      converged: state.status === "converged",
      confidence,
      rounds: state.round,
    };
    const { id, errorCode } = persistRun("consensus", req, ex, parts);
    if (!id) emitPersistFailed(loopSid, errorCode);
    return { id, persisted: !!id, errorCode };
  }

  /**
   * Run the ask-all fan-out. Returns the response payload plus the parts needed
   * to persist a record. Shared by the ask-all tool and session-revisit.
   * @param {DelegationRequest} req
   * @param {string|undefined} expert
   * @returns {Promise<{payload:any, parts:any}>}
   */
  async function runAskAll(req, expert, opts = /** @type {{noCache?:boolean}} */ ({})) {
    const { providers: selected, omitted } = registry.selectForAskAll({ config: getConfig(), expert: expert || "" });
    const lg = currentLogger();
    try { lg.logEvent({ event: "dispatch_start", at: Date.now(), tool: "ask-all", voices: selected.length }); } catch { /* never break */ }
    // session-revisit passes noCache: a revisit is a deliberate RE-RUN of the stored
    // question, so it must never replay a cached opinion from the live tool path.
    const results = await askAll(selected, withPersona(req, expert), { logger: lg, tool: "ask-all", cache: opts.noCache ? undefined : resultCache, orientationFiles: orient(req) });
    return {
      payload: { results, omitted },
      parts: { opinions: results, blindVerdict: null, verdict: null, arbiter: null, warnings: [] },
    };
  }

  /**
   * Run the consensus fan-out + arbiter resolution. Returns the response payload
   * plus the parts needed to persist a record. Shared by the consensus tool and
   * session-revisit.
   * @param {DelegationRequest} req
   * @param {string|undefined} expert
   * @returns {Promise<{payload:any, parts:any}>}
   */
  async function runConsensus(req, expert) {
    const cfg = getConfig() || {};
    const { providers: selected } = registry.selectForConsensus({ config: cfg, expert: expert || "" });
    const cc = cfg.consensus || {};
    const arbiterSpec = cc.arbiterDefaulted ? (isClaudeHost() ? "host" : "auto") : (cc.arbiter || "auto");
    const blindVote = !!cc.blindVote;
    const warnings = Array.isArray(cfg.consensusWarnings) ? cfg.consensusWarnings.slice() : [];
    const cfgErr = typeof getConfigError === "function" ? getConfigError() : null;
    if (cfgErr) warnings.push(`config not loaded: ${cfgErr}`);

    const resolved = await resolveArbiter(arbiterSpec, selected, registry, getConfig);
    if (resolved.warning) warnings.push(resolved.warning);

    if (resolved.mode === "host") {
      const opinions = await askAll(selected, withPersona(req, expert), { logger: currentLogger(), tool: "consensus", orientationFiles: orient(req) });
      const arbiter = { mode: "host" };
      const body = { opinions, blindVerdict: null, verdict: null, arbiter, warnings };
      return { payload: body, parts: body };
    }

    if (!resolved.provider) {
      const out = await consensus(selected, withPersona(req, expert), { arbiterInstructions: PROMPTS.arbiter, logger: currentLogger(), orientationFiles: orient(req) });
      const arbiter = { mode: "server", provider: null };
      return {
        payload: { opinions: out.opinions, blindVerdict: out.blindVerdict, verdict: out.verdict, error: out.error, arbiter, warnings },
        parts: { opinions: out.opinions, blindVerdict: out.blindVerdict, verdict: out.verdict, arbiter, warnings },
      };
    }

    const arbiterP = resolved.provider;
    let peers = selected.filter((p) => p.name !== arbiterP.name);
    if (peers.length < 2) {
      peers = selected;
      warnings.push(`panel too small to exclude arbiter '${arbiterP.name}'; kept it in the peer panel (floor of 2)`);
    }
    const out = await consensus(peers, withPersona(req, expert), { arbiter: arbiterP, arbiterInstructions: PROMPTS.arbiter, blindVote, logger: currentLogger(), orientationFiles: orient(req) });
    const arbiter = { mode: "server", provider: arbiterP.name };
    return {
      payload: { opinions: out.opinions, blindVerdict: out.blindVerdict, verdict: out.verdict, error: out.error, arbiter, warnings },
      parts: { opinions: out.opinions, blindVerdict: out.blindVerdict, verdict: out.verdict, arbiter, warnings },
    };
  }

  /**
   * Run the full multi-round convergence loop server-side via runToConvergence.
   * Needs a CONCRETE provider arbiter (the loop is provider-driven here); if the
   * config resolves to host/none, fall back to a selected provider as the driver
   * with a warning (the host-driven client loop is the consensus-step path, not
   * this one). Shares runConsensus's panel selection + floor-of-2 exclusion.
   * @param {DelegationRequest} req
   * @param {string|undefined} expert
   * @param {number} [maxRoundsOverride]  per-call cap; falls back to consensus.maxRounds, then the engine default
   * @returns {Promise<{payload:any, parts:(any|null)}>}  payload is the tool result; parts is non-null only on a real run (drives persistence); never throws
   */
  async function runConsensusAuto(req, expert, maxRoundsOverride) {
    try {
      const cfg = getConfig() || {};
      const { providers: selected } = registry.selectForConsensus({ config: cfg, expert: expert || "" });
      const cc = cfg.consensus || {};
      const arbiterSpec = cc.arbiterDefaulted ? (isClaudeHost() ? "host" : "auto") : (cc.arbiter || "auto");
      /** @type {string[]} */
      const warnings = Array.isArray(cfg.consensusWarnings) ? cfg.consensusWarnings.slice() : [];
      const cfgErr = typeof getConfigError === "function" ? getConfigError() : null;
      if (cfgErr) warnings.push(`config not loaded: ${cfgErr}`);
      const resolved = await resolveArbiter(arbiterSpec, selected, registry, getConfig);
      if (resolved.warning) warnings.push(resolved.warning);

      const arbiterP = resolved.provider;
      if (!arbiterP) {
        // consensus-auto needs a CONCRETE provider arbiter (the loop runs server-side).
        // host mode is the client-driven /consensus path; do NOT silently pick a peer.
        const host = resolved.mode === "host";
        warnings.push(host
          ? "consensus runs the loop server-side and needs a concrete arbiter; set consensus.arbiter to a provider or openrouter:<alias> (host mode drives the client-side /consensus instead)"
          : "no usable arbiter provider available");
        return { payload: { converged: false, verdict: null, confidence: "none", rounds: 0, opinions: [], arbiter: { mode: resolved.mode, provider: null }, warnings, error: host ? "arbiter-is-host" : "no-arbiter" }, parts: null };
      }

      // Exclude the arbiter from the peer panel - never let it review its own output.
      // A single distinct peer is a valid minimal panel (peer != arbiter).
      const peers = selected.filter((p) => p.name !== arbiterP.name);
      if (peers.length < 1) {
        return { payload: { converged: false, verdict: null, confidence: "none", rounds: 0, opinions: [], arbiter: { mode: "server", provider: arbiterP.name }, warnings: warnings.concat(["consensus needs at least one peer distinct from the arbiter"]), error: "insufficient-peers" }, parts: null };
      }

      // Per-call maxRounds wins; else the config default; else the engine default.
      const maxRounds = Number.isInteger(maxRoundsOverride) && /** @type {number} */ (maxRoundsOverride) > 0
        ? maxRoundsOverride
        : (Number.isInteger(cc.maxRounds) && cc.maxRounds > 0 ? cc.maxRounds : undefined);
      const maxWallMs = Number.isInteger(cc.maxWallMs) && cc.maxWallMs > 0 ? cc.maxWallMs : undefined;
      const out = await runToConvergence(peers, withPersona(req, expert), { arbiter: arbiterP, maxRounds, maxWallMs, logger: currentLogger(), orientationFiles: orient(req) });
      const allWarnings = out.error ? warnings.concat([`loop: ${out.error}`]) : warnings;
      const rounds = Array.isArray(out.rounds) ? out.rounds.length : 0;
      const arbiter = { mode: "server", provider: arbiterP.name };
      const payload = {
        converged: out.converged,
        verdict: out.verdict,
        confidence: out.confidence,
        rounds,
        opinions: out.opinions,
        arbiter,
        warnings: allWarnings,
        error: out.error,
        stopReason: out.stopReason,
      };
      // parts drives persistence (only on a real run). blindVerdict is per-round in
      // the loop, so the final record stores null (the verdict + opinions are the
      // durable summary; full round history is intentionally not persisted yet).
      const parts = {
        opinions: out.opinions,
        blindVerdict: null,
        verdict: out.verdict,
        arbiter,
        warnings: allWarnings,
        converged: out.converged,
        confidence: out.confidence,
        rounds,
      };
      return { payload, parts };
    } catch (e) {
      // Never reject the tool call - degrade to a structured error.
      return { payload: { converged: false, verdict: null, confidence: "none", rounds: 0, opinions: [], arbiter: null, warnings: [], error: `internal: ${String((e && /** @type {any} */ (e).message) || e)}` }, parts: null };
    }
  }

  /**
   * The unified `consensus` tool: ONE shape for both modes, shared by the tool
   * dispatch and session-revisit (so the engine stays the single source of truth).
   * - default (loop): runs the full convergence loop via runConsensusAuto.
   * - synthesizeAlways: ONE arbiter synthesis pass via runConsensus; the one-shot's
   *   free-text verdict becomes `synthesis` and the enum `verdict` is null.
   * Return envelope keys are identical across modes; the inapplicable fields are
   * null (explicit, caller-selected - not hidden polymorphism). `parts` is null on
   * a loop error path (no persistence); synthesize runs always persist.
   * @param {DelegationRequest} req
   * @param {string|undefined} expert
   * @param {{synthesizeAlways?:boolean, maxRounds?:number}} [opts]
   * @returns {Promise<{payload:any, parts:(any|null)}>}
   */
  async function runConsensusTool(req, expert, opts = {}) {
    try {
      if (opts.synthesizeAlways === true) {
        const { payload: p } = await runConsensus(req, expert);
        // One-shot `verdict` is the arbiter's result OBJECT (free-text synthesis), or
        // null in host mode where the host synthesizes. Extract its text into
        // `synthesis`; the enum `verdict` field stays null in synthesize mode.
        const synthesis = textOf(p.verdict);
        const blindVerdict = textOf(p.blindVerdict); // carries the optional blindVote pre-vote
        const warnings = Array.isArray(p.warnings) ? p.warnings.slice() : [];
        // A failed arbiter result (isError, not a throw) yields synthesis:null with no
        // top-level error - surface it as a warning so it does not read as empty success.
        if (synthesis == null && p.verdict && p.verdict.isError) {
          warnings.push(`arbiter synthesis failed${p.verdict.errorKind ? `: ${p.verdict.errorKind}` : ""}`);
        }
        const envelope = {
          opinions: p.opinions, verdict: null, synthesis, blindVerdict,
          arbiter: p.arbiter, warnings,
          converged: null, confidence: null, rounds: 1,
          synthesizeAlways: true, error: p.error == null ? null : p.error,
        };
        const parts = {
          opinions: p.opinions, verdict: null, synthesis, blindVerdict,
          arbiter: p.arbiter, warnings, synthesizeAlways: true,
        };
        return { payload: envelope, parts };
      }
      const { payload: p, parts } = await runConsensusAuto(req, expert, opts.maxRounds);
      const envelope = {
        opinions: p.opinions, verdict: p.verdict, synthesis: null, blindVerdict: null,
        arbiter: p.arbiter, warnings: p.warnings,
        converged: p.converged, confidence: p.confidence, rounds: p.rounds,
        synthesizeAlways: false, error: p.error == null ? null : p.error,
        stopReason: p.stopReason,
      };
      if (!parts) return { payload: envelope, parts: null }; // error path - do not persist
      return { payload: envelope, parts: { ...parts, synthesis: null, synthesizeAlways: false } };
    } catch (e) {
      // Never reject the tool call - degrade to a structured error (matches runConsensusAuto).
      const synth = opts.synthesizeAlways === true;
      return {
        payload: {
          opinions: [], verdict: null, synthesis: null, blindVerdict: null, arbiter: null, warnings: [],
          converged: null, confidence: null, rounds: synth ? 1 : 0, synthesizeAlways: synth,
          error: `internal: ${String((e && /** @type {any} */ (e).message) || e)}`,
        },
        parts: null,
      };
    }
  }

  /**
   * Enter the `await_blind` status: compute this round's prompts and stash the
   * peer prompt on the stored state (the pure machine ignores the extra field;
   * dispatch_peers reads it, since prepareRound is guarded to await_blind only).
   * @param {any} state
   * @returns {{state:any, blindPrompt:string}}
   */
  function enterBlind(state) {
    const { peerPrompt, blindPrompt } = loop.prepareRound(state);
    return { state: { ...state, peerPrompt }, blindPrompt };
  }

  /**
   * Client-driven, host-arbitrated consensus loop - one action per MCP call,
   * LoopState carried in the ephemeral loop store by sessionId. The host model
   * supplies the blind verdict / adjudication / revision (visible in its
   * transcript); the server only fans out to the peer providers. Never throws:
   * a wrong-order action or an expired session returns a structured error so the
   * driver can recover. A TERMINAL transition (converged/unresolved) persists ONE
   * session record via persistConsensusStep when sessions.persist is on (atomic
   * take guarantees at-most-one; best-effort, content-free failure telemetry).
   * @param {any} args
   * @param {string|undefined} expert
   * @returns {Promise<any>}
   */
  async function runConsensusStep(args, expert) {
    const action = String(args.action || "");
    try {
      if (action === "init") {
        const cfg = getConfig() || {};
        const cc = cfg.consensus || {};
        const maxRounds = Number.isInteger(cc.maxRounds) && cc.maxRounds > 0 ? cc.maxRounds : undefined;
        const originalPrompt = typeof args.prompt === "string" ? args.prompt : "";
        let state = loop.initConsensusLoop({ plan: originalPrompt, expert: args.expert, arbiterMode: "host", maxRounds });
        const entered = enterBlind(state);
        const sid = sessions.newSessionId();
        // Stash the ORIGINAL prompt so a terminal record's `question` is the original
        // plan, not the final revision (currentPlan is overwritten each round). Rides
        // through every pure-machine transition via spread, like peerPrompt.
        loopStore.put(sid, { ...entered.state, originalPrompt });
        return { sessionId: sid, status: entered.state.status, round: entered.state.round, blindPrompt: entered.blindPrompt, note: "write your blind verdict, then call record_blind" };
      }

      const sid = String(args.sessionId == null ? "" : args.sessionId);
      if (!sid) return { error: "missing-sessionId", note: "sessionId is required for every action except init" };
      const cur = loopStore.get(sid);
      if (!cur) return { error: "session-expired", note: "no live session for that id (server restart or TTL); restart with action:init" };

      if (action === "record_blind") {
        const next = loop.recordBlindVerdict(cur, String(args.blindVerdict == null ? "" : args.blindVerdict));
        // Defensive: pin the stashed peerPrompt across the transition (the pure
        // machine carries it via spread today; don't rely on that staying true).
        if (cur.peerPrompt && !next.peerPrompt) next.peerPrompt = cur.peerPrompt;
        loopStore.put(sid, next);
        return { sessionId: sid, status: next.status, round: next.round, note: "call dispatch_peers to fan out to the providers" };
      }

      if (action === "dispatch_peers") {
        // Guard the status BEFORE the fan-out so a skipped record_blind cannot
        // burn provider calls (addOpinions would otherwise throw only AFTER askAll).
        if (cur.status !== "await_peers") {
          return { error: "unexpected-action-for-status", detail: `dispatch_peers expects status 'await_peers', got '${cur.status}'` };
        }
        // peerPrompt was stashed on entry to await_blind; fall back to the plan
        // text (NOT prepareRound, which is guarded to await_blind and would throw).
        const peerPrompt = cur.peerPrompt || cur.currentPlan || "";
        // One resolved expert for selection, persona, and the request - consistent.
        const ex = cur.expert || expert || undefined;
        const { providers: selected } = registry.selectForConsensus({ config: getConfig() || {}, expert: ex || "" });
        /** @type {DelegationRequest} */
        const peerReq = { prompt: peerPrompt, expert: ex, cwd: typeof args.cwd === "string" ? args.cwd : undefined };
        const lg = currentLogger();
        try { lg.logEvent({ event: "dispatch_start", at: Date.now(), tool: "consensus", round: cur.round, voices: selected.length }); } catch { /* never break */ }
        const peerResults = await askAll(selected, withPersona(peerReq, ex), { logger: lg, tool: "consensus", orientationFiles: orient(peerReq) });
        const results = peerResults.map((r) =>
          r.isError
            ? { source: r.provider, isError: true, errorKind: r.errorKind, verdict: null, criticalIssues: [], model: r.model, reasoningEffort: r.reasoningEffort ?? null, ms: r.ms }
            // Retain the raw response `text` on the in-memory loop result so a terminal
            // persist can store it WHEN sessions.captureText is on (persistRun gates it;
            // the wire `opinions` mapping below omits text, so it never leaves the loop).
            : { ...parseReview(typeof r.text === "string" ? r.text : ""), source: r.provider, isError: false, text: typeof r.text === "string" ? r.text : undefined, model: r.model, reasoningEffort: r.reasoningEffort ?? null, ms: r.ms }
        );
        const next = loop.addOpinions(cur, results);
        loopStore.put(sid, next);
        return {
          sessionId: sid,
          status: next.status,
          round: next.round,
          // model + reasoningEffort + ms ride along so the command can show real
          // reasoning effort per voice (no more hardcoded "n/a") and a time footer.
          opinions: results.map((r) => ({ source: r.source, isError: r.isError, errorKind: r.errorKind, verdict: r.verdict, criticalIssues: r.criticalIssues, model: r.model, reasoningEffort: r.reasoningEffort, ms: r.ms })),
          note: "adjudicate the opinions, then call submit_adjudication with your verdict + per-issue decisions",
        };
      }

      if (action === "submit_adjudication") {
        const decisions = Array.isArray(args.decisions) ? args.decisions : [];
        const next = loop.submitAdjudication(cur, { verdict: args.verdict, decisions });
        try {
          currentLogger().logEvent({
            event: "round", at: Date.now(), tool: "consensus", round: cur.round,
            verdict: typeof args.verdict === "string" ? args.verdict : null,
            converged: next.status === "converged",
            acceptedCritical: decisions.filter((/** @type {any} */ d) => d && d.action === "accept").length,
            voices: Array.isArray(cur.results) ? cur.results.length : undefined,
          });
        } catch { /* logging must never break the step */ }
        if (next.status === "converged") {
          const { finalReport, confidence } = loop.finalize(next);
          // Atomic take: remove-and-return in ONE synchronous step so a concurrent/
          // retried terminal call finds nothing (session-expired) and cannot
          // double-persist. take==null => already finalized; return non-durable.
          const taken = loopStore.take(sid);
          const { id, persisted, errorCode } = taken ? persistConsensusStep(next, sid, confidence) : { id: null, persisted: false, errorCode: null };
          // persistError (content-free) lets the host tell "write failed" from "persistence off" (both persisted:false).
          return { sessionId: id || undefined, loopSessionId: sid, persisted, ...(errorCode ? { persistError: errorCode } : {}), status: "converged", converged: true, verdict: next.hostVerdict ? next.hostVerdict.verdict : null, confidence, finalReport };
        }
        loopStore.put(sid, next);
        return { sessionId: sid, status: next.status, round: next.round, note: "not converged - revise the plan, then call submit_revision" };
      }

      if (action === "submit_revision") {
        const advanced = loop.submitRevision(cur, typeof args.revisedPlan === "string" ? args.revisedPlan : cur.currentPlan, args.diffSummary);
        if (advanced.status === "unresolved") {
          const { finalReport, confidence } = loop.finalize(advanced);
          const taken = loopStore.take(sid);
          const { id, persisted, errorCode } = taken ? persistConsensusStep(advanced, sid, confidence) : { id: null, persisted: false, errorCode: null };
          return { sessionId: id || undefined, loopSessionId: sid, persisted, ...(errorCode ? { persistError: errorCode } : {}), status: "unresolved", converged: false, confidence, finalReport };
        }
        const entered = enterBlind(advanced);
        // Re-stash originalPrompt EXPLICITLY across the revision loop-back (defensive,
        // mirrors the peerPrompt pin in record_blind) so a future pure-machine refactor
        // can't silently drop it and persist a revised plan as `question`.
        loopStore.put(sid, { ...entered.state, originalPrompt: cur.originalPrompt });
        return { sessionId: sid, status: entered.state.status, round: entered.state.round, blindPrompt: entered.blindPrompt, note: "next round - write your blind verdict, then call record_blind" };
      }

      return { error: `unknown action: ${action}` };
    } catch (e) {
      // A wrong-order action throws from the state-machine guard (assertStatus).
      const msg = String((e && /** @type {any} */ (e).message) || e);
      return { error: /expected status/.test(msg) ? "unexpected-action-for-status" : "step-failed", detail: msg };
    }
  }

  /**
   * Read-only run analytics for the `analyze` tool: tail the opt-in debug log,
   * read recent persisted sessions, and return aggregated stats + advisory
   * recommendations (core/analyze.js). Writes nothing. Tail-bounds the log read so
   * a large file cannot bloat memory, and drops the partial first line.
   * @param {any} args  // untrusted JSON-RPC tool arguments
   * @returns {import("../../core/analyze.js").Analysis}
   */
  function runAnalyze(args) {
    const fs = require("node:fs");
    const cfg = getConfig() || {};
    const dbg = cfg.debug || {};
    const debugEnabled = !!dbg.enabled;
    const logPath = (typeof dbg.path === "string" && dbg.path) || resolveDebugLogPath();
    const limitBytes = Number.isInteger(args.limitBytes) && args.limitBytes > 0 ? args.limitBytes : 1024 * 1024;
    let text = "";
    try {
      const fd = fs.openSync(logPath, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const start = size > limitBytes ? size - limitBytes : 0;
        const len = size - start;
        if (len > 0) {
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, start);
          text = buf.toString("utf8");
          if (start > 0) {
            const nl = text.indexOf("\n");
            if (nl >= 0) text = text.slice(nl + 1);
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Missing/unreadable log -> no timing data; buildAnalysis flags insufficientData.
    }
    const events = analyzeCore.parseDebugLog(text);

    // Agreement lens: only when persistence is on (otherwise there are no records).
    /** @type {any[]} */
    const records = [];
    const persist = persistEnabled();
    if (persist) {
      const n = Number.isInteger(args.sessions) && args.sessions > 0 ? args.sessions : 50;
      for (const e of sessions.listSessions({ dir: sessionsDir }).slice(0, n)) {
        const rec = sessions.readSession(e.id, { dir: sessionsDir });
        if (rec) records.push(rec);
      }
    }
    return analyzeCore.buildAnalysis(events, records, cfg, { logPath, debugEnabled, sessionsPersist: persist, sessionsDir });
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
    if (name === "panel") {
      // Echo the EXACT set ask-all would dispatch (same selection function, same
      // fanout cap), WITHOUT calling any provider. The command issues one ask-one
      // per name in parallel for visible per-provider progress.
      const { providers: selected, omitted } = registry.selectForAskAll({ config: getConfig(), expert: expert || "" });
      return jsonResult({
        providers: selected.map((p) => p.name),
        omitted: (Array.isArray(omitted) ? omitted : []).map((o) => (o && o.alias) || String(o)),
      });
    }
    if (name === "ask-one") {
      // Resolve ONE provider by name from the SAME selection set (so a pinned
      // openrouter:<alias> resolves and a disabled/over-cap one is rejected).
      const want = typeof args.provider === "string" ? args.provider : "";
      const { providers: selected } = registry.selectForAskAll({ config: getConfig(), expert: expert || "" });
      const p = selected.find((x) => x.name === want);
      if (!p) {
        return jsonResult({ error: `provider "${want}" is not in the active panel`, panel: selected.map((x) => x.name) });
      }
      const result = await askOne(p, withPersona(req, expert), { logger: currentLogger(), tool: "ask-one", cache: resultCache, orientationFiles: orient(req) });
      return jsonResult({ result });
    }
    if (name === "analyze") {
      return jsonResult(runAnalyze(args));
    }
    if (name === "ask-all") {
      // selectForAskAll returns a FLAT provider list: enabled built-ins + per-alias OR wrappers.
      const { payload, parts } = await runAskAll(req, expert);
      const { id: sid } = persistRun("ask-all", req, expert, parts);
      if (sid) payload.sessionId = sid;
      return jsonResult(payload);
    }
    if (name === "consensus") {
      // The unified consensus tool: the full convergence loop (provider arbiter) by
      // default, or a single arbiter synthesis pass with synthesizeAlways:true. One
      // engine, one return shape (split verdict/synthesis). Persisted as tool:"consensus"
      // with the mode flag so session-revisit replays the same mode. parts is null on a
      // loop error path (no-arbiter/insufficient-peers) - skip the write.
      const { payload, parts } = await runConsensusTool(req, expert, {
        synthesizeAlways: args.synthesizeAlways === true,
        // Clamp the per-call override to the same hard cap the config path uses (50),
        // so a caller cannot drive an unbounded paid loop.
        maxRounds: Number.isInteger(args.maxRounds) && args.maxRounds > 0 ? Math.min(args.maxRounds, 50) : undefined,
      });
      if (parts) {
        const { id: sid } = persistRun("consensus", req, expert, parts);
        if (sid) payload.sessionId = sid;
      }
      return jsonResult(payload);
    }
    if (name === "consensus-step") {
      // Client-driven, host-arbitrated loop. State lives in the ephemeral loop
      // store by sessionId; the host model drives one action per call.
      return jsonResult(await runConsensusStep(args, expert));
    }
    if (name === "session-get") {
      if (!persistEnabled()) return disabledMsg();
      const rec = sessions.readSession(String(args.sessionId == null ? "" : args.sessionId), { dir: sessionsDir });
      if (!rec) return notFoundMsg(args.sessionId);
      return jsonResult({ session: rec });
    }
    if (name === "session-annotate") {
      if (!persistEnabled()) return disabledMsg();
      const cfg = sessionsCfg();
      const updated = sessions.annotateSession(
        String(args.sessionId == null ? "" : args.sessionId),
        String(args.note == null ? "" : args.note),
        { dir: sessionsDir, maxRecords: cfg.maxRecords, maxAgeDays: cfg.maxAgeDays }
      );
      if (!updated) return notFoundMsg(args.sessionId);
      return jsonResult({ session: updated });
    }
    if (name === "session-revisit") {
      if (!persistEnabled()) return disabledMsg();
      const rec = sessions.readSession(String(args.sessionId == null ? "" : args.sessionId), { dir: sessionsDir });
      if (!rec) return notFoundMsg(args.sessionId);
      // Re-run the ORIGINAL question with the CURRENT providers/config via the same
      // path, then write a CHILD record linked by parentId. Re-run (not replay):
      // revisit's purpose is to re-evaluate against the current context.
      const childExpert = rec.expert || undefined;
      // Carry the original attachment REFS so the re-run sees the same file
      // context the parent did (paths were scrubbed on write).
      const childFiles = Array.isArray(rec.files) && rec.files.length ? rec.files : undefined;
      // Build childReq EXPLICITLY from the persisted record (+ cwd) - do NOT spread
      // `req`, or a raw caller could smuggle developerInstructions/reasoningEffort
      // into the rerun even though session-revisit only advertises sessionId + cwd.
      /** @type {DelegationRequest} */
      const childReq = {
        prompt: rec.question,
        expert: childExpert,
        files: childFiles,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      };
      // Route by the ORIGINAL tool. A "consensus" record re-runs the consensus tool,
      // REPLAYING its mode (the loop, or a synthesize pass) from the stored flag - a
      // missing flag means loop. The consensus path can return parts:null on a loop
      // error; ask-all always carries parts. (Records written before this PR are
      // unsupported - pre-1.0, no users; wipe the local session store if any exist.)
      const tool = rec.tool === "ask-all" ? "ask-all" : "consensus";
      const { payload, parts } = tool === "ask-all"
        ? await runAskAll(childReq, childExpert, { noCache: true })
        : await runConsensusTool(childReq, childExpert, { synthesizeAlways: rec.synthesizeAlways === true });
      if (parts) {
        const { id: sid } = persistRun(tool, childReq, childExpert, { ...parts, parentId: rec.id });
        if (sid) payload.sessionId = sid;
      }
      payload.parentId = rec.id;
      return jsonResult(payload);
    }
    if (Object.prototype.hasOwnProperty.call(ASK_PROVIDER, name)) {
      const p = registry.get(ASK_PROVIDER[name]);
      if (!p) return { content: [{ type: "text", text: JSON.stringify({ error: `provider ${ASK_PROVIDER[name]} not registered` }) }] };
      const result = await askOne(p, withPersona(req, expert), { logger: currentLogger(), tool: "ask-one", cache: resultCache, orientationFiles: orient(req) });
      return { content: [{ type: "text", text: JSON.stringify({ result }) }] };
    }
    if (EXPERTS.includes(name)) {
      const { providers: selected } = registry.selectForAskAll({ config: getConfig(), expert: name });
      const results = await askAll(selected, withPersona({ ...req, expert: name }, expert), { logger: currentLogger(), tool: name, cache: resultCache, orientationFiles: orient(req) });
      return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
    }
    throw new Error(`unknown tool: ${name}`);
  }

  /** @param {any} msg */
  async function handle(msg) {
    try {
      if (msg.method === "initialize") {
        // Capture the client name (hint for the arbiter default; see isClaudeHost).
        const ci = msg.params && msg.params.clientInfo;
        if (ci && typeof ci.name === "string") clientName = ci.name;
        // `logging: {}` advertises that we emit `notifications/message` (Phase 4 spike).
        return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {}, logging: {} }, serverInfo: { name: "deliberation-mcp", version: "0.1.0" } } };
      }
      if (msg.method === "logging/setLevel") {
        const level = msg.params && msg.params.level;
        if (!setLogLevel(level)) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `invalid log level: ${String(level)}` } };
        return { jsonrpc: "2.0", id: msg.id, result: {} };
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
  // Expose the last config load error (e.g. JSON parse failure) so the consensus
  // handler can surface a broken config.json as a warning rather than swallow it.
  /** @returns {(string|null)} */
  const getConfigError = () => {
    const r = reader.get();
    return r && r.ok === false ? (r.error || "config load failed") : null;
  };

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
  const sessionsDir = require("../../core/paths.js").resolveSessionsDir();
  // Server->client notification writer (Phase 4): an unsolicited JSON-RPC message
  // (no `id`) on stdout. Used to stream per-provider progress during a blocking call.
  const notify = (/** @type {string} */ method, /** @type {any} */ params) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const srv = buildServer({ providers, getConfig, getConfigError, sessionsDir, notify });

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
