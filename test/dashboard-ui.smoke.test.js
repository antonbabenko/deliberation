// test/dashboard-ui.smoke.test.js - one browser smoke test of the live dashboard UI.
// Playwright is not a repo dependency: it is resolved from a local install or the global
// npm root, and the test is skipped with a message when neither has it.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { createDashboardServer } = require("../server/dashboard/server.js");
const { createRunIndex } = require("../server/dashboard/runs.js");
const { createTailer } = require("../server/dashboard/tail.js");

/** @returns {any} */
function resolvePlaywright() {
  const candidates = ["playwright", "/opt/node22/lib/node_modules/playwright"];
  try {
    candidates.push(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), "playwright"));
  } catch {
    // no npm on PATH
  }
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      // try the next one
    }
  }
  return null;
}

/** @param {any} chromium */
async function launch(chromium) {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  }
}

test("UI2: live graph node states follow journal appends", async (t) => {
  const pw = resolvePlaywright();
  if (!pw) return t.skip("playwright not resolvable (local or global npm root); smoke test skipped");
  let browser;
  try {
    browser = await launch(pw.chromium);
  } catch (e) {
    return t.skip(`chromium could not launch: ${String(/** @type {any} */ (e).message || e).split("\n")[0]}`);
  }

  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "delib-dashui-"));
  const token = "b".repeat(64);
  const tailer = createTailer({ runsDir, sweepMs: 100 });
  const server = createDashboardServer({
    port: 0,
    token,
    uiDir: path.join(__dirname, "..", "server", "dashboard", "ui"),
    index: createRunIndex({ runsDir, isAlive: () => true }),
    tailer,
    getConfig: () => ({ dashboard: { enabled: true, capture: "metadata", showPII: false } }),
    health: async () => ({ providers: [] }),
    stats: () => ({ daily: [] }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    server.close();
  });

  const page = await browser.newPage();
  /** @type {string[]} */
  const pageErrors = [];
  page.on("pageerror", (/** @type {Error} */ e) => pageErrors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${port}/?t=${token}`);
  await page.waitForSelector("[data-view='live']");

  const file = path.join(runsDir, "cs-smoke.jsonl");
  let seq = 0;
  const append = (/** @type {Record<string, unknown>} */ f) =>
    fs.appendFileSync(file, JSON.stringify({ v: 1, runId: "cs-smoke", at: Date.now(), seq: seq++, ...f }) + "\n");
  append({ kind: "run_start", tool: "consensus-step", workflow: "consensus-step", providers: ["codex", "grok"], pid: process.pid });
  append({ kind: "call_start", callId: "c1", provider: "codex", model: null, role: "peer", round: 1 });
  await page.waitForSelector("[data-node='peers'][data-state='running']", { timeout: 3000 });

  append({ kind: "call_end", callId: "c1", provider: "codex", model: "gpt-5", ms: 40, isError: false });
  append({ kind: "run_end", status: "converged", rounds: 1, droppedProviders: [] });
  await page.waitForSelector("[data-node='converged'][data-state='succeeded']", { timeout: 3000 });
  assert.deepEqual(pageErrors, []);
});
