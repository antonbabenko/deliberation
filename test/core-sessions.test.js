"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  writeSession, readSession, listSessions, pruneSessions, annotateSession,
  scrubSecrets, stripPII, isSafeId, newSessionId, SCHEMA_VERSION, MAX_TEXT_BYTES,
} = require("../core/sessions.js");

test("PII1: stripPII redacts emails and separator-bearing phones, leaves plain text/ids alone", () => {
  assert.equal(stripPII("ping a@b.co please"), "ping [REDACTED_EMAIL] please");
  assert.equal(stripPII("call 415-555-2671 now"), "call [REDACTED_PHONE] now");
  assert.equal(stripPII("intl +1 415 555 2671 ok"), "intl [REDACTED_PHONE] ok");
  assert.equal(stripPII("area (415) 555-2671"), "area [REDACTED_PHONE]");
  // No false positives on normal content, bare digit runs, versions, code.
  assert.equal(stripPII("verdict APPROVE in round 2"), "verdict APPROVE in round 2");
  assert.equal(stripPII("id 4155552671 v1.2.3 status 200"), "id 4155552671 v1.2.3 status 200");
  assert.equal(stripPII(""), "");
});

test("PII2: a persisted opinion text is secret-scrubbed THEN PII-stripped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delib-pii-"));
  const id = newSessionId();
  writeSession({
    id, parentId: null, schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(),
    tool: "ask-all", question: "q",
    opinions: [{ provider: "grok", text: "reach me at a@b.co with key sk-abcdefghijklmnopqrstuvwxyz123456" }],
  }, { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  const t = back.opinions[0].text || "";
  assert.ok(t.includes("[REDACTED_EMAIL]"), "email PII redacted");
  assert.ok(t.includes("[REDACTED]") && !t.includes("sk-abcdefghijklmnop"), "secret scrubbed (mandatory)");
});

test("PII3: stripPII stays linear on pathological input (no catastrophic backtracking)", () => {
  // A long run of valid email-local chars with no '@' is the O(n^2) trap when the
  // quantifiers are unbounded. RFC-bounded quantifiers keep it linear; a
  // catastrophic regex would hang the suite instead of returning.
  const big = "a.".repeat(40000); // 80k chars, nothing to redact
  const out = stripPII(big);
  assert.equal(typeof out, "string");
  assert.equal(out, big);
});

/** @typedef {import("../core/sessions.js").SessionRecord} SessionRecord */

// Each test gets its own temp sessions dir.
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-sess-"));
}

/**
 * Build a minimal valid record. Caller overrides fields as needed.
 * @param {Partial<SessionRecord>} [over]
 * @returns {SessionRecord}
 */
function rec(over) {
  /** @type {SessionRecord} */
  const base = {
    id: newSessionId(),
    parentId: null,
    schemaVersion: SCHEMA_VERSION,
    createdAt: "2026-06-01T00:00:00.000Z",
    tool: "consensus",
    question: "what is 2+2?",
    expert: null,
    files: null,
    opinions: [{ provider: "codex", model: "m", text: "4" }],
    blindVerdict: null,
    verdict: "the answer is 4",
    arbiter: { mode: "server", provider: "grok" },
    warnings: [],
    annotations: [],
  };
  return { ...base, ...(over || {}) };
}

// --- round-trip --------------------------------------------------------------

test("S1: write + read round-trip preserves core fields", () => {
  const dir = tmpDir();
  const r = rec({});
  const id = writeSession(r, { dir });
  assert.equal(id, r.id);
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.equal(back.id, r.id);
  assert.equal(back.tool, "consensus");
  assert.equal(back.question, "what is 2+2?");
  assert.equal(back.verdict, "the answer is 4");
  assert.equal(back.opinions[0].text, "4");
  assert.equal(back.schemaVersion, SCHEMA_VERSION);
});

// --- atomic write ------------------------------------------------------------

