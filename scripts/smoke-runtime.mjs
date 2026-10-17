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
 *   A7  a real multi-turn model session emits compaction/start ->
 *       compaction/summary -> user/message -> compaction/end, with a non-empty
 *       provider/model on the summary.  Opt-in via SMOKE_SESSION=1: the M2 policy
 *       has landed, so the only blocker is a model credential, and this run
 *       drives a real provider; see docs/runtime-verification.md §4.
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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
    // stdin stays open when a caller pipes a task in (A7's long first turn).
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input: options.input,
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

/**
 * Stop before any assertion ran. Exit 2, not 0: "verified nothing" must never be
 * reported as success by the exit code (see the verdict section). Callers that
 * accept an unverified run opt in with SMOKE_ALLOW_SKIP=1.
 */
function bail(reason) {
  console.log('SMOKE RESULT: SKIPPED (' + reason + ')')
  console.log('SMOKE NOTE: this run verified nothing; report it as unverified.')
  console.log('SMOKE NOTE: exit ' + (process.env.SMOKE_ALLOW_SKIP === '1' ? '0 (SMOKE_ALLOW_SKIP=1)' : '2') + ' from here.')
  process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2)
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

  // ------------------------------- A7 session-level (opt-in, real provider)
  const session = sessionAssertion()
  if (session.status === 'SKIPPED') skip('A7 ' + session.reason)
  else if (session.status === 'OK') {
    ok('A7 real session emitted ' + session.sequence)
    console.log('SMOKE     : A7 ' + session.detail)
  } else fail('A7 ' + session.reason)
} catch (error) {
  fail('unexpected smoke error: ' + (error instanceof Error ? error.message : String(error)))
} finally {
  cleanup()
}

/**
 * A7 — drive a real multi-turn session until the compaction policy fires.
 *
 * Two design points that make this test *able* to pass, both learned the hard way:
 *
 *  1. The shipped `headless` template disables the `credentials` row
 *     (`patched by @deepseek-ai/dsh-headless`), so a seeded store alone is not
 *     enough — the A7 overlay re-enables the row so `ctx.get("credentials")`
 *     exists and the file-backed provider is consulted.
 *  2. The default trigger is 90% of the routed model's window (~1M tokens here),
 *     which no short conversation reaches. A "say ok" session therefore fails for
 *     lack of input, not for lack of correctness. The overlay forces an absolute
 *     `triggerLimitTokens: 2000` and keeps a single recent unit, and turn 2 is
 *     what crosses it (turn 1 alone is one structural unit and the newest unit is
 *     always retained, so it legitimately compacts nothing).
 */
