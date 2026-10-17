import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('../scripts/assert-isolated-home.mjs', import.meta.url))

/** Run the guard with a controlled DSH_HOME; `undefined` leaves it unset. */
function runGuard(dshHome, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
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

test('guard resolves DSH_HOME and the temp roots through the same resolver', (t) => {
  // Reproduces the macOS shape (/var/folders -> /private/var/folders) on any host:
  // the temp root is a link and DSH_HOME is a child of it. If only one side is
  // realpath'ed, the containment check compares a resolved home against an
  // unresolved root and refuses a legitimate throwaway home. A guard that
  // false-rejects is a guard people learn to bypass.
  //
  // Windows (terminal-verification F7): `mklink /D` needs elevation, so a symbolic
  // link is not available on a stock runner — but a *directory junction* is
  // created without elevation and resolves through the same
  // GetFinalPathNameByHandle path, so it reproduces the same two-spellings shape.
  // We therefore attempt the junction instead of skipping Windows outright, and
  // only skip when even that is refused; the residual gap is recorded in
  // docs/final-verification.md (F7).
  const base = mkdtempSync(join(tmpdir(), 'dsh-guard-sym-'))
  try {
    const realRoot = join(base, 'real-root')
    mkdirSync(realRoot, { recursive: true })
    const linkRoot = join(base, 'link-root')
    try {
      symlinkSync(realRoot, linkRoot, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (process.platform === 'win32') {
        t.skip('this Windows runner refused an elevation-free junction: ' + String(error && error.code))
        return
      }
      throw error
    }
    const home = join(linkRoot, 'dsh')
    mkdirSync(home, { recursive: true })

    const result = runGuard(home, { TMPDIR: linkRoot, TMP: linkRoot, TEMP: linkRoot })
    assert.equal(
      result.status,
      0,
      'a linked temp root must still accept its own child home; stderr: ' + result.stderr
    )
    assert.match(result.stdout, /guard\s*: ok/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
