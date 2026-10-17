#!/usr/bin/env node
/**
 * M5-15 (#15) — release artifact verifier.
 *
 * dsh display metadata fails **silently**: a missing icon, or an `exports` map that
 * forgets `./package.json` / `./locale/*.json`, produces no error and no log — the
 * plugin is simply installed "and nothing happens". A verifier that only prints OK
 * is therefore worthless here, so this script is built to be *discriminating*, and
 * `--selftest` proves it by injecting each known fault and asserting we catch it.
 *
 * Checks (against a real `npm pack` tarball, not the working tree):
 *   1. every shipped path is covered by `files[]`
 *   2. everything `files[]` declares actually ships
 *   3. every `exports` subpath resolves inside the tarball (globs must match >= 1 file)
 *   4. `./package.json` and `./locale/*.json` are exported when `exports` exists
 *   5. the icon exists, stays inside the package after realpath, is <= 256 KiB,
 *      is SVG/PNG/JPEG/WebP, and is actually packed
 *   6. every packed `locale/*.json` has a non-empty `meta.title` and `meta.description`
 *   7. `dsh.bundle.patch` is declared and packed
 *
 * Usage:
 *   node scripts/verify-pack.mjs              # verify this repository
 *   node scripts/verify-pack.mjs --selftest   # verify, then prove the checks bite
 *   node scripts/verify-pack.mjs --dir <path> # verify another package directory
 *   node scripts/verify-pack.mjs --keep       # keep the temporary pack directory
 *
 * Exit codes: 0 all checks pass (and, with --selftest, every injected fault was
 * caught); 1 otherwise.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICON_MAX_BYTES = 256 * 1024
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const WIN = process.platform === 'win32'

/** ---- small helpers (no regexes, so the file stays readable) ------------- */

/**
 * Match a path against a npm-exports-style glob. '*' means "any run of
 * characters" and may appear inside a segment, which is exactly the shape of
 * `./locale/*.json` — matching only whole-segment '*' would silently treat that
 * key as unresolved and defeat check 3.
 */
function matchesGlob(pattern, path) {
  const segments = pattern.split('*')
  if (segments.length === 1) return pattern === path
  if (!path.startsWith(segments[0])) return false
  let cursor = segments[0].length
  for (let i = 1; i < segments.length; i += 1) {
    const literal = segments[i]
    if (i === segments.length - 1) {
      return path.endsWith(literal) && path.length - literal.length >= cursor
    }
    const found = path.indexOf(literal, cursor)
    if (found === -1) return false
    cursor = found + literal.length
  }
  return true
}

/** Collect every string target reachable in a conditional `exports` entry. */
function collectExportTargets(target) {
  if (typeof target === 'string') return [target]
  if (target === null || typeof target !== 'object') return []
  const found = []
  for (const value of Object.values(target)) found.push(...collectExportTargets(value))
  return found
}

/** Files npm always packs, even when `files[]` does not mention them. */
function isImplicitlyPacked(path) {
  return (
    path === 'package.json' ||
    path.startsWith('README') ||
    path.startsWith('LICENSE') ||
    path.startsWith('LICENCE') ||
    path.startsWith('CHANGELOG')
  )
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function toPosix(path) {
  const posix = path.split(sep).join('/')
  return posix.startsWith('./') ? posix.slice(2) : posix
}

/** ---- packing ------------------------------------------------------------ */

function pack(dir, keep) {
  const dest = mkdtempSync(join(tmpdir(), 'verify-pack-out-'))
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: dir,
    encoding: 'utf8',
    shell: WIN,
    timeout: 180_000
  })
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || 'npm pack exited ' + result.status).trim() }
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    return { ok: false, error: 'npm pack --json produced unparsable output: ' + error.message }
  }
  const entry = parsed[0]
  if (!entry || !Array.isArray(entry.files)) return { ok: false, error: 'npm pack --json reported no files' }
  const cleanup = () => { if (!keep) rmSync(dest, { recursive: true, force: true }) }
  return {
    ok: true,
    cleanup,
    tarball: entry.filename,
    paths: entry.files.map((file) => file.path),
    sizes: new Map(entry.files.map((file) => [file.path, file.size]))
  }
}

