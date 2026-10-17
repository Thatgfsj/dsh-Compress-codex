import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMPACTION_TRIGGERS, D1_DEFAULTS, decideCompaction, scaleByRatio } from '../lib/core/trigger.js'

const W = 100000
const FULL = 95000 // floor(W * 0.95)
const LIMIT = 90000 // floor(W * 0.9)

/** TokenMeasurement stub: activeTokens / scopeTokens are the two readings D1 uses. */
const measureOf = (activeTokens, scopeTokens) => () => ({ totalTokens: activeTokens, surfaceTokens: scopeTokens })

const pressure = (over = {}) => ({
  trigger: 'pressure',
  policy: {},
  capacity: { windowTokens: W },
  measure: measureOf(0, 0),
  ...over
})

test('the documented defaults are the Codex ones (buffer 0, not a 64Ki headroom)', () => {
  assert.equal(D1_DEFAULTS.triggerLimitRatio, 0.9)
  assert.equal(D1_DEFAULTS.effectiveWindowPercent, 0.95)
  assert.equal(D1_DEFAULTS.triggerBufferTokens, 0)
  assert.equal(D1_DEFAULTS.turnEndPercent, 0)
  assert.equal(D1_DEFAULTS.triggerLimitTokens, undefined)
})

// docs/codex-impl-checklist.md §1.5, table-driven.
const boundaries = [
  { name: 'scope = limit + buffer - 1, active below full -> no trigger', scope: LIMIT - 1, active: 10, expected: 'skip', reason: 'd1-below-threshold' },
  { name: 'scope = limit exactly (buffer 0) -> limit triggers', scope: LIMIT, active: 10, expected: 'compact', reason: 'd1-limit-reached' },
  { name: 'scope = limit + 1 -> limit triggers', scope: LIMIT + 1, active: 10, expected: 'compact', reason: 'd1-limit-reached' },
  { name: 'active = full - 1 with a tiny body -> no trigger', scope: 1000, active: FULL - 1, expected: 'skip', reason: 'd1-below-threshold' },
  { name: 'active = full with a tiny body -> full triggers', scope: 1000, active: FULL, expected: 'compact', reason: 'd1-full-reached' },
  { name: 'active past full and past limit -> full wins the reason, it needs no baseline', scope: LIMIT + 1, active: FULL, expected: 'compact', reason: 'd1-full-reached' }
]

for (const c of boundaries) {
  test(c.name, () => {
    const result = decideCompaction(pressure({ measure: measureOf(c.active, c.scope) }))
    assert.equal(result.action, c.expected)
    assert.equal(result.reason, c.reason)
    assert.equal(result.numbers.fullTokens, FULL)
    assert.equal(result.numbers.limitTokens, LIMIT)
  })
}

test('the buffer is added on the limit side only, and never shrinks full', () => {
  const below = decideCompaction(pressure({ policy: { triggerBufferTokens: 100 }, measure: measureOf(10, LIMIT + 99) }))
  assert.equal(below.action, 'skip')
  assert.equal(below.numbers.thresholdTokens, LIMIT + 100)
  assert.equal(below.numbers.fullTokens, FULL, 'the buffer must not move the full ceiling')

  const at = decideCompaction(pressure({ policy: { triggerBufferTokens: 100 }, measure: measureOf(10, LIMIT + 100) }))
  assert.equal(at.action, 'compact')
  assert.equal(at.reason, 'd1-limit-reached')
})

test('the prefix trap: a restored session whose prefix alone fills the window still fires', () => {
  // active is at full while the compactable body is nearly empty; a limit-only
  // check would read scopeTokens = 0 forever and never compact.
  const result = decideCompaction(pressure({ measure: measureOf(FULL + 5000, 12) }))
  assert.equal(result.action, 'compact')
  assert.equal(result.reason, 'd1-full-reached')
  assert.ok(result.numbers.scopeTokens < result.numbers.thresholdTokens)
})

test('triggerLimitTokens caps the ratio floor, it never raises it', () => {
  const capped = decideCompaction(pressure({ policy: { triggerLimitTokens: 50000 }, measure: measureOf(10, 50000) }))
  assert.equal(capped.numbers.limitTokens, 50000)
  assert.equal(capped.action, 'compact')

  const raised = decideCompaction(pressure({ policy: { triggerLimitTokens: 98000 }, measure: measureOf(10, LIMIT) }))
  assert.equal(raised.numbers.limitTokens, LIMIT, 'min(absolute, ratio) keeps the ratio as the ceiling')
  assert.equal(raised.action, 'compact')
})

test('turnEndPercent = 0 disables the turn-end check entirely', () => {
  const result = decideCompaction(pressure({ measure: measureOf(FULL, 10) }))
  assert.equal(result.numbers.turnEndReached, false)
})

test('turnEndPercent is an independent check and is reported, not acted on at pre-step', () => {
  // 76000 * 100 >= 95000 * 80, and both other thresholds are far away.
  const at = decideCompaction(pressure({ policy: { turnEndPercent: 80 }, measure: measureOf(76000, 10) }))
  assert.equal(at.numbers.turnEndReached, true)
  assert.equal(at.action, 'skip', 'DSH has no turn-end seam yet; the flag is for the eventual caller and #13')

  const below = decideCompaction(pressure({ policy: { turnEndPercent: 80 }, measure: measureOf(75999, 10) }))
  assert.equal(below.numbers.turnEndReached, false)
})