function sessionAssertion() {
  if (process.env.SMOKE_SESSION !== '1') {
    return { status: 'SKIPPED', reason: 'A7 drives a real multi-turn model session and is opt-in; the M2 policy has landed, so the only blocker is a credential. Re-run with SMOKE_SESSION=1 (see docs/runtime-verification.md §4)' }
  }

  // Credential: seed the throwaway home from the real store (the real home is
  // only ever READ). Everything else happens inside the temp home.
  const store = join(home, '.credentials.yaml')
  if (!existsSync(store) && process.env.DEEPSEEK_API_KEY === undefined) {
    const realStore = join(homedir(), '.dsh', '.credentials.yaml')
    if (!existsSync(realStore)) {
      return { status: 'SKIPPED', reason: 'no credential available: neither DEEPSEEK_API_KEY nor ' + realStore }
    }
    copyFileSync(realStore, store)
    chmodSync(store, 0o600) // the provider refuses a document readable beyond its owner
  }

  const profile = PROFILE + '-session'
  dsh(['--profile', profile, '--from-default-profile', 'headless', '--dump-config'])
  dsh(['plugin', '--profile', profile, 'add', REPO_ROOT])

  const overlay = join(home, 'a7-overlay.yml')
  writeFileSync(overlay, [
    '- id: credentials',
    '  disabled: false',
    '- id: compaction-codex',
    '  config:',
    '    triggerLimitTokens: 2000',
    '    retainRecentUnits: 1',
    ''
  ].join('\n'))

  const sentence = 'The DSH compaction seam summarises the oldest balanced span while keeping a recent tail verbatim. '
  let prompt = 'Read the reference text and reply with exactly the single word ACK.\n\n'
  while (prompt.length < 14_000) prompt += sentence

  const first = dsh(['--profile', profile, '--patch', overlay, '-'], { timeout: 300_000, input: prompt })
  if (first.code !== 0) return { status: 'FAIL', reason: 'turn 1 failed (exit ' + first.code + '): ' + brief(first.err || first.out) }
  const sessionDir = newestSessionDir(home)
  if (sessionDir === null) return { status: 'FAIL', reason: 'turn 1 wrote no session directory under $DSH_HOME/sessions' }

  const second = dsh(['--profile', profile, '--patch', overlay, '--session-id', basename(sessionDir), 'reply with the single word DONE'], { timeout: 300_000 })
  if (second.code !== 0) return { status: 'FAIL', reason: 'turn 2 failed (exit ' + second.code + '): ' + brief(second.err || second.out) }

  const sessionFile = newestSessionFile(home)
  if (sessionFile === null) return { status: 'FAIL', reason: 'no session file under $DSH_HOME/sessions' }
  const events = decodeSessionEvents(sessionFile)
  if (events === null) return { status: 'FAIL', reason: 'the session log did not decode into events: ' + sessionFile }

  const start = events.find((event) => event.type === 'compaction/start')
  if (start === undefined) {
    return { status: 'FAIL', reason: 'the session emitted no compaction/start — triggerLimitTokens=2000 was never crossed (routed model: ' + sessionFile + ')' }
  }
  const id = start.data === undefined ? undefined : start.data.compactionId
  const summary = events.find((event) => event.type === 'compaction/summary' && event.data !== undefined && event.data.compactionId === id)
  if (summary === undefined) return { status: 'FAIL', reason: 'compaction/start ' + String(id) + ' has no matching compaction/summary' }
  const end = events.find((event) => event.type === 'compaction/end' && event.data !== undefined && event.data.compactionId === id)
  if (end === undefined) return { status: 'FAIL', reason: 'compaction/start ' + String(id) + ' was never closed by compaction/end' }
  if (!(start.seq < summary.seq && summary.seq < end.seq)) {
    return { status: 'FAIL', reason: 'the transaction is out of order: start=' + start.seq + ' summary=' + summary.seq + ' end=' + end.seq }
  }

  const replacement = events.find((event) => event.type === 'user/message' && event.seq === summary.seq + 1)
  if (replacement === undefined) return { status: 'FAIL', reason: 'no user/message immediately after compaction/summary seq ' + summary.seq + ' (C3 adjacency)' }
  if (!JSON.stringify(replacement.data === undefined ? {} : replacement.data).includes('<compacted-summary>')) {
    return { status: 'FAIL', reason: 'the replacement user/message is not framed as <compacted-summary>' }
  }

  const provider = summary.data.provider
  const model = summary.data.model
  if (typeof provider !== 'string' || provider.length === 0) return { status: 'FAIL', reason: 'compaction/summary carries an empty provider (the summary is not a real model call)' }
  if (typeof model !== 'string' || model.length === 0) return { status: 'FAIL', reason: 'compaction/summary carries an empty model' }
  const summaryText = (Array.isArray(summary.data.summary) ? summary.data.summary : [])
    .map((block) => (block === null || typeof block !== 'object' ? '' : String(block.text ?? '')))
    .join('')
  if (summaryText.trim().length === 0) return { status: 'FAIL', reason: 'compaction/summary carries no text' }

  return {
    status: 'OK',
    sequence: 'compaction/start(' + start.seq + ') -> compaction/summary(' + summary.seq + ') -> user/message(' + replacement.seq + ') -> compaction/end(' + end.seq + ')',
    detail: 'provider=' + provider + ' model=' + model + ' summaryChars=' + summaryText.length +
      ' shadowedRange=' + JSON.stringify(summary.data.shadowedRange === undefined ? null : summary.data.shadowedRange)
  }
}

