#!/usr/bin/env node
/**
 * Doc provenance check (#68).
 *
 * WHY: issue #67 shipped a README that called the WHOLE plugin "Codex-style", while
 * lib/core/idempotence.js states the opposite in its HONEST LABEL. docs/PLAN.md and
 * docs/codex-dsh-mapping.md already forbade that wording, but nothing checked it, so
 * the same class of defect had already shipped twice (final verification F6, then #67).
 *
 * THE HARD PART, and the reason this is not a simple grep: the RULE ITSELF contains the
 * banned phrase. docs/codex-dsh-mapping.md says any document must NOT call it
 * "Codex 风格", and idempotence.js says "Do not describe it as Codex-style". Those are
 * META statements (they are about the phrase, not uses of it) and flagging them would
 * make the rule fail its own check. A file whitelist would be a hole rather than a fix,
 * so this checker decides by meaning:
 *
 *   a hit is a VIOLATION only when the enclosing sentence attributes a DSH-ORIGINAL
 *   element (anti-drift / idempotence / #9) to Codex, or predicates a Codex-style
 *   label of the whole plugin — AND the sentence carries no negation/meta marker.
 *
 * Everything else is recorded as 'ok' or 'meta' and printed, so the log shows what was
 * seen and how it was judged instead of only what was rejected.
 *
 * Exit codes follow the repository convention for non-gate jobs:
 *   0 PASS       - the corpus was scanned and is clean
 *   1 FAIL       - a violation, a missing HONEST LABEL, or drifted field bullets
 *   2 INCOMPLETE - the source of truth could not be loaded, so nothing was verified
 *
 * Usage:
 *   node scripts/doc-provenance-check.mjs            # scan the repository
 *   node scripts/doc-provenance-check.mjs --selftest  # reverse proofs only
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

export const EXIT_PASS = 0
export const EXIT_FAIL = 1
export const EXIT_INCOMPLETE = 2

/* ------------------------------------------------------------------ */
/* vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** Phrases that attribute a mechanism to Codex. Legitimate for D1/D4/D5. */
export const BANNED_ATTRIBUTIONS = Object.freeze([
  'Codex 风格',
  'Codex风格',
  'Codex-style',
  'Codex style'
])

/** The mechanisms this repository develops itself; attributing THESE to Codex is the bug. */
export const SELF_DEVELOPED_SUBJECTS = Object.freeze([
  '防漂移',
  '幂等',
  'idempotence',
  'idempotent',
  'anti-drift',
  '#9',
  '议题 #9'
])

/** Tokens that make a Codex-style label a claim about the whole plugin (#67). */
export const WHOLE_PLUGIN_SUBJECTS = Object.freeze([
  '本插件',
  '整个插件',
  '全插件',
  '插件本身',
  'the whole plugin',
  'this plugin',
  'the plugin as a whole'
])

/**
 * Negation / prohibition / meta markers.
 *
 * These are what separate "do not call it Codex-style" (a rule) from "it is
 * Codex-style" (the defect). Note that the English forms are deliberately multi-word:
 * a bare 'no' or 'not' appears in ordinary prose often enough that it would silence
 * real violations.
 */
export const META_MARKERS = Object.freeze([
  '不得',
  '不可',
  '不能',
  '不要',
  '不应',
  '禁止',
  '绝不',
  '并非',
  '不是',
  '而非',
  '没有',
  '不存在',
  '无此',
  '如实标注',
  '称其为',
  '描述为',
  '统称',
  '声称',
  'do not',
  'does not',
  'is not',
  'are not',
  'must not',
  'cannot',
  "can't",
  'never',
  'no explicit',
  'is wrong',
  'are wrong',
  'rather than',
  'instead of',
  'not a port'
])

/** Verbs that claim the mechanism was copied FROM Codex. */
export const CODEX_SOURCE_VERBS = Object.freeze([
  '照搬 Codex',
  '照搬Codex',
  'Codex 移植',
  '移植自 Codex',
  'ported from Codex',
  'port of Codex'
])

