// test/core-host-budget.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hostBudgetMs, clampToHostBudget, hostBudgetHint, annotateTimeout, remainingHostBudgetMs, fitToHostBudget, seedHostBudget, spendHostBudget, graceWithinHostBudget, HOST_BUDGET_MARGIN_MS, HOST_BUDGET_MIN_MS } = require("../core/host-budget.js");

test("HB1: hostBudgetMs reads MCP_TOOL_TIMEOUT and treats garbage/zero/negative/empty as no cap", () => {
  assert.equal(hostBudgetMs({}), null);
  assert.equal(hostBudgetMs({ MCP_TOOL_TIMEOUT: "" }), null);
  assert.equal(hostBudgetMs({ MCP_TOOL_TIMEOUT: "abc" }), null);
  assert.equal(hostBudgetMs({ MCP_TOOL_TIMEOUT: "0" }), null);
  assert.equal(hostBudgetMs({ MCP_TOOL_TIMEOUT: "-5" }), null);
  assert.equal(hostBudgetMs({ MCP_TOOL_TIMEOUT: " 60000 " }), 60000);
  assert.equal(hostBudgetMs({ MCP_TOOL_TIMEOUT: "1800000.9" }), 1800000);
});

test("HB2: no cap -> the wanted ceiling passes through (undefined stays undefined for the adapter default)", () => {
  assert.deepEqual(clampToHostBudget(180000, {}), { timeoutMs: 180000, clamped: false, budgetMs: null });
  assert.deepEqual(clampToHostBudget(undefined, {}), { timeoutMs: undefined, clamped: false, budgetMs: null });
  assert.deepEqual(clampToHostBudget(0, {}), { timeoutMs: undefined, clamped: false, budgetMs: null });
});

test("HB3: under a cap, larger and undefined ceilings clamp to budget minus margin; smaller ones do not", () => {
  const env = { MCP_TOOL_TIMEOUT: "60000" };
  assert.deepEqual(clampToHostBudget(180000, env), { timeoutMs: 60000 - HOST_BUDGET_MARGIN_MS, clamped: true, budgetMs: 60000 });
  assert.deepEqual(clampToHostBudget(undefined, env), { timeoutMs: 60000 - HOST_BUDGET_MARGIN_MS, clamped: true, budgetMs: 60000 });
  assert.deepEqual(clampToHostBudget(30000, env), { timeoutMs: 30000, clamped: false, budgetMs: 60000 });
  assert.deepEqual(clampToHostBudget(55000, env), { timeoutMs: 55000, clamped: false, budgetMs: 60000 }, "exactly at the ceiling is fine");
});

test("HB3b: a remaining budget lowers the ceiling further, never raises it, never below the floor", () => {
  const env = { MCP_TOOL_TIMEOUT: "60000" };
  assert.deepEqual(clampToHostBudget(180000, env, 20000), { timeoutMs: 20000, clamped: true, budgetMs: 60000 });
  assert.deepEqual(clampToHostBudget(2000, env, 20000), { timeoutMs: 2000, clamped: false, budgetMs: 60000 }, "a shorter configured ceiling still wins");
  assert.deepEqual(clampToHostBudget(undefined, env, 20000), { timeoutMs: 20000, clamped: true, budgetMs: 60000 });
  assert.equal(clampToHostBudget(180000, env, 90000).timeoutMs, 55000, "remaining above the cap ceiling changes nothing");
  assert.equal(clampToHostBudget(180000, env, 10).timeoutMs, HOST_BUDGET_MIN_MS);
  assert.deepEqual(clampToHostBudget(180000, {}, 20000), { timeoutMs: 180000, clamped: false, budgetMs: null }, "no cap -> remaining is ignored");
});

test("HB4: the clamp never goes below the floor, even for an absurd cap", () => {
  assert.equal(clampToHostBudget(180000, { MCP_TOOL_TIMEOUT: "2000" }).timeoutMs, HOST_BUDGET_MIN_MS);
});

