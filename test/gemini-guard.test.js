// test/gemini-guard.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { advisoryEnv, THREAD_ID_RE } = require("../server/gemini/index.js");

test("GG1: advisoryEnv scrubs credential-shaped vars, keeps PATH/HOME/LANG", () => {
  const env = {
    XAI_API_KEY: "x",
    AWS_SECRET_ACCESS_KEY: "y",
    OPENAI_API_KEY: "z",
    GOOGLE_APPLICATION_CREDENTIALS: "/path/creds.json",
    GITHUB_TOKEN: "gh",
    PATH: "/usr/bin",
    HOME: "/Users/test",
    LANG: "en_US.UTF-8",
  };
  const out = advisoryEnv(env);

  // Credential-shaped + explicit denylist entry are gone.
  assert.equal(out.XAI_API_KEY, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(out.OPENAI_API_KEY, undefined);
  assert.equal(out.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(out.GITHUB_TOKEN, undefined);

  // Non-credential operational vars are preserved.
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.HOME, "/Users/test");
  assert.equal(out.LANG, "en_US.UTF-8");
});

test("GG2: advisoryEnv does not mutate the input env", () => {
  const env = { XAI_API_KEY: "x", PATH: "/usr/bin" };
  advisoryEnv(env);
  assert.equal(env.XAI_API_KEY, "x");
});

test("GG3: THREAD_ID_RE accepts a well-formed conversation id", () => {
  assert.equal(THREAD_ID_RE.test("abc-123_DEF"), true);
});

test("GG4: THREAD_ID_RE rejects flag-shaped, whitespace, empty, and oversized ids", () => {
  assert.equal(THREAD_ID_RE.test("--sandbox"), false);
  assert.equal(THREAD_ID_RE.test("-p"), false);
  assert.equal(THREAD_ID_RE.test("a b"), false);
  assert.equal(THREAD_ID_RE.test(""), false);
  assert.equal(THREAD_ID_RE.test("a".repeat(200)), false);
});
