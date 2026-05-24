'use strict'

/**
 * conventional-changelog-action@v5 pre-commit hook.
 *
 * Runs AFTER the changelog/version-file bump and BEFORE the action's
 * git add/commit/tag. Files staged here land in the release commit AND the
 * tag, so tag-pinned consumers (agent-plugins pins ref:vX.Y.Z) get a tree
 * whose manifest versions match the tag.
 *
 * Node built-ins only (fs, path, child_process). No npm deps. The action
 * stages only version-file + the changelog, so this hook stages the manifests
 * it edits.
 *
 * version.json is the single CI-owned version source; the manifests below
 * mirror it. Each replace is value-only and indent-anchored (rewrites only the
 * quoted value), so byte layout / key position / trailing commas are untouched
 * (no JSON re-serialize, no diff noise).
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const SENTINEL_REL = 'version.json'

// Each target: file + an indent-anchored regex matching the version line's
// value. The indent disambiguates which "version" key is meant:
//   - 2-space  => top-level key (plugin.json, package.json)
//   - 6-space  => plugins[0].version (marketplace.json; the only version line)
const TARGETS = [
  { rel: '.claude-plugin/plugin.json', re: /^( {2}"version":\s*)"[^"]*"/m },
  { rel: '.claude-plugin/marketplace.json', re: /^( {6}"version":\s*)"[^"]*"/m },
  { rel: 'package.json', re: /^( {2}"version":\s*)"[^"]*"/m },
]

function repoRoot() {
  const root = process.env.GITHUB_WORKSPACE || process.cwd()
  if (!fs.existsSync(path.join(root, SENTINEL_REL))) {
    throw new Error(
      `pre-commit: sentinel ${SENTINEL_REL} not found in repo root ${root}; ` +
        `refusing to run (wrong working directory?)`
    )
  }
  return root
}

function syncVersion(root, target, version) {
  const file = path.join(root, target.rel)
  if (!fs.existsSync(file)) {
    throw new Error(`pre-commit: ${target.rel} not found`)
  }
  const src = fs.readFileSync(file, 'utf8')
  if (!target.re.test(src)) {
    throw new Error(`pre-commit: version line not found in ${target.rel}`)
  }
  fs.writeFileSync(file, src.replace(target.re, `$1"${version}"`))
  return target.rel
}

async function preCommit(props) {
  const version = props && props.version
  if (!version || typeof version !== 'string') {
    throw new Error(`pre-commit: invalid version from action: ${version}`)
  }

  try {
    const root = repoRoot()
    const staged = []
    for (const target of TARGETS) {
      const rel = syncVersion(root, target, version)
      console.log(`pre-commit: synced ${rel} -> ${version}`)
      staged.push(rel)
    }
    // The action stages only version-file + changelog. Stage ours so they are
    // in the release commit and the tag.
    execSync(`git add ${staged.join(' ')}`, { cwd: root, stdio: 'inherit' })
  } catch (err) {
    // Fail loud so the release job stops rather than tagging a stale tree.
    console.error(`pre-commit: ${err && err.message ? err.message : err}`)
    throw err
  }
}

module.exports = { preCommit }