test("HB5: the hint names the env var, the value, the ceiling THIS leg got, and the web fix", () => {
  const h = hostBudgetHint(60000);
  assert.match(h, /MCP_TOOL_TIMEOUT=60000/);
  assert.match(h, /55000 ms/);
  assert.match(h, /Claude Code on the web/);
  assert.match(hostBudgetHint(60000, 20000), /clamped this provider's ceiling to 20000 ms/, "a later leg reports what it actually got, not the cap");
});

test("HB6: annotateTimeout appends the hint ONLY to a timeout that fired under a clamp", () => {
  const clamped = { clamped: true, budgetMs: 60000, timeoutMs: 55000 };
  const t = annotateTimeout({ code: "timeout", message: "Grok timed out after 55s" }, clamped);
  assert.match(t.message, /^Grok timed out after 55s\. Host MCP_TOOL_TIMEOUT=60000/);
  const later = annotateTimeout({ code: "timeout", message: "t" }, { clamped: true, budgetMs: 60000, timeoutMs: 20000 });
  assert.match(later.message, /ceiling to 20000 ms/);
  const net = annotateTimeout({ code: "network", message: "Network error: x" }, clamped);
  assert.equal(net.message, "Network error: x");
  const unclamped = annotateTimeout({ code: "timeout", message: "t" }, { clamped: false, budgetMs: 60000 });
  assert.equal(unclamped.message, "t");
  const noCap = annotateTimeout({ code: "timeout", message: "t" }, { clamped: false, budgetMs: null });
  assert.equal(noCap.message, "t");
});

test("HB7: remainingHostBudgetMs counts down from tool entry and never drops below the floor", () => {
  const env = { MCP_TOOL_TIMEOUT: "60000" };
  assert.equal(remainingHostBudgetMs(1000, {}, () => 50000), null, "no cap -> null");
  assert.equal(remainingHostBudgetMs(1000, env, () => 1000), 55000);
  assert.equal(remainingHostBudgetMs(1000, env, () => 21000), 35000);
  assert.equal(remainingHostBudgetMs(1000, env, () => 900000), HOST_BUDGET_MIN_MS);
});

test("HB8: fitToHostBudget stamps what is left on hostBudgetRemainingMs and leaves timeoutMs alone", () => {
  const env = { MCP_TOOL_TIMEOUT: "60000" };
  const req = /** @type {any} */ ({ prompt: "x", timeoutMs: 180000 });
  assert.equal(fitToHostBudget(req, 0, {}, () => 30000), req, "no cap -> the same object, nothing stamped");
  const fitted = fitToHostBudget(req, 0, env, () => 30000);
  assert.equal(fitted.hostBudgetRemainingMs, 25000);
  assert.equal(fitted.timeoutMs, 180000, "the wanted ceiling is NOT rewritten - a shorter configured one must still win downstream");
  assert.equal(fitToHostBudget(req, 0, env, () => 90000).hostBudgetRemainingMs, HOST_BUDGET_MIN_MS, "spent -> the floor, so the leg fails fast naming the cap");
});

test("HB9: graceWithinHostBudget disables the Gemini drain under any host cap and keeps it otherwise", () => {
  assert.equal(graceWithinHostBudget(120000, { MCP_TOOL_TIMEOUT: "60000" }), 0);
  assert.equal(graceWithinHostBudget(120000, { MCP_TOOL_TIMEOUT: "1800000" }), 0, "even a generous cap is hard; the drain would only run into the kill");
  assert.equal(graceWithinHostBudget(120000, {}), 120000, "no cap -> unchanged");
});

test("HB10: seedHostBudget starts an unstamped call at the cap ceiling and passes a stamp through; spendHostBudget counts down to 1", () => {
  const env = { MCP_TOOL_TIMEOUT: "60000" };
  assert.equal(seedHostBudget(undefined, env), 55000);
  assert.equal(seedHostBudget(20000, env), 20000, "a stamp from upstream wins");
  assert.equal(seedHostBudget(undefined, {}), undefined, "no cap -> nothing to spend");
  assert.equal(spendHostBudget(55000, 40000), 15000);
  assert.equal(spendHostBudget(55000, 90000), 1, "spent -> 1, which the clamp floors, never 'no budget'");
  assert.equal(spendHostBudget(undefined, 40000), undefined);
});