test("S2: atomic write leaves no temp file and a valid JSON dest", () => {
  const dir = tmpDir();
  const id = writeSession(rec({}), { dir });
  const names = fs.readdirSync(dir);
  assert.deepEqual(names, [`${id}.json`]); // exactly the dest, no .tmp leftover
  const raw = fs.readFileSync(path.join(dir, `${id}.json`), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
});

// --- file mode 0600 ----------------------------------------------------------

test("S3: written file is mode 0600", { skip: process.platform === "win32" }, () => {
  const dir = tmpDir();
  const id = writeSession(rec({}), { dir });
  const mode = fs.statSync(path.join(dir, `${id}.json`)).mode & 0o777;
  assert.equal(mode, 0o600);
});

// --- unsafe id rejected (no traversal) --------------------------------------

test("S4: writeSession rejects an unsafe id (path traversal)", () => {
  const dir = tmpDir();
  assert.throws(() => writeSession(rec({ id: "../evil" }), { dir }), /unsafe session id/);
  assert.throws(() => writeSession(rec({ id: "a/b" }), { dir }), /unsafe session id/);
});

test("S5: readSession returns null for an unsafe id", () => {
  const dir = tmpDir();
  assert.equal(readSession("../evil", { dir }), null);
  assert.equal(readSession("a/b", { dir }), null);
  assert.equal(readSession("a.b", { dir }), null);
});

test("S6: isSafeId guards the anchored shape", () => {
  assert.equal(isSafeId("abc-123"), true);
  assert.equal(isSafeId("../x"), false);
  assert.equal(isSafeId("a/b"), false);
  assert.equal(isSafeId("a.b"), false);
  assert.equal(isSafeId(""), false);
  assert.equal(isSafeId(42), false);
});

// --- corrupt JSON -> null ----------------------------------------------------

test("S7: readSession returns null on corrupt JSON (never throws)", () => {
  const dir = tmpDir();
  const id = "deadbeef";
  fs.writeFileSync(path.join(dir, `${id}.json`), "{ this is not json");
  assert.equal(readSession(id, { dir }), null);
});

test("S8: readSession returns null for an absent file", () => {
  const dir = tmpDir();
  assert.equal(readSession("missing", { dir }), null);
});

// --- listing newest-first ----------------------------------------------------

test("S9: listSessions returns newest-first by mtime", () => {
  const dir = tmpDir();
  const a = writeSession(rec({}), { dir });
  const b = writeSession(rec({}), { dir });
  const c = writeSession(rec({}), { dir });
  // Force distinct, deterministic mtimes: a oldest, c newest.
  fs.utimesSync(path.join(dir, `${a}.json`), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(dir, `${b}.json`), new Date(2000), new Date(2000));
  fs.utimesSync(path.join(dir, `${c}.json`), new Date(3000), new Date(3000));
  const ids = listSessions({ dir }).map((e) => e.id);
  assert.deepEqual(ids, [c, b, a]);
});

test("S10: listSessions on a missing dir yields []", () => {
  const got = listSessions({ dir: path.join(os.tmpdir(), "delib-does-not-exist-xyz") });
  assert.deepEqual(got, []);
});

// --- prune by age + by count -------------------------------------------------

test("S11: pruneSessions deletes records older than maxAgeDays", () => {
  const dir = tmpDir();
  const fresh = writeSession(rec({}), { dir });
  const old = writeSession(rec({}), { dir });
  // Backdate `old` by ~10 days.
  const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
  fs.utimesSync(path.join(dir, `${old}.json`), new Date(tenDaysAgo), new Date(tenDaysAgo));
  const { removed } = pruneSessions({ dir, maxAgeDays: 1, maxRecords: 100 });
  assert.equal(removed, 1);
  assert.equal(readSession(old, { dir }), null);
  assert.ok(readSession(fresh, { dir }));
});

test("S12: pruneSessions trims to the newest maxRecords", () => {
  const dir = tmpDir();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(writeSession(rec({}), { dir }));
  // Distinct ascending, RECENT mtimes (seconds apart) so only the count-trim
  // applies - not the age cutoff. ids[0] oldest, ids[4] newest.
  const nowMs = Date.now();
  for (let i = 0; i < ids.length; i++) {
    const t = new Date(nowMs - (ids.length - i) * 1000);
    fs.utimesSync(path.join(dir, `${ids[i]}.json`), t, t);
  }
  const { removed } = pruneSessions({ dir, maxRecords: 2, maxAgeDays: 3650 });
  assert.equal(removed, 3);
  const remaining = listSessions({ dir }).map((e) => e.id).sort();
  assert.deepEqual(remaining, [ids[3], ids[4]].sort()); // two newest survive
});

test("S12b: pruneSessions maxRecords:-1 keeps every record (unlimited count)", () => {
  const dir = tmpDir();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(writeSession(rec({}), { dir, maxRecords: -1, maxAgeDays: 3650 }));
  const { removed } = pruneSessions({ dir, maxRecords: -1, maxAgeDays: 3650 });
  assert.equal(removed, 0);
  assert.equal(listSessions({ dir }).length, 5);
});

test("S12c: pruneSessions maxAgeDays:-1 keeps a very old record (unlimited age)", () => {
  const dir = tmpDir();
  const old = writeSession(rec({}), { dir, maxRecords: -1, maxAgeDays: -1 });
  const ancient = Date.now() - 1000 * 24 * 60 * 60 * 1000; // ~1000 days
  fs.utimesSync(path.join(dir, `${old}.json`), new Date(ancient), new Date(ancient));
  const { removed } = pruneSessions({ dir, maxRecords: -1, maxAgeDays: -1 });
  assert.equal(removed, 0);
  assert.ok(readSession(old, { dir }));
});

test("S13: pruneSessions is ENOENT-tolerant (missing dir, repeat prune)", () => {
  assert.doesNotThrow(() => pruneSessions({ dir: path.join(os.tmpdir(), "delib-none-abc") }));
  const dir = tmpDir();
  const old = writeSession(rec({}), { dir });
  const past = Date.now() - 100 * 24 * 60 * 60 * 1000;
  fs.utimesSync(path.join(dir, `${old}.json`), new Date(past), new Date(past));
  assert.doesNotThrow(() => pruneSessions({ dir, maxAgeDays: 1 }));
  // Second prune over the now-empty dir must not throw either.
  assert.doesNotThrow(() => pruneSessions({ dir, maxAgeDays: 1 }));
});

// --- writeSession prunes after each write ------------------------------------

test("S14: writeSession prunes to maxRecords after writing", () => {
  const dir = tmpDir();
  for (let i = 0; i < 4; i++) writeSession(rec({}), { dir, maxRecords: 2, maxAgeDays: 3650 });
  assert.ok(listSessions({ dir }).length <= 2);
});

// --- annotate ----------------------------------------------------------------

test("S15: annotateSession appends an annotation and persists it", () => {
  const dir = tmpDir();
  const id = writeSession(rec({}), { dir });
  const updated = annotateSession(id, "looks good", { dir, at: "2026-06-02T00:00:00.000Z" });
  assert.ok(updated);
  if (!updated) return;
  assert.equal(updated.annotations && updated.annotations.length, 1);
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.equal(back.annotations && back.annotations[0].note, "looks good");
  assert.equal(back.annotations && back.annotations[0].at, "2026-06-02T00:00:00.000Z");
});

test("S16: annotateSession returns null for an unknown id", () => {
  const dir = tmpDir();
  assert.equal(annotateSession("missing", "x", { dir }), null);
});

// --- scrubSecrets ------------------------------------------------------------

test("S17: scrubSecrets redacts each key pattern", () => {
  const openai = "sk-" + "a".repeat(24);
  const openrouter = "sk-or-v1-" + "b".repeat(24);
  const xai = "xai-" + "c".repeat(24);
  const google = "AIza" + "D".repeat(35);
  const bearerTok = "abc.def-ghi_jkl+mno/pqrST"; // >= 20 chars, base64url-ish
  const bearer = `Bearer ${bearerTok}`;

  assert.equal(scrubSecrets(openai).includes(openai), false);
  assert.ok(scrubSecrets(openai).includes("[REDACTED]"));

  assert.equal(scrubSecrets(openrouter).includes(openrouter), false);
  assert.ok(scrubSecrets(openrouter).includes("[REDACTED]"));

  assert.equal(scrubSecrets(xai).includes(xai), false);
  assert.ok(scrubSecrets(xai).includes("[REDACTED]"));

  assert.equal(scrubSecrets(google).includes(google), false);
  assert.ok(scrubSecrets(google).includes("[REDACTED]"));

  const scrubbedBearer = scrubSecrets(bearer);
  assert.equal(scrubbedBearer.includes(bearerTok), false);
  assert.ok(scrubbedBearer.includes("Bearer [REDACTED]"));
});

test("S17d: scrubSecrets leaves short hyphenated terms and the word 'bearer' intact", () => {
  // {20,} minimum: these are NOT keys and must survive unchanged.
  assert.equal(scrubSecrets("sk-folding-cube spinner"), "sk-folding-cube spinner");
  assert.equal(scrubSecrets("xai-explainability docs"), "xai-explainability docs");
  // No `i` flag: the English word "bearer" (lowercase, short follow) is untouched.
  assert.equal(scrubSecrets("the bearer of this responsibility"), "the bearer of this responsibility");
});

test("S17e: scrubSecrets redacts GitHub and AWS key shapes", () => {
  const gh = "ghp_" + "a".repeat(36);
  const aws = "AKIA" + "ABCDEFGHIJKLMNOP"; // AKIA + 16
  assert.ok(scrubSecrets(gh).includes("[REDACTED]"));
  assert.equal(scrubSecrets(gh).includes(gh), false);
  assert.ok(scrubSecrets(`id=${aws} x`).includes("[REDACTED]"));
});

test("S17f: scrubSecrets redacts URL-embedded credentials (password only)", () => {
  const url = "postgres://user:supersecretpw@db.example.com/app";
  const out = scrubSecrets(url);
  assert.ok(out.includes("postgres://user:[REDACTED]@db.example.com"));
  assert.equal(out.includes("supersecretpw"), false);
});

test("S17g: scrubSecrets redacts non-Bearer 'Token <value>' auth headers", () => {
  // GitHub-style header with the literal "Token" scheme.
  const ghHeader = "Authorization: Token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const ghOut = scrubSecrets(ghHeader);
  assert.ok(ghOut.includes("Token [REDACTED]"));
  assert.equal(ghOut.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), false);
  // A non-GitHub token value exercises the new Token rule (not the gh_ rule).
  const opaque = "Token " + "A1b2C3d4E5f6G7h8I9j0KLMN"; // >= 20 chars, no gh_ prefix
  const out = scrubSecrets(opaque);
  assert.equal(out, "Token [REDACTED]");
});

