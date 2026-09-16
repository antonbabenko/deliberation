"use strict";
/**
 * Host tool-call budget.
 *
 * Some MCP hosts cap every tool call from the outside. Claude Code on the web exports
 * `MCP_TOOL_TIMEOUT=60000`, so a provider ceiling of 180-600s is unreachable there: the
 * host kills the call at 60s with "timed out after 60s" and the provider's own error
 * path never runs - no errorKind, no message, nothing that names the cap.
 *
 * The rule: read the host cap from the environment, keep every provider ceiling a
 * margin UNDER it so the provider fails first (a real `timeout` result that names the
 * cap), and say what to raise. No config key - the cap is the host's, not ours.
 *
 * The host resolves the cap per server as `config.timeout ?? MCP_TOOL_TIMEOUT ?? default`,
 * so `.claude-plugin/plugin.json` declares `timeout: 1800000` on every server AND mirrors it
 * into the server's env as MCP_TOOL_TIMEOUT: the process inherits the host's 60000
 * otherwise, and this clamp would cancel the override. A clamped timeout on a current
 * manifest therefore means an old plugin install or a host with no per-server timeout.
 */

const HOST_BUDGET_ENV = "MCP_TOOL_TIMEOUT";
/** Headroom so the provider's timeout fires before the host's - the result still has to be serialized and written. */
const HOST_BUDGET_MARGIN_MS = 5000;
/** Never clamp below this: a sub-second ceiling helps nobody and hides the real problem. */
const HOST_BUDGET_MIN_MS = 1000;

/**
 * The host's per-tool-call cap in ms, or null when the host declares none.
 * Garbage, zero, and negatives read as "no cap" - never throws.
 * @param {Record<string, (string|undefined)>} [env]
 * @returns {(number|null)}
 */
