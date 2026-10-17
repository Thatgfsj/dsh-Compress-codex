#!/usr/bin/env node
/**
 * M4-12 (#12) — real-runtime smoke test.
 *
 * Proves, against a throwaway DSH_HOME and a throwaway `dsh plugin add` profile,
 * that this bundle really replaces the compaction backend *in a booting dsh
 * process* — not merely in a composed config tree:
 *
 *   A1  `dsh plugin add <repo>` accepts this package into a fresh profile
 *   A2  the official `compaction-basic` row is disabled *by our layer*, and the
 *       dump attributes the patch to dsh-compress-codex
 *   A3  our `compaction-codex` row is mounted and resolves to this package
 *   A4  the loader reported no unresolved patch target ("patch: entry ... not found")
 *   A5  negative control: a stock headless profile *without* this bundle keeps
 *       compaction-basic enabled, so A2 measures our patch and not the template
 *   A6  real boot: inside a booting dsh process, this package's `mountEngine()`
 *       resolves the real `@deepseek-ai/dsh-compaction-basic` and constructs
 *       CodexCompactionEngine; no "cannot load" line is emitted
 *   A7  (M2-gated) a real session emits compaction/start -> compaction/summary ->
 *       user/message -> compaction/end.  SKIPPED until #4/#5/#6 land and a model
 *       credential is available; see docs/runtime-verification.md.
 *
 * Why the profile must come from `dsh plugin add` and not a shipped template:
 * the `web` template disables compaction-basic on its own (owned by
 * @deepseek-ai/dsh-web-app), so a template-based smoke would be a false green.
 *
 * Not part of the CI gate: it needs a real `dsh` plus pnpm, while the gate runs
 * with zero node_modules so a registry outage can never block main. Missing
 * prerequisites print SMOKE RESULT: SKIPPED and exit 0 — a skip is NOT a pass.
 *
 * Usage: node scripts/smoke-runtime.mjs
 * Env:   DSH_BIN (default: dsh), SMOKE_PROFILE (default: codexrtsmoke),
 *        SMOKE_KEEP=1 to keep the temp home, SMOKE_SESSION=1 to attempt A7.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = process.env.DSH_BIN || 'dsh'
const PROFILE = process.env.SMOKE_PROFILE || 'codexrtsmoke'
const CONTROL = PROFILE + '-control'
const BOOT_PROFILE = PROFILE + '-boot'
const WIN = process.platform === 'win32'

const results = []
function ok(what) { results.push(['OK', what]); console.log('SMOKE OK  : ' + what) }
function fail(what) { results.push(['FAIL', what]); console.log('SMOKE FAIL: ' + what) }
function skip(what) { results.push(['SKIP', what]); console.log('SMOKE SKIP: ' + what) }

/** Run a command, never throwing; returns { code, out, err }. */
function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 180_000,
    cwd: options.cwd ?? REPO_ROOT,
    env: process.env
  })
  return {
    code: result.status ?? (result.error ? 1 : 0),
    out: result.stdout ?? '',
    err: (result.stderr ?? '') + (result.error ? String(result.error.message) : '')
  }
}

function dsh(args, options) { return run(DSH, args, options) }

/** Extract the `# == <annotation>` line and the block of one `- id: <id>` entry. */
function blockFor(dump, id) {
  const lines = dump.split(/\r?\n/)
  let annotation = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('# == ')) { annotation = line; continue }
    if (!line.startsWith('- id: ')) continue
    if (line.slice('- id: '.length).trim() !== id) continue
    const block = [annotation, line]
    for (let j = i + 1; j < lines.length && /^\s{2}/.test(lines[j]); j++) block.push(lines[j])
    return block.join('\n')
  }
  return ''
}

function bail(reason) {
  console.log('SMOKE RESULT: SKIPPED (' + reason + ')')
  console.log('SMOKE NOTE: this run verified nothing; report it as unverified.')
  process.exit(0)
}

// ---------------------------------------------------------------- prerequisites
if (!existsSync(join(REPO_ROOT, 'package.json'))) bail('run from the repository root')
if (run(WIN ? 'where' : 'which', [DSH]).code !== 0) bail(DSH + ' is not on PATH')
if (run(WIN ? 'where' : 'which', ['pnpm']).code !== 0) bail('pnpm is not on PATH, and "dsh plugin add" needs it')

