"use strict";
// The `doctor` MCP tool: the read-only health check behind /deliberation:doctor, callable
// from any host that runs only the npx server. Reads files and env, writes nothing.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { buildServer } = require("../server/mcp/index.js");
const { runDoctor, AGY_TERMS_WARNING } = require("../server/mcp/doctor.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-doctor-"));
}
/** @param {string} name @param {object} [extra] @param {object} [health] */
function fake(name, extra = {}, health = { ok: true }) {
  return { name, capabilities: { canImplement: false, fileUpload: false, multiTurn: false }, async health() { return health; }, async ask() { throw new Error("doctor must not call ask"); }, ...extra };
}
/** @param {any} srv @param {any} [args] */
async function callDoctor(srv, args) {
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "doctor", arguments: args || {} } });
  return JSON.parse(res.result.content[0].text);
}
/** @param {any} config */
function setup(config) {
  const dir = tmpdir();
  const configPath = path.join(dir, "config.json");
  if (config !== undefined) fs.writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
  const sessionsDir = path.join(dir, "sessions");
  // The server config points analyze at a temp debug log, so no test reads the real one.
  const getConfig = () => ({ debug: { path: path.join(dir, "debug.jsonl") } });
  return { dir, configPath, sessionsDir, getConfig };
}
/** @param {any} out @param {string} check */
const byCheck = (out, check) => out.findings.filter((/** @type {any} */ f) => f.check === check);

test("D1: doctor is advertised in tools/list with readOnlyHint", async () => {
  const srv = buildServer({ providers: [], getConfig: () => ({}) });
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = res.result.tools.find((/** @type {any} */ t) => t.name === "doctor");
  assert.ok(tool, "doctor tool present");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
});

test("D2: doctor returns the findings structure for a temp config", async () => {
  const { configPath, sessionsDir, getConfig } = setup({ version: 1, sessions: { persist: true }, debug: { enabled: false } });
  fs.mkdirSync(sessionsDir);
  fs.writeFileSync(path.join(sessionsDir, "a.json"), "{}");
  const srv = buildServer({ providers: [fake("grok"), fake("openrouter", {}, { ok: false, reason: "OPENROUTER_API_KEY unset" })], getConfig, configPath, sessionsDir });
  const out = await callDoctor(srv, { shellSessionsDir: sessionsDir });
  assert.ok(Array.isArray(out.findings));
  for (const f of out.findings) {
    assert.equal(typeof f.check, "string");
    assert.ok(["ok", "warn", "fail", "info"].includes(f.status), f.status);
    assert.equal(typeof f.message, "string");
  }
  assert.deepEqual(out.paths, { config: configPath, sessions: sessionsDir });
  assert.equal(byCheck(out, "config")[0].status, "ok");
  assert.equal(byCheck(out, "sessions.persist")[0].status, "ok");
  assert.equal(byCheck(out, "debug.enabled")[0].status, "warn");
  assert.equal(byCheck(out, "provider:grok")[0].status, "ok");
  assert.match(byCheck(out, "provider:openrouter")[0].message, /OPENROUTER_API_KEY unset/);
  assert.match(byCheck(out, "sessions-dir")[0].message, /1 record/);
  assert.equal(byCheck(out, "sessions-path")[0].status, "ok");
  const total = out.summary.ok + out.summary.warn + out.summary.fail + out.summary.info;
  assert.equal(total, out.findings.length);
});

test("D3: an invalid config gives a finding, not a crash", async () => {
  for (const bad of ["{ not json", JSON.stringify({ version: 1, routing: { maxFanout: 0 } })]) {
    const { configPath, sessionsDir, getConfig } = setup(bad);
    const srv = buildServer({ providers: [], getConfig, configPath, sessionsDir });
    const out = await callDoctor(srv);
    const cfg = byCheck(out, "config")[0];
    assert.equal(cfg.status, "fail");
    assert.ok(out.summary.fail >= 1);
  }
  const { configPath, sessionsDir, getConfig } = setup({ version: 1, sesions: { persist: true } });
  const out = await callDoctor(buildServer({ providers: [], getConfig, configPath, sessionsDir }));
  assert.ok(byCheck(out, "config").some((/** @type {any} */ f) => f.status === "warn" && /"sesions"/.test(f.message)), "unknown key flagged");
  const missing = setup(undefined);
  const out2 = await callDoctor(buildServer({ providers: [], getConfig: missing.getConfig, configPath: missing.configPath, sessionsDir: missing.sessionsDir }));
  assert.equal(byCheck(out2, "config")[0].status, "warn");
});

test("D4: the agy terms warning appears only when agy is the Gemini path", async () => {
  /** @param {any} config @param {any} gemini */
  async function agyWarned(config, gemini) {
    const { configPath, sessionsDir } = setup(config);
    const out = await runDoctor({ providers: gemini ? [gemini] : [], configPath, sessionsDir, env: {} });
    return out.findings.some((/** @type {any} */ f) => f.check === "gemini-agy-terms" && f.status === "warn" && f.message === AGY_TERMS_WARNING);
  }
  const agy = fake("gemini", { transport: "agy" });
  assert.equal(await agyWarned({ version: 1 }, agy), true, "enabled + agy + CLI present");
  assert.equal(await agyWarned({ version: 1, providers: { gemini: { enabled: false } } }, agy), false, "disabled");
  assert.equal(await agyWarned({ version: 1 }, fake("gemini", { transport: "agy" }, { ok: false, reason: "agy not on PATH" })), false, "agy CLI missing");
  assert.equal(await agyWarned({ version: 1 }, fake("gemini")), false, "a non-agy Gemini transport");
  assert.equal(await agyWarned({ version: 1 }, null), false, "no Gemini provider");
});

test("D5: sessions path drift is a failure; a codex with no login is a warning with the login fix", async () => {
  const { configPath, sessionsDir } = setup({ version: 1 });
  const codex = fake("codex", {}, { ok: true, needsLogin: true });
  const out = await runDoctor({ providers: [codex], configPath, sessionsDir, shellSessionsDir: "/elsewhere/sessions", env: { PATH: "" }, home: tmpdir() });
  assert.equal(byCheck(out, "sessions-path")[0].status, "fail");
  const c = byCheck(out, "provider:codex")[0];
  assert.equal(c.status, "warn");
  assert.match(c.fix, /codex-login/);
});

test("D6: session records without per-opinion verdicts give an info finding, only then", async () => {
  const { configPath, sessionsDir } = setup({ version: 1 });
  /** @param {any} analyzeMeta */
  const has = async (analyzeMeta) => byCheck(await runDoctor({ providers: [], configPath, sessionsDir, env: {}, analyzeMeta }), "sessions-verdicts").length;
  assert.equal(await has({ sessionsRead: 3, agreementVotes: 0 }), 1);
  assert.equal(await has({ sessionsRead: 3, agreementVotes: 2 }), 0);
  assert.equal(await has({ sessionsRead: 0, agreementVotes: 0 }), 0);
  assert.equal(await has(null), 0);
});
