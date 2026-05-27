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

module.exports = { matchPattern, matchAny, rejectBackslashes, compile };
