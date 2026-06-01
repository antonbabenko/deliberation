#!/usr/bin/env node
"use strict";
/**
 * Dev-only generator for the NATIVE per-host plugin artifacts.
 *
 * Single source of truth -> many hosts. Reads the canonical repo sources
 * (version.json, prompts/*.md, AGENTS.md, examples/*.md) and emits each host's
 * native files so they never drift from the Claude Code plugin surface.
 *
 * Each host is a self-contained module under scripts/hosts/<host>.js exporting
 * `build(ctx) -> { repoRelativePath: content }`. Register it in HOSTS below.
 * This script is NEVER imported by the runtime or the esbuild bundle - it is a
 * build-time generator like scripts/sync-prompts.js. The files it writes are
 * committed; CI runs it with --check and fails on any drift.
 *
 * Usage:
 *   node scripts/sync-hosts.js          # write all host artifacts
 *   node scripts/sync-hosts.js --check  # generate in-memory, exit 1 on any drift
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

/** Registered host generators. Add a host by dropping a module here. */
const HOSTS = [
  require("./hosts/cursor"),
  require("./hosts/codex"),
  require("./hosts/kiro"),
  require("./hosts/opencode"),
];

/** @returns {string} the semver string from version.json (the single SSOT). */
function readVersion() {
  const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "version.json"), "utf8")).version;
  if (typeof v !== "string" || !v) throw new Error("version.json: missing version string");
  return v;
}

/**
 * Reject an output path that is absolute, uses backslashes, or escapes the repo
 * via `..` - a generated artifact must always be a forward-slash repo-relative
 * path. Guards against a buggy host module writing outside the tree.
 * @param {string} rel @param {string} hostId
 */
function assertSafeRel(rel, hostId) {
  // Reject absolute, backslash, and any "..", "." or empty segment. The empty/dot
  // checks also catch "", ".", "a/./b" and trailing slashes (which would resolve
  // to a directory and crash the write, or alias two distinct keys to one file).
  const unsafeSeg = (seg) => seg === ".." || seg === "." || seg === "";
  if (path.isAbsolute(rel) || rel.includes("\\") || rel.split("/").some(unsafeSeg)) {
    throw new Error(`host '${hostId}' produced an unsafe output path: ${rel}`);
  }
}

/**
 * Claude-Code-ONLY tokens that are broken/meaningless on other hosts. A generated
 * host artifact must contain none of these (the plain word "Claude" is allowed as
 * cross-host context). Sources like rules/*.md keep these tokens for Claude Code;
 * the per-host generators must strip/transform them (e.g. kiro.js hostNeutralTriggers).
 */
const CLAUDE_ONLY_TOKENS = [
  /\$\{CLAUDE_PLUGIN_ROOT\}/, // Claude plugin env var
  /\.claude\//, // Claude config/cache paths
  /\/deliberation:/, // Claude slash-command namespace (/deliberation:ask-gpt, ...)
  /mcp__deliberation/, // Claude MCP tool ids (mcp__deliberation__ask-all, mcp__deliberation-codex__codex, ...)
  /reload-plugins/, // Claude /reload-plugins guidance
  /plugins\/cache\//, // Claude plugin cache globs
];

/**
 * Throw if a generated artifact leaks a Claude-Code-only token (see CLAUDE_ONLY_TOKENS).
 * @param {string} rel @param {string} content @param {string} hostId
 */
function assertHostClean(rel, content, hostId) {
  for (const re of CLAUDE_ONLY_TOKENS) {
    if (re.test(content)) {
      throw new Error(
        `host '${hostId}' artifact ${rel} leaks a Claude-Code-only reference (${re}); ` +
          "host artifacts must be host-neutral - strip/transform it in the host generator."
      );
    }
  }
}

/**
 * Build every host artifact as a { repoRelativePath: content } map. Throws if a
 * host emits an unsafe path or two hosts claim the same output path.
 * @returns {Record<string,string>}
 */
function buildArtifacts() {
  const ctx = { repoRoot: REPO_ROOT, version: readVersion() };
  /** @type {Record<string,string>} */
  const all = {};
  for (const build of HOSTS) {
    const files = build(ctx);
    for (const [rel, content] of Object.entries(files)) {
      assertSafeRel(rel, build.id);
      assertHostClean(rel, content, build.id);
      if (Object.prototype.hasOwnProperty.call(all, rel)) {
        throw new Error(`host '${build.id}' collides on output path: ${rel}`);
      }
      all[rel] = content;
    }
  }
  return all;
}

/** Read a file as LF text (or null if absent) so the drift compare ignores CRLF checkout. */
function readDiskLF(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
}

function main() {
  const check = process.argv.includes("--check");
  const artifacts = buildArtifacts();
  /** @type {string[]} */
  const drifted = [];

  for (const [rel, content] of Object.entries(artifacts)) {
    const file = path.join(REPO_ROOT, rel);
    if (check) {
      if (readDiskLF(file) !== content) drifted.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  if (check) {
    if (drifted.length) {
      process.stderr.write(
        "host artifacts out of date - run `node scripts/sync-hosts.js`:\n" +
          drifted.map((r) => `  - ${r}`).join("\n") +
          "\n"
      );
      process.exit(1);
    }
    process.stdout.write(`host artifacts up to date (${Object.keys(artifacts).length} files)\n`);
    return;
  }
  process.stdout.write(`wrote ${Object.keys(artifacts).length} host artifacts\n`);
}

if (require.main === module) main();

module.exports = { buildArtifacts, readVersion, readDiskLF, HOSTS, CLAUDE_ONLY_TOKENS };
