"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const RELOAD_SCRIPT = path.join(REPO_ROOT, "scripts", "commands", "reload-mcp.sh");
const RELOAD_CMD_MD = path.join(REPO_ROOT, "commands", "reload-mcp.md");

test("reload-mcp.sh: --help exits 0 with usage instructions", () => {
  const res = spawnSync("bash", [RELOAD_SCRIPT, "--help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes("Usage: reload-mcp.sh [options]"));
  assert.ok(res.stdout.includes("--dry-run"));
  assert.ok(res.stdout.includes("--no-update-agents"));
  assert.ok(res.stdout.includes("--no-restart-dashboard"));
  assert.ok(res.stdout.includes("--force-workers"));
});

test("reload-mcp.sh: unknown option exits 1", () => {
  const res = spawnSync("bash", [RELOAD_SCRIPT, "--unrecognized-option-test"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes("Unknown option"));
});

test("reload-mcp.sh: --dry-run completes without crashing or signaling", () => {
  const res = spawnSync("bash", [RELOAD_SCRIPT, "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes("=== Deliberation MCP Reload & Host Audit ==="));
  assert.ok(res.stdout.includes("DRY RUN"));
  assert.ok(res.stdout.includes("Audit Summary"));
});

test("reload-mcp.sh: --no-update-agents skips agent updates section", () => {
  const res = spawnSync("bash", [RELOAD_SCRIPT, "--dry-run", "--no-update-agents"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("• Updating Supported Agent Harnesses..."));
  assert.ok(res.stdout.includes("Audit Summary"));
});

test("commands/reload-mcp.md: command manifest exists with valid frontmatter", () => {
  assert.ok(fs.existsSync(RELOAD_CMD_MD), "missing commands/reload-mcp.md");
  const content = fs.readFileSync(RELOAD_CMD_MD, "utf8");
  assert.match(content, /^---\nname: reload-mcp\n/);
  assert.match(content, /allowed-tools:.*Bash/);
  assert.match(content, /reload-mcp\.sh/);
});

test("host artifacts: reload-mcp artifacts exist across hosts", () => {
  const hostFiles = [
    path.join(REPO_ROOT, "plugins/deliberation/skills/reload-mcp/SKILL.md"),
    path.join(REPO_ROOT, ".agents/skills/reload-mcp/SKILL.md"),
    path.join(REPO_ROOT, ".gemini/skills/reload-mcp/SKILL.md"),
    path.join(REPO_ROOT, ".opencode/commands/reload-mcp.md"),
  ];

  for (const f of hostFiles) {
    assert.ok(fs.existsSync(f), `missing host file: ${f}`);
    const content = fs.readFileSync(f, "utf8");
    assert.match(content, /name: "reload-mcp"/);
    assert.match(content, /reload-mcp\.sh/);
  }
});
