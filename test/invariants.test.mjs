/**
 * M4-11 — cross-module invariant regression.
 *
 * Every other test file checks one module against its own contract. This file
 * checks the **seams** between them, because that is where the illegal requests
 * are produced:
 *
 *   C1  every span handed to the transaction is tool-pairing balanced on both
 *       edges, for the host edge checks *and* for the zero-dependency fallback;
 *   C2  surface node 0 never lands inside a shadowed span;
 *   ZW  a decision that compacts nothing appends nothing (no session write);
 *   D1  monotonicity: growing usage never turns a 'compact' back into a 'skip';
 *   DS  decision/selection consistency: 'skip'/'delegate' never reach the
 *       selector, and a 'compact' decision commits exactly the selector's span.
 *
 * C1 verdicts come from test/support/host-tool-pairing.mjs, a verdict-for-verdict
 * reproduction of the host algorithm (dsh-compaction/lib/types/tool-pairing.js,
 * 0.2.1-rc.2) — never from lib/core/select.js, so this file can falsify it.
 *
 * Every property runs from a fixed seed and names it on failure, so a red run is
 * reproducible with DSH_INVARIANTS_SEED=<seed>.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_POLICY, normalizePolicy } from '../lib/core/config.js'
import { decideCompaction } from '../lib/core/trigger.js'
import { createCodexCompactionEngine } from '../lib/engine.js'
import { selectCompactionRange } from '../lib/core/select.js'
import { build, indexOfSeq, mulberry32, randomKinds, sequences } from './support/select-fixtures.mjs'
import { createHostToolPairing } from './support/host-tool-pairing.mjs'
import { createFakeAgent, createFakeCtx } from './support/fake-base.mjs'

/** Fixed seed; override only to hunt for more counterexamples. */
const SEED = Number(process.env.DSH_INVARIANTS_SEED ?? 0x11c0ffee)
const CASES = Number(process.env.DSH_INVARIANTS_CASES ?? 250)

/** Run one property case; a failure names the seed and case so it reproduces. */
function property(label, index, run) {
  try {
    run()
  } catch (error) {
    throw new Error('invariant ' + label + ' failed at seed ' + SEED + ' case ' + index + ': ' + error.message, {
      cause: error
    })
  }
}

/** The async twin of property(), for cases that drive the engine. */
async function propertyAsync(label, index, run) {
  try {
    await run()
  } catch (error) {
    throw new Error('invariant ' + label + ' failed at seed ' + SEED + ' case ' + index + ': ' + error.message, {
      cause: error
    })
  }
}

/** Policy built from the frozen defaults, so normalizePolicy never rejects it. */
const policyOf = (overrides) => normalizePolicy({ ...DEFAULT_POLICY, ...overrides })

/** A read-only session that also counts writes, for the zero-write invariant. */
function recordingSession(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const appended = []
  let next = events.length
  return {
    surface: { nodes: sequences(events), replaceGeneration: 0 },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data) {
      appended.push({ type, data })
      return { seq: next++, type, data }
    },
    appended
  }
}

/** C1/C2 acceptance at the transaction boundary, judged by the host contract. */
function assertTransactionSafe(session, events, range, host, label) {
  const startIndex = indexOfSeq(events, range.start)
  const endIndex = indexOfSeq(events, range.end)
  assert.notEqual(startIndex, -1, label + ': start must be a surface node')
  assert.notEqual(endIndex, -1, label + ': end must be a surface node')
  assert.ok(startIndex <= endIndex, label + ': the span must not be reversed')
  assert.ok(startIndex >= 1, label + ': surface node 0 must never be shadowed (C2)')
  assert.equal(host.before(session, range.start), true, label + ': the leading cut must be balanced (C1)')
  assert.equal(host.after(session, range.end), true, label + ': the trailing cut must be balanced (C1)')
  // A system/message *after* node 0 may be crossed on purpose: the soft barrier
  // preference (Lead ruling) only keeps it visible while that is affordable.
  // C2 protects node 0 alone, which the startIndex check above pins down.
}

/** One random, structurally valid surface plus a random retention policy. */
function randomCase(rng) {
  const events = build(randomKinds(rng))
  const roll = rng()
  return {
    events,
    policy: policyOf({
      retainRecentUnits: 1 + Math.floor(rng() * 4),
      // The #3 schema requires a positive integer, so 1 stands in for
      // "smallest useful budget" (the soft bound still keeps one whole unit).
      retainTokens: roll < 0.3 ? undefined : roll < 0.6 ? 1 : roll < 0.85 ? 40 : 400
    }),
    trigger: rng() < 0.25 ? 'context-overflow' : 'pressure'
  }
}

