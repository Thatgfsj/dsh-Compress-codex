import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SYSTEM_BARRIER_MIN_SHADOW_RATIO, foldSurfaceBalance, localToolPairingBalancedAfter,
  localToolPairingBalancedBefore, planCompactionRange, selectCompactionRange,
  splitSurfaceUnits, surfaceEventDelta
} from '../lib/core/select.js'
import { assertSafeRange, build, guardedSession, indexOfSeq, mulberry32, planOf, policy } from './support/select-fixtures.mjs'
import { randomKinds, rangeOf, referenceCuts, sessionOf, sequences } from './support/select-fixtures.mjs'
import { createHostToolPairing } from './support/host-tool-pairing.mjs'

/** Reusable surface shapes: balanced units, with or without system/message barriers. */
const TWO_UNITS = ['system', 'user', 'call1', 'result', 'user', 'call1', 'result']
const FOUR_UNITS = Array.from({ length: 4 }, () => ['user', 'call1', 'result']).flat()
// A system/message in the third of four units (affordable detour) vs the first (gutted).
const BARRIER_NEAR = [...TWO_UNITS, 'user', 'call1', 'result', 'system', 'user', 'call1', 'result']
const BARRIER_EARLY = ['system', 'user', 'call1', 'result', 'system', ...FOUR_UNITS]

test('the selector requires a session and answers null for an unreadable surface', () => {
  assert.throws(() => selectCompactionRange(), TypeError)
  assert.throws(() => selectCompactionRange({}), TypeError)
  assert.throws(() => planCompactionRange({ session: null }), TypeError)
  assert.equal(selectCompactionRange({ session: { surface: { nodes: [] } } }), null)
  assert.equal(selectCompactionRange({ session: {} }), null)
})

test('the frozen return shape carries the inclusive span and the retained head', () => {
  const events = build(TWO_UNITS)
  const range = rangeOf(events, { retainRecentUnits: 1 })
  assert.notEqual(range, null)
  assert.deepEqual(
    { start: range.start, end: range.end, retainFrom: range.retainFrom },
    { start: 1, end: 3, retainFrom: 4 }
  )
  assert.equal(typeof range.reason, 'string')
  assert.equal(range.shadowedUnitCount, 1)
  assert.equal(range.retainedUnitCount, 1)
  assertSafeRange(events, range, 'pressure')
})

test('manual compaction leaves /compact to the official engine', () => {
  const events = build(TWO_UNITS)
  assert.equal(rangeOf(events, {}, { trigger: 'manual' }), null)
  const plan = planOf(events, {}, { trigger: 'manual' })
  assert.equal(plan.status, 'none')
  assert.match(plan.reason, /manual/)
})

test('surface node 0 stays verbatim, system head or not (C2)', () => {
  const headed = build(TWO_UNITS)
  assert.equal(indexOfSeq(headed, rangeOf(headed, { retainRecentUnits: 1 }).start), 1)
  const headless = build(['user', 'call1', 'result', 'user', 'call1', 'result'])
  assert.equal(indexOfSeq(headless, rangeOf(headless, { retainRecentUnits: 1 }).start), 1)
  const doubleHead = build(['system', 'system', 'user', 'call1', 'result', 'user', 'call1', 'result'])
  assert.equal(indexOfSeq(doubleHead, rangeOf(doubleHead, { retainRecentUnits: 1 }).start), 2)
})

test('the compactable start snaps forward to a balanced cut', () => {
  const events = build(['call1', 'result', 'user', 'call1', 'result', 'user', 'call1', 'result'])
  const plan = planOf(events, { retainRecentUnits: 1 })
  assert.equal(plan.status, 'shadow', plan.reason)
  assert.deepEqual([plan.startIndex, plan.start, plan.end], [2, 2, 4])
  assertSafeRange(events, plan, 'snapped')
})

test('one indivisible unit means null and zero writes', () => {
  const events = build(['system', 'user', 'call1', 'result'])
  const touched = []
  const plan = planCompactionRange({ session: guardedSession(events, touched), policy: policy({ retainRecentUnits: 1 }) })
  assert.equal(plan.status, 'none')
  assert.match(plan.reason, /nothing to shadow/)
  assert.equal(rangeOf(events, { retainRecentUnits: 1 }), null)
  assert.deepEqual([...new Set(touched)].sort(), ['eventAt', 'surface'])
})

test('retaining every unit means null, and the selector only reads surface/eventAt', () => {
  const events = build(TWO_UNITS)
  assert.equal(rangeOf(events, { retainRecentUnits: 3 }), null)
  assert.match(planOf(events, { retainRecentUnits: 3 }).reason, /nothing to shadow/)
  const touched = []
  const range = selectCompactionRange({ session: guardedSession(events, touched), policy: policy({ retainRecentUnits: 1 }) })
  assert.notEqual(range, null)
  assert.deepEqual([...new Set(touched)].sort(), ['eventAt', 'surface'])
})

