#!/usr/bin/env node
/**
 * Guard for CI and local test runs: refuse to run when DSH_HOME points at a real
 * user home. Every automated test must operate on a throwaway home under the
 * runner's temp directory, so a bug can never touch someone's real ~/.dsh.
 *
 * docs/PLAN.md §4.8 makes this a hard repository rule: "不碰真实环境：测试一律用
 * 临时 DSH_HOME，CI 有守卫脚本兜底". Exit codes are the contract:
 *
 *   0  DSH_HOME is set and lives under a platform/CI temp root
 *   1  DSH_HOME is unset, points at ~/.dsh, or is not under any known temp root
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Canonicalize a path that need not exist yet.
 *
 * Resolving only the paths that happen to exist is not symmetric, and the
 * asymmetry always cuts the same way: a temp root exists while a throwaway
 * DSH_HOME usually does not. On macOS the root is a symlink
 * (/var/folders -> /private/var/folders), so the resolved home is compared
 * against an unresolved root and a legitimate home is refused. Realpath the
 * longest existing ancestor and re-attach the remainder, so both sides of the
 * containment check are compared in the same form.
 */
function canonicalize(target) {
  const absolute = resolve(target)
  let prefix = absolute
  const remainder = []
  while (!existsSync(prefix)) {
    const parent = dirname(prefix)
    if (parent === prefix) return absolute
    remainder.unshift(basename(prefix))
    prefix = parent
  }
  let base
  try {
    base = realpathSync.native(prefix)
  } catch {
    return absolute
  }
  return remainder.length === 0 ? base : join(base, ...remainder)
}

const home = process.env.DSH_HOME
if (!home) {
  console.error('guard FAIL: DSH_HOME is not set; automated runs must use a throwaway home')
  process.exit(1)
}

const real = canonicalize(home)
const realHome = canonicalize(join(homedir(), '.dsh'))

if (real.toLowerCase() === realHome.toLowerCase()) {
  console.error(`guard FAIL: DSH_HOME points at the real DSH home (${real})`)
  process.exit(1)
}

// Accept any temp root the platform or CI provides: RUNNER_TEMP is not always
// under os.tmpdir(), notably on Windows runners where it lives on another drive.
// Both sides of the containment check go through the same resolver. On macOS a
// temp root is a symlink (/var/folders -> /private/var/folders): resolving only
// DSH_HOME makes the two forms disagree and the guard refuses a legitimate
// throwaway home. Asymmetry here is a false rejection, and a guard that
// false-rejects is a guard people learn to bypass.
const roots = [tmpdir(), process.env.RUNNER_TEMP, process.env.TMPDIR, process.env.TEMP]
  .filter((value) => typeof value === 'string' && value.length > 0)
  .map((value) => canonicalize(value).toLowerCase())

const matched = roots.find((root) => {
  const sep = root.endsWith('/') || root.endsWith('\\') ? '' : process.platform === 'win32' ? '\\' : '/'
  return real.toLowerCase() === root || real.toLowerCase().startsWith(root + sep)
})

if (!matched) {
  console.error(`guard FAIL: DSH_HOME must live under a temp directory; got ${real}`)
  console.error(`guard FAIL: known temp roots: ${roots.join(', ')}`)
  process.exit(1)
}

console.log(`guard      : DSH_HOME=${real}`)
console.log(`guard      : temp root=${matched}`)
console.log('guard      : ok')