function hostBudgetMs(env = process.env) {
  const raw = env[HOST_BUDGET_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Clamp a provider ceiling under the host cap.
 *
 * `timeoutMs` undefined means "the adapter's built-in default applies"; under a host cap
 * that default is unknown here and almost certainly too large, so the clamped ceiling is
 * returned explicitly and the adapter default never runs.
 *
 * `remainingMs` (from `fitToHostBudget`, carried on the request as `hostBudgetRemainingMs`)
 * lowers the ceiling further for a leg that starts after earlier legs of the same tool call
 * have used part of the cap. It travels separately from `timeoutMs` on purpose: writing it
 * INTO `timeoutMs` would override a shorter construction-time or configured ceiling, which
 * every adapter treats as "the caller asked for exactly this".
 *
 * @param {(number|undefined)} timeoutMs  the ceiling the caller wanted (undefined = adapter default)
 * @param {Record<string, (string|undefined)>} [env]
 * @param {number} [remainingMs]  what is left of the cap for this leg
 * @returns {{timeoutMs:(number|undefined), clamped:boolean, budgetMs:(number|null)}}
 */
function clampToHostBudget(timeoutMs, env = process.env, remainingMs) {
  const wanted = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined;
  const budgetMs = hostBudgetMs(env);
  if (budgetMs === null) return { timeoutMs: wanted, clamped: false, budgetMs: null };
  let ceiling = Math.max(HOST_BUDGET_MIN_MS, budgetMs - HOST_BUDGET_MARGIN_MS);
  if (typeof remainingMs === "number" && remainingMs > 0) ceiling = Math.max(HOST_BUDGET_MIN_MS, Math.min(ceiling, remainingMs));
  if (wanted !== undefined && wanted <= ceiling) return { timeoutMs: wanted, clamped: false, budgetMs };
  return { timeoutMs: ceiling, clamped: true, budgetMs };
}

/**
 * One line that names the cap, the ceiling this leg actually got, and the fix. Only
 * meaningful after a clamped ceiling actually fired - callers gate on `clamped`.
 * @param {number} budgetMs
 * @param {number} [ceilingMs]  the ceiling applied to THIS leg (a later leg of the same call gets less than the cap); defaults to the cap-derived one
 * @returns {string}
 */
function hostBudgetHint(budgetMs, ceilingMs) {
  const ceiling = typeof ceilingMs === "number" && ceilingMs > 0 ? ceilingMs : Math.max(HOST_BUDGET_MIN_MS, budgetMs - HOST_BUDGET_MARGIN_MS);
  return `Host ${HOST_BUDGET_ENV}=${budgetMs} caps every MCP tool call, so deliberation clamped this ` +
    `provider's ceiling to ${ceiling} ms. The plugin manifest sets a per-server "timeout": 1800000 ` +
    `(and the same ${HOST_BUDGET_ENV} in the server env), which overrides the host cap - so this is ` +
    `an older plugin install or a host without per-server timeouts. Claude Code on the web: update the ` +
    `plugin (claude plugin update deliberation@antonbabenko) and start a new session; a manual .mcp.json ` +
    `install: add "timeout": 1800000 and "env": {"${HOST_BUDGET_ENV}": "1800000"} to the server entry.`;
}

/**
 * Append the hint to a timeout error that fired because of the clamp. Any other error,
 * or an unclamped ceiling, passes through untouched. Mutates and returns `err`.
 * @template {{code?: string, message: string}} E
 * @param {E} err
 * @param {{clamped:boolean, budgetMs:(number|null), timeoutMs?:(number|undefined)}} clamp
 * @returns {E}
 */
function annotateTimeout(err, clamp) {
  if (err && clamp && clamp.clamped && clamp.budgetMs !== null && err.code === "timeout") {
    err.message = `${err.message}. ${hostBudgetHint(clamp.budgetMs, clamp.timeoutMs)}`;
  }
  return err;
}

/**
 * What is left of the host's cap for a tool call that started at `startedAt`, or null when
 * the host declares none. Never below the floor: a caller that has used everything still
 * gets a ceiling that fails FAST as a timeout naming the cap, rather than 0 (= "no timeout").
 * @param {number} startedAt  Date.now() at tool entry
 * @param {Record<string, (string|undefined)>} [env]
 * @param {() => number} [now]
 * @returns {(number|null)}
 */
function remainingHostBudgetMs(startedAt, env = process.env, now = Date.now) {
  const budgetMs = hostBudgetMs(env);
  if (budgetMs === null) return null;
  return Math.max(HOST_BUDGET_MIN_MS, budgetMs - HOST_BUDGET_MARGIN_MS - (now() - startedAt));
}

/**
 * Stamp a request with what is left of the host's cap. A per-call clamp alone is not
 * enough: one tool call can run several provider legs in sequence (a retry after a
 * failure, the arbiter passes of a consensus round, the peer fan-out of a later round),
 * and each fresh leg would otherwise get the whole cap again - the host still kills the
 * call, just later. The value rides on `hostBudgetRemainingMs`, NOT on `timeoutMs`, so a
 * shorter configured ceiling still wins (see clampToHostBudget). No cap = no change.
 * @template {{timeoutMs?: number, hostBudgetRemainingMs?: number, [k: string]: any}} R
 * @param {R} req
 * @param {number} startedAt
 * @param {Record<string, (string|undefined)>} [env]
 * @param {() => number} [now]
 * @returns {R}
 */
function fitToHostBudget(req, startedAt, env = process.env, now = Date.now) {
  const remaining = remainingHostBudgetMs(startedAt, env, now);
  if (remaining === null) return req;
  return { ...req, hostBudgetRemainingMs: remaining };
}

/**
 * The starting budget for a call that arrived WITHOUT a stamp (the standalone bridges'
 * own tool handlers, where nothing upstream ran `fitToHostBudget`): under a cap it is the
 * cap-derived ceiling, so every later leg of that call (an upload, a fallback, a retry)
 * spends from one number instead of each starting the cap over. A stamp passes through.
 * @param {(number|undefined)} remainingMs
 * @param {Record<string, (string|undefined)>} [env]
 * @returns {(number|undefined)}
 */
function seedHostBudget(remainingMs, env = process.env) {
  if (typeof remainingMs === "number" && remainingMs > 0) return remainingMs;
  const budgetMs = hostBudgetMs(env);
  return budgetMs === null ? undefined : Math.max(HOST_BUDGET_MIN_MS, budgetMs - HOST_BUDGET_MARGIN_MS);
}

/**
 * What is left of a leg's budget after `sinceMs` of it has been spent - undefined stays
 * undefined (no cap). Floors at 1 so a spent budget still reaches the clamp (which applies
 * its own floor) rather than reading as "no budget".
 * @param {(number|undefined)} remainingMs
 * @param {number} sinceMs
 * @returns {(number|undefined)}
 */
function spendHostBudget(remainingMs, sinceMs) {
  return typeof remainingMs === "number" ? Math.max(1, remainingMs - sinceMs) : undefined;
}

/**
 * The Gemini bridge keeps `agy` alive past its SOFT timeout to drain a late answer. Under a
 * host cap the ceiling is hard - the host kills the call - so the drain would only run into
 * that kill (a clamped 55s soft timeout + the default 120s drain is a 175s call under a 60s
 * cap, and a later leg cannot even know how much of the cap earlier legs used). No cap = the
 * grace is returned unchanged; any cap = no drain.
 * @param {number} graceMs
 * @param {Record<string, (string|undefined)>} [env]
 * @returns {number}
 */
function graceWithinHostBudget(graceMs, env = process.env) {
  return hostBudgetMs(env) === null ? graceMs : 0;
}

module.exports = { hostBudgetMs, clampToHostBudget, hostBudgetHint, annotateTimeout, remainingHostBudgetMs, fitToHostBudget, seedHostBudget, spendHostBudget, graceWithinHostBudget, HOST_BUDGET_ENV, HOST_BUDGET_MARGIN_MS, HOST_BUDGET_MIN_MS };