/** ---- the checks --------------------------------------------------------- */

function verify(dir, options = {}) {
  const findings = []
  const fail = (code, message) => findings.push({ level: 'FAIL', code, message })
  const warn = (code, message) => findings.push({ level: 'WARN', code, message })

  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    fail('manifest-missing', 'no package.json under ' + dir)
    return { findings, packed: null }
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail('manifest-invalid', 'package.json is not valid JSON: ' + error.message)
    return { findings, packed: null }
  }

  const packed = pack(dir, options.keep === true)
  if (!packed.ok) {
    fail('pack-failed', packed.error)
    return { findings, packed: null }
  }
  const shipped = new Set(packed.paths)

  // 1 + 2. files[] <-> tarball, in both directions.
  const declared = (Array.isArray(pkg.files) ? pkg.files : []).map(toPosix)
  if (declared.length === 0) warn('files-empty', 'package.json declares no files[]; npm falls back to shipping everything not ignored')
  for (const path of shipped) {
    if (isImplicitlyPacked(path)) continue
    if (declared.some((rule) => path === rule || path.startsWith(rule + '/'))) continue
    fail('files-uncovered', 'tarball ships ' + path + ' but files[] does not declare it')
  }
  for (const rule of declared) {
    if (!existsSync(join(dir, rule))) continue
    const covered = [...shipped].some((path) => path === rule || path.startsWith(rule + '/'))
    if (!covered) fail('files-not-packed', 'files[] declares ' + rule + ' but nothing from it is in the tarball')
  }

  // 3 + 4. exports subpaths resolve; display metadata cannot be silently dropped.
  const exportsMap = pkg.exports
  if (exportsMap === undefined || exportsMap === null || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    warn('exports-absent', 'package.json has no exports map; subpath resolution falls back to raw file paths')
  } else {
    for (const [key, target] of Object.entries(exportsMap)) {
      // Condition objects ({"types": ..., "default": ...}) are resolved
      // recursively: every string leaf must exist in the tarball, otherwise a
      // subpath resolves for nobody at runtime.
      const leaves = collectExportTargets(target)
      if (leaves.length === 0) {
        warn('exports-empty', 'exports["' + key + '"] carries no string target to check')
        continue
      }
      for (const leaf of leaves) {
        const rel = toPosix(leaf)
        if (key.includes('*')) {
          const matches = [...shipped].filter((path) => matchesGlob(rel, path))
          if (matches.length === 0) fail('exports-unresolved', 'exports["' + key + '"] -> ' + leaf + ' matches nothing in the tarball')
        } else if (!shipped.has(rel)) {
          fail('exports-unresolved', 'exports["' + key + '"] -> ' + leaf + ' is not in the tarball')
        }
      }
    }
    if (!Object.keys(exportsMap).includes('./package.json')) {
      fail('exports-metadata', 'exports exists but does not export "./package.json"; dsh display metadata is dropped silently')
    }
    if (!Object.keys(exportsMap).some((key) => key.startsWith('./locale/'))) {
      fail('exports-metadata', 'exports exists but does not export ./locale/*.json; dsh display metadata is dropped silently')
    }
  }

  // 5. icon: reference exists, stays inside, size/format legal, and actually ships.
  const viaField = typeof pkg.icon === 'string' ? pkg.icon : null
  const viaExports = exportsMap && typeof exportsMap['./icon'] === 'string' ? exportsMap['./icon'] : null
  const iconRef = viaField ?? viaExports
  if (iconRef === null) {
    fail('icon-missing', 'no display icon: set package.json.icon (preferred) or exports["./icon"]; without it the plugin shows no metadata and fails silently')
  } else {
    const abs = resolve(dir, iconRef)
    // Containment is checked before existence: a path that escapes must be
    // reported as an escape even when the file it points at is absent, otherwise
    // the diagnostic lies about what is wrong.
    if (!isInside(resolve(dir), abs)) {
      fail('icon-escape', 'icon ' + iconRef + ' resolves outside the package; dsh rejects it')
    } else if (!existsSync(abs)) {
      fail('icon-absent', 'icon ' + iconRef + ' does not exist')
    } else {
      let realRoot = dir
      let realIcon = abs
      try {
        realRoot = realpathSync(dir)
        realIcon = realpathSync(abs)
      } catch {
        warn('icon-realpath', 'could not realpath the icon; checked the literal path only')
      }
      if (!isInside(realRoot, realIcon)) {
        fail('icon-escape', 'icon ' + iconRef + ' resolves outside the package (' + realIcon + '); dsh rejects it')
      } else {
        const stats = statSync(realIcon)
        if (!stats.isFile()) fail('icon-not-file', 'icon ' + iconRef + ' is not a regular file')
        if (stats.size > ICON_MAX_BYTES) {
          fail('icon-too-large', 'icon is ' + stats.size + ' bytes; the limit is ' + ICON_MAX_BYTES)
        }
        if (!ICON_EXTENSIONS.has(extname(realIcon).toLowerCase())) {
          fail('icon-format', 'icon extension ' + extname(realIcon) + ' is not SVG/PNG/JPEG/WebP')
        }
      }
      const rel = toPosix(relative(dir, abs))
      if (!shipped.has(rel)) fail('icon-not-packed', 'icon ' + rel + ' is not in the tarball; add its directory to files[]')
    }
  }

  // 6. locale metadata must be present and non-empty.
  const locales = [...shipped].filter((path) => path.startsWith('locale/') && path.endsWith('.json'))
  if (locales.length === 0) {
    fail('locale-missing', 'no locale/*.json in the tarball; dsh has no title/description to show')
  }
  for (const path of locales) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(dir, path), 'utf8'))
    } catch (error) {
      fail('locale-invalid', path + ' is not valid JSON: ' + error.message)
      continue
    }
    const meta = parsed.meta
    if (meta === null || typeof meta !== 'object') {
      fail('locale-meta', path + ' has no meta object')
      continue
    }
    if (typeof meta.title !== 'string' || meta.title.trim().length === 0) {
      fail('locale-title', path + ' has an empty meta.title')
    }
    if (typeof meta.description !== 'string' || meta.description.trim().length === 0) {
      fail('locale-description', path + ' has an empty meta.description')
    }
  }

  // 7. the bundle patch must ship, or the plugin cannot be a profile layer.
  const patchRef = pkg.dsh && pkg.dsh.bundle ? pkg.dsh.bundle.patch : undefined
  if (typeof patchRef !== 'string' || patchRef.length === 0) {
    fail('bundle-patch', 'package.json declares no dsh.bundle.patch')
  } else if (!shipped.has(toPosix(patchRef))) {
    fail('bundle-patch-unpacked', 'dsh.bundle.patch ' + patchRef + ' is not in the tarball')
  }

  return { findings, packed }
}

