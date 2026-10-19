#!/usr/bin/env node
/**
 * Generate preset-codex from the AUTHORITATIVE upstream preset file.
 *
 * Why this exists: an agent preset composes its own isolated services
 * (isolate: { compaction: true }) and loader patches address TOP-LEVEL entry ids
 * only, so the isolated compaction group cannot be retargeted by a profile patch.
 * The preset registry has no extends/inheritance: official guidance is to restate
 * the whole plugin list. A hand-copied roster drifts SILENTLY when
 * @deepseek-ai/dsh-web-app changes; this script makes that drift a loud failure.
 *
 * Single source of truth:
 *   <dsh>/node_modules/@deepseek-ai/dsh-web-app/presets/<base>.patch.yml
 * which is a complete "- insert:" patch (not a slice of a composed dump), so the
 * transform below is a counted, exact-match rewrite of a few lines - no
 * indentation reconstruction, and no dependence on the user's own profile patch.
 *
 * Anchor: scripts/preset-anchors.json records the SHA256 of that file. The script
 * verifies it by default and refuses to generate when it does not match, so an
 * upstream change can never be absorbed silently. Re-baseline deliberately with
 * --update-anchor AFTER reviewing the generated diff.
 *
 * Usage:
 *   node scripts/sync-preset-codex.mjs                       # verify + generate
 *   node scripts/sync-preset-codex.mjs --out /tmp/next.yml    # write elsewhere
 *   node scripts/sync-preset-codex.mjs --check                # anchor only (CI)
 *   node scripts/sync-preset-codex.mjs --update-anchor        # re-baseline
 *   node scripts/sync-preset-codex.mjs --selftest             # reverse proofs
 *
 * Shaping the generated preset (all optional; the defaults reproduce the
 * historical output byte for byte, which --selftest asserts):
 *   --preset-id <id>     loader row id        (default preset-codex)
 *   --config-id <id>     registry key         (default codex, must be kebab-case)
 *   --order <n>          preset order         (default 0)
 *   --name <text>        config.name, shown in the Web preset picker
 *   --description <text> config.description, ditto
 * --name/--description are omitted entirely when absent, and are emitted as
 * single-quoted YAML scalars, so ':' '#' '{' '}' quotes and non-ASCII text are
 * literal. A value containing a line break is refused rather than folded.
 * --out defaults to <preset-id>.patch.yml.
 *
 * Exit codes (the check job maps them to PASS / FAIL / INCOMPLETE):
 *   0  anchor verified (and the preset was generated, unless --check)
 *   1  FAIL: anchor mismatch, no anchor recorded, or the upstream shape changed
 *   2  INCOMPLETE: no dsh install / source file reachable, so nothing was verified
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ANCHORS = join(HERE, 'preset-anchors.json')
const WEB_APP_PACKAGE = '@deepseek-ai/dsh-web-app'
const PRESET_DIR = 'presets'
const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_INCOMPLETE = 2

/**
 * Read one --flag value, or undefined when the flag is absent.
 * A flag that is present but has no value - either it is last, or the next
 * token is another flag - is a usage error, not "absent": silently treating
 * it as absent would drop the caller's intent and emit a preset with the
 * default id.
 */
function argValue(name) {
  const index = process.argv.indexOf('--' + name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--' + name + ' needs a value (got ' + (value === undefined ? 'nothing' : value) + ')')
  }
  return value
}

/**
 * Render a string as a YAML single-quoted scalar: a quote is doubled, and a
 * line break is refused because a single-quoted scalar cannot span lines.
 * Values with ':', '#', '{', '}' or non-ASCII text therefore need no escaping.
 */
function yamlScalar(value, label) {
  if (/[\r\n]/.test(value)) {
    throw new Error('--' + label + ' cannot contain a line break')
  }
  return "'" + value.replaceAll("'", "''") + "'"
}

