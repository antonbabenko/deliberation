// test/core-resolve-bin.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveCommand, shimMessage } = require("../core/resolve-bin.js");

// --- helpers -----------------------------------------------------------------
//
// Pure unit tests. Platform, env, and the filesystem probe are all injected, so the
// win32 branch is asserted on macOS/Linux - which is the only way this is testable at
// all: CI has no Windows runner (see issue #170).

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const NPM_DIR = "C:\\Users\\t\\AppData\\Roaming\\npm";
const SYS32 = "C:\\Windows\\System32";
const CODEX_ENTRY = { pkg: "@openai/codex", bin: "bin/codex.js" };

/** @param {string[]} present @returns {(p:string)=>boolean} */
function fakeExists(present) {
  const set = new Set(present);
  return (p) => set.has(p);
}

/** @param {string[]} dirs @param {string} [pathext] */
function winEnv(dirs, pathext) {
  return { PATH: dirs.join(";"), PATHEXT: pathext || ".COM;.EXE;.BAT;.CMD" };
}

// --- pass-through: no behaviour change off Windows ---------------------------

test("RB1: a non-win32 platform passes the bare name through untouched", () => {
  const r = resolveCommand("codex", {
    platform: "darwin",
    env: winEnv([NPM_DIR]),
    exists: fakeExists([`${NPM_DIR}\\codex.exe`]),
  });
  assert.deepEqual(r, { cmd: "codex", prefixArgs: [], shim: false });
});

test("RB2: a name containing a path separator passes through even on win32", () => {
  // The Gemini test harness points AGY_BIN at an absolute bash fixture; rewriting that
  // would break ~30 bridge tests, and an explicit path is the caller's business anyway.
  // Shim EXTENSIONS are the one exception (see RB8c); anything else is spawned as given.
  for (const explicit of ["/tmp/fixtures/fake-agy.sh", "C:\\tools\\agy.exe", "./local-codex"]) {
    const r = resolveCommand(explicit, { platform: "win32", env: winEnv([NPM_DIR]), exists: () => true });
    assert.deepEqual(r, { cmd: explicit, prefixArgs: [], shim: false }, explicit);
  }
});

test("RB3: win32 with nothing on PATH passes the bare name through (preserves today's ENOENT)", () => {
  const r = resolveCommand("codex", { platform: "win32", env: winEnv([NPM_DIR, SYS32]), exists: () => false });
  assert.deepEqual(r, { cmd: "codex", prefixArgs: [], shim: false });
});

// --- win32 resolution --------------------------------------------------------

test("RB4: a directly spawnable .exe resolves to its absolute path with no prefix args", () => {
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([NPM_DIR]),
    exists: fakeExists([`${NPM_DIR}\\codex.exe`]),
  });
  assert.deepEqual(r, { cmd: `${NPM_DIR}\\codex.exe`, prefixArgs: [], shim: false });
});

test("RB5: a .cmd shim plus a present npm entry resolves to node + the entry (the #170 fix)", () => {
  const entry = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([NPM_DIR]),
    exists: fakeExists([`${NPM_DIR}\\codex.cmd`, entry]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: NODE, prefixArgs: [entry], shim: false });
});

test("RB6: a .cmd shim with no npm entry on disk reports shim:true rather than a bare EINVAL", () => {
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([NPM_DIR]),
    exists: fakeExists([`${NPM_DIR}\\codex.cmd`]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: `${NPM_DIR}\\codex.cmd`, prefixArgs: [], shim: true });
});

test("RB7: with no npmEntry hint a shim is never bypassed (agy publishes no npm bin)", () => {
  const r = resolveCommand("agy", {
    platform: "win32",
    env: winEnv([NPM_DIR]),
    // An entry that WOULD match the codex layout is on disk; without the hint it is not probed.
    exists: fakeExists([`${NPM_DIR}\\agy.cmd`, `${NPM_DIR}\\node_modules\\agy\\bin\\agy.js`]),
    nodePath: NODE,
  });
  assert.deepEqual(r, { cmd: `${NPM_DIR}\\agy.cmd`, prefixArgs: [], shim: true });
});

test("RB8: PATH precedence is first-match-wins - an earlier shim with a usable entry beats a later .exe", () => {
  // libuv and `where` both take the first PATH entry. Preferring the .exe further down would
  // run a different install than the user's own shell resolves for the same command.
  const entry = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([NPM_DIR, SYS32]),
    exists: fakeExists([`${NPM_DIR}\\codex.cmd`, entry, `${SYS32}\\codex.exe`]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: NODE, prefixArgs: [entry], shim: false });
});

test("RB8b: a later .exe is still taken when the earlier shim has no entry point behind it", () => {
  // Only once the winning entry turns out to be unusable is scanning worth continuing -
  // running the wrong-order .exe beats failing outright.
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([NPM_DIR, SYS32]),
    exists: fakeExists([`${NPM_DIR}\\codex.cmd`, `${SYS32}\\codex.exe`]),
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: `${SYS32}\\codex.exe`, prefixArgs: [], shim: false });
});

