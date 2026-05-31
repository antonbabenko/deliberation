"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolveConfigPath, resolveGrokCachePath } = require("../core/paths.js");

// --- helpers -----------------------------------------------------------------
//
// Pure unit tests: the resolver does no FS access. A fixed HOME, a fake env, and
// a fixed platform fully determine the result.

const HOME = "/home/tester";

function canonicalConfig(/** @type {string} */ home) {
  return path.join(home, ".config", "deliberation", "config.json");
}
function canonicalCache(/** @type {string} */ home) {
  return path.join(home, ".cache", "deliberation", "grok-files.json");
}

// --- config: env override ----------------------------------------------------

test("CP1: DELIBERATION_CONFIG wins verbatim", () => {
  const override = "/somewhere/custom/my-config.json";
  const got = resolveConfigPath({
    home: HOME,
    env: { DELIBERATION_CONFIG: override },
    platform: "linux",
  });
  assert.equal(got, override);
});

test("CP2: empty DELIBERATION_CONFIG falls through to canonical", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: { DELIBERATION_CONFIG: "" },
    platform: "linux",
  });
  assert.equal(got, canonicalConfig(HOME));
});

// --- config: canonical default -----------------------------------------------

test("CP3: no override -> canonical XDG config", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: {},
    platform: "linux",
  });
  assert.equal(got, canonicalConfig(HOME));
});

test("CP4: XDG_CONFIG_HOME relocates the canonical config", () => {
  const xdg = "/xdg/cfg";
  const got = resolveConfigPath({
    home: HOME,
    env: { XDG_CONFIG_HOME: xdg },
    platform: "linux",
  });
  assert.equal(got, path.join(xdg, "deliberation", "config.json"));
});

// --- config: windows shape ---------------------------------------------------

test("CP5: win32 uses APPDATA (Roaming) for canonical config", () => {
  const appData = "C:\\Users\\tester\\AppData\\Roaming";
  const got = resolveConfigPath({
    home: "C:\\Users\\tester",
    env: { APPDATA: appData },
    platform: "win32",
  });
  assert.equal(got, path.join(appData, "deliberation", "config.json"));
});

test("CP6: win32 without APPDATA falls back to ~/AppData/Roaming", () => {
  const home = "C:\\Users\\tester";
  const got = resolveConfigPath({
    home,
    env: {},
    platform: "win32",
  });
  assert.equal(got, path.join(home, "AppData", "Roaming", "deliberation", "config.json"));
});

// --- config: relative XDG base must be ignored (XDG spec) ---------------------

test("CP7: relative XDG_CONFIG_HOME is ignored -> canonical default (~/.config)", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: { XDG_CONFIG_HOME: "relative/cfg" },
    platform: "linux",
  });
  assert.equal(got, canonicalConfig(HOME));
});

test("CP8: win32 relative APPDATA is ignored -> ~/AppData/Roaming fallback", () => {
  const home = "C:\\Users\\tester";
  const got = resolveConfigPath({
    home,
    env: { APPDATA: "relative\\roaming" },
    platform: "win32",
  });
  assert.equal(got, path.join(home, "AppData", "Roaming", "deliberation", "config.json"));
});

// --- cache: env override + canonical default ---------------------------------

test("CC1: DELIBERATION_CACHE wins verbatim", () => {
  const override = "/somewhere/custom/grok-files.json";
  const got = resolveGrokCachePath({
    home: HOME,
    env: { DELIBERATION_CACHE: override },
    platform: "linux",
  });
  assert.equal(got, override);
});

test("CC2: no override -> canonical XDG cache", () => {
  const got = resolveGrokCachePath({
    home: HOME,
    env: {},
    platform: "linux",
  });
  assert.equal(got, canonicalCache(HOME));
});

test("CC3: XDG_CACHE_HOME relocates the canonical cache", () => {
  const xdg = "/xdg/cache";
  const got = resolveGrokCachePath({
    home: HOME,
    env: { XDG_CACHE_HOME: xdg },
    platform: "linux",
  });
  assert.equal(got, path.join(xdg, "deliberation", "grok-files.json"));
});

test("CC4: relative XDG_CACHE_HOME is ignored -> canonical default (~/.cache)", () => {
  const got = resolveGrokCachePath({
    home: HOME,
    env: { XDG_CACHE_HOME: "relative/cache" },
    platform: "linux",
  });
  assert.equal(got, canonicalCache(HOME));
});

test("CC5: win32 uses LOCALAPPDATA (Local, not Roaming) for canonical cache", () => {
  const localAppData = "C:\\Users\\tester\\AppData\\Local";
  const got = resolveGrokCachePath({
    home: "C:\\Users\\tester",
    env: { LOCALAPPDATA: localAppData },
    platform: "win32",
  });
  assert.equal(got, path.join(localAppData, "deliberation", "grok-files.json"));
});

test("CC6: win32 without LOCALAPPDATA falls back to ~/AppData/Local", () => {
  const home = "C:\\Users\\tester";
  const got = resolveGrokCachePath({
    home,
    env: {},
    platform: "win32",
  });
  assert.equal(got, path.join(home, "AppData", "Local", "deliberation", "grok-files.json"));
});

test("CC7: win32 relative LOCALAPPDATA is ignored -> ~/AppData/Local fallback", () => {
  const home = "C:\\Users\\tester";
  const got = resolveGrokCachePath({
    home,
    env: { LOCALAPPDATA: "relative\\local" },
    platform: "win32",
  });
  assert.equal(got, path.join(home, "AppData", "Local", "deliberation", "grok-files.json"));
});