/** True when the flag is present. */
function flag(name) {
  return process.argv.includes('--' + name)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function fail(message) {
  console.error('sync-preset-codex: FAIL: ' + message)
  return EXIT_FAIL
}

/** Candidate source paths derived from one directory. */
function sourceUnder(dir, base) {
  return [
    join(dir, 'node_modules', WEB_APP_PACKAGE, PRESET_DIR, base + '.patch.yml'),
    join(dir, 'node_modules', WEB_APP_PACKAGE, 'dist', PRESET_DIR, base + '.patch.yml')
  ].find((candidate) => existsSync(candidate))
}

/** Resolve the shim/executable named dsh on PATH, without a shell. */
function dshOnPath() {
  const path = process.env.PATH === undefined ? '' : process.env.PATH
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const entry of path.split(delimiter)) {
    if (entry.length === 0) continue
    for (const name of names) {
      const candidate = join(entry, name)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // not there; keep looking
      }
    }
  }
  return undefined
}

/**
 * Walk up from a dsh install to the preset file it ships.
 * A global install keeps the app package nested under the dsh package's own
 * node_modules, so walking ancestors finds it whether dsh was hoisted or not.
 */
function sourceFromDshBinary(bin, base) {
  let dir
  try {
    dir = dirname(realpathSync(bin))
  } catch {
    return undefined
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const found = sourceUnder(dir, base)
    if (found !== undefined) return found
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Locate the upstream preset file. Order: explicit --source, DSH_PRESET_DIR,
 * DSH_BIN / dsh on PATH, then nothing (INCOMPLETE).
 * @returns { path, how } or { path: undefined, reason }.
 */
function resolveSource(base, explicit) {
  if (explicit !== undefined) {
    return existsSync(explicit)
      ? { path: resolve(explicit), how: '--source' }
      : { path: undefined, reason: '--source ' + explicit + ' does not exist' }
  }
  const presetDir = process.env.DSH_PRESET_DIR
  if (presetDir !== undefined && presetDir.length > 0) {
    const candidate = join(presetDir, base + '.patch.yml')
    if (existsSync(candidate)) return { path: candidate, how: 'DSH_PRESET_DIR' }
    return { path: undefined, reason: 'DSH_PRESET_DIR has no ' + base + '.patch.yml' }
  }
  const bin = process.env.DSH_BIN !== undefined && process.env.DSH_BIN.length > 0 ? process.env.DSH_BIN : dshOnPath()
  if (bin !== undefined) {
    const found = sourceFromDshBinary(bin, base)
    if (found !== undefined) return { path: found, how: 'dsh install at ' + bin }
    return { path: undefined, reason: 'dsh found at ' + bin + ' but it ships no ' + PRESET_DIR + '/' + base + '.patch.yml' }
  }
  return { path: undefined, reason: 'no dsh executable on PATH (set DSH_BIN, DSH_PRESET_DIR or --source)' }
}

/**
 * Rewrite the upstream patch into preset-codex. Counted, exact-match rules: any
 * upstream shape change makes one of the counts wrong and fails loud instead of
 * emitting a half-retargeted preset.
 */
function transform(text, options) {
  const base = options.base
  const plugin = options.plugin
  const lines = text.split(/\r?\n/)
  const insertAt = lines.findIndex((line) => line.trim() === '- insert:')
  if (insertAt === -1) throw new Error('upstream file has no top-level "- insert:" patch')
  let body = lines.slice(insertAt)
  const changes = []

  const rewrite = (label, pattern, build) => {
    let seen = 0
    const next = body.map((line) => {
      const match = pattern.exec(line)
      if (match === null) return line
      seen += 1
      return build(match)
    })
    if (seen !== 1) {
      throw new Error('expected exactly 1 ' + label + ' row(s) in the upstream patch, found ' + seen)
    }
    changes.push(label)
    return next
  }

  // --name/--description are optional: when absent this build returns exactly
  // the config.id line, so an unparametrised run stays byte-identical.
  const extra = []
  if (options.name !== undefined) extra.push(m => m[1] + 'name: ' + yamlScalar(options.name, 'name'))
  if (options.description !== undefined) extra.push(m => m[1] + 'description: ' + yamlScalar(options.description, 'description'))

  body = rewrite('inserted preset id', new RegExp('^(\\s*)- id: preset-' + base + '\\s*$'), (m) => m[1] + '- id: ' + options.presetId)
  body = rewrite('preset config.id', new RegExp('^(\\s*)id: ' + base + '\\s*$'), (m) => {
    const lines = [m[1] + 'id: ' + options.configId]
    for (const build of extra) lines.push(build(m))
    return lines.join('\n')
  })
  body = rewrite('preset order', /^(\s*)order:\s*\d+\s*$/, (m) => m[1] + 'order: ' + String(options.order))
  body = rewrite('isolated compaction flag', /^(\s*)compaction:\s*true\s*$/, (m) => m[1] + 'compaction: true')
  body = rewrite('nested compaction row', /^(\s*)- id:\s*compaction-basic\s*$/, (m) => m[1] + '- id: compaction-codex')
  body = rewrite(
    'nested compaction module',
    /^(\s*)name:\s*'@deepseek-ai\/dsh-compaction-basic'\s*$/,
    (m) => m[1] + "name: '" + plugin + "'"
  )

  const header = [
    '# ' + options.presetId + ' -- the shipped "' + base + '" preset whose isolated compaction',
    '# group runs ' + plugin + ' instead of the official backend.',
    '#',
    '# Generated by scripts/sync-preset-codex.mjs from the authoritative upstream file',
    '#   ' + WEB_APP_PACKAGE + '/' + PRESET_DIR + '/' + base + '.patch.yml',
    '# source sha256: ' + options.hash,
    '# Do not hand-edit: re-run the script after upgrading dsh and review the diff.'
  ]
  return { output: header.concat(body).join('\n') + '\n', changes }
}

/** Load the anchor table, or an empty one when the file is absent. */
function readAnchors(path) {
  if (!existsSync(path)) return { baseline: null, sources: {} }
  const parsed = readJson(path)
  const sources = parsed.sources === undefined || parsed.sources === null ? {} : parsed.sources
  return { baseline: parsed.baseline === undefined ? null : parsed.baseline, sources }
}

function writeAnchors(path, anchors) {
  const doc = {
    '//': 'Anchor = SHA256 of the upstream preset file this repo was generated from.',
    '//baseline': 'The @deepseek-ai/dsh version the anchors were recorded against.',
    baseline: anchors.baseline,
    '//sources': 'Keyed by --base name; value = sha256 of <dsh>/node_modules/' + WEB_APP_PACKAGE + '/' + PRESET_DIR + '/<base>.patch.yml',
    sources: anchors.sources
  }
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
}

/** Verify (and optionally re-baseline) the anchor for one base. */
function verifyAnchor(options, resolved, hash) {
  const anchors = readAnchors(options.anchors)
  let expected = anchors.sources[options.base]
  if (flag('update-anchor')) {
    anchors.sources[options.base] = hash
    if (anchors.baseline === null && options.baseline !== undefined) anchors.baseline = options.baseline
    writeAnchors(options.anchors, anchors)
    console.log('sync-preset-codex: anchor updated for ' + options.base + ' -> ' + hash)
    expected = hash
  }
  if (expected === undefined) {
    return fail(
      'no anchor recorded for "' + options.base + '" in ' + options.anchors +
      '; review ' + resolved.path + ' and re-run with --update-anchor'
    )
  }
  if (expected !== hash) {
    console.error('sync-preset-codex: FAIL: the upstream preset changed (anchor mismatch)')
    console.error('  file    : ' + resolved.path)
    console.error('  expected: ' + expected)
    console.error('  actual  : ' + hash)
    console.error('  The vendor preset moved, so preset-codex is stale. Re-run the generator')
    console.error('  and review the diff, then re-baseline with --update-anchor.')
    return EXIT_FAIL
  }
  console.log('sync-preset-codex: anchor verified for ' + options.base + ' (' + hash + ')')
  return EXIT_OK
}

function main() {
  const base = argValue('base') === undefined ? 'standard' : argValue('base')
  // Every default below is today's literal, so a run with no new flag produces
  // byte-identical output (proved by --selftest's "defaults are the literals").
  const options = {
    base,
    plugin: argValue('plugin') === undefined ? 'dsh-compress-codex' : argValue('plugin'),
    presetId: argValue('preset-id') === undefined ? 'preset-codex' : argValue('preset-id'),
    configId: argValue('config-id') === undefined ? 'codex' : argValue('config-id'),
    order: argValue('order') === undefined ? '0' : argValue('order'),
    name: argValue('name'),
    description: argValue('description'),
    out: argValue('out'),
    anchors: argValue('anchors') === undefined ? DEFAULT_ANCHORS : resolve(argValue('anchors')),
    baseline: argValue('baseline')
  }
  if (options.out === undefined) options.out = options.presetId + '.patch.yml'
  if (!/^\d+$/.test(options.order)) {
    return fail('--order must be a non-negative integer, got "' + options.order + '"')
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.configId)) {
    return fail('--config-id must be kebab-case (registry key), got "' + options.configId + '"')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.presetId)) {
    return fail('--preset-id must be a plain loader row id, got "' + options.presetId + '"')
  }
  const resolved = resolveSource(base, argValue('source'))
  if (resolved.path === undefined) {
    console.error('sync-preset-codex: INCOMPLETE: ' + resolved.reason)
    console.error('sync-preset-codex: nothing was verified; set DSH_BIN, DSH_PRESET_DIR or --source.')
    return EXIT_INCOMPLETE
  }
  const text = readFileSync(resolved.path, 'utf8')
  const hash = sha256(text)
  console.log('sync-preset-codex: source ' + resolved.path + ' (' + resolved.how + ')')
  const verified = verifyAnchor(options, resolved, hash)
  if (verified !== EXIT_OK) return verified
  if (flag('check')) {
    console.log('sync-preset-codex: check only; preset not written')
    return EXIT_OK
  }
  let generated
  try {
    generated = transform(text, {
      base,
      plugin: options.plugin,
      presetId: options.presetId,
      configId: options.configId,
      order: options.order,
      name: options.name,
      description: options.description,
      hash
    })
  } catch (error) {
    return fail('cannot retarget the upstream patch: ' + error.message)
  }
  writeFileSync(options.out, generated.output)
  console.log('sync-preset-codex: wrote ' + options.out + ' (retargeted: ' + generated.changes.join(', ') + ')')
  return EXIT_OK
}