/** First 300 characters of a command's diagnostic output, for a FAIL reason. */
function brief(text) {
  return String(text).trim().slice(0, 300)
}

/** Newest `session-*` directory under `$DSH_HOME/sessions`. */
function newestSessionDir(root) {
  const sessionsRoot = join(root, 'sessions')
  if (!existsSync(sessionsRoot)) return null
  const dirs = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name.startsWith('session-')) dirs.push(full)
      walk(full)
    }
  }
  walk(sessionsRoot)
  dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return dirs[0] ?? null
}

/**
 * Decode a session log into its events.
 *
 * `session.v4.jsonl.zstd` is a CONCATENATED multi-frame stream (one frame per
 * append), and `zstdDecompressSync` over the whole file decodes only the FIRST
 * frame — in practice 169 bytes of session header out of a 19 KB log, which looks
 * exactly like "no events were recorded". Scan for the frame magic and decode each
 * frame separately: a magic sequence occurring inside compressed payload fails to
 * decode and is skipped. Returns null when nothing decoded, so the caller reports
 * a decode failure instead of a false negative.
 */
function decodeSessionEvents(file) {
  const bytes = readFileSync(file)
  let text = bytes.toString('utf8')
  if (file.endsWith('.zstd')) {
    const magic = [0x28, 0xb5, 0x2f, 0xfd]
    const parts = []
    for (let i = 0; i <= bytes.length - 4; i += 1) {
      if (bytes[i] !== magic[0] || bytes[i + 1] !== magic[1] || bytes[i + 2] !== magic[2] || bytes[i + 3] !== magic[3]) continue
      try { parts.push(zstdDecompressSync(bytes.subarray(i)).toString('utf8')) } catch { /* not a frame start */ }
    }
    text = parts.join('')
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try { events.push(JSON.parse(line)) } catch { /* torn or foreign line */ }
  }
  return events.length === 0 ? null : events
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

// ------------------------------------------------------------------- verdict
//
// The header says "a skip is NOT a pass"; that has to hold for a *machine*, not
// only for a human reading the log. Exit codes are therefore part of the
// contract, and 0 is reserved for a genuinely complete run:
//
//   0  every assertion passed and none was skipped
//   1  at least one assertion FAILED
//   2  everything that ran passed, but at least one assertion was SKIPPED, so the
//      run is INCOMPLETE and must not be reported as verified
//
// A caller that deliberately does not ask for an opt-in assertion (the
// non-gating `ci / compat-next` job has no model credential, so it never sets
// SMOKE_SESSION=1) declares that scope with SMOKE_ALLOW_SKIP=1, which maps an
// otherwise-clean but incomplete run to 0 — the explicit conclusion line is still
// printed, so nothing is hidden, only the exit code is agreed.
const failed = results.filter(([status]) => status === 'FAIL')
const passed = results.filter(([status]) => status === 'OK').length
const skippedRows = results.filter(([status]) => status === 'SKIP')
const allowSkip = process.env.SMOKE_ALLOW_SKIP === '1'
console.log('SMOKE SUMMARY: ' + passed + ' ok, ' + failed.length + ' failed, ' + skippedRows.length + ' skipped')
if (failed.length > 0) {
  console.log('SMOKE RESULT: FAIL (' + failed.length + ' failing assertion(s))')
  process.exit(1)
}
if (skippedRows.length > 0) {
  const names = skippedRows.map(([, what]) => String(what).split(' ')[0]).join(', ')
  console.log('SMOKE RESULT: INCOMPLETE — PASS WITH ' + skippedRows.length + ' SKIPPED, NOT fully verified (' + names + ')')
  console.log('SMOKE NOTE: re-run without skipping to claim verification' +
    (allowSkip ? '; SMOKE_ALLOW_SKIP=1 therefore exits 0.' : '; this is exit 2.'))
  process.exit(allowSkip ? 0 : 2)
}
console.log('SMOKE RESULT: PASS (complete — no failing, no skipped assertions)')
process.exit(0)
