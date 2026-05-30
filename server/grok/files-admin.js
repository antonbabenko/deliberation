#!/usr/bin/env node

/**
 * Claude Delegator - Grok file storage admin
 *
 * Two cleanup paths, complementary:
 *
 *   prune  - deletes REMOTE xAI files by filename prefix + created_at cutoff.
 *            Safe without the local cache.
 *   gc     - syncs the LOCAL cache (~/.claude/cache/deliberation/grok-files.json)
 *            with the remote file list via ONE paginated GET /v1/files. Prunes
 *            local rows whose fileId no longer exists remotely. Default scope:
 *            current XAI_API_KEY + XAI_API_BASE rows only. --all-keys widens;
 *            --force-local-prune required to drop ambiguous foreign rows.
 *
 * Auth: XAI_API_KEY (env). Endpoint: XAI_API_BASE (env) or https://api.x.ai/v1.
 */

const DEFAULT_API_BASE = process.env.XAI_API_BASE || "https://api.x.ai/v1";
const DEFAULT_PREFIX = "deliberation-";

// Parse a human duration into seconds. Accepts Ns, Nm, Nh, Nd, or a plain
// integer (seconds). Returns a non-negative number or throws on bad input.
function parseOlderThan(str) {
  const m = String(str).trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) throw new Error(`Invalid --older-than value: "${str}" (use e.g. 30m, 24h, 7d, or seconds)`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return n * mult;
}

// Pure: pick files that are bridge-owned (filename prefix) AND older than the
// cutoff. `cutoffEpochSec` is the threshold; a file is prunable when its
// created_at is strictly less than the cutoff. The DEFAULT_PREFIX floor is a HARD
// safety invariant - even a caller-supplied `prefix` of "" can never select a file
// that is not bridge-owned.
function selectPrunable(files, { prefix = DEFAULT_PREFIX, cutoffEpochSec }) {
  return (files || []).filter(
    (f) =>
      f &&
      typeof f.filename === "string" &&
      f.filename.startsWith(DEFAULT_PREFIX) &&
      f.filename.startsWith(prefix) &&
      typeof f.created_at === "number" &&
      f.created_at < cutoffEpochSec
  );
}

function authHeader(apiKey) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error("XAI_API_KEY is not set; export it before running files-admin.");
  }
  return { Authorization: `Bearer ${apiKey}` };
}