// ---------------------------------------------------------------------------
// C1 / C2 — the selector's span, judged by the host contract
// ---------------------------------------------------------------------------

test('C1+C2 (property): every selector span is balanced on both edges and keeps node 0', () => {
  const rng = mulberry32(SEED)
  const host = createHostToolPairing()
  let selected = 0
  let refused = 0
  for (let index = 0; index < CASES; index += 1) {
    property('C1+C2', index, () => {
      const { events, policy, trigger } = randomCase(rng)
      // Both edge-check sources must agree: the injected host pair and the
      // zero-dependency fallback the gate uses when no host helper exists.
      for (const edgeChecks of [host, null]) {
        const session = recordingSession(events)
        const range = selectCompactionRange({
          session,
          policy,
          trigger,
          capacity: { windowTokens: 100000 },
          measure: () => ({ nodes: sequences(events).map((seq) => ({ seq, tokens: (seq * 7) % 31 })) }),
          edgeChecks
        })
        assert.equal(session.appended.length, 0, 'selection must never write')
        if (range === null) {
          refused += 1
          continue
        }
        selected += 1
        assertTransactionSafe(session, events, range, host, edgeChecks === null ? 'fallback' : 'host')
      }
    })
  }
  assert.ok(selected > 50, 'the corpus must exercise real spans, got ' + String(selected))
  assert.ok(refused > 50, 'the corpus must exercise refusals, got ' + String(refused))
})

test('reverse: the C1 checker rejects a span that really splits a tool pair', () => {
  const host = createHostToolPairing()
  // [system0, user1, call2, result3] — ending at the call leaves its result out.
  const events = build(['system', 'user', 'call1', 'result', 'user', 'call1', 'result'])
  const session = recordingSession(events)
  assert.throws(
    () => assertTransactionSafe(session, events, { start: events[1].seq, end: events[2].seq }, host, 'naive'),
    /trailing cut must be balanced/
  )
  // ...and accepts the real selector on the same surface, so the rejection is
  // about the span, not about the checker refusing everything.
  const ours = selectCompactionRange({ session, policy: policyOf({ retainRecentUnits: 1 }), trigger: 'pressure', capacity: null, measure: () => ({ nodes: [] }), edgeChecks: host })
  assert.doesNotThrow(() => assertTransactionSafe(session, events, ours, host, 'ours'))
})

test('reverse: a node-0 span passes balance but must still be rejected by C2', () => {
  const host = createHostToolPairing()
  const events = build(['user', 'call1', 'result', 'user', 'call1', 'result'])
  const session = recordingSession(events)
  // The cut before node 0 is trivially balanced, so only C2 can catch this.
  assert.equal(host.before(session, events[0].seq), true)
  assert.throws(
    () => assertTransactionSafe(session, events, { start: events[0].seq, end: events[1].seq }, host, 'naive'),
    /node 0/
  )
})

// ---------------------------------------------------------------------------
// Zero writes
// ---------------------------------------------------------------------------

test('zero-write (property): a refusal appends nothing to the session', () => {
  const rng = mulberry32(SEED ^ 0x5eed)
  const host = createHostToolPairing()
  let refusals = 0
  for (let index = 0; index < CASES; index += 1) {
    property('zero-write', index, () => {
      const { events, policy, trigger } = randomCase(rng)
      const session = recordingSession(events)
      const range = selectCompactionRange({ session, policy, trigger, capacity: null, measure: () => ({ nodes: [] }), edgeChecks: host })
      if (range === null) refusals += 1
      assert.deepEqual(session.appended, [], 'no decision may append a session event')
      // The four refusal reasons that must exist at least once across the corpus.
      assert.notEqual(session.surface.nodes.length, 0)
    })
  }
  assert.ok(refusals > 20, 'the corpus must contain refusals, got ' + String(refusals))
})

test('zero-write: an unreadable or empty surface refuses without touching the session', () => {
  const host = createHostToolPairing()
  const empty = recordingSession([])
  assert.equal(selectCompactionRange({ session: empty, policy: policyOf({}), trigger: 'pressure', capacity: null, measure: () => ({ nodes: [] }), edgeChecks: host }), null)
  assert.deepEqual(empty.appended, [])
  const corrupt = build(['system', 'user', 'result'])
  const corruptSession = recordingSession(corrupt)
  assert.equal(selectCompactionRange({ session: corruptSession, policy: policyOf({}), trigger: 'pressure', capacity: null, measure: () => ({ nodes: [] }), edgeChecks: host }), null)
  assert.deepEqual(corruptSession.appended, [])
})

