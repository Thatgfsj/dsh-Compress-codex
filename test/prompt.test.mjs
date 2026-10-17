/**
 * #6 acceptance: the D4 template is a frozen artifact.
 *
 * The two golden strings below are the point of this file. Any accidental edit
 * to the Codex wording, to the field order, or to the "(omit if none)" guards
 * shows up as a diff here instead of as silent summary drift in production, and
 * the "dirty reply" cases prove the projection really is the C5 filter and not
 * just a filter-shaped function.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizePolicy } from '../lib/core/config.js'
import {
  CODEX_SUMMARY_FIELDS,
  EXTRA_SUMMARY_FIELDS,
  SUMMARY_PREFIX,
  SUMMARY_TEMPLATE_VERSION,
  buildSummaryRequest,
  projectSummaryOutput,
  resolveSummaryFields
} from '../lib/core/prompt.js'

/** Codex `prompts/templates/compact/prompt.md`, verbatim (docs/codex-notes.md §3.2). */
const CODEX_PROMPT = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.',
  '',
  'Include:',
  '- Current progress and key decisions made',
  '- Important context, constraints, or user preferences',
  '- What remains to be done (clear next steps)',
  '- Any critical data, examples, or references needed to continue',
  '',
  'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.'
].join('\n')

/** Default policy: Codex's nine lines plus the two bullets Codex does not have. */
const DEFAULT_PROMPT = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.',
  '',
  'Include:',
  '- Current progress and key decisions made',
  '- Important context, constraints, or user preferences',
  '- What remains to be done (clear next steps)',
  '- Any critical data, examples, or references needed to continue',
  '- Files touched and their current state (omit if none)',
  '- Known pitfalls or failed approaches (omit if none)',
  '',
  'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.'
].join('\n')

const REPLAY = { input: { messages: [] } }

test('the default prompt is a frozen snapshot: Codex 9 lines + 2 extra bullets', () => {
  assert.equal(CODEX_PROMPT.split('\n').length, 9, 'the Codex baseline is a 9-line file')
  assert.equal(DEFAULT_PROMPT.split('\n').length, 11)
  assert.equal(buildSummaryRequest(REPLAY).prompt, DEFAULT_PROMPT)
  assert.equal(buildSummaryRequest(REPLAY).prompt, DEFAULT_PROMPT, 'the template must be deterministic')
})

test('Codex wording is kept verbatim and extras only extend it', () => {
  const pure = buildSummaryRequest({ ...REPLAY, policy: { summaryExtraFields: [] } }).prompt
  assert.equal(pure, CODEX_PROMPT, 'an empty summaryExtraFields must reproduce Codex byte for byte')

  const first = CODEX_PROMPT.split('\n')[0]
  const last = CODEX_PROMPT.split('\n').at(-1)
  assert.equal(DEFAULT_PROMPT.split('\n')[0], first, 'the role instruction must stay line 1')
  assert.equal(DEFAULT_PROMPT.split('\n').at(-1), last, 'the closing line must stay last')
  assert.match(first, /^You are performing a CONTEXT CHECKPOINT COMPACTION\./)
  for (const field of CODEX_SUMMARY_FIELDS) {
    assert.ok(DEFAULT_PROMPT.includes('- ' + field.bullet), 'missing Codex bullet: ' + field.bullet)
  }
})

test('the template version is readable data, and an unknown version fails fast', () => {
  assert.equal(SUMMARY_TEMPLATE_VERSION, 'codex-v1')
  assert.equal(buildSummaryRequest(REPLAY).template, SUMMARY_TEMPLATE_VERSION)
  assert.equal(buildSummaryRequest({ ...REPLAY, policy: { summaryTemplate: 'codex-v1' } }).template, 'codex-v1')
  for (const bad of ['codex-v2', 'codex-v1 ', '', 7, {}]) {
    assert.throws(
      () => buildSummaryRequest({ ...REPLAY, policy: { summaryTemplate: bad } }),
      TypeError,
      'unknown summaryTemplate must not silently render codex-v1: ' + String(bad)
    )
  }
})

test('summaryExtraFields defaults to all extras and selects them canonically', () => {
  const all = buildSummaryRequest(REPLAY)
  assert.deepEqual(
    all.fields.map((field) => field.id),
    ['progress', 'context', 'next-steps', 'references', 'files', 'pitfalls']
  )

  const filesOnly = buildSummaryRequest({ ...REPLAY, policy: { summaryExtraFields: ['files'] } })
  assert.deepEqual(filesOnly.fields.map((field) => field.id), [
    'progress',
    'context',
    'next-steps',
    'references',
    'files'
  ])
  assert.ok(filesOnly.prompt.includes(EXTRA_SUMMARY_FIELDS.files.bullet))
  assert.ok(!filesOnly.prompt.includes(EXTRA_SUMMARY_FIELDS.pitfalls.bullet))

  const reordered = buildSummaryRequest({
    ...REPLAY,
    policy: { summaryExtraFields: ['pitfalls', 'files', 'files'] }
  })
  assert.equal(reordered.prompt, DEFAULT_PROMPT, 'config order and duplicates must not move the template')

  const none = buildSummaryRequest({ ...REPLAY, policy: { summaryExtraFields: [] } })
  assert.deepEqual(none.fields.map((field) => field.id), ['progress', 'context', 'next-steps', 'references'])
})

