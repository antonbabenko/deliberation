"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lock = require("../server/grok/lock.js");

function tmpLockBase() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-lock-")), "cache.json");
}

test("acquire creates lockDir with unique owner marker", () => {
  const base = tmpLockBase();
  const handle = lock.acquire(base, { maxWaitMs: 100 });
  assert.ok(handle, "lock acquired");
  const lockDir = `${base}.lock`;
  assert.ok(fs.existsSync(lockDir), "lockDir exists");
  const markers = fs.readdirSync(lockDir).filter((f) => f.startsWith("owner."));
  assert.equal(markers.length, 1);
  assert.match(markers[0], /^owner\.[0-9a-f]{32}\.txt$/);
  lock.release(handle);
});

test("acquire writes the owner marker with 0600 permissions", () => {
  const base = tmpLockBase();
  const handle = lock.acquire(base, { maxWaitMs: 100 });
  assert.ok(handle, "lock acquired");
  const mode = fs.statSync(handle.markerPath).mode & 0o777;
  assert.equal(mode, 0o600, `marker mode ${mode.toString(8)} should be 600`);
  lock.release(handle);
});

test("acquire returns null when lock already held and not stale", () => {
  const base = tmpLockBase();
  const h1 = lock.acquire(base, { maxWaitMs: 50 });
  assert.ok(h1, "first acquire");
  const h2 = lock.acquire(base, { maxWaitMs: 50 });
  assert.equal(h2, null, "second acquire fails");
  lock.release(h1);
});

test("release removes our marker and rmdirs the lockDir", () => {
  const base = tmpLockBase();
  const handle = lock.acquire(base, { maxWaitMs: 100 });
  lock.release(handle);
  const lockDir = `${base}.lock`;
  assert.equal(fs.existsSync(lockDir), false);
});

test("stale lock (mtime > 5s) is reclaimed", () => {
  const base = tmpLockBase();
  const lockDir = `${base}.lock`;
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "owner.deadbeef.txt"), "stale");
  const past = (Date.now() - 6000) / 1000;
  fs.utimesSync(lockDir, past, past);

  const handle = lock.acquire(base, { maxWaitMs: 200 });
  assert.ok(handle, "stale lock reclaimed");
  lock.release(handle);
});

test("release after reclaim does not delete the reclaimer's lock", () => {
  const base = tmpLockBase();
  const lockDir = `${base}.lock`;

  const a = lock.acquire(base, { maxWaitMs: 100 });

  // Simulate reclaim: another process added its own marker.
  const reclaimerMarker = path.join(lockDir, "owner.cafebabe1234567890abcdef12345678.txt");
  fs.writeFileSync(reclaimerMarker, "reclaimer");

  lock.release(a);

  assert.equal(fs.existsSync(lockDir), true, "reclaimer's lockDir still exists");
  assert.equal(fs.existsSync(reclaimerMarker), true, "reclaimer's marker still exists");
  assert.equal(fs.existsSync(a.markerPath), false, "A's marker removed");

  fs.rmSync(lockDir, { recursive: true, force: true });
});

test("heartbeat keeps mtime fresh so live lock is not reclaimed", () => {
  const base = tmpLockBase();
  const handle = lock.acquire(base, { maxWaitMs: 100 });
  const past = (Date.now() - 6000) / 1000;
  fs.utimesSync(handle.lockDir, past, past);

  lock.heartbeat(handle);

  const st = fs.statSync(handle.lockDir);
  assert.ok(Date.now() - st.mtimeMs < 1000, "mtime refreshed by heartbeat");
  lock.release(handle);
});

test("acquire creates parent dirs when missing", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-lockparent-"));
  // basePath points into a NESTED dir that does not exist yet.
  const base = path.join(baseDir, "nested", "deeper", "cache.json");
  const handle = lock.acquire(base, { maxWaitMs: 200 });
  assert.ok(handle, "lock acquired despite missing parent dirs");
  assert.ok(fs.existsSync(path.dirname(handle.lockDir)), "parent dir was created");
  lock.release(handle);
});