test('corrupt surfaces and unsupported policy fail closed without writing', () => {
  const base = build(TWO_UNITS)
  assert.equal(rangeOf(build(['system', 'user', 'result', 'user', 'call1', 'result']), {}), null)
  const missing = sessionOf(base)
  missing.eventAt = () => undefined
  assert.equal(selectCompactionRange({ session: missing }), null)
  const mismatched = sessionOf(base)
  mismatched.eventAt = (seq) => ({ seq: seq + 100, type: 'user/message', data: {} })
  assert.equal(selectCompactionRange({ session: mismatched }), null)
  const bad = [
    { retainMode: 'weighted' },
    { retainRecentUnits: 0 },
    { retainRecentUnits: 1.5 },
    { retainRecentUnits: '3' },
    { retainTokens: -1 },
    { retainTokens: 1.5 }
  ]
  for (const overrides of bad) {
    const plan = planOf(base, overrides)
    assert.equal(plan.status, 'none', JSON.stringify(overrides))
    assert.match(plan.reason, /retainMode|retainRecentUnits|retainTokens/)
  }
})

test('retainTokens is a soft bound: the newest unit is kept whole', () => {
  const events = build(TWO_UNITS)
  const nodes = sequences(events)
  const measure = () => ({ nodes: nodes.map((seq) => ({ seq, tokens: seq >= 4 ? 1000 : 1 })) })
  const plan = planOf(events, { retainRecentUnits: 5, retainTokens: 10 }, { measure })
  assert.equal(plan.status, 'shadow', plan.reason)
  assert.equal(plan.endIndex, 3, 'the span stops before the whole newest unit')
  assert.equal(plan.tokenBudgetApplied, true)
  assert.ok(plan.retainedTokens > 10, 'the budget is exceeded rather than splitting the unit')
  assert.equal(plan.retainedUnitCount, 1)
  const range = rangeOf(events, { retainRecentUnits: 5, retainTokens: 10 }, { measure })
  assert.deepEqual({ start: range.start, end: range.end }, { start: 1, end: 3 })
  assertSafeRange(events, range, 'soft-cap')
})

test('retainTokens narrows the retained tail without ever splitting a unit', () => {
  const events = build(FOUR_UNITS)
  const nodes = sequences(events)
  const plan = planOf(
    events,
    { retainRecentUnits: 10, retainTokens: 60 },
    { measure: () => ({ nodes: nodes.map((seq) => ({ seq, tokens: 10 })) }) }
  )
  assert.equal(plan.status, 'shadow', plan.reason)
  assert.equal(plan.unitCount, 4)
  assert.equal(plan.retainedUnitCount, 2, '60 tokens buys two 30-token units')
  assert.equal(plan.shadowedUnitCount, 2)
  assert.equal(plan.retainedTokens, 60)
  assert.equal(plan.retainFrom, nodes[plan.endIndex + 1])
})

test('context-overflow bypasses the retention policy down to the newest unit', () => {
  const events = build(FOUR_UNITS)
  assert.equal(planOf(events, { retainRecentUnits: 8 }).status, 'none', 'pressure keeps every unit')
  const overflow = planOf(events, { retainRecentUnits: 8 }, { trigger: 'context-overflow' })
  assert.equal(overflow.status, 'shadow')
  assert.equal(overflow.retainedUnitCount, 1)
  assert.equal(overflow.retainedUnitCount + overflow.shadowedUnitCount, overflow.unitCount)
  assertSafeRange(events, overflow, 'overflow')
})

test('an in-history system/message is kept when the detour still releases most of the span', () => {
  const events = build(BARRIER_NEAR)
  const plan = planOf(events, { retainRecentUnits: 1 })
  assert.equal(plan.status, 'shadow', plan.reason)
  assert.equal(plan.end, 6, 'the cut is pulled back in front of the system node unit')
  assert.equal(plan.systemBarrier, 'kept')
  assert.equal(plan.systemBarrierPreference, 'applied')
  assert.ok(indexOfSeq(events, 10) > indexOfSeq(events, plan.end))
  assertSafeRange(events, plan, 'barrier-kept')
})

