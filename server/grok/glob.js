// @ts-nocheck -- legacy bridge; predates the strict typecheck gate (core-only). Opt-in is a separate pass.
"use strict";

function rejectBackslashes(pattern) {
  if (typeof pattern === "string" && pattern.includes("\\")) {
    throw new Error(`glob pattern "${pattern}" contains backslashes; v1 patterns are POSIX-only (use /)`);
  }
}

function patternToRegex(pattern) {
  let i = 0;
  let out = "";
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) { out += "\\["; i += 1; }
      else { out += pattern.slice(i, end + 1); i = end + 1; }
    } else if ("\\^$.|+(){}".includes(ch)) {
      out += "\\" + ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function compile(pattern) {
  rejectBackslashes(pattern);
  if (!pattern.includes("/")) {
    const re = patternToRegex(pattern);
    // Literal names (no wildcards) match at any depth; patterns match at root only
    const hasWildcard = pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
    const regex = hasWildcard ? new RegExp(`^${re}$`) : new RegExp(`(?:^|/)${re}$`);
    return { kind: "bare", re: regex };
  }
  return { kind: "path", re: new RegExp(`^${patternToRegex(pattern)}$`) };
}

function matchPattern(pattern, relPath) {
  return compile(pattern).re.test(relPath);
}

function matchAny(patterns, relPath) {
  for (const p of patterns) if (matchPattern(p, relPath)) return true;
  return false;
}

const fs = require("node:fs");
const path = require("node:path");

function walk(rootAbs, { include, exclude, maxFiles, maxBytes }) {
  const includeRes = include.map((p) => compile(p));
  const excludeRes = exclude.map((p) => compile(p));
  const files = [];
  let totalBytes = 0;

  function matches(res, rel) {
    for (const c of res) if (c.re.test(rel)) return true;
    return false;
  }

  function descend(absDir, relDir) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (_) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const ent of entries) {
      const absChild = path.join(absDir, ent.name);
      const relChild = (relDir ? relDir + "/" : "") + ent.name;
      const relPosix = relChild.replace(/\\/g, "/");

      if (ent.isSymbolicLink()) {
        let realTarget;
        try { realTarget = fs.realpathSync(absChild); } catch (_) { continue; }
        const relReal = path.relative(rootAbs, realTarget);
        if (relReal.startsWith("..") || path.isAbsolute(relReal)) continue;
        let st;
        try { st = fs.statSync(realTarget); } catch (_) { continue; }
        if (st.isDirectory()) continue;
        if (!st.isFile()) continue;
        if (matches(excludeRes, relPosix)) continue;
        if (!matches(includeRes, relPosix)) continue;
        files.push({ rel: relPosix, abs: realTarget, size: st.size });
        totalBytes += st.size;
      } else if (ent.isDirectory()) {
        if (matches(excludeRes, relPosix) || matches(excludeRes, relPosix + "/**")) continue;
        descend(absChild, relPosix);
      } else if (ent.isFile()) {
        if (matches(excludeRes, relPosix)) continue;
        if (!matches(includeRes, relPosix)) continue;
        let st;
        try { st = fs.statSync(absChild); } catch (_) { continue; }
        files.push({ rel: relPosix, abs: absChild, size: st.size });
        totalBytes += st.size;
      }
    }
  }

  descend(rootAbs, "");

  if (files.length > maxFiles) {
    throw new Error(`directory expansion selected ${files.length} files; exceeds maxFiles=${maxFiles}. Narrow include or raise the limit.`);
  }
  if (totalBytes > maxBytes) {
    throw new Error(`directory expansion selected ${totalBytes} bytes; exceeds maxBytes=${maxBytes}. Narrow include or raise the limit.`);
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel, "en"));
  return { files, totalBytes };
}

module.exports = { matchPattern, matchAny, rejectBackslashes, compile, walk };
