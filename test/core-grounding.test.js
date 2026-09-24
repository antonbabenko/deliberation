"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { groundingNote } = require("../core/grounding.js");

const DATE_LINE = /Current date \(UTC\): \d{4}-\d{2}-\d{2}\. /;

test("GR1: groundingNote stamps the UTC date and carries the no-denial rule", () => {
  // 23:30 at UTC-5 is already the next day in UTC: the note must use the UTC date.
  const note = groundingNote(new Date("2026-09-24T04:30:00Z"));
  assert.ok(note.startsWith("Current date (UTC): 2026-09-24. "));
  assert.match(note, /hallucinated/);
  assert.match(note, /\[unverified\]/);
});

test("GR2: the Grok bridge puts the note in the system turn, after the no-tools note", () => {
  const grok = /** @type {any} */ (require("../server/grok/index.js"));
  const [system] = grok.buildInitialTurns("SYS", "Q", []);
  assert.equal(system.role, "system");
  assert.ok(system.text.startsWith(`SYS\n\n${grok.NO_TOOLS_NOTE}\n\n`));
  assert.match(system.text, DATE_LINE);
});

test("GR3: the OpenRouter bridge always seeds a system turn with the note", () => {
  const or = /** @type {any} */ (require("../server/openrouter/index.js"));
  const withSys = or.buildInitialTurns("SYS", "Q", []);
  assert.equal(withSys[0].role, "system");
  assert.ok(withSys[0].text.startsWith("SYS\n\n"));
  assert.match(withSys[0].text, DATE_LINE);
  const noSys = or.buildInitialTurns(undefined, "Q", []);
  assert.equal(noSys.length, 2, "a system turn is added even without instructions");
  assert.match(noSys[0].text, DATE_LINE);
  assert.equal(noSys[1].text, "Q");
});

test("GR4: the Gemini bridge folds the note into both read-only and workspace-write prompts", () => {
  const { buildAgyArgs } = /** @type {any} */ (require("../server/gemini/index.js"));
  for (const sandbox of ["read-only", "workspace-write"]) {
    const args = buildAgyArgs({ prompt: "Q", sandbox });
    const prompt = args[args.lastIndexOf("-p") + 1];
    assert.match(prompt, DATE_LINE, sandbox);
    assert.ok(prompt.endsWith("Q"), `${sandbox}: the question stays last`);
  }
});

test("GR5: Codex receives the note above the separator, with or without instructions", async () => {
  const { makeCodexProvider } = require("../core/providers/codex.js");
  /** @type {string[]} */
  const seen = [];
  const p = makeCodexProvider({ run: async (/** @type {any} */ o) => { seen.push(o.prompt); return { code: 0, stdout: "ok", stderr: "" }; } });
  await p.ask({ prompt: "Q", developerInstructions: "SYS" });
  await p.ask({ prompt: "Q" });
  assert.match(seen[0], /^SYS\n\nCurrent date \(UTC\): \d{4}-\d{2}-\d{2}\. [\s\S]*\n\n---\n\nQ$/);
  assert.match(seen[1], /^Current date \(UTC\): \d{4}-\d{2}-\d{2}\. [\s\S]*\n\n---\n\nQ$/);
});

test("GR6: codex echoing the stamped prompt is not mistaken for its own error", async () => {
  const { makeCodexProvider } = require("../core/providers/codex.js");
  // codex exec echoes the whole prompt on stderr before its own error line. The note
  // mentions nothing auth-like, but the prompt might: the echo must be consumed, so the
  // classification comes from codex's own 429 line.
  /** @type {string} */
  let sent = "";
  const p = makeCodexProvider({
    run: async (/** @type {any} */ o) => {
      sent = o.prompt;
      return { code: 1, stdout: "", stderr: `user\n${o.prompt}\nERROR: stream error: 429 Too Many Requests, rate limited`, timedOut: false };
    },
    env: {},
  });
  const r = /** @type {any} */ (await p.ask({ prompt: "why could the access token could not be refreshed?" }));
  assert.match(sent, DATE_LINE);
  assert.equal(r.errorKind, "rate-limit");
});