test('an in-history system/message is crossed rather than making a long session uncompactable', () => {
  const events = build(BARRIER_EARLY)
  const plan = planOf(events, { retainRecentUnits: 1 })
  assert.equal(plan.status, 'shadow', plan.reason)
  assert.equal(plan.systemBarrier, 'crossed')
  assert.equal(plan.systemBarrierPreference, 'declined')
  assert.equal(plan.shadowedNodeCount, 13, 'the early prompt update does not block compaction')
  assert.match(plan.reason, /crossed/)
  assertSafeRange(events, plan, 'barrier-crossed')
  // Reverse: a hard barrier would stop in front of the system node and gut compaction.
  const hardBarrierEnd = 3
  const ours = rangeOf(events, { retainRecentUnits: 1 })
  assert.equal(indexOfSeq(events, ours.end), 13)
  assert.ok(indexOfSeq(events, ours.end) > hardBarrierEnd + 5)
  assert.equal(SYSTEM_BARRIER_MIN_SHADOW_RATIO, 0.5)
  // A system/message the policy cut already retains needs no detour at all.
  const retained = planOf(build([...TWO_UNITS, 'system']), { retainRecentUnits: 1 })
  assert.equal(retained.systemBarrier, 'kept')
  assert.equal(retained.systemBarrierPreference, 'not-needed')
})

test('an injected host checker is used and reported', () => {
  const events = build(TWO_UNITS)
  const host = createHostToolPairing()
  const calls = []
  const edgeChecks = {
    before: (session, seq) => (calls.push(seq), host.before(session, seq)),
    after: (session, seq) => (calls.push(seq), host.after(session, seq))
  }
  const plan = planOf(events, { retainRecentUnits: 1 }, { edgeChecks })
  assert.equal(plan.status, 'shadow')
  assert.equal(plan.edgeChecks, 'injected')
  assert.ok(calls.length > 0, 'the injected checks must be consulted')
  const local = planOf(events, { retainRecentUnits: 1 })
  assert.equal(local.edgeChecks, 'local')
  assert.deepEqual({ start: plan.start, end: plan.end }, { start: local.start, end: local.end })
})

test('a disagreeing injection is never silently replaced by the local fallback', () => {
  const events = build(TWO_UNITS)
  assert.equal(planOf(events, { retainRecentUnits: 1 }).status, 'shadow', 'the fallback would accept this range')
  const refused = planOf(events, { retainRecentUnits: 1 }, {
    edgeChecks: { before: () => false, after: () => true }
  })
  assert.equal(refused.status, 'none')
  const boom = () => {
    throw new Error('host helper blew up')
  }
  const pair = { before: localToolPairingBalancedBefore, after: boom }
  assert.equal(rangeOf(events, { retainRecentUnits: 1 }, { edgeChecks: pair }), null)
})

test('injected host semantics agree with the local fallback at every surface position', () => {
  const host = createHostToolPairing()
  const rng = mulberry32(0x1234abcd)
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const events = build(randomKinds(rng))
    const session = sessionOf(events)
    const cuts = referenceCuts(events)
    for (let index = 0; index < events.length; index += 1) {
      const seq = events[index].seq
      const where = iteration + '/' + index
      assert.equal(localToolPairingBalancedBefore(session, seq), host.before(session, seq), 'before ' + where)
      assert.equal(localToolPairingBalancedAfter(session, seq), host.after(session, seq), 'after ' + where)
      assert.equal(localToolPairingBalancedBefore(session, seq), cuts[index], 'before reference ' + where)
      assert.equal(localToolPairingBalancedAfter(session, seq), cuts[index + 1], 'after reference ' + where)
    }
    for (const check of [localToolPairingBalancedBefore, localToolPairingBalancedAfter, host.before, host.after]) {
      assert.throws(() => check(session, events.length), /not found/)
    }
  }
})

test('the local fallback mirrors the host helper contract', () => {
  const events = build(TWO_UNITS)
  const session = sessionOf(events)
  const cuts = [1, 2, 3].map((seq) => [localToolPairingBalancedBefore(session, seq), localToolPairingBalancedAfter(session, seq)])
  assert.deepEqual(cuts, [[true, true], [true, false], [false, true]])
  assert.throws(() => localToolPairingBalancedBefore(session, 99), /not found/)
  assert.deepEqual([surfaceEventDelta(events[1]), surfaceEventDelta(events[2]), surfaceEventDelta(events[3])], [0, 1, -1])
})

test('a missing or mismatched measurement degrades to structure-only retention', () => {
  const events = build(TWO_UNITS)
  const untouched = planOf(events, { retainRecentUnits: 1 }, {
    measure: () => {
      throw new Error('measure must not be called without retainTokens')
    }
  })
  assert.equal(untouched.status, 'shadow')
  assert.equal(untouched.tokenBudgetApplied, false)
  for (const measure of [
    () => ({ nodes: [{ seq: 6, tokens: 1 }] }),
    () => {
      throw new Error('no token meter')
    },
    () => ({ nodes: sequences(events).map((seq) => ({ seq, tokens: '10' })) })
  ]) {
    const plan = planOf(events, { retainRecentUnits: 1, retainTokens: 100 }, { measure })
    assert.equal(plan.status, 'shadow')
    assert.equal(plan.tokenBudgetApplied, false)
  }
})