/** ---- fault injection: prove the checks are not decorative ---------------- */

const FAULTS = [
  {
    name: 'exports: drop ./locale/*.json',
    apply: (dir, pkg) => { delete pkg.exports['./locale/*.json'] }
  },
  {
    name: 'exports: drop ./package.json',
    apply: (dir, pkg) => { delete pkg.exports['./package.json'] }
  },
  {
    name: 'exports: "." points at a missing file',
    apply: (dir, pkg) => { pkg.exports['.'] = { default: './lib/does-not-exist.js' } }
  },
  {
    name: 'icon: field removed',
    apply: (dir, pkg) => { delete pkg.icon }
  },
  {
    name: 'icon: path escapes the package',
    apply: (dir, pkg) => { pkg.icon = '../outside.svg' }
  },
  {
    name: 'icon: file does not exist',
    apply: (dir, pkg) => { pkg.icon = 'assets/does-not-exist.svg' }
  },
  {
    name: 'icon: no longer packed (files[] drops its directory)',
    apply: (dir, pkg) => { pkg.files = pkg.files.filter((rule) => rule !== 'assets') }
  },
  {
    name: 'icon: oversize (> 256 KiB)',
    apply: (dir, pkg) => {
      const target = join(dir, 'assets', 'oversize.svg')
      writeFileSync(target, '<svg xmlns="http://www.w3.org/2000/svg">' + 'x'.repeat(ICON_MAX_BYTES + 16) + '</svg>')
      pkg.icon = 'assets/oversize.svg'
      if (!pkg.files.includes('assets')) pkg.files.push('assets')
    }
  },
  {
    name: 'locale: empty meta.description',
    apply: (dir) => {
      const target = join(dir, 'locale', 'en.json')
      const parsed = JSON.parse(readFileSync(target, 'utf8'))
      parsed.meta.description = ''
      writeFileSync(target, JSON.stringify(parsed, null, 2) + '\n')
    }
  },
  {
    name: 'bundle: dsh.bundle.patch removed',
    apply: (dir, pkg) => { delete pkg.dsh.bundle.patch }
  }
]