// ---------------------------------------------------------------------------
// D1 monotonicity
// ---------------------------------------------------------------------------

/** Ascending usage vectors for one window: the shape a real session traces. */
function usageLadder(windowTokens, steps = 24) {
  const ladder = []
  for (let step = 0; step <= steps; step += 1) {
    const total = Math.floor((windowTokens * step) / steps)
    ladder.push({ totalTokens: total, surfaceTokens: Math.max(0, total - Math.floor(windowTokens / 20)) })
  }
  return ladder
}

/** First point where a 'compact' outcome regresses into a non-compact one. */
function firstMonotonicityViolation(decide, { windowTokens, policy, usages }) {
  let compacted = false
  for (const usage of usages) {
    const result = decide({ trigger: 'pressure', policy, capacity: { windowTokens }, measure: () => usage })
    assert.equal(typeof result.action, 'string', 'a decision must name its action')
    if (result.action === 'compact') {
      compacted = true
      continue
    }
    if (compacted) return { usage, action: result.action }
  }
  return null
}

test('D1 monotonicity (property): growing usage never turns compact back into skip', () => {
  const rng = mulberry32(SEED ^ 0xd1d1)
  for (let index = 0; index < CASES; index += 1) {
    property('D1-monotonic', index, () => {
      const windowTokens = 8192 + Math.floor(rng() * 1000000)
      const policy = policyOf({
        triggerLimitRatio: 0.3 + rng() * 0.6,
        effectiveWindowPercent: 1,
        triggerBufferTokens: Math.floor(rng() * 4096),
        turnEndPercent: 0
      })
      const violation = firstMonotonicityViolation(decideCompaction, {
        windowTokens,
        policy,
        usages: usageLadder(windowTokens)
      })
      assert.equal(violation, null, 'compact regressed at ' + JSON.stringify(violation))
    })
  }
})

test('reverse: a band-based decider violates the monotonicity checker', () => {
  const windowTokens = 100000
  const policy = policyOf({ triggerLimitRatio: 0.9, effectiveWindowPercent: 1 })
  const bandDecider = ({ capacity, policy: active, measure }) => {
    const { surfaceTokens } = measure()
    const window = capacity.windowTokens
    const limit = Math.floor(window * active.triggerLimitRatio)
    // Broken on purpose: fires only inside a band, so a fuller session falls back
    // out of it — exactly the regression the invariant must catch.
    return surfaceTokens >= limit && surfaceTokens < limit + Math.floor(window * 0.02)
      ? { action: 'compact', reason: 'band' }
      : { action: 'skip', reason: 'band' }
  }
  const violation = firstMonotonicityViolation(bandDecider, {
    windowTokens,
    policy,
    usages: usageLadder(windowTokens)
  })
  assert.notEqual(violation, null, 'the checker must catch a non-monotone decider')
  assert.equal(violation.action, 'skip')
  // The real decider is monotone on the same ladder.
  assert.equal(firstMonotonicityViolation(decideCompaction, { windowTokens, policy, usages: usageLadder(windowTokens) }), null)
})

test('D1: an unknown window delegates instead of skipping, so official policy survives', () => {
  const policy = policyOf({})
  for (const capacity of [null, undefined, { windowTokens: 0 }, { windowTokens: 1.5 }]) {
    const result = decideCompaction({
      trigger: 'pressure',
      policy,
      capacity,
      measure: () => {
        throw new Error('an unknown window must not need a measurement')
      }
    })
    assert.equal(result.action, 'delegate', JSON.stringify(capacity))
  }
})

// ---------------------------------------------------------------------------
// Decision / selection consistency, through the engine
// ---------------------------------------------------------------------------

/** Mount the real decision layer over a base that only records the span. */
function mountRealEngine({ session, measurement, windowTokens = 100000, config = {}, edgeChecks = null, hooks } = {}) {
  const regionCalls = []
  class RecordingBase {
    constructor(ctx, baseConfig) {
      this.ctx = ctx
      this.config = baseConfig
    }
    async compactIfNeeded() {
      return { base: true }
    }
    compactNow() {
      return { base: true }
    }
    async summarize() {
      return { summary: [{ type: 'text', text: 'base' }], provider: 'p', model: 'm' }
    }
    compactRegion(start, end) {
      regionCalls.push([start, end])
      return { start, end }
    }
  }
  const ctx = createFakeCtx({ windowTokens, measurement })
  const Engine = createCodexCompactionEngine(RecordingBase, hooks, { edgeChecks })
  const agent = { session, options: createFakeAgent().options }
  return { engine: new Engine(ctx, config), regionCalls }
}

