"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const REPO_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(REPO_ROOT, "server/gemini/index.js");
const FIXTURES = path.join(__dirname, "fixtures");

function startBridge({ env = {}, fakeBin = "fake-agy.sh" } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-bin-"));
  // Bridge spawns the binary named by AGY_BIN; point it straight at the fixture.
  const agyBin = path.join(FIXTURES, fakeBin);
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      AGY_BIN: agyBin,
      CDG_ARGV_LOG: path.join(tmpDir, "argv.log"),
      // Keep the integration suite hermetic + cross-platform: the macOS sandbox-exec
      // wrapper denies workspace writes, which would block the fixture's own argv log.
      // Tests that exercise the wrapper opt back in by overriding this via `env`.
      DELIBERATION_DISABLE_OS_SANDBOX: "1",
      // The fixtures print short sentinels ("FAKE AGY OK") to assert PLUMBING, not answer
      // length, so the non-answer floor is off by default here. Tests that exercise the
      // floor opt back in by overriding this via `env`.
      GEMINI_MIN_ANSWER_CHARS: "0",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.argvLog = path.join(tmpDir, "argv.log");
  child.tmpDir = tmpDir;
  return child;
}

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function collectResponses(child) {
  return new Promise((resolve) => {
    let buf = "";
    const out = [];
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (e) { out.push({ _parseError: e.message, raw: line }); }
      }
    });
    child.on("close", () => {
      if (buf.trim()) { try { out.push(JSON.parse(buf)); } catch (_) {} }
      resolve(out);
    });
  });
}

function readArgv(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath);
  // Each invocation: NUL-separated args terminated by '\n'.
  const invocations = [];
  let cur = [];
  let acc = "";
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === 0x00) { cur.push(acc); acc = ""; }
    else if (b === 0x0a) { invocations.push(cur); cur = []; }
    else acc += String.fromCharCode(b);
  }
  if (acc || cur.length) invocations.push([...cur, acc].filter(Boolean));
  return invocations;
}

module.exports = { startBridge, send, collectResponses, readArgv };
