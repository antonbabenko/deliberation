// @ts-nocheck -- legacy bridge; predates the strict typecheck gate (core-only). Opt-in is a separate pass.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STALE_MS = 5_000;
const POLL_MS = 20;

function sleepSyncMs(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

function acquire(basePath, { maxWaitMs = 1000 } = {}) {
  const lockDir = `${basePath}.lock`;
  const token = crypto.randomBytes(16).toString("hex");
  const markerName = `owner.${token}.txt`;
  const deadline = Date.now() + maxWaitMs;

  // Ensure parent dir exists before trying to create lockDir
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  } catch (_) {
    /* parent already exists or unreadable */
  }

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      const markerPath = path.join(lockDir, markerName);
      fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, token, t: Date.now() }));
      return { lockDir, markerPath, token };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          const dead = `${lockDir}.dead.${process.pid}.${Date.now()}`;
          try {
            fs.renameSync(lockDir, dead);
            fs.rmSync(dead, { recursive: true, force: true });
            continue;
          } catch (_) { /* lost rename race */ }
        }
      } catch (_) { /* lock vanished mid-stat */ }
    }

    if (Date.now() >= deadline) return null;
    sleepSyncMs(POLL_MS);
  }
}

function release(handle) {
  if (!handle) return;
  try { fs.unlinkSync(handle.markerPath); } catch (_) { /* already gone */ }
  try { fs.rmdirSync(handle.lockDir); } catch (_) {
    // ENOTEMPTY → reclaimer's marker present; leave their lock intact.
    // ENOENT → already removed.
  }
}

function heartbeat(handle) {
  if (!handle) return;
  const now = new Date();
  try { fs.utimesSync(handle.lockDir, now, now); } catch (_) { /* lock vanished */ }
}

module.exports = { acquire, release, heartbeat, STALE_MS, POLL_MS };
