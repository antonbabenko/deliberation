// @ts-nocheck -- legacy bridge; predates the strict typecheck gate (core-only). Opt-in is a separate pass.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const glob = require("../grok/glob.js");

const DEFAULT_PER_FILE_CAP = Number(process.env.OPENROUTER_INLINE_MAX_BYTES) > 0
  ? Math.floor(Number(process.env.OPENROUTER_INLINE_MAX_BYTES)) : 256 * 1024;
const DEFAULT_TOTAL_CAP = Number(process.env.OPENROUTER_INLINE_MAX_TOTAL_BYTES) > 0
  ? Math.floor(Number(process.env.OPENROUTER_INLINE_MAX_TOTAL_BYTES)) : 1024 * 1024;

// Same safe directory excludes the Grok bridge uses (kept local to avoid coupling).
const DEFAULT_EXCLUDE = [
  ".git", "node_modules", "**/dist/**", "**/build/**", "**/.venv/**", "**/venv/**",
  "**/__pycache__/**", "**/target/**", "**/vendor/**", "**/*.lock",
  "**/*.tfstate*", "**/.env", "**/.env.local", "**/.ssh/**", "**/*.pem", "**/*.key",
];

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

function resolveUnderRoots(p, roots) {
  const isAbs = path.isAbsolute(p);
  for (const root of roots) {
    const abs = isAbs ? p : path.join(root, p);
    try {
      const realRoot = fs.realpathSync(root);
      const realAbs = fs.realpathSync(abs);
      const rel = path.relative(realRoot, realAbs);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return realAbs;
    } catch (_) { /* try next root */ }
  }
  return null;
}

// Turn a `files` param into { blocks: string[], notes: string[] }.
// blocks are "=== <name> ===\n<content>" text segments; notes record skips.
function inlineFiles(files, opts = {}) {
  const roots = (opts.roots && opts.roots.length) ? opts.roots : [process.cwd()];
  const perFileCap = opts.perFileCap != null ? opts.perFileCap : DEFAULT_PER_FILE_CAP;
  const totalCap = opts.totalCap != null ? opts.totalCap : DEFAULT_TOTAL_CAP;
  const blocks = [];
  const notes = [];
  let total = 0;

  function addFile(abs, label) {
    let st;
    try { st = fs.statSync(abs); } catch (e) { notes.push(`${label}: skipped (stat error: ${e.message})`); return; }
    if (st.size > perFileCap) { notes.push(`${label}: skipped (${st.size} bytes > per-file cap ${perFileCap})`); return; }
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) { notes.push(`${label}: skipped (read error: ${e.message})`); return; }
    if (!isProbablyText(buf)) { notes.push(`${label}: skipped (binary)`); return; }
    if (total + buf.length > totalCap) { notes.push(`${label}: omitted (aggregate inline budget ${totalCap} bytes exceeded)`); return; }
    total += buf.length;
    blocks.push(`=== ${label} ===\n${buf.toString("utf8")}`);
  }

  for (const entry of files || []) {
    if (entry.file_id !== undefined || entry.file_url !== undefined) {
      throw new Error("file_id / file_url are not supported by the OpenRouter bridge (text-inline only)");
    }
    if (entry.path) {
      const abs = resolveUnderRoots(entry.path, roots);
      if (!abs) { notes.push(`${entry.path}: skipped (not found under roots)`); continue; }
      addFile(abs, path.basename(entry.path));
    } else if (entry.dir) {
      const absDir = resolveUnderRoots(entry.dir, roots);
      if (!absDir) { notes.push(`${entry.dir}: skipped (dir not found under roots)`); continue; }
      const exclude = entry.excludeReset === true ? (entry.exclude || []) : [...DEFAULT_EXCLUDE, ...(entry.exclude || [])];
      let walked;
      try {
        ({ files: walked } = glob.walk(absDir, {
          include: entry.include || ["**/*"],
          exclude,
          maxFiles: entry.maxFiles || 50,
          maxBytes: entry.maxBytes || 128 * 1024 * 1024,
        }));
      } catch (e) {
        notes.push(`${entry.dir}: skipped (${e.message})`);
        continue;
      }
      for (const w of walked) addFile(w.abs, path.relative(absDir, w.abs) || path.basename(w.abs));
    }
  }
  return { blocks, notes };
}

module.exports = { inlineFiles, DEFAULT_PER_FILE_CAP, DEFAULT_TOTAL_CAP };
