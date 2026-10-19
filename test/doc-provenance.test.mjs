/**
 * Issue #68: the doc provenance check, and the boundary it must not cross.
 *
 * The interesting assertions here are the NEGATIVE ones about meta statements. A check
 * written as "the phrase appears -> red" passes every positive test and still fails its
 * purpose, because the rule itself (docs/codex-dsh-mapping.md) and the HONEST LABEL
 * (lib/core/idempotence.js) both contain the phrase in order to forbid it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CODEX_SUMMARY_FIELDS } from '../lib/core/prompt.js'
import {
  HONEST_LABEL_PATH,
  REQUIRED_HONEST_LABEL,
  attributionHits,
  docPaths,
  fieldConsistency,
  honestLabelProblems,
  loadCorpus,
  paragraphsOf,
  scanCorpus
} from '../scripts/doc-provenance-check.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Verdicts for a single paragraph of text. */
function verdicts(text) {
  return scanCorpus([{ path: 'probe.md', text }])
}

const violations = (text) => verdicts(text).filter((hit) => hit.verdict === 'violation')

/* ------------------------------------------------------------------ */
/* the meta boundary                                                   */
/* ------------------------------------------------------------------ */

test('the Chinese rule statement is a meta statement, not a violation', () => {
  // Verbatim from docs/codex-dsh-mapping.md: it forbids the label by using it.
  const text = '任何文档、PR 或对外描述都不得称其为"Codex 风格"。'
  assert.deepEqual(violations(text), [])
  assert.equal(verdicts(text).filter((hit) => hit.verdict === 'meta').length, 1)
})

test('the English HONEST LABEL is a meta statement, not a violation', () => {
  const text = 'Do not describe it as Codex-style.'
  assert.deepEqual(violations(text), [])
})

test('a prohibition whose predicate is on the next line is still meta', () => {
  // The real README soft-wraps mid-sentence; a line-based scan would miss 'wrong'.
  const text =
    'Codex has *no explicit anti-drift mechanism*, so describing the whole plugin as "Codex-style" is\nwrong.'
  assert.deepEqual(violations(text), [])
})

test('the boundary is semantic, not a file whitelist', () => {
  // Same file that carries the HONEST LABEL: an injected claim inside it must still
  // be caught. A path allowlist would silently accept this.
  const text = 'HONEST LABEL: everything is DSH-original.\n\n实际上本插件的防漂移就是 Codex 风格的实现。'
  const hits = scanCorpus([{ path: HONEST_LABEL_PATH, text }]).filter((hit) => hit.verdict === 'violation')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, HONEST_LABEL_PATH)
})

/* ------------------------------------------------------------------ */
/* what must be caught                                                 */
/* ------------------------------------------------------------------ */

test('attributing the DSH-original anti-drift layer to Codex is caught', () => {
  assert.equal(violations('本插件的防漂移机制是 Codex 风格的实现。').length, 1)
  assert.equal(violations('The anti-drift layer is Codex-style.').length, 1)
  assert.equal(violations('#9 是 Codex-style 的移植。').length, 1)
  assert.equal(violations('幂等性照搬 Codex 的做法。').length, 1)
})

test('labelling the whole plugin is caught', () => {
  const hits = violations('本插件是 Codex 风格的压缩后端。')
  assert.equal(hits.length, 1)
  assert.match(hits[0].reason, /whole plugin/)
})

test('a Codex-derived dimension may still be called Codex-style', () => {
  // D1 and D4 really are Codex-derived, and the docs say so. Flagging this would
  // punish accurate provenance, which is the opposite of the point.
  assert.deepEqual(violations('D1 触发策略使用 Codex 风格触发算式。'), [])
  assert.deepEqual(violations('D4 摘要模板采用 Codex 风格结构化提示词。'), [])
})

/* ------------------------------------------------------------------ */
/* the field set and the HONEST LABEL                                   */
/* ------------------------------------------------------------------ */

test('the documented bullets match lib/core/prompt.js verbatim', () => {
  const corpus = loadCorpus(docPaths())
  const report = fieldConsistency(corpus, CODEX_SUMMARY_FIELDS)
  assert.deepEqual(report.problems, [])
  assert.equal(report.bullets.length, 4)
  assert.notEqual(report.block, null, 'the four bullets must appear as an ordered block')
})

test('a renamed bullet that the docs did not follow is a problem', () => {
  const corpus = loadCorpus(docPaths())
  const drifted = CODEX_SUMMARY_FIELDS.map((field, index) =>
    index === 0 ? { id: field.id, bullet: field.bullet + ' (renamed upstream)' } : field
  )
  const report = fieldConsistency(corpus, drifted)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0], /not quoted verbatim/)
})

test('an empty corpus is reported as a problem, never as clean', () => {
  const report = fieldConsistency([], CODEX_SUMMARY_FIELDS)
  assert.ok(report.problems.length > 0, 'an empty scan target must not look clean')
})

test('the HONEST LABEL is still present in the source', () => {
  const source = readFileSync(join(ROOT, HONEST_LABEL_PATH), 'utf8')
  assert.deepEqual(honestLabelProblems(source, HONEST_LABEL_PATH), [])
  assert.equal(REQUIRED_HONEST_LABEL.length, 3)
  for (const phrase of REQUIRED_HONEST_LABEL) assert.ok(source.includes(phrase), phrase)
})

test('a deleted HONEST LABEL is a problem', () => {
  const problems = honestLabelProblems('# nothing to see here', 'probe.js')
  assert.equal(problems.length, REQUIRED_HONEST_LABEL.length)
})

/* ------------------------------------------------------------------ */
/* the repository as it stands                                          */
/* ------------------------------------------------------------------ */

test('the repository corpus is clean and non-empty', () => {
  const docs = docPaths()
  assert.ok(docs.includes('README.md'), 'README.md must be in the scan target')
  assert.ok(docs.length >= 10, 'the scan target must not collapse to a couple of files')
  const files = loadCorpus(docs).concat(loadCorpus([HONEST_LABEL_PATH]))
  const hits = scanCorpus(files)
  assert.deepEqual(hits.filter((hit) => hit.verdict === 'violation'), [])
  // Proof the scan actually looked at prose rather than an empty corpus.
  assert.ok(hits.filter((hit) => hit.verdict === 'meta').length >= 2, 'the rule statements must be seen and excused')
})

test('paragraph grouping keeps a soft-wrapped sentence together', () => {
  const paragraphs = paragraphsOf('a\nb\n\nc')
  assert.deepEqual(paragraphs.map((row) => row.text), ['a b', 'c'])
  assert.equal(paragraphs[1].line, 4)
})