const home = join(tmpdir(), 'dsh-compress-codex-runtime-' + process.pid)
process.env.DSH_HOME = home
const guard = run(process.execPath, [join(REPO_ROOT, 'scripts', 'assert-isolated-home.mjs')])
if (guard.code !== 0) bail('isolated-home guard refused this DSH_HOME:\n' + guard.err.trim())

mkdirSync(home, { recursive: true })
const cleanup = () => { if (process.env.SMOKE_KEEP !== '1') rmSync(home, { recursive: true, force: true }) }
console.log('SMOKE     : DSH_HOME=' + home)
console.log('SMOKE     : ' + DSH + ' = ' + dsh(['--version']).out.trim())

try {
  // ------------------------------------------------------------ A1 install
  const add = dsh(['plugin', '--profile', PROFILE, 'add', REPO_ROOT])
  if (add.code === 0 && /dsh-compress-codex/.test(add.out + add.err)) ok('A1 dsh plugin add accepted this package')
  else fail('A1 dsh plugin add failed (exit ' + add.code + '):\n' + (add.err || add.out).trim())

  // ------------------------------------------- A2/A3/A4 composed tree + loader
  const dump = dsh(['--profile', PROFILE, '--dump-config'])
  if (dump.code !== 0) {
    fail('A2/A3 could not dump the profile (exit ' + dump.code + '):\n' + dump.err.trim())
  } else {
    const basic = blockFor(dump.out, 'compaction-basic')
    if (!basic) fail('A2 compaction-basic row is missing from the composed tree; the assertion would be vacuous')
    else if (!basic.includes('disabled: true')) fail('A2 compaction-basic is not disabled after our layer:\n' + basic)
    else if (!basic.includes('dsh-compress-codex')) fail('A2 compaction-basic is disabled, but not attributed to our layer:\n' + basic)
    else ok('A2 compaction-basic disabled by this bundle')

    const codex = blockFor(dump.out, 'compaction-codex')
    if (!codex.includes('name: dsh-compress-codex') && !codex.includes("name: 'dsh-compress-codex'")) {
      fail('A3 compaction-codex is not mounted as this package:\n' + (codex || '(row absent)'))
    } else ok('A3 compaction-codex mounted from this package')

    const loaderText = dump.out + '\n' + dump.err
    if (/patch: entry .* not found/.test(loaderText)) fail('A4 loader could not resolve a patch target:\n' + loaderText.match(/.*patch: entry.*/g).join('\n'))
    else ok('A4 no unresolved patch target ("patch: entry ... not found")')
  }

  // --------------------------------------------------- A5 negative control
  const control = dsh(['--profile', CONTROL, '--from-default-profile', 'headless', '--dump-config'])
  const controlBasic = blockFor(control.out, 'compaction-basic')
  if (!controlBasic) fail('A5 negative control found no compaction-basic row; the assertion would be vacuous')
  else if (controlBasic.includes('disabled: true')) fail('A5 negative control: compaction-basic is already disabled without this bundle:\n' + controlBasic)
  else ok('A5 negative control: compaction-basic stays live without this bundle')

  // ------------------------------------------------- A6 real boot / real mount
  // The probe runs *inside* the booting dsh process, from a file under the
  // profile dir, so it exercises the same module resolution the loader uses.
  // NOTE: plain `node` cannot resolve @deepseek-ai/* from a profile directory —
  // the boot-time runtime resolution supplies them. Do not "fix" this by
  // resolving from a bare node process; that check produces a false negative.
  dsh(['--profile', BOOT_PROFILE, '--from-default-profile', 'headless', '--dump-config'])
  dsh(['plugin', '--profile', BOOT_PROFILE, 'add', REPO_ROOT])
  const profileDir = join(home, 'profiles', BOOT_PROFILE)
  const probePath = join(profileDir, 'probe-mount.mjs')
  const overlayPath = join(home, 'probe-overlay.yml')
  writeFileSync(probePath, [
    'export const name = "probe-mount"',
    'export async function apply() {',
    '  const mod = await import("dsh-compress-codex")',
    '  const fiber = await mod.mountEngine({ plugin: (E, c) => ({ mounted: E.name, configKind: typeof c }) }, {})',
    '  console.error("[probe-mount] mountEngine -> " + JSON.stringify(fiber))',
    '}',
    ''
  ].join('\n'))
  writeFileSync(overlayPath, '- insert:\n    - id: probe-mount\n      name: ' + JSON.stringify(probePath) + '\n')
  const boot = dsh(['--profile', BOOT_PROFILE, '--patch', overlayPath], { timeout: 120_000 })
  const bootText = boot.out + '\n' + boot.err
  const mountLine = bootText.match(/\[probe-mount\] mountEngine -> (.*)/)
  if (/cannot load @deepseek-ai\/dsh-compaction-basic/.test(bootText)) {
    fail('A6 the seam did NOT install itself in a real boot:\n' + bootText.trim())
  } else if (!mountLine) {
    fail('A6 the boot never reached the mount probe (exit ' + boot.code + '):\n' + bootText.trim())
  } else if (!mountLine[1].includes('CodexCompactionEngine')) {
    fail('A6 mounted something unexpected: ' + mountLine[1])
  } else if (!/a task is required/.test(bootText)) {
    fail('A6 the probe ran but the boot did not reach the app stage:\n' + bootText.trim())
  } else {
    ok('A6 real boot: real base resolved, CodexCompactionEngine mounted, no load failure')
  }

  // ------------------------------------------- A7 session-level (M2-gated)
  const session = sessionAssertion()
  if (session.status === 'SKIPPED') skip('A7 ' + session.reason)
  else if (session.status === 'OK') ok('A7 session emitted ' + session.sequence)
  else fail('A7 ' + session.reason)
} catch (error) {
  fail('unexpected smoke error: ' + (error instanceof Error ? error.message : String(error)))
} finally {
  cleanup()
}