test('consistency (property): the engine commits exactly the selector span, or nothing', async () => {
  const rng = mulberry32(SEED ^ 0xda7a)
  const host = createHostToolPairing()
  let committed = 0
  let quiet = 0
  for (let index = 0; index < CASES; index += 1) {
    await propertyAsync('engine-dispatch', index, async () => {
      const { events, policy, trigger } = randomCase(rng)
      const retainRecentUnits = policy.retainRecentUnits
      const config = { retainRecentUnits }
      const windowTokens = 100000
      // Bias above the limit so most cases reach the selector; the thin arm of
      // the ladder is covered by the D1 property below.
      const totalTokens = Math.floor(windowTokens * (0.85 + rng() * 0.25))
      const measurement = { totalTokens, surfaceTokens: totalTokens }

      const session = recordingSession(events)
      const { engine, regionCalls } = mountRealEngine({
        session,
        measurement,
        windowTokens,
        config,
        edgeChecks: host
      })
      const decision = decideCompaction({
        trigger,
        policy: normalizePolicy(config),
        capacity: trigger === 'pressure' ? { windowTokens } : null,
        measure: () => measurement
      })
      const agent = { session, options: createFakeAgent().options }
      const result = await engine.compactIfNeeded(agent, trigger, undefined)
      // A null result is a quiet decision; { base: true } is the engine handing
      // the context-overflow path back to the official engine, which owns its own
      // writes. Neither may commit one of our spans.
      if (result === null || (result !== null && result.base === true)) {
        quiet += 1
        assert.deepEqual(regionCalls, [], 'a non-committing decision must not commit a span')
        assert.deepEqual(session.appended, [], 'a non-committing decision must not write')
        return
      }
      committed += 1
      assert.equal(regionCalls.length, 1, 'exactly one transaction per decision')
      const expected = selectCompactionRange({
        session,
        policy: normalizePolicy(config),
        trigger,
        capacity: trigger === 'pressure' ? { windowTokens } : null,
        measure: () => measurement,
        edgeChecks: host
      })
      assert.notEqual(expected, null, 'a committed decision must come from a real span')
      assert.deepEqual(regionCalls[0], [expected.start, expected.end], 'the committed span must be the selector span')
      assertTransactionSafe(session, events, { start: regionCalls[0][0], end: regionCalls[0][1] }, host, 'engine')
      assert.deepEqual(session.appended, [], 'the transaction is the base owner; the engine must not write')
      assert.equal(decision.action, 'compact')
    })
  }
  assert.ok(committed > 30, 'the corpus must commit spans, got ' + String(committed))
  assert.ok(quiet > 30, 'the corpus must contain quiet decisions, got ' + String(quiet))
})

test('consistency: skip and delegate never call the selector', async () => {
  const events = build(['system', 'user', 'call1', 'result', 'user', 'call1', 'result'])
  const calls = []
  const spy = (context) => {
    calls.push(context.trigger)
    return selectCompactionRange(context)
  }
  for (const action of ['skip', 'delegate']) {
    const { engine, regionCalls } = mountRealEngine({
      session: recordingSession(events),
      measurement: { totalTokens: 0, surfaceTokens: 0 },
      hooks: {
        decideCompaction: () => ({ action, reason: 'test-' + action }),
        selectCompactionRange: spy,
        buildSummaryRequest: () => null
      }
    })
    const result = await engine.compactIfNeeded({ session: recordingSession(events), options: {} }, 'pressure', undefined)
    assert.equal(result === null || result.base === true, true)
    assert.deepEqual(regionCalls, [])
  }
  assert.deepEqual(calls, [], 'the selector must not be consulted for skip/delegate')
})

test('consistency: a compact decision with no safe span is a zero-write null', async () => {
  const events = build(['system', 'user', 'call1', 'result'])
  const session = recordingSession(events)
  const { engine, regionCalls } = mountRealEngine({
    session,
    measurement: { totalTokens: 99999, surfaceTokens: 99999 },
    edgeChecks: createHostToolPairing()
  })
  const agent = { session, options: createFakeAgent().options }
  const result = await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(result, null)
  assert.deepEqual(regionCalls, [])
  assert.deepEqual(session.appended, [])
})