/* ------------------------------------------------------------------ */
/* text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Hard sentence boundaries. Newlines are NOT boundaries: markdown soft-wraps. */
const CLAUSE_BREAKS = '。！？；;.!?'

/**
 * The sentence containing `index`, or the whole text when it has no boundary.
 *
 * Newlines must not split a sentence: the README writes
 *   ... describing the whole plugin as "Codex-style" is
 *   wrong.
 * across two physical lines, and the prohibition marker only lands in the second.
 */
export function clauseAt(text, index) {
  let start = 0
  for (let i = Math.min(index, text.length - 1); i >= 0; i -= 1) {
    if (CLAUSE_BREAKS.includes(text[i])) {
      start = i + 1
      break
    }
  }
  let end = text.length
  for (let i = Math.max(index, 0); i < text.length; i += 1) {
    if (CLAUSE_BREAKS.includes(text[i])) {
      end = i + 1
      break
    }
  }
  return text.slice(start, end)
}

/**
 * Group physical lines into paragraphs, so a sentence split across lines stays whole.
 *
 * @returns array of `{ text, line }` where `line` is the 1-based first line.
 */
export function paragraphsOf(source) {
  const lines = source.split('\n')
  const paragraphs = []
  let buffer = []
  let firstLine = 1
  const flush = () => {
    if (buffer.length > 0) paragraphs.push({ text: buffer.join(' '), line: firstLine })
    buffer = []
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      flush()
      firstLine = i + 2
      continue
    }
    if (buffer.length === 0) firstLine = i + 1
    buffer.push(line)
  }
  flush()
  return paragraphs
}

const containsAny = (haystack, needles) => {
  const lower = haystack.toLowerCase()
  return needles.some((needle) => lower.includes(needle.toLowerCase()))
}

/* ------------------------------------------------------------------ */
/* the attribution detector                                            */
/* ------------------------------------------------------------------ */

/**
 * Judge every banned attribution in one paragraph.
 *
 * @returns array of `{ phrase, verdict, reason, line }` with verdict in
 *   'violation' | 'meta' | 'ok'.
 *
 * Verdict order matters: META is checked first, so the rule that forbids the phrase
 * cannot itself be flagged. Without that ordering the check would be self-defeating.
 */
export function attributionHits(paragraph, path, line) {
  const hits = []
  const text = paragraph.text
  const lower = text.toLowerCase()
  for (const phrase of BANNED_ATTRIBUTIONS) {
    const needle = phrase.toLowerCase()
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at === -1) break
      from = at + needle.length
      const clause = clauseAt(text, at)
      const prefix = text.slice(Math.max(0, at - 16), at)
      if (containsAny(clause, META_MARKERS) || containsAny(prefix, META_MARKERS)) {
        hits.push({ path, line, phrase, verdict: 'meta', reason: 'the sentence forbids or denies the label' })
        continue
      }
      const selfDeveloped = containsAny(clause, SELF_DEVELOPED_SUBJECTS)
      const wholePlugin = containsAny(prefix, WHOLE_PLUGIN_SUBJECTS)
      if (selfDeveloped) {
        hits.push({ path, line, phrase, verdict: 'violation', reason: 'attributes a DSH-original mechanism (anti-drift / idempotence / #9) to Codex' })
        continue
      }
      if (wholePlugin) {
        hits.push({ path, line, phrase, verdict: 'violation', reason: 'labels the whole plugin as Codex-style' })
        continue
      }
      hits.push({ path, line, phrase, verdict: 'ok', reason: 'describes a Codex-derived dimension (D1-D5), which may legitimately be called Codex-style' })
    }
  }
  for (const verb of CODEX_SOURCE_VERBS) {
    const needle = verb.toLowerCase()
    const at = lower.indexOf(needle)
    if (at === -1) continue
    const clause = clauseAt(text, at)
    if (!containsAny(clause, SELF_DEVELOPED_SUBJECTS)) continue
    if (containsAny(clause, META_MARKERS)) continue
    hits.push({ path, line, phrase: verb, verdict: 'violation', reason: 'claims a DSH-original mechanism was copied from Codex' })
  }
  return hits
}