function copyPackage(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const rel = relative(from, source)
      if (rel === '') return true
      const top = rel.split(sep)[0]
      return top !== 'node_modules' && top !== '.git'
    }
  })
}

function selftest(dir) {
  const rows = []
  for (const fault of FAULTS) {
    const scratch = mkdtempSync(join(tmpdir(), 'verify-pack-fault-'))
    let detected = false
    let note = ''
    try {
      copyPackage(dir, scratch)
      const manifestPath = join(scratch, 'package.json')
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
      fault.apply(scratch, pkg)
      writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n')
      const { findings } = verify(scratch)
      detected = findings.some((finding) => finding.level === 'FAIL')
      note = findings.filter((finding) => finding.level === 'FAIL').map((finding) => finding.code).join(', ')
    } catch (error) {
      note = 'threw: ' + error.message
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    rows.push({ fault: fault.name, detected, note })
  }
  return rows
}

/** ---- CLI ---------------------------------------------------------------- */

function parseArgs(argv) {
  const options = { dir: REPO_ROOT, selftest: false, keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--selftest') options.selftest = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--dir') { options.dir = resolve(argv[i + 1]); i += 1 }
    else if (arg === '--help' || arg === '-h') { options.help = true }
    else { console.error('verify-pack: unknown argument ' + arg); process.exit(2) }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  console.log('usage: node scripts/verify-pack.mjs [--dir <path>] [--selftest] [--keep]')
  process.exit(0)
}

console.log('verify-pack: ' + options.dir)
const { findings, packed } = verify(options.dir, options)

if (packed && packed.ok) {
  console.log('verify-pack: packed ' + packed.tarball + ' with ' + packed.paths.length + ' entries')
}
for (const finding of findings) {
  console.log('  ' + finding.level + ' [' + finding.code + '] ' + finding.message)
}
if (packed && packed.cleanup) packed.cleanup()

const failures = findings.filter((finding) => finding.level === 'FAIL')
let exitCode = failures.length === 0 ? 0 : 1

if (options.selftest) {
  console.log('')
  console.log('verify-pack selftest: injecting known faults')
  if (failures.length > 0) {
    console.log('  NOTE baseline is already failing; fault results are reported but cannot certify the checks')
  }
  const rows = selftest(options.dir)
  let undetected = 0
  for (const row of rows) {
    if (row.detected) {
      console.log('  DETECTED  ' + row.fault + '  (' + row.note + ')')
    } else {
      undetected += 1
      console.log('  MISSED    ' + row.fault + (row.note ? '  (' + row.note + ')' : ''))
    }
  }
  console.log('  ' + (rows.length - undetected) + '/' + rows.length + ' injected faults detected')
  if (undetected > 0) exitCode = 1
}

console.log('verify-pack RESULT: ' + (exitCode === 0 ? 'PASS' : 'FAIL') + ' (' + failures.length + ' failing check(s))')
process.exit(exitCode)
