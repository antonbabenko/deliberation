"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { runSetup, STARTER_CONFIG } = require("../server/mcp/setup.js");
const { validateConfig } = require("../server/openrouter/config.js");

/** Make an isolated temp HOME; never touches the real ~/.claude. */
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-setup-"));
}
function rmrf(/** @type {string} */ dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
/** Capture stdout lines from runSetup. */
function capture() {
  /** @type {string[]} */
  const lines = [];
  return { out: (/** @type {string} */ l) => lines.push(l), lines };
}

// SU1: config absent -> writes a starter with a consensus block, exit 0.
test("SU1: absent config -> writes starter with consensus block", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out });

    assert.equal(code, 0);
    assert.equal(fs.existsSync(override), true);
    const written = JSON.parse(fs.readFileSync(override, "utf8"));
    assert.deepEqual(written.consensus, { arbiter: "auto" });
    assert.deepEqual(written, STARTER_CONFIG);
    assert.ok(lines.some((l) => l.includes("Wrote starter config")));
  } finally {
    rmrf(home);
  }
});

// SU2: config exists -> never clobbered; guidance emitted, exit 0.
test("SU2: existing config -> not overwritten, guidance emitted", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    fs.mkdirSync(path.dirname(override), { recursive: true });
    const original = '{"version":1,"my":"custom","openrouter":{"enabled":true,"models":[]}}';
    fs.writeFileSync(override, original);

    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out });

    assert.equal(code, 0);
    assert.equal(fs.readFileSync(override, "utf8"), original); // byte-for-byte unchanged
    assert.ok(lines.some((l) => l.includes("leaving it unchanged")));
    assert.ok(lines.some((l) => l.includes('"consensus"'))); // suggested block printed
  } finally {
    rmrf(home);
  }
});

// SU3: mkdir fails -> exit 1, reported as a DIRECTORY error, not as "config
// already exists" and not as a write error. Write is never reached.
test("SU3: mkdir failure -> exit 1 with dir-creation message", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    const fsImpl = {
      statSync: () => { const e = new Error("ENOENT"); /** @type {any} */ (e).code = "ENOENT"; throw e; },
      mkdirSync: () => { const e = new Error("ENOTDIR: not a directory"); /** @type {any} */ (e).code = "ENOTDIR"; throw e; },
      writeFileSync: () => { throw new Error("should not reach writeFileSync"); },
    };
    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out, fsImpl });

    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("Could not create config directory")));
    assert.ok(!lines.some((l) => l.includes("leaving it unchanged")));
    assert.ok(!lines.some((l) => l.includes("Could not write config")));
  } finally {
    rmrf(home);
  }
});

// SU4: config path is a DIRECTORY -> exit 1, no write, clear message.
test("SU4: existing path is a directory -> exit 1, no write, clear message", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    fs.mkdirSync(override, { recursive: true }); // create a dir AT the config path
    const before = fs.readdirSync(override);

    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out });

    assert.equal(code, 1);
    assert.equal(fs.statSync(override).isDirectory(), true); // still a dir, nothing written into it as a file
    assert.deepEqual(fs.readdirSync(override), before); // untouched
    assert.ok(lines.some((l) => l.includes("not a regular file")));
  } finally {
    rmrf(home);
  }
});

// SU5: TOCTOU - file appears between stat and write -> EEXIST treated as unchanged, exit 0.
test("SU5: write race (EEXIST) -> leave unchanged, exit 0", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    const fsImpl = {
      statSync: () => { const e = new Error("ENOENT"); /** @type {any} */ (e).code = "ENOENT"; throw e; },
      mkdirSync: () => undefined,
      writeFileSync: () => { const e = new Error("EEXIST: file already exists"); /** @type {any} */ (e).code = "EEXIST"; throw e; },
    };
    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out, fsImpl });

    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.includes("leaving it unchanged")));
  } finally {
    rmrf(home);
  }
});

// SU6 (FIX 2): a mid-write failure leaves a partial file. Setup must unlink it
// before reporting, so a later read does not crash on a truncated file. Exit 1.
test("SU6: write failure -> partial config unlinked, exit 1", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    let unlinked = "";
    let created = false;
    const fsImpl = {
      statSync: () => { const e = new Error("ENOENT"); /** @type {any} */ (e).code = "ENOENT"; throw e; },
      // existsSync: the partial file "exists" only after the failed write created it.
      existsSync: (/** @type {string} */ p) => (p === override ? created : false),
      mkdirSync: () => undefined,
      writeFileSync: () => {
        created = true; // a truncated file landed
        const e = new Error("ENOSPC: no space left on device"); /** @type {any} */ (e).code = "ENOSPC"; throw e;
      },
      unlinkSync: (/** @type {string} */ p) => { unlinked = p; created = false; },
    };
    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out, fsImpl });

    assert.equal(code, 1);
    assert.equal(unlinked, override); // partial file removed
    assert.ok(lines.some((l) => l.includes("Could not write config")));
  } finally {
    rmrf(home);
  }
});

// SU8: the STARTER_CONFIG written by setup must itself validate under validateConfig
// (no ajv: parity is asserted via the real validator). Guards against the starter
// drifting from the schema the server enforces.
test("SU8: STARTER_CONFIG validates under validateConfig", () => {
  const { ok, resolved, error } = validateConfig(STARTER_CONFIG);
  assert.equal(ok, true, error);
  assert.ok(resolved);
  // openrouter ships disabled in the starter; consensus arbiter is the auto shorthand.
  assert.equal(resolved.openrouter.enabled, false);
  assert.deepEqual(resolved.consensus, { arbiter: "auto", arbiterDefaulted: false, blindVote: false });
  assert.deepEqual(resolved.openrouter.models, []);
  assert.equal(resolved.openrouter.maxFanout, 3);
});

// SU9: the JSON Schema's worked example must also validate under validateConfig, so
// the schema and the runtime validator agree on the unified v1 shape.
test("SU9: config.schema.json example validates under validateConfig", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "config.schema.json"), "utf8"));
  assert.ok(Array.isArray(schema.examples) && schema.examples.length >= 1, "schema carries an example");
  const example = schema.examples[0];
  const { ok, resolved, error } = validateConfig(example);
  assert.equal(ok, true, error);
  assert.ok(resolved);
  // the dedicated arbiter record resolves and is referenced by { model: id }
  assert.deepEqual(resolved.consensus.arbiter, { model: "claude-arb" });
  assert.equal(resolved.openrouter.models.some((m) => m.alias === "claude-arb"), true);
  assert.deepEqual(resolved.consensusWarnings, []);
});

// SU7: mkdir throws EEXIST (a parent component is a regular file). This must
// report a dir error, NOT be mistaken for the write-side TOCTOU EEXIST that
// means "already exists, unchanged".
test("SU7: mkdir EEXIST -> dir-creation error, not 'unchanged'", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    const fsImpl = {
      statSync: () => { const e = new Error("ENOENT"); /** @type {any} */ (e).code = "ENOENT"; throw e; },
      mkdirSync: () => { const e = new Error("EEXIST: file already exists"); /** @type {any} */ (e).code = "EEXIST"; throw e; },
      writeFileSync: () => { throw new Error("should not reach writeFileSync"); },
    };
    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out, fsImpl });

    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("Could not create config directory")));
    assert.ok(!lines.some((l) => l.includes("leaving it unchanged")));
  } finally {
    rmrf(home);
  }
});