test('the normalized policy still defaults to all extras (integration guard)', () => {
  // The key surface belongs to #3/infra. This pins the seam from the consuming
  // side so a default of `[]` there cannot silently drop the two fields this
  // project exists for: an absent key means "all on", an explicit [] does not.
  const built = buildSummaryRequest({ input: {}, policy: normalizePolicy({}) })
  assert.deepEqual(
    built.fields.map((field) => field.id),
    ['progress', 'context', 'next-steps', 'references', 'files', 'pitfalls']
  )
})

test('a malformed summaryExtraFields fails fast instead of shrinking the handoff', () => {
  for (const bad of ['files', 7, {}, ['file'], ['files', 42], [null]]) {
    assert.throws(
      () => buildSummaryRequest({ ...REPLAY, policy: { summaryExtraFields: bad } }),
      TypeError,
      'malformed summaryExtraFields must throw: ' + JSON.stringify(bad)
    )
  }
  assert.throws(() => resolveSummaryFields({ summaryExtraFields: ['nope'] }), /unknown summaryExtraFields/)
})

test('C5: reasoning, tool calls, tool results and images never reach the checkpoint', () => {
  const raw = [
    { type: 'reasoning', text: 'SECRET-REASONING' },
    { type: 'text', text: 'Progress: engine seam wired.' },
    { type: 'tool_call', id: 'call-1', name: 'exec', arguments: { cmd: 'boom' } },
    { type: 'tool_call_result', callId: 'call-1', content: [{ type: 'text', text: 'SECRET-TOOL-RESULT' }] },
    { type: 'text', text: 'Next: land #7.' },
    { type: 'image', data: 'SECRET-IMAGE' }
  ]
  const projected = projectSummaryOutput(raw)
  assert.deepEqual(projected, [
    { type: 'text', text: SUMMARY_PREFIX + '\nProgress: engine seam wired.\nNext: land #7.' }
  ])
  assert.deepEqual(Object.keys(projected[0]), ['type', 'text'], 'a checkpoint block is pure text, nothing else')
  for (const leak of ['SECRET-REASONING', 'SECRET-TOOL-RESULT', 'SECRET-IMAGE', 'call-1']) {
    assert.ok(!projected[0].text.includes(leak), 'leaked into the checkpoint: ' + leak)
  }
})

test('an empty reply yields no shell field and no preface-only block', () => {
  const emptiness = [
    [],
    undefined,
    null,
    'transcript text is not a block list',
    [{ type: 'reasoning', text: 'thinking' }],
    [{ type: 'text', text: '   \n\t ' }],
    [{ type: 'text' }],
    [{ type: 'text', text: 42 }],
    [null, 42, 'text']
  ]
  for (const raw of emptiness) {
    assert.equal(projectSummaryOutput(raw), null, 'expected null for ' + JSON.stringify(raw))
  }
})

test('the request carries the projection, and the prompt ignores the replay payload', () => {
  const built = buildSummaryRequest({ input: { messages: [{ role: 'user' }] }, agent: { id: 'agent-1' } })
  assert.equal(typeof built.projection, 'function')
  assert.deepEqual(
    built.projection([{ type: 'text', text: 'x' }]),
    projectSummaryOutput([{ type: 'text', text: 'x' }])
  )
  assert.equal(built.projection([]), null, 'the wired projection must keep the empty-reply contract')
  assert.ok(Object.isFrozen(built))
  assert.ok(Object.isFrozen(built.fields))

  const other = buildSummaryRequest({
    input: { messages: [{ role: 'assistant', content: 'unrelated' }] },
    agent: { id: 'agent-2' },
    policy: undefined
  })
  assert.equal(other.prompt, built.prompt, 'the instruction depends on the policy, not on the replay payload')
  assert.deepEqual(
    built.fields.map((field) => field.id),
    resolveSummaryFields(undefined).map((field) => field.id)
  )
})

test('the frozen input guard stays: no replay input, no request', () => {
  for (const bad of [undefined, null, {}, { input: null }, { input: 'messages' }, { input: 7 }]) {
    assert.throws(() => buildSummaryRequest(bad), TypeError)
  }
})

test('SUMMARY_PREFIX is Codex summary_prefix.md, one line, no trailing newline', () => {
  assert.equal(
    SUMMARY_PREFIX,
    'Another language model started to solve this problem and produced a summary of its thinking process. ' +
      'You also have access to the state of the tools that were used by that language model. ' +
      'Use this to build on the work that has already been done and avoid duplicating work. ' +
      'Here is the summary produced by the other language model, use the information in this summary to ' +
      'assist with your own analysis:'
  )
  assert.ok(SUMMARY_PREFIX.endsWith('assist with your own analysis:'))
  assert.ok(!SUMMARY_PREFIX.includes('\n'), 'Codex joins the prefix with an explicit newline, it does not carry one')
  assert.equal(projectSummaryOutput([{ type: 'text', text: 'body' }])[0].text, SUMMARY_PREFIX + '\nbody')
  assert.ok(!buildSummaryRequest(REPLAY).prompt.includes(SUMMARY_PREFIX), 'the preface is output, not instruction')
})