/** Scan a whole corpus for attribution verdicts. */
export function scanCorpus(files) {
  const hits = []
  for (const file of files) {
    for (const paragraph of paragraphsOf(file.text)) {
      hits.push(...attributionHits(paragraph, file.path, paragraph.line))
    }
  }
  return hits
}

/* ------------------------------------------------------------------ */
/* field-set consistency                                               */
/* ------------------------------------------------------------------ */

/**
 * The Codex four-field set must be quoted in the docs exactly as lib/core/prompt.js
 * defines it. The bullets are IMPORTED, never re-typed here: a copy would drift the
 * same way the docs did, and would then agree with itself while disagreeing with the
 * template the code actually renders.
 *
 * @param files - the doc corpus.
 * @param fields - the field descriptors; defaults to the real ones.
 * @returns `{ problems, bullets, quotedIn, block }`.
 */
export function fieldConsistency(files, fields) {
  const list = fields === undefined ? CODEX_SUMMARY_FIELDS : fields
  const bullets = list.map((field) => field.bullet)
  const problems = []
  const quotedIn = new Map()
  let block = null
  for (const file of files) {
    const lines = file.text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      bullets.forEach((bullet, index) => {
        if (lines[i].includes(bullet)) {
          if (!quotedIn.has(bullet)) quotedIn.set(bullet, [])
          quotedIn.get(bullet).push(file.path + ':' + (i + 1))
        }
        if (index !== 0 || block !== null) return
        // The four bullets must also appear as an ordered block: scattered mentions
        // of one bullet are not a statement of the field set.
        let cursor = i
        let ok = true
        for (let k = 1; k < bullets.length; k += 1) {
          let found = -1
          for (let j = cursor + 1; j <= Math.min(i + 6, lines.length - 1); j += 1) {
            if (lines[j].includes(bullets[k])) {
              found = j
              break
            }
          }
          if (found === -1) {
            ok = false
            break
          }
          cursor = found
        }
        if (ok) block = { path: file.path, line: i + 1 }
      })
    }
  }
  for (const bullet of bullets) {
    if (!quotedIn.has(bullet)) {
      problems.push('the Codex field bullet is not quoted verbatim in any document: "' + bullet + '"')
    }
  }
  if (block === null) {
    problems.push('no document presents the four Codex bullets as an ordered block, so the field set is not actually documented')
  }
  return { problems, bullets, quotedIn, block }
}

/* ------------------------------------------------------------------ */
/* the HONEST LABEL                                                    */
/* ------------------------------------------------------------------ */

/**
 * Statements idempotence.js must keep, because the whole provenance argument rests
 * on them. If they are ever deleted, the docs assertion above would have nothing to
 * be aligned WITH, so their absence is a failure rather than a tidy-up.
 */
export const REQUIRED_HONEST_LABEL = Object.freeze([
  'no explicit anti-drift mechanism',
  'Everything in this module is DSH-original',
  'Do not describe it as Codex-style'
])

export function honestLabelProblems(source, path) {
  return REQUIRED_HONEST_LABEL.filter((phrase) => !source.includes(phrase)).map(
    (phrase) => path + ' no longer states: "' + phrase + '"'
  )
}

/* ------------------------------------------------------------------ */
/* corpus loading                                                      */
/* ------------------------------------------------------------------ */

export function docPaths() {
  const docs = join(ROOT, 'docs')
  const found = []
  if (existsSync(join(ROOT, 'README.md'))) found.push('README.md')
  if (existsSync(docs)) {
    for (const name of readdirSync(docs).sort()) {
      if (name.endsWith('.md')) found.push('docs/' + name)
    }
  }
  return found
}

/** The HONEST LABEL lives in source, not docs; it is scanned to prove meta detection. */
export const HONEST_LABEL_PATH = 'lib/core/idempotence.js'