test('the turn-end compare is integer cross multiplication', () => {
  const full = 95000
  const at = decideCompaction(pressure({ policy: { turnEndPercent: 79 }, measure: measureOf(75049, 10) }))
  // 75049 * 100 = 7504900 >= 95000 * 79 = 7505000 is false
  assert.equal(at.numbers.turnEndReached, false)
  const next = decideCompaction(pressure({ policy: { turnEndPercent: 79 }, measure: measureOf(75050, 10) }))
  assert.equal(next.numbers.turnEndReached, true)
  assert.ok(full > 0)
})

test('context-overflow bypasses every threshold and never measures', () => {
  const result = decideCompaction({
    trigger: 'context-overflow',
    policy: {},
    capacity: undefined,
    measure: () => {
      throw new Error('the overflow bypass must not need a measurement')
    }
  })
  assert.equal(result.action, 'compact')
  assert.equal(result.reason, 'd1-context-overflow-bypass')
})

test('a missing window delegates instead of reading as zero', async () => {
  for (const capacity of [undefined, null, {}, { windowTokens: 0 }, { windowTokens: -1 }, { windowTokens: 1.5 }, { windowTokens: '1000' }]) {
    const result = decideCompaction({
      trigger: 'pressure',
      policy: {},
      capacity,
      measure: () => {
        throw new Error('a window-less decision must not measure')
      }
    })
    // 'delegate', not 'skip': skipping would disable the official policy too.
    assert.equal(result.action, 'delegate')
    assert.equal(result.reason, 'd1-no-window')
    assert.equal(result.numbers.windowTokens, null)
  }
})

test('the self-healing bypass can be opted out of, and then delegates', () => {
  const result = decideCompaction({
    trigger: 'context-overflow',
    policy: { overflowRecovery: false },
    capacity: null,
    measure: () => {
      throw new Error('the overflow decision must not measure')
    }
  })
  assert.equal(result.action, 'delegate', 'an opt-out must not disable self-healing, only hand it back')
  assert.equal(result.reason, 'd1-overflow-recovery-disabled')
})

test('every action is one of the frozen three', () => {
  const seen = new Set()
  for (const context of [
    { trigger: 'pressure', policy: {}, capacity: { windowTokens: W }, measure: measureOf(0, 0) },
    { trigger: 'pressure', policy: {}, capacity: null, measure: measureOf(0, 0) },
    { trigger: 'pressure', policy: {}, capacity: { windowTokens: W }, measure: measureOf(FULL, 0) },
    { trigger: 'context-overflow', policy: {}, capacity: null, measure: measureOf(0, 0) }
  ]) {
    const result = decideCompaction(context)
    assert.ok(['delegate', 'skip', 'compact'].includes(result.action))
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
    seen.add(result.action)
  }
  assert.ok(seen.size >= 2)
})

test('ratio scaling is exact integer arithmetic, not float multiplication', () => {
  for (const w of [1, 3, 7, 99, 999, 65536, 999999, 1000000, 1000001, 123456789]) {
    assert.equal(scaleByRatio(w, 0.9), Number((BigInt(w) * 9n) / 10n))
    assert.equal(scaleByRatio(w, 0.95), Number((BigInt(w) * 95n) / 100n))
  }
})

test('every reason carries the numbers that produced it', () => {
  const result = decideCompaction(pressure({ measure: measureOf(1234, 5678) }))
  assert.deepEqual(result.numbers, {
    windowTokens: W,
    activeTokens: 1234,
    scopeTokens: 5678,
    limitTokens: LIMIT,
    fullTokens: FULL,
    thresholdTokens: LIMIT,
    bufferTokens: 0,
    turnEndPercent: 0,
    limitReached: false,
    fullReached: false,
    turnEndReached: false
  })
})

test('the trigger union stays closed', () => {
  for (const bad of [undefined, null, 'manual', 'boom', 0]) {
    assert.throws(() => decideCompaction({ trigger: bad }), TypeError)
  }
  for (const good of COMPACTION_TRIGGERS) {
    assert.doesNotThrow(() => decideCompaction({ trigger: good, policy: {}, capacity: undefined }))
  }
})

const invalidPolicies = [
  ['triggerLimitRatio 0', { triggerLimitRatio: 0 }],
  ['triggerLimitRatio above 1', { triggerLimitRatio: 1.1 }],
  ['triggerLimitRatio not a number', { triggerLimitRatio: 'x' }],
  ['effectiveWindowPercent above 1', { effectiveWindowPercent: 1.2 }],
  ['effectiveWindowPercent 0', { effectiveWindowPercent: 0 }],
  ['triggerBufferTokens negative', { triggerBufferTokens: -1 }],
  ['triggerBufferTokens fractional', { triggerBufferTokens: 1.5 }],
  ['turnEndPercent above 100', { turnEndPercent: 101 }],
  ['turnEndPercent negative', { turnEndPercent: -1 }],
  ['triggerLimitTokens 0', { triggerLimitTokens: 0 }],
  ['triggerLimitTokens fractional', { triggerLimitTokens: 1.5 }],
  ['overflowRecovery not a boolean', { overflowRecovery: 'yes' }]
]

for (const [name, policy] of invalidPolicies) {
  test('rejects an out-of-range policy: ' + name, () => {
    assert.throws(() => decideCompaction(pressure({ policy })), RangeError)
  })
}
