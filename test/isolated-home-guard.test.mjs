import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('../scripts/assert-isolated-home.mjs', import.meta.url))

/** Run the guard with a controlled DSH_HOME; `undefined` leaves it unset. */
function runGuard(dshHome) {
  const env = { ...process.env }
  if (dshHome === undefined) delete env.DSH_HOME
  else env.DSH_HOME = dshHome
  const result = spawnSync(process.execPath, [guard], { env, encoding: 'utf8' })
  assert.equal(result.error, undefined)
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('guard fails when DSH_HOME is unset', () => {
  const result = runGuard(undefined)
  assert.notEqual(result.status, 0, 'an unset DSH_HOME must never let a run proceed')
  assert.match(result.stderr, /DSH_HOME is not set/)
})

test('guard fails when DSH_HOME points at the real DSH home', () => {
  const result = runGuard(resolve(homedir(), '.dsh'))
  assert.notEqual(result.status, 0, 'the whole point of the guard is refusing ~/.dsh')
  assert.match(result.stderr, /real DSH home/)
})

test('guard fails when DSH_HOME is not under a temp root', () => {
  // Deliberately anchored at the user home rather than the checkout: a worktree
  // under /tmp is itself inside a temp root, which would make this case vacuous.
  const result = runGuard(join(homedir(), 'dsh-compress-codex-guard-probe', 'dsh'))
  assert.notEqual(result.status, 0, 'a home outside the temp roots must be refused')
  assert.match(result.stderr, /must live under a temp directory/)
})

test('guard passes for a throwaway home under the platform temp root', () => {
  const result = runGuard(join(tmpdir(), 'dsh-compress-codex-guard-ok'))
  assert.equal(result.status, 0, `expected the guard to accept a temp home, got: ${result.stderr}`)
  assert.match(result.stdout, /guard\s*: ok/)
})