export function loadCorpus(paths) {
  return paths.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }))
}

/* ------------------------------------------------------------------ */
/* verdict                                                             */
/* ------------------------------------------------------------------ */

/**
 * Print one verdict and assert the invariant that keeps it honest: an INCOMPLETE
 * verdict may never contain the substring PASS. Checked mechanically (same device as
 * scripts/preset-drift-check.sh) so "unverified" can never be read as "verified".
 */
export function emitVerdict(state, message) {
  if (state === 'INCOMPLETE' && message.includes('PASS')) {
    console.error('::error::DOC-PROVENANCE: self-check failed - an INCOMPLETE verdict contained PASS')
    console.log('DOC-PROVENANCE: FAIL (verdict self-check)')
    return EXIT_FAIL
  }
  if (state === 'FAIL') console.error('::error::DOC-PROVENANCE: ' + state + ' - ' + message)
  else if (state === 'INCOMPLETE') console.error('::warning::DOC-PROVENANCE: ' + state + ' - ' + message)
  console.log('DOC-PROVENANCE: ' + state + ' - ' + message)
  return state === 'PASS' ? EXIT_PASS : state === 'FAIL' ? EXIT_FAIL : EXIT_INCOMPLETE
}

/* ------------------------------------------------------------------ */
/* reverse proofs                                                      */
/* ------------------------------------------------------------------ */

/**
 * Each proof mutates an input in memory and asserts the detector reacts the way the
 * task requires. Both directions are covered: a violation must go red, and a META
 * statement must stay green — without the second one, "grep for the phrase" would
 * pass this suite while failing the rule it is supposed to protect.
 */