test("RB8c: an explicitly named shim is recognised as one, with or without a path", () => {
  // Telling someone to "set CODEX_BIN" when CODEX_BIN is what they set is circular advice.
  for (const named of ["codex.cmd", `${NPM_DIR}\\codex.CMD`, "C:\\tools\\codex.ps1"]) {
    const r = resolveCommand(named, { platform: "win32", env: winEnv([NPM_DIR]), exists: () => false });
    assert.deepEqual(r, { cmd: named, prefixArgs: [], shim: true }, named);
  }
});

test("RB8d: an explicitly named shim is bypassed when its package entry is on disk", () => {
  const entry = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const r = resolveCommand(`${NPM_DIR}\\codex.cmd`, {
    platform: "win32",
    env: winEnv([NPM_DIR]),
    exists: fakeExists([entry]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: NODE, prefixArgs: [entry], shim: false });
});

test("RB8e: a local install's node_modules/.bin shim resolves up to the package entry", () => {
  const bin = "C:\\proj\\node_modules\\.bin";
  const entry = "C:\\proj\\node_modules\\@openai\\codex\\bin\\codex.js";
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([bin]),
    exists: fakeExists([`${bin}\\codex.cmd`, entry]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: NODE, prefixArgs: [entry], shim: false });
});

test("RB9: PATHEXT is honoured - an extension absent from it is not probed", () => {
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([NPM_DIR], ".EXE"),
    exists: fakeExists([`${NPM_DIR}\\codex.cmd`]),
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: "codex", prefixArgs: [], shim: false });
});

test("RB10: an unset PATHEXT falls back to the Windows default (.CMD still found)", () => {
  const r = resolveCommand("codex", {
    platform: "win32",
    env: { PATH: NPM_DIR },
    exists: fakeExists([`${NPM_DIR}\\codex.cmd`]),
    npmEntry: CODEX_ENTRY,
  });
  assert.equal(r.shim, true);
  assert.equal(r.cmd, `${NPM_DIR}\\codex.cmd`);
});

test("RB11: an empty or non-string name passes through without touching the filesystem", () => {
  let probed = false;
  const exists = () => { probed = true; return true; };
  assert.deepEqual(resolveCommand("", { platform: "win32", env: winEnv([NPM_DIR]), exists }), {
    cmd: "", prefixArgs: [], shim: false,
  });
  assert.equal(probed, false);
});

test("RB12: shimMessage names the shim path and the env-var escape hatch", () => {
  const msg = shimMessage("codex", `${NPM_DIR}\\codex.cmd`, "CODEX_BIN");
  assert.match(msg, /shell shim/);
  assert.ok(msg.includes(`${NPM_DIR}\\codex.cmd`));
  assert.match(msg, /CODEX_BIN/);
});

test("RB8f: a bare shim NAME is located on PATH before its entry point is probed", () => {
  // CODEX_BIN=codex.cmd names a shim without saying where it is. Probing the entry beside the
  // process's cwd would reject a perfectly good global install.
  const entry = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const r = resolveCommand("codex.cmd", {
    platform: "win32",
    env: winEnv([SYS32, NPM_DIR]),
    exists: fakeExists([`${NPM_DIR}\\codex.cmd`, entry]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: NODE, prefixArgs: [entry], shim: false });
});

test("RB8g: a later working install is taken when the first shim is broken - .exe or shim alike", () => {
  // A shim whose package is missing is a partial install. Scanning past it must not stop at
  // executables only: another npm install further down PATH is equally usable, and failing
  // while a working one exists would be the worse outcome. Out of shell order, deliberately.
  const A = "C:\\a", B = "C:\\b";
  const entryB = `${B}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([A, B]),
    exists: fakeExists([`${A}\\codex.cmd`, `${B}\\codex.cmd`, entryB]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: NODE, prefixArgs: [entryB], shim: false });

  // With nothing usable anywhere, the FIRST shim is what gets reported - the one the user
  // believes they are running, not whichever broken copy happened to be scanned last.
  const none = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([A, B]),
    exists: fakeExists([`${A}\\codex.cmd`, `${B}\\codex.cmd`]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(none, { cmd: `${A}\\codex.cmd`, prefixArgs: [], shim: true });
});

test("RB8h: a hand-written .cmd wrapper with no package beside it is skipped, not honoured", () => {
  // Documented limitation rather than a design choice: Node cannot execute ANY .cmd, so a custom
  // wrapper can never be run. Pinning it here so the day someone decides to honour wrappers, this
  // test is what they have to consciously change - the wrapper's flags/env silently do not apply.
  const TOOLS = "C:\\tools";
  const entry = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const r = resolveCommand("codex", {
    platform: "win32",
    env: winEnv([TOOLS, NPM_DIR]),
    exists: fakeExists([`${TOOLS}\\codex.cmd`, `${NPM_DIR}\\codex.cmd`, entry]),
    nodePath: NODE,
    npmEntry: CODEX_ENTRY,
  });
  assert.deepEqual(r, { cmd: NODE, prefixArgs: [entry], shim: false });
});
