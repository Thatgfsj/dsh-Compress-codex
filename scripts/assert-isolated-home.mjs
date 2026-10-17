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
import { resolve } from 'node:path'

/** Resolve a path without requiring it to exist yet. */
function resolveLoose(path) {
  if (existsSync(path)) {
    try {
      return realpathSync.native(path)
    } catch {
      return resolve(path)
    }
  }
  return resolve(path)
}

const home = process.env.DSH_HOME
if (!home) {
  console.error('guard FAIL: DSH_HOME is not set; automated runs must use a throwaway home')
  process.exit(1)
}

const real = resolveLoose(home)
const realHome = resolve(homedir(), '.dsh')

if (real.toLowerCase() === realHome.toLowerCase()) {
  console.error(`guard FAIL: DSH_HOME points at the real DSH home (${real})`)
  process.exit(1)
}

// Accept any temp root the platform or CI provides: RUNNER_TEMP is not always
// under os.tmpdir(), notably on Windows runners where it lives on another drive.
const roots = [tmpdir(), process.env.RUNNER_TEMP, process.env.TMPDIR, process.env.TEMP]
  .filter((value) => typeof value === 'string' && value.length > 0)
  .map((value) => resolve(value).toLowerCase())

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