test("S17h: scrubSecrets leaves credential-free URLs and emails intact", () => {
  // No user:pass@ -> nothing to redact.
  assert.equal(scrubSecrets("http://host/path?q=1"), "http://host/path?q=1");
  // A bare email (no scheme, no password) must survive.
  assert.equal(scrubSecrets("contact user@host.com today"), "contact user@host.com today");
  // mailto: has no user:pass@ shape -> untouched.
  assert.equal(scrubSecrets("mailto:user@host.com"), "mailto:user@host.com");
});

test("S17b: scrubSecrets does NOT corrupt normal words containing key-like substrings", () => {
  // "risk-analysis" contains "sk-analysis"; word-boundary anchors must spare it.
  assert.equal(scrubSecrets("risk-analysis and disk-space"), "risk-analysis and disk-space");
  assert.equal(scrubSecrets("maxai-thing"), "maxai-thing");
});

test("S17c: a longer-than-39-char Google key is fully redacted (no tail leak)", () => {
  const longKey = "AIza" + "D".repeat(40); // 44 chars total, > the canonical 39
  const out = scrubSecrets(`k=${longKey} end`);
  assert.equal(out.includes(longKey), false); // whole key gone
  assert.equal(out.includes("DDDD"), false); // no leaked tail run
  assert.equal(out, "k=[REDACTED] end");
});

