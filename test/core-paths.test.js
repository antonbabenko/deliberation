"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { resolveConfigPath, resolveGrokCachePath } = require("../core/paths.js");

// --- helpers -----------------------------------------------------------------

/** Make an isolated temp HOME; never touches the real ~/.claude. */
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-paths-"));
}

function rmrf(/** @type {string} */ dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function configNewPath(/** @type {string} */ home) {
  return path.join(home, ".claude", "deliberation", "config.json");
}
function grokNewPath(/** @type {string} */ home) {
  return path.join(home, ".claude", "cache", "deliberation", "grok-files.json");
}

// --- tests -------------------------------------------------------------------

// CP1: no env -> returns the deliberation config path, creates nothing.
test("CP1: no env -> returns ~/.claude/deliberation/config.json, no file created", () => {
  const home = makeHome();
  try {
    const got = resolveConfigPath({ home, env: {} });
    assert.equal(got, configNewPath(home));
    assert.equal(fs.existsSync(configNewPath(home)), false);
  } finally {
    rmrf(home);
  }
});

// CP2: DELIBERATION_CONFIG set -> returned verbatim, deliberation path untouched.
test("CP2: DELIBERATION_CONFIG wins verbatim", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "custom", "my-config.json");
    const got = resolveConfigPath({ home, env: { DELIBERATION_CONFIG: override } });
    assert.equal(got, override);
    assert.equal(fs.existsSync(configNewPath(home)), false);
  } finally {
    rmrf(home);
  }
});

// CP3: empty DELIBERATION_CONFIG -> falls through to the deliberation config path.
test("CP3: empty DELIBERATION_CONFIG falls through to deliberation config path", () => {
  const home = makeHome();
  try {
    const got = resolveConfigPath({ home, env: { DELIBERATION_CONFIG: "" } });
    assert.equal(got, configNewPath(home));
  } finally {
    rmrf(home);
  }
});

// CP4: grok cache -> always the deliberation cache path, creates nothing.
test("CP4: grok cache -> ~/.claude/cache/deliberation/grok-files.json, no file created", () => {
  const home = makeHome();
  try {
    const got = resolveGrokCachePath({ home });
    assert.equal(got, grokNewPath(home));
    assert.equal(fs.existsSync(grokNewPath(home)), false);
  } finally {
    rmrf(home);
  }
});