/**
 * Fault injection: prove the anchor check and the shape checks can fail. Runs
 * against a throwaway copy of the real upstream file, so it never touches the
 * repository or the installed dsh.
 */
function selftest() {
  const base = argValue('base') === undefined ? 'standard' : argValue('base')
  const resolved = resolveSource(base, argValue('source'))
  if (resolved.path === undefined) {
    console.log('PRESET-SYNC SELFTEST: INCOMPLETE (' + resolved.reason + ')')
    return EXIT_INCOMPLETE
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preset-selftest-'))
  const script = fileURLToPath(import.meta.url)
  const results = []
  const run = (args) => spawnSync(process.execPath, [script].concat(args), { encoding: 'utf8' })
  const record = (label, ok, status, expected) => {
    results.push({ label, ok })
    console.log('PRESET-SYNC SELFTEST: ' + (ok ? 'ok   ' : 'FAIL ') + label + ' (exit ' + status + ', expected ' + expected + ')')
  }
  const expectExit = (label, expected, args) => {
    const result = run(args)
    record(label, result.status === expected, result.status, expected)
    return result
  }
  const source = join(dir, 'standard.patch.yml')
  const anchors = join(dir, 'anchors.json')
  const out = join(dir, 'out.yml')
  try {
    copyFileSync(resolved.path, source)
    const pristine = readFileSync(source, 'utf8')
    const good = sha256(pristine)
    const baseArgs = ['--source', source, '--anchors', anchors]
    writeAnchors(anchors, { baseline: 'selftest', sources: { [base]: good } })
    expectExit('pristine source generates', EXIT_OK, baseArgs.concat(['--out', out]))
    const generated = readFileSync(out, 'utf8')
    // Assert against the ids this run actually used, not hard-coded literals:
    // otherwise changing a default would turn these into vacuous checks.
    const retargeted =
      generated.includes('- id: preset-codex') &&
      generated.includes('id: codex') &&
      generated.includes('id: compaction-codex') &&
      generated.includes("name: 'dsh-compress-codex'") &&
      !generated.includes('@deepseek-ai/dsh-compaction-basic')
    record('generated preset is retargeted', retargeted, retargeted ? EXIT_OK : 99, EXIT_OK)

    // The regression that keeps parametrisation honest: an unparametrised run
    // must be byte-identical to an explicit run passing today's literals.
    // Any future default change breaks this, and a change that silently stops
    // emitting the literals breaks it too.
    const plain = join(dir, 'plain.yml')
    const explicit = join(dir, 'explicit.yml')
    expectExit('defaults generate', EXIT_OK, baseArgs.concat(['--out', plain]))
    expectExit(
      'explicit literals generate',
      EXIT_OK,
      baseArgs.concat(['--preset-id', 'preset-codex', '--config-id', 'codex', '--order', '0', '--out', explicit])
    )
    const same = readFileSync(plain, 'utf8') === readFileSync(explicit, 'utf8')
    record('defaults are exactly the literals', same, same ? EXIT_OK : 99, EXIT_OK)

    // Parametrised run: ids, order and the two optional metadata lines.
    const custom = join(dir, 'custom.yml')
    expectExit(
      'parametrised ids generate',
      EXIT_OK,
      baseArgs.concat([
        '--preset-id', 'preset-codex-ptc', '--config-id', 'codex-ptc', '--order', '5',
        '--name', "Codex (PTC)", '--description', "keep 'run_code' : #1 {ok}", '--out', custom
      ])
    )
    const customText = readFileSync(custom, 'utf8')
    const customOk =
      customText.includes('- id: preset-codex-ptc') &&
      customText.includes('id: codex-ptc') &&
      customText.includes('order: 5') &&
      customText.includes("name: 'Codex (PTC)'") &&
      customText.includes("description: 'keep ''run_code'' : #1 {ok}'") &&
      customText.includes('# preset-codex-ptc -- the shipped')
    record('parametrised ids land in the right rows', customOk, customOk ? EXIT_OK : 99, EXIT_OK)

    expectExit(
      'a line break in --name is refused',
      EXIT_FAIL,
      baseArgs.concat(['--name', 'two' + String.fromCharCode(10) + 'lines', '--out', custom])
    )
    expectExit('a flag swallowed as a value is refused', EXIT_FAIL, baseArgs.concat(['--name', '--out', custom]))
    expectExit('a non-numeric --order is refused', EXIT_FAIL, baseArgs.concat(['--order', 'first', '--out', custom]))
    expectExit('a non-kebab --config-id is refused', EXIT_FAIL, baseArgs.concat(['--config-id', 'Codex PTC', '--out', custom]))

    writeAnchors(anchors, { baseline: 'selftest', sources: { [base]: 'f'.repeat(64) } })
    expectExit('tampered anchor fails', EXIT_FAIL, baseArgs.concat(['--check']))

    writeAnchors(anchors, { baseline: 'selftest', sources: { [base]: good } })
    writeFileSync(source, pristine + "          - id: tool-upstream-new\n            name: '@deepseek-ai/dsh-tool-upstream-new'\n")
    expectExit('simulated upstream change fails', EXIT_FAIL, baseArgs.concat(['--check']))

    const changed = readFileSync(source, 'utf8')
    writeAnchors(anchors, { baseline: 'selftest', sources: { [base]: sha256(changed) } })
    expectExit('re-baselined upstream change passes', EXIT_OK, baseArgs.concat(['--check']))

    writeFileSync(source, changed.replace('- id: compaction-basic', '- id: compaction-renamed'))
    writeAnchors(anchors, { baseline: 'selftest', sources: { [base]: sha256(readFileSync(source, 'utf8')) } })
    expectExit('lost retarget row fails', EXIT_FAIL, baseArgs.concat(['--out', out]))

    rmSync(anchors, { force: true })
    expectExit('missing anchor fails', EXIT_FAIL, baseArgs.concat(['--check']))
    rmSync(source, { force: true })
    expectExit('missing source is INCOMPLETE, never PASS', EXIT_INCOMPLETE, baseArgs.concat(['--check']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const failed = results.filter((row) => !row.ok)
  if (failed.length > 0) {
    console.log('PRESET-SYNC SELFTEST: FAIL (' + failed.length + ' of ' + results.length + ' expectations missed)')
    return EXIT_FAIL
  }
  console.log('PRESET-SYNC SELFTEST: PASS (' + results.length + ' expectations met)')
  return EXIT_OK
}

/** Entry point: a usage error is a FAIL with a one-line message, not a stack trace. */
function run() {
  try {
    return flag('selftest') ? selftest() : main()
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

process.exit(run())