test('the plan explains both the chosen span and the null answers', () => {
  const events = build(TWO_UNITS)
  const chosen = planOf(events, { retainRecentUnits: 1 })
  assert.equal(chosen.status, 'shadow')
  assert.match(chosen.reason, /structural retention/)
  assert.deepEqual(
    [chosen.startIndex, chosen.endIndex, chosen.shadowedNodeCount, chosen.surfaceNodes, chosen.trigger],
    [1, 3, 3, events.length, 'pressure']
  )
  const empty = planOf([], {})
  assert.equal(empty.status, 'none')
  assert.match(empty.reason, /no nodes/)
  const oneUnit = planOf(build(['system', 'user', 'call1', 'result']), { retainRecentUnits: 1 })
  assert.equal(oneUnit.status, 'none')
  assert.match(oneUnit.reason, /nothing to shadow/)
  // capacity is diagnostics-only: it must not invent a retention budget.
  const capped = planOf(events, { retainRecentUnits: 1 }, { capacity: { windowTokens: 200000 } })
  assert.deepEqual([capped.status, capped.windowTokens], ['shadow', 200000])
  assert.equal(rangeOf(events, { retainRecentUnits: 1 }, { capacity: null }).start, 1)
})

test('property: every returned span is C1-balanced, keeps node 0, and never splits a unit', () => {
  const rng = mulberry32(0x5e1ec7)
  const host = createHostToolPairing()
  let selected = 0
  let none = 0
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const events = build(randomKinds(rng))
    const nodes = sequences(events)
    const retainRecentUnits = 1 + Math.floor(rng() * 4)
    const roll = rng()
    const retainTokens = roll < 0.25 ? undefined : roll < 0.5 ? 0 : roll < 0.75 ? 40 : 400
    const trigger = rng() < 0.2 ? 'context-overflow' : 'pressure'
    const plan = planOf(events, { retainRecentUnits, retainTokens }, {
      trigger,
      capacity: { windowTokens: 100000 },
      measure: () => ({ nodes: nodes.map((seq) => ({ seq, tokens: (seq * 7) % 31 })) }),
      edgeChecks: host
    })
    assert.ok(plan.reason.length > 0, 'every plan explains itself')
    if (plan.status === 'none') {
      none += 1
      continue
    }
    selected += 1
    assert.equal(plan.edgeChecks, 'injected', 'the corpus must exercise the host injection path')
    assertSafeRange(events, plan, 'property #' + iteration)
    const folded = foldSurfaceBalance(nodes, sessionOf(events).eventAt)
    const units = splitSurfaceUnits(folded.entries, folded.cutBalanced, plan.startIndex, plan.endIndex)
    assert.equal(plan.shadowedUnitCount, units.length)
    assert.deepEqual([units[0].start, units[units.length - 1].end], [plan.startIndex, plan.endIndex])
    assert.equal(plan.retainFrom, nodes[plan.endIndex + 1])
    assert.equal(plan.retainedUnitCount + plan.shadowedUnitCount, plan.unitCount)
    if (trigger === 'context-overflow') assert.equal(plan.retainedUnitCount, 1)
    else assert.ok(plan.retainedUnitCount <= retainRecentUnits)
    const span = events.slice(plan.startIndex, plan.endIndex + 1)
    assert.equal(plan.systemBarrier === 'crossed', span.some((event) => event.type === 'system/message'))
    assert.notEqual(plan.systemBarrierPreference, undefined)
  }
  assert.ok(selected > 30, 'the corpus must exercise real selections, got ' + String(selected))
  assert.ok(none > 30, 'the corpus must exercise null answers, got ' + String(none))
})

test('reverse: a naive token-boundary cut splits a tool pair and the assertion catches it', () => {
  const events = build(TWO_UNITS)
  // Naive Codex-style port: cut at a token boundary, never check pairing.
  const naive = { start: events[1].seq, end: events[5].seq }
  assert.throws(() => assertSafeRange(events, naive, 'naive'), /balanced|orphan|close/)
  const ours = rangeOf(events, { retainRecentUnits: 1, retainTokens: 0 })
  assert.doesNotThrow(() => assertSafeRange(events, ours, 'ours'))
  assert.equal(indexOfSeq(events, ours.end), 3, 'we pull the cut back to a whole-unit boundary')
})

test('reverse: shadowing node 0 or an orphaned result is caught by the assertion', () => {
  const events = build(TWO_UNITS)
  const naive = { start: events[0].seq, end: events[events.length - 2].seq }
  assert.throws(() => assertSafeRange(events, naive, 'naive'), /node 0/)
  assert.throws(() => assertSafeRange(events, { start: 3, end: 6 }, 'naive-shifted'), /balanced|orphan|close/)
  assert.doesNotThrow(() => assertSafeRange(events, rangeOf(events, { retainRecentUnits: 1 }), 'ours'))
})