test("S18: secrets are scrubbed on write (question, opinion text, verdict, file refs)", () => {
  const dir = tmpDir();
  const secret = "sk-" + "z".repeat(24);
  const id = writeSession(rec({
    question: `key is ${secret}`,
    opinions: [{ provider: "codex", model: "m", text: `leaked ${secret}` }],
    verdict: `verdict mentions ${secret}`,
    files: [{ path: `/tmp/${secret}/notes.md` }],
  }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  const blob = JSON.stringify(back);
  assert.equal(blob.includes(secret), false);
  assert.ok(blob.includes("[REDACTED]"));
});

test("S18b: secrets in the warnings array are scrubbed on write", () => {
  const dir = tmpDir();
  const secret = "sk-" + "w".repeat(30);
  const id = writeSession(rec({ warnings: [`provider error: invalid key ${secret}`] }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.equal(JSON.stringify(back.warnings).includes(secret), false);
  assert.ok((back.warnings || [])[0].includes("[REDACTED]"));
});

test("S18c: pruneSessions reaps an orphaned old .tmp file", () => {
  const dir = tmpDir();
  writeSession(rec({}), { dir });
  // Simulate a crash-orphaned temp from a previous write, aged > 1h.
  const orphan = path.join(dir, "abc.json.tmp.999.123");
  fs.writeFileSync(orphan, "partial");
  const old = Date.now() - 2 * 60 * 60 * 1000;
  fs.utimesSync(orphan, new Date(old), new Date(old));
  pruneSessions({ dir, maxAgeDays: 3650, maxRecords: 100 });
  assert.equal(fs.existsSync(orphan), false);
});

test("S18d: pruneSessions leaves a FRESH .tmp file alone (in-flight write)", () => {
  const dir = tmpDir();
  writeSession(rec({}), { dir });
  const fresh = path.join(dir, "abc.json.tmp.999.456");
  fs.writeFileSync(fresh, "in-flight");
  pruneSessions({ dir, maxAgeDays: 3650, maxRecords: 100 });
  assert.equal(fs.existsSync(fresh), true); // younger than the 1h reap window
});

// --- 100 KB cap --------------------------------------------------------------

test("S19: opinion + verdict text are capped at ~100 KB on write", () => {
  const dir = tmpDir();
  const huge = "x".repeat(MAX_TEXT_BYTES + 5000);
  const id = writeSession(rec({
    opinions: [{ provider: "codex", model: "m", text: huge }],
    verdict: huge,
  }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  const optText = back.opinions[0].text || "";
  assert.ok(Buffer.byteLength(optText, "utf8") < MAX_TEXT_BYTES + 200);
  assert.ok(optText.includes("[truncated"));
  assert.ok((back.verdict || "").includes("[truncated"));
});

// --- file refs not bodies ----------------------------------------------------

test("S20: files persist as path REFS only", () => {
  const dir = tmpDir();
  const id = writeSession(rec({ files: [{ path: "./notes.md" }] }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.deepEqual(back.files, [{ path: "./notes.md" }]);
});

test("S20b: non-path file refs (dir/file_id/file_url/mode) survive a round-trip", () => {
  const dir = tmpDir();
  const files = [
    { dir: "src", mode: "inline" },
    { file_id: "file-abc123" },
    { file_url: "https://example.com/x.pdf" },
  ];
  const id = writeSession(rec({ files }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.deepEqual(back.files, files); // preserved so session-revisit keeps context
});

// --- consensus-loop record fields (verdict / criticalIssues / loop summary) ---

test("S21: the writer's SCHEMA_VERSION is 1 (single stamp, no dual-version support)", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("S22: a consensus opinion persists its verdict + criticalIssues losslessly", () => {
  const dir = tmpDir();
  const id = writeSession(rec({
    tool: "consensus",
    opinions: [{
      provider: "codex",
      verdict: "REQUEST_CHANGES",
      criticalIssues: [{ category: "security", description: "missing auth check" }],
    }],
  }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.equal(back.tool, "consensus");
  assert.equal(back.opinions[0].provider, "codex");
  assert.equal(back.opinions[0].verdict, "REQUEST_CHANGES");
  assert.deepEqual(back.opinions[0].criticalIssues, [{ category: "security", description: "missing auth check" }]);
});

test("S22b: a critical-issue description is secret-scrubbed + capped on write", () => {
  const dir = tmpDir();
  const secret = "sk-" + "q".repeat(30);
  const huge = "y".repeat(MAX_TEXT_BYTES + 4000);
  const id = writeSession(rec({
    tool: "consensus",
    opinions: [{ provider: "grok", verdict: "REJECT", criticalIssues: [
      { category: "ops", description: `leaked ${secret}` },
      { category: "correctness", description: huge },
    ] }],
  }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  const ci = back.opinions[0].criticalIssues || [];
  assert.equal(JSON.stringify(ci).includes(secret), false);
  assert.ok(ci[0].description.includes("[REDACTED]"));
  assert.ok(ci[1].description.includes("[truncated"));
});

test("S22c: a non-enum verdict is coerced to null on write (writer is the trust boundary)", () => {
  const dir = tmpDir();
  const secret = "sk-" + "v".repeat(30);
  const id = writeSession(rec({
    tool: "consensus",
    // A hand-built record that ignores parseReview's enum contract: the writer
    // must NOT persist arbitrary free text (incl. a secret) in the verdict field.
    opinions: [{ provider: "codex", verdict: /** @type {any} */ (`bogus ${secret}`) }],
  }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.equal(back.opinions[0].verdict, null);
  assert.equal(JSON.stringify(back).includes(secret), false);
});

test("S22d: question is capped at ~100 KB on write", () => {
  const dir = tmpDir();
  const huge = "q".repeat(MAX_TEXT_BYTES + 5000);
  const id = writeSession(rec({ question: huge }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.ok(Buffer.byteLength(back.question, "utf8") < MAX_TEXT_BYTES + 200);
  assert.ok(back.question.includes("[truncated"));
});

test("S23: converged / confidence / rounds round-trip on a consensus record", () => {
  const dir = tmpDir();
  const id = writeSession(rec({
    tool: "consensus",
    converged: true,
    confidence: "high",
    rounds: 3,
  }), { dir });
  const back = readSession(id, { dir });
  assert.ok(back);
  if (!back) return;
  assert.equal(back.converged, true);
  assert.equal(back.confidence, "high");
  assert.equal(back.rounds, 3);
});

test("S18e: tmp reap only matches the writer's exact temp shape", () => {
  const dir = tmpDir();
  writeSession(rec({}), { dir });
  const ours = path.join(dir, "abc.json.tmp.111.222");   // matches <id>.json.tmp.<pid>.<ms>
  const theirs = path.join(dir, "notes.tmp.backup");      // unrelated ".tmp." file
  fs.writeFileSync(ours, "x");
  fs.writeFileSync(theirs, "keep me");
  const old = Date.now() - 2 * 60 * 60 * 1000;
  fs.utimesSync(ours, new Date(old), new Date(old));
  fs.utimesSync(theirs, new Date(old), new Date(old));
  pruneSessions({ dir, maxAgeDays: 3650, maxRecords: 100 });
  assert.equal(fs.existsSync(ours), false);  // reaped
  assert.equal(fs.existsSync(theirs), true); // left alone
});