// List ALL files, following pagination_token. `fetchImpl` injectable for tests.
async function listFiles({ apiKey, apiBase, fetchImpl, pageLimit = 1000 }) {
  const f = fetchImpl || globalThis.fetch;
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const headers = authHeader(apiKey);
  const all = [];
  let token = null;
  let lastToken = null;
  // Bound the loop so a misbehaving server can't spin forever.
  for (let i = 0; i < 10_000; i++) {
    const url = new URL(`${base}/files`);
    url.searchParams.set("limit", String(pageLimit));
    if (token) url.searchParams.set("pagination_token", token);
    const res = await f(url.toString(), { method: "GET", headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`List files failed ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const page = Array.isArray(data.data) ? data.data : [];
    for (const item of page) all.push(item);
    token = data.pagination_token || null;
    // Stop at a short/empty page, when there is no token, or if the token did not
    // advance (defensive against a server that echoes the same token).
    if (!token || token === lastToken || page.length < pageLimit) break;
    lastToken = token;
  }
  return all;
}

async function deleteFile(id, { apiKey, apiBase, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const res = await f(`${base}/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeader(apiKey),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Delete ${id} failed ${res.status}: ${text.slice(0, 200)}`);
  return true;
}

// Orchestrate a prune. Returns { candidates, deleted, failed } (deleted/failed
// empty on dry run). One delete failure does not abort the rest.
async function prune({ olderThanSec, prefix = DEFAULT_PREFIX, apiKey, apiBase, fetchImpl, dryRun = true, now = Date.now() }) {
  const cutoffEpochSec = Math.floor(now / 1000) - olderThanSec;
  const files = await listFiles({ apiKey, apiBase, fetchImpl });
  const candidates = selectPrunable(files, { prefix, cutoffEpochSec });
  const deleted = [];
  const failed = [];
  if (!dryRun) {
    for (const file of candidates) {
      try {
        await deleteFile(file.id, { apiKey, apiBase, fetchImpl });
        deleted.push(file.id);
      } catch (e) {
        failed.push({ id: file.id, error: (e && e.message) || String(e) });
      }
    }
  }
  return { candidates, deleted, failed };
}

const cacheModule = require("./cache.js");

async function gc({ cacheFile, apiKey, apiBase, fetchImpl, allKeys = false, forceLocalPrune = false }) {
  let files;
  try {
    files = await listFiles({ apiKey, apiBase, fetchImpl });
  } catch (e) {
    const err = new Error(`gc aborted: failed to list xAI files (${(e && e.message) || e}); local cache unchanged`);
    err.exitCode = 2;
    throw err;
  }
  const remoteIds = new Set(files.map((f) => f.id));
  const currentKeyFp = require("node:crypto").createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 16);
  const apiBaseNorm = cacheModule.normalize(apiBase);

  const lock = require("./lock.js");
  const handle = lock.acquire(cacheFile, { maxWaitMs: 3000 });
  if (!handle) {
    const err = new Error("gc: could not acquire cache lock (another process is writing); retry");
    err.exitCode = 3;
    throw err;
  }
  let prunedLocal = 0;
  try {
    const data = cacheModule.readCache(cacheFile);
    for (const k of Object.keys(data.entries)) {
      const e = data.entries[k];
      const isMine = e.keyFp === currentKeyFp && e.apiBase === apiBaseNorm;
      if (!isMine && !allKeys) continue;
      if (remoteIds.has(e.fileId)) continue;
      if (!isMine && !forceLocalPrune) continue;
      delete data.entries[k];
      prunedLocal += 1;
    }
    cacheModule.writeCache(cacheFile, data);
  } finally {
    lock.release(handle);
  }
  return { prunedLocal };
}

// --- CLI ---

function parseArgs(argv) {
  const out = { _: [], "older-than": null, yes: false, prefix: DEFAULT_PREFIX, "all-keys": false, "force-local-prune": false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--older-than") out["older-than"] = argv[++i];
    else if (a === "--prefix") out.prefix = argv[++i];
    else if (a === "--all-keys") out["all-keys"] = true;
    else if (a === "--force-local-prune") out["force-local-prune"] = true;
    else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const apiKey = process.env.XAI_API_KEY;

  if (cmd === "list") {
    const files = await listFiles({ apiKey });
    const mine = files.filter((f) => typeof f.filename === "string" && f.filename.startsWith(args.prefix));
    console.log(`Total xAI files: ${files.length}; bridge-owned (${args.prefix}*): ${mine.length}`);
    for (const f of mine) {
      const created = new Date((f.created_at || 0) * 1000).toISOString();
      const expires = f.expires_at ? new Date(f.expires_at * 1000).toISOString() : "never";
      console.log(`  ${f.id}  ${created}  expires:${expires}  ${f.filename}`);
    }
    return;
  }

  if (cmd === "prune") {
    if (!args["older-than"]) throw new Error("prune requires --older-than (e.g. --older-than 24h)");
    const olderThanSec = parseOlderThan(args["older-than"]);
    const dryRun = !args.yes;
    const { candidates, deleted, failed } = await prune({
      olderThanSec,
      prefix: args.prefix,
      apiKey,
      dryRun,
    });
    if (dryRun) {
      console.log(`[dry run] ${candidates.length} file(s) older than ${args["older-than"]} would be deleted (pass --yes to delete):`);
      for (const f of candidates) console.log(`  ${f.id}  ${f.filename}`);
    } else {
      console.log(`Deleted ${deleted.length} file(s) older than ${args["older-than"]}.`);
      if (failed.length) {
        console.error(`Failed to delete ${failed.length} file(s):`);
        for (const x of failed) console.error(`  ${x.id}: ${x.error}`);
        process.exitCode = 1;
      }
    }
    return;
  }

  if (cmd === "gc") {
    const cacheFile = require("./cache.js").CACHE_FILE;
    const apiBase = DEFAULT_API_BASE;
    try {
      const result = await gc({
        cacheFile,
        apiKey,
        apiBase,
        allKeys: args["all-keys"],
        forceLocalPrune: args["force-local-prune"],
      });
      console.log(`gc: pruned ${result.prunedLocal} local cache row(s).`);
    } catch (e) {
      console.error(e.message);
      process.exitCode = e.exitCode || 1;
    }
    return;
  }

  console.error(
    "Usage:\n" +
    "  files-admin.js list\n" +
    "  files-admin.js prune --older-than <30m|24h|7d|seconds> [--yes] [--prefix deliberation-]\n" +
    "  files-admin.js gc [--all-keys] [--force-local-prune]\n" +
    "\n" +
    "gc syncs the local cache with xAI: one paginated GET /v1/files; rows whose\n" +
    "fileId is absent remotely are pruned locally. Default scope is the current\n" +
    "XAI_API_KEY + XAI_API_BASE; --all-keys widens; --force-local-prune required\n" +
    "to drop ambiguous foreign rows.\n",
  );
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`files-admin error: ${(e && e.message) || e}`);
    process.exitCode = 1;
  });
}

module.exports = { parseOlderThan, selectPrunable, listFiles, deleteFile, prune, gc, parseArgs, DEFAULT_PREFIX };
