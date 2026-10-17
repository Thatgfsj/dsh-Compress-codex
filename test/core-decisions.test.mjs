import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_POLICY, normalizePolicy } from '../lib/core/config.js'
import { POLICY_KEYS } from '../lib/core/keys.js'
import { buildSummaryRequest } from '../lib/core/prompt.js'
import { selectCompactionRange } from '../lib/core/select.js'
import { COMPACTION_TRIGGERS, decideCompaction } from '../lib/core/trigger.js'

/**
 * Contract-shape assertions only.
 *
 * These must stay green both while the D1-D4 hooks are skeletons and after #4,
 * #5, #6 land their real implementations, so nothing here asserts a *value* the
 * skeleton happens to return. The engine tests exercise behaviour through
 * explicitly injected hooks; these exercise the shape each hook guarantees.
 */
const ACTIONS = ['delegate', 'skip', 'compact']

const pressure = (over = {}) => ({
  trigger: 'pressure',
  policy: DEFAULT_POLICY,
  capacity: { windowTokens: 200000 },
  measure: () => ({ totalTokens: 0, surfaceTokens: 0 }),
  ...over
})

const noWriteMeasurement = () => ({ totalTokens: 0, surfaceTokens: 0 })

test('D1 answers with an actionable three-state result', () => {
  for (const context of [pressure(), pressure({ capacity: null }), pressure({ policy: {} })]) {
    const result = decideCompaction(context)
    assert.ok(ACTIONS.includes(result.action), 'action must be one of ' + ACTIONS.join('/'))
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0, 'every decision must carry a reason for #13')
    assert.equal(typeof result.numbers, 'object')
  }
})

test('D1 keeps the trigger union closed', () => {
  for (const bad of [undefined, null, 'manual', 'boom', 0]) {
    assert.throws(() => decideCompaction({ trigger: bad }), TypeError)
  }
})

test('D1 answers every legal trigger, whatever the policy state', () => {
  for (const trigger of COMPACTION_TRIGGERS) {
    const result = decideCompaction({ trigger, policy: {}, capacity: null, measure: noWriteMeasurement })
    assert.ok(ACTIONS.includes(result.action))
  }
})

test('D2/D3 answers null or a well-formed range, and node 0 is never shadowed', () => {
  // C2 holds regardless of whether node 0 is a system message: a range that
  // starts at 0 would shadow the prompt.
  const session = {
    surface: { nodes: [{ seq: 1, type: 'user/message' }, { seq: 2, type: 'assistant/message' }] }
  }
  const range = selectCompactionRange({
    session,
    policy: DEFAULT_POLICY,
    trigger: 'pressure',
    capacity: { windowTokens: 200000 },
    measure: noWriteMeasurement,
    edgeChecks: null
  })
  assert.ok(range === null || (Number.isInteger(range.start) && Number.isInteger(range.end)))
  if (range !== null) {
    assert.ok(range.start > 0, 'surface node 0 must never be shadowed (C2)')
    assert.ok(range.end >= range.start)
  }
})

test('D2/D3 tolerates the engine context it is handed', () => {
  assert.doesNotThrow(() =>
    selectCompactionRange({
      session: { surface: { nodes: [] } },
      policy: DEFAULT_POLICY,
      trigger: 'manual',
      capacity: null,
      measure: noWriteMeasurement,
      edgeChecks: { before: () => true, after: () => true }
    })
  )
  assert.throws(() => selectCompactionRange({}), TypeError)
})

test('D4 answers null or the frozen request shape', () => {
  const request = buildSummaryRequest({ input: { messages: [] }, agent: {}, policy: DEFAULT_POLICY })
  assert.ok(request === null || typeof request === 'object')
  if (request !== null) {
    assert.equal(typeof request.prompt, 'string')
    assert.equal(typeof request.projection, 'function')
    assert.equal(typeof request.template, 'string')
    assert.ok(Array.isArray(request.fields))
  }
  assert.throws(() => buildSummaryRequest({}), TypeError)
})

test('normalizePolicy fills every default and freezes the result', () => {
  const policy = normalizePolicy({ triggerLimitRatio: 0.5 })
  assert.equal(policy.triggerLimitRatio, 0.5)
  assert.equal(policy.retainMode, 'structural')
  assert.deepEqual(Object.keys(policy).sort(), [...POLICY_KEYS].sort())
  assert.ok(Object.isFrozen(policy))
})

test("the D4 extra fields default to the full set, never to an empty array", () => {
  // An empty default would silently switch off the two fields this project exists
  // for; #6 reads "missing" as all-on, so the policy must not materialise [].
  const policy = normalizePolicy({})
  assert.equal(policy.summaryExtraFields.length, 2)
  assert.deepEqual([...policy.summaryExtraFields], ['files', 'pitfalls'])
  assert.deepEqual([...normalizePolicy({ summaryExtraFields: [] }).summaryExtraFields], [])
})

test('normalizePolicy rejects a config it cannot read, loudly', () => {
  for (const bad of [null, undefined, 'config', 7, []]) {
    assert.throws(() => normalizePolicy(bad), TypeError)
  }
  assert.throws(() => normalizePolicy({ unknownKey: true }), /unknown config key/)
  assert.throws(() => normalizePolicy({ triggerRatio: 0.5 }), /unknown config key/)
})

test('the retain budget is documented as a soft ceiling, not a hard cap', () => {
  assert.ok(POLICY_KEYS.includes('retainTokens'))
  assert.ok(POLICY_KEYS.includes('retainRecentUnits'))
  assert.equal(DEFAULT_POLICY.retainTokens, undefined, 'unset means pure structural retention')
})