function sessionAssertion() {
  if (process.env.SMOKE_SESSION !== '1') {
    return { status: 'SKIPPED', reason: 'session-level compaction needs the M2 policy (#4/#5/#6). Re-enable with SMOKE_SESSION=1 once M2 is merged and a model credential is present' }
  }
  if (!process.env.DEEPSEEK_API_KEY) return { status: 'SKIPPED', reason: 'SMOKE_SESSION=1 but DEEPSEEK_API_KEY is unset' }
  const boot = dsh(['--profile', PROFILE, 'say ok'], { timeout: 300_000 })
  const combined = boot.out + boot.err
  if (/MISSING_CREDENTIAL|no API key/.test(combined)) return { status: 'SKIPPED', reason: 'no usable credential for the routed model' }
  const sessionFile = newestSessionFile(home)
  if (!sessionFile) return { status: 'FAIL', reason: 'no session file was written under $DSH_HOME/sessions' }
  const text = decompress(sessionFile)
  // Ordered subsequence over the durable event types recorded by dsh-compaction.
  const wanted = ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']
  let cursor = 0
  const seen = []
  for (const needle of wanted) {
    const at = text.indexOf(needle, cursor)
    if (at === -1) return { status: 'FAIL', reason: 'session did not emit ' + wanted.join(' -> ') + ' in order; missing "' + needle + '" after offset ' + cursor }
    seen.push(needle)
    cursor = at + needle.length
  }
  return { status: 'OK', sequence: seen.join(' -> ') }
}

function newestSessionFile(root) {
  const sessionsRoot = join(root, 'sessions')
  if (!existsSync(sessionsRoot)) return null
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) found.push(full)
    }
  }
  walk(sessionsRoot)
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return found[0] ?? null
}

function decompress(file) {
  const bytes = readFileSync(file)
  if (file.endsWith('.zstd')) {
    try { return zstdDecompressSync(bytes).toString('utf8') } catch { return '' }
  }
  return bytes.toString('utf8')
}

// ------------------------------------------------------------------- verdict
const failed = results.filter(([status]) => status === 'FAIL')
const passed = results.filter(([status]) => status === 'OK').length
const skipped = results.filter(([status]) => status === 'SKIP').length
console.log('SMOKE SUMMARY: ' + passed + ' ok, ' + failed.length + ' failed, ' + skipped + ' skipped')
console.log(failed.length === 0 ? 'SMOKE RESULT: PASS' : 'SMOKE RESULT: FAIL')
process.exit(failed.length === 0 ? 0 : 1)
