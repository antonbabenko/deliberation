// test/mcp-bundle.test.js - the published npm bundle (esbuild, as in server/mcp prepack) still
// starts: the stdio MCP server answers, and `dashboard` serves the UI copied to dashboard-ui/.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const repo = path.join(__dirname, "..");
/** @type {any} */ let esbuild = null;
try {
  esbuild = require("esbuild");
} catch {
  // devDependency missing: skip below
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "delib-bundle-"));
const dist = path.join(root, "dist");

/** Same build as the `prepack` script, into a temp dir: bundle, then copy the UI next to it. */
function build() {
  esbuild.buildSync({
    entryPoints: [path.join(repo, "server/mcp/index.js")],
    bundle: true, platform: "node", target: "node18", format: "cjs",
    outfile: path.join(dist, "index.js"), logLevel: "silent",
  });
  fs.cpSync(path.join(repo, "server/dashboard/ui"), path.join(dist, "dashboard-ui"), { recursive: true });
}

/** @param {import("node:child_process").ChildProcess} child @returns {Promise<string>} */
function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`no output in 10s; stderr: ${err}`)), 10000);
    child.stderr?.on("data", (d) => { err += d; });
    child.stdout?.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) { clearTimeout(timer); resolve(buf.slice(0, i)); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited ${code}; stderr: ${err}`)); });
  });
}

/** @param {string} url @param {Record<string, string>} [headers] */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

test("prepack copies the UI to the path the bundle serves from", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "server/mcp/package.json"), "utf8"));
  assert.match(pkg.scripts.prepack, /cpSync\('\.\.\/dashboard\/ui','dist\/dashboard-ui'/);
});

test("bundle: stdio MCP server answers initialize", { skip: !esbuild && "esbuild not installed" }, async () => {
  build();
  const env = { ...process.env, DELIBERATION_CONFIG: path.join(root, "none.json"), XDG_CACHE_HOME: path.join(root, "cache") };
  const child = spawn(process.execPath, [path.join(dist, "index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const line = firstLine(child);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    assert.equal(JSON.parse(await line).result.serverInfo.name, "deliberation-mcp");
  } finally {
    child.kill();
  }
});

test("bundle: `dashboard` prints its URL and serves the copied UI", { skip: !esbuild && "esbuild not installed" }, async () => {
  if (!fs.existsSync(path.join(dist, "index.js"))) build();
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, dashboard: { enabled: true } }));
  const env = { ...process.env, DELIBERATION_CONFIG: configPath, XDG_CACHE_HOME: path.join(root, "cache"), DELIBERATION_RUNS: path.join(root, "runs") };
  const child = spawn(process.execPath, [path.join(dist, "index.js"), "dashboard", "--no-open", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const m = /^Deliberation dashboard: (http:\/\/127\.0\.0\.1:(\d+))\/\?t=([0-9a-f]{64})$/.exec(await firstLine(child));
    assert.ok(m, "URL line");
    const [, base, , token] = m;
    const first = /** @type {any} */ (await get(`${base}/?t=${token}`));
    assert.equal(first.status, 200);
    const page = /** @type {any} */ (await get(`${base}/`, { Cookie: `dlb_dash=${token}` }));
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/i);
  } finally {
    child.kill();
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