export function selfProofs(fields) {
  const results = []
  const record = (label, ok, detail) => {
    results.push({ label, ok })
    console.log('DOC-PROVENANCE: proof ' + (ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : ' (' + detail + ')'))
  }
  const violationsIn = (text) => scanCorpus([{ path: 'injected.md', text }]).filter((hit) => hit.verdict === 'violation')

  record(
    'an injected Chinese violation is caught',
    violationsIn('# 说明\n\n本插件的防漂移机制是 Codex 风格的实现。').length === 1
  )
  record('an injected English violation is caught', violationsIn('The anti-drift layer is Codex-style.').length === 1)
  record('an injected #9 attribution is caught', violationsIn('#9 是 Codex-style 的移植。').length === 1)
  record(
    'a whole-plugin label is caught',
    violationsIn('本插件是 Codex 风格的压缩后端。').length === 1
  )
  record(
    'the Chinese rule statement stays green',
    violationsIn('任何文档、PR 或对外描述都不得称其为"Codex 风格"。').length === 0,
    'meta statement'
  )
  record(
    'the English rule statement stays green',
    violationsIn('Do not describe it as Codex-style.').length === 0,
    'meta statement'
  )
  record(
    'the real README provenance note stays green',
    scanCorpus([{ path: 'README.md', text: 'Codex has *no explicit anti-drift mechanism*, so describing the whole plugin as "Codex-style" is\nwrong.' }]).filter((hit) => hit.verdict === 'violation').length === 0,
    'sentence spans two lines'
  )

  // Bullet drift: rename one bullet and require the consistency check to notice.
  const drifted = (fields === undefined ? [] : fields).map((field, index) =>
    index === 0 ? { id: field.id, bullet: field.bullet + ' (renamed upstream)' } : field
  )
  const real = docPaths().filter((path) => path !== HONEST_LABEL_PATH)
  const corpus = loadCorpus(real)
  const clean = fieldConsistency(corpus, fields)
  const broken = fieldConsistency(corpus, drifted)
  record('the current corpus satisfies the field set', clean.problems.length === 0, clean.problems.join('; ') || 'in sync')
  record(
    'a drifted bullet makes the field check fail',
    broken.problems.length > 0,
    broken.problems.join('; ') || 'no problem reported'
  )
  record(
    'an empty corpus is not a pass',
    fieldConsistency([], fields).problems.length > 0,
    'empty-set trap'
  )

  const failed = results.filter((row) => !row.ok)
  console.log('DOC-PROVENANCE: ' + (failed.length === 0
    ? 'PROOFS ok (' + results.length + ' expectations met)'
    : 'PROOFS FAIL (' + failed.length + ' of ' + results.length + ' expectations missed)'))
  return failed.length === 0 ? EXIT_PASS : EXIT_FAIL
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const proveOnly = process.argv.includes('--selftest')
  let fields
  try {
    const prompt = await import('../lib/core/prompt.js')
    fields = prompt.CODEX_SUMMARY_FIELDS
  } catch (error) {
    // Without the source of truth nothing can be verified. Saying so is the point.
    return emitVerdict('INCOMPLETE', 'cannot load lib/core/prompt.js (' + error.message + '), so nothing was verified')
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    return emitVerdict('INCOMPLETE', 'lib/core/prompt.js exports no CODEX_SUMMARY_FIELDS, so nothing was verified')
  }

  const proofs = selfProofs(fields)
  if (proveOnly) return proofs

  const docs = docPaths()
  if (docs.length === 0) {
    // An empty scan target is not a clean corpus. This is the same trap as #62:
    // "0 hits" must never be confused with "nothing to scan".
    return emitVerdict('FAIL', 'the doc scan target is empty, so nothing was verified (this is not a pass)')
  }

  const corpus = loadCorpus(docs)
  const withSource = corpus.concat(loadCorpus([HONEST_LABEL_PATH]))
  const hits = scanCorpus(withSource)
  const violations = hits.filter((hit) => hit.verdict === 'violation')
  const meta = hits.filter((hit) => hit.verdict === 'meta')
  const benign = hits.filter((hit) => hit.verdict === 'ok')

  // Anti-vacuous: report what was scanned, so a green run is evidence rather than
  // an assertion. Both counts are printed even when they are zero.
  console.log('DOC-PROVENANCE: scanned ' + withSource.length + ' file(s), ' +
    withSource.reduce((total, file) => total + file.text.split('\n').length, 0) + ' line(s)')
  console.log('DOC-PROVENANCE: attribution hits: ' + violations.length + ' violation(s), ' +
    meta.length + ' meta statement(s), ' + benign.length + ' legitimate Codex-derived use(s)')
  for (const hit of hits) {
    console.log('DOC-PROVENANCE:   [' + hit.verdict + '] ' + hit.path + ':' + hit.line + ' "' + hit.phrase + '" - ' + hit.reason)
  }

  const fields_report = fieldConsistency(corpus, fields)
  const labelProblems = honestLabelProblems(loadCorpus([HONEST_LABEL_PATH])[0].text, HONEST_LABEL_PATH)
  console.log('DOC-PROVENANCE: field set: ' + fields.length + ' bullet(s) from lib/core/prompt.js, block at ' +
    (fields_report.block === null ? 'NOWHERE' : fields_report.block.path + ':' + fields_report.block.line))

  const failures = []
  for (const hit of violations) {
    failures.push('banned provenance at ' + hit.path + ':' + hit.line + ' (' + hit.phrase + '): ' + hit.reason)
  }
  failures.push(...fields_report.problems)
  failures.push(...labelProblems)

  if (failures.length > 0) {
    for (const failure of failures) console.error('DOC-PROVENANCE:   - ' + failure)
    return emitVerdict('FAIL', failures.length + ' provenance problem(s): ' + failures[0])
  }
  if (proofs !== EXIT_PASS) {
    return emitVerdict('FAIL', 'the reverse proofs did not hold, so a green corpus would not mean anything')
  }
  return emitVerdict('PASS', 'scanned ' + withSource.length + ' file(s): provenance labels, the four-field set and the HONEST LABEL are consistent')
}

// Only run when executed directly, so tests can import the detectors.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code
  })
}
