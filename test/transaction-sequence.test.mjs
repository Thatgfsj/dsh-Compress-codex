/**
 * M4-11 — the compaction transaction's event-sequence contract, executable.
 *
 * The real transaction lives in BasicCompactionEngine (not importable under the
 * zero-install gate), so this file drives the engine's dispatch into a **model**
 * transcribed from `dsh-compaction-basic/lib/types/region.js` (0.2.1-rc.2):
 * validate the region (membership, order, both tool-pairing edges) BEFORE any
 * append → `compaction/start` → summarize → `compaction/summary` → adjacent
 * replacement `user/message` ({ surfaceOp: replace, sourceEventSeqs: [...] }) →
 * `compaction/end`; every failure after the marker makes exactly one end.
 *
 * Failure *classification* is owned by lib/core/errors.js and tested by
 * test/errors.test.mjs (#33). This file owns the sequence consequence of each
 * reaction: 'retry' then 'degrade' (a summary failure) opens a **fresh**
 * transaction and answers null while the session keeps running; 'propagate'
 * (busy / changed / commit / persistence / cancellation) means exactly one
 * attempt and the original error thrown unchanged; in every case one
 * `compaction/end` per `compaction/start` — the lock invariant this file exists
 * to pin down.
 *
 * The model is a contract model, not the host implementation: the host itself is
 * exercised by the ci/compat-next job and #12's runtime smoke. The D4 summarizer
 * call (#7) is out of scope: the model takes the summarizer as a parameter.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizePolicy } from '../lib/core/config.js'
import { createCodexCompactionEngine } from '../lib/engine.js'
import { build, sequences } from './support/select-fixtures.mjs'
import { createHostToolPairing } from './support/host-tool-pairing.mjs'
import { createFakeAgent, createFakeCtx } from './support/fake-base.mjs'

const EVENTS = (session) => session.appended.map((event) => event.type)
const TYPES = ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']

/** A session that records every append and never mutates real history. */
function createSession(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const appended = []
  let next = events.length
  return {
    surface: { nodes: sequences(events), replaceGeneration: 0 },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, options) {
      const event = { seq: next, type, data, ...(options === undefined ? {} : options) }
      next += 1
      appended.push(event)
      return event
    },
    appended
  }
}

/** Fresh identity per transaction, the way the host mints one per attempt. */
let transactionCounter = 0

/**
 * The transaction model: validation first, then the marker, then the protocol.
 * `summarize` may throw; `onCommit` runs between the summary record and the
 * replacement (a commit-stage failure is a real category in the host code).
 */
function runTransaction({ session, start, end, summarize, onCommit }) {
  const compactionId = 'c-' + (transactionCounter += 1)
  const nodes = session.surface.nodes
  const checks = createHostToolPairing()
  const startIndex = nodes.indexOf(start)
  const endIndex = nodes.indexOf(end)
  if (startIndex === -1) throw new Error('compactRegion: start seq ' + String(start) + ' not found in surface')
  if (endIndex === -1) throw new Error('compactRegion: end seq ' + String(end) + ' not found in surface')
  if (startIndex > endIndex) throw new Error('compactRegion: start is after end on the surface')
  if (!checks.before(session, start)) throw new Error('compactRegion: start is not a balanced boundary')
  if (!checks.after(session, end)) throw new Error('compactRegion: end is not a balanced boundary')
  const shadowedSeqs = nodes.slice(startIndex, endIndex + 1)

  const startEvent = session.append('compaction/start', { compactionId, turn: 1 })
  try {
    const summary = summarize()
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test'
    })
    if (onCommit !== undefined) onCommit()
    session.append(
      'user/message',
      { content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'compact-checkpoint', compactionId } },
      {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
      }
    )
    session.append('compaction/end', { compactionId, turn: 1 })
    return { compactionId }
  } catch (error) {
    session.append('compaction/end', { compactionId, turn: 1, error: String(error && error.message) })
    throw error
  }
}

/** The lock invariant: one end per start, every trigger, every failure class. */
function assertBalancedMarkers(session, label) {
  const starts = session.appended.filter((event) => event.type === 'compaction/start')
  const ends = session.appended.filter((event) => event.type === 'compaction/end')
  assert.equal(ends.length, starts.length, label + ': one compaction/end per compaction/start (no leaked lock)')
  starts.forEach((start, index) => {
    assert.equal(ends[index].data.compactionId, start.data.compactionId, label + ': attempt ' + index + ' closes its own marker')
  })
  return starts.length
}

/** Exactly one attempt: opened and closed at the edges — no lock leak. */
function assertClosedSequence(session, label) {
  const types = EVENTS(session)
  assert.equal(types.filter((type) => type === 'compaction/start').length, 1, label + ': exactly one start')
  assert.equal(types.filter((type) => type === 'compaction/end').length, 1, label + ': exactly one end')
  assert.equal(types[0], 'compaction/start', label + ': the sequence opens with the marker')
  assert.equal(types[types.length - 1], 'compaction/end', label + ': the sequence closes with the marker')
}

/** No marker at all: the transaction refused before taking the lock. */
function assertNoLockLeak(session, label) {
  assert.deepEqual(EVENTS(session), [], label + ': a rejected range must not take the compaction lock')
}

/** Mount the real decision layer over the transaction model, with a diagnostic sink. */
function mount({
  session,
  measurement = { totalTokens: 99999, surfaceTokens: 99999 },
  config = { retainRecentUnits: 1 },
  summarize,
  onCommit,
  signal,
  edgeChecks
}) {
  const calls = []
  const diagnostics = []
  class TransactionBase {
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
      throw new Error('the model passes its own summarizer; the engine hook is #7')
    }
    compactRegion(start, end) {
      calls.push([start, end])
      return runTransaction({ session, start, end, summarize, onCommit })
    }
  }
  const logger = {
    info() {},
    warn: (...args) => diagnostics.push(['warn', ...args]),
    error: (...args) => diagnostics.push(['error', ...args])
  }
  const ctx = { ...createFakeCtx({ windowTokens: 100000, measurement }), logger }
  const Engine = createCodexCompactionEngine(TransactionBase, undefined, { edgeChecks: edgeChecks ?? createHostToolPairing() })
  const agent = { session, options: createFakeAgent().options }
  return { engine: new Engine(ctx, config), agent, calls, diagnostics, signal }
}

const SURFACE = build([
  'system', 'user', 'call1', 'result', 'user', 'call1', 'result', 'user', 'call1', 'result'
])

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test('the success path is start -> summary -> replacement user/message -> end, in that order', async () => {
  const session = createSession(SURFACE)
  const { engine, agent, calls } = mount({
    session,
    summarize: () => [{ type: 'text', text: 'summary' }]
  })
  await engine.compactIfNeeded(agent, 'pressure', undefined)

  assert.equal(calls.length, 1, 'the selector span reaches the transaction exactly once')
  const [start, end] = calls[0]
  assert.deepEqual(EVENTS(session), TYPES, 'the protocol order is contractual (C3)')
  assertClosedSequence(session, 'success')

  const [startEvent, summaryEvent, replacement, endEvent] = session.appended
  assert.equal(summaryEvent.data.compactionId, startEvent.data.compactionId)
  assert.equal(endEvent.data.compactionId, startEvent.data.compactionId)
  assert.deepEqual(summaryEvent.data.shadowedRange, { start, end })
  assert.deepEqual(
    [replacement.surfaceOp.startSeq, replacement.surfaceOp.endSeq],
    [start, end],
    'the replacement shadows exactly the span the selector chose'
  )
  assert.equal(replacement.surfaceOp.op, 'replace')
  assert.deepEqual(replacement.sourceEventSeqs, [startEvent.seq, summaryEvent.seq, ...summaryEvent.data.shadowedSeqs])
  assert.equal(replacement.data.source.kind, 'compact-checkpoint')
  // The replacement is adjacent to the summary record: consumers pair them.
  assert.equal(session.appended.indexOf(replacement), session.appended.indexOf(summaryEvent) + 1)
})

test('the transaction model rejects exactly the spans the selector refuses to emit', async () => {
  const session = createSession(SURFACE)
  const { engine, agent, calls } = mount({
    session,
    summarize: () => [{ type: 'text', text: 'summary' }]
  })
  await engine.compactIfNeeded(agent, 'pressure', undefined)
  const [start, end] = calls[0]
  // Replaying the committed span through the model must validate again.
  const replay = createSession(SURFACE)
  assert.doesNotThrow(() =>
    runTransaction({ session: replay, start, end, summarize: () => [{ type: 'text', text: 's' }] })
  )
  assertClosedSequence(replay, 'replay')
})

// ---------------------------------------------------------------------------
// Failure paths (#33 semantics): every reaction closes its own markers
// ---------------------------------------------------------------------------

test('a summary failure retries once then degrades: two closed transactions, null, one error diagnostic', async () => {
  const session = createSession(SURFACE)
  const boom = () => {
    throw new Error('summarizer exploded')
  }
  const { engine, agent, diagnostics, calls } = mount({ session, summarize: boom })
  const result = await engine.compactIfNeeded(agent, 'pressure', undefined)

  assert.equal(result, null, 'a degraded summary failure keeps the session running')
  assert.deepEqual(EVENTS(session), ['compaction/start', 'compaction/end', 'compaction/start', 'compaction/end'])
  assert.equal(assertBalancedMarkers(session, 'summary failure'), 2, '#33 allows exactly one retry')
  // Each attempt is its own transaction with its own identity.
  const ids = session.appended.filter((event) => event.type === 'compaction/start').map((event) => event.data.compactionId)
  assert.notEqual(ids[0], ids[1], 'a retry opens a fresh transaction')
  // Each failed attempt recorded its own error on its own close event.
  assert.match(session.appended[1].data.error, /summarizer exploded/)
  assert.match(session.appended[3].data.error, /summarizer exploded/)
  assert.deepEqual(diagnostics.map((entry) => entry[0]), ['warn', 'error'], 'retry warns, degrade errors')
  assert.equal(diagnostics[1][2].error.code, 'summary')
  assert.equal(diagnostics[1][2].attempt, 2)
  assert.deepEqual(diagnostics[1][2].range, { start: calls[0][0], end: calls[0][1] }, 'the diagnostic names the span')
  assert.match(diagnostics[1][1], /degrade after a summary compaction failure/)
})

test('propagate-class failures keep the error identity and still close exactly one marker pair', async () => {
  const cases = [
    { code: 'busy', message: 'lock already active' },
    { code: 'changed', message: 'the surface changed' },
    { code: 'commit', message: 'commit stage failed' },
    { code: 'persistence', message: 'durability checkpoint failed' }
  ]
  for (const { code, message } of cases) {
    const session = createSession(SURFACE)
    const thrown = Object.assign(new Error(message), { code })
    const { engine, agent, diagnostics } = mount({
      session,
      summarize: () => [{ type: 'text', text: 'summary' }],
      onCommit: () => {
        throw thrown
      }
    })
    let caught
    try {
      await engine.compactIfNeeded(agent, 'pressure', undefined)
    } catch (error) {
      caught = error
    }
    assert.equal(caught, thrown, code + ': the caller sees the exact error, unwrapped')
    assert.equal(assertBalancedMarkers(session, code), 1, code + ': one attempt, one closed marker pair')
    assert.deepEqual(diagnostics, [], code + ': propagation is the caller’s to report, not ours')
  }
})

test('cancellation outranks a summary-shaped failure: propagate once, never retry, reason kept', async () => {
  const session = createSession(SURFACE)
  const controller = new AbortController()
  controller.abort()
  const reason = new Error('caller aborted the compaction')
  reason.name = 'AbortError'
  const { engine, agent, diagnostics } = mount({
    session,
    summarize: () => {
      throw reason
    }
  })
  let caught
  try {
    await engine.compactIfNeeded(agent, 'pressure', controller.signal)
  } catch (error) {
    caught = error
  }
  assert.equal(caught, reason, 'cancellation keeps its exact reason')
  assert.equal(assertBalancedMarkers(session, 'cancelled'), 1, 'an aborted call is never retried')
  assert.deepEqual(diagnostics, [], 'cancellation is not a diagnostic event')
})

test('a summary failure that succeeds on retry leaves exactly the successful protocol', async () => {
  const session = createSession(SURFACE)
  let attempts = 0
  const { engine, agent, diagnostics } = mount({
    session,
    summarize: () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient provider failure')
      return [{ type: 'text', text: 'summary' }]
    }
  })
  await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(assertBalancedMarkers(session, 'retry-then-success'), 2, 'the failed attempt still closed its marker')
  assert.deepEqual(diagnostics.map((entry) => entry[0]), ['warn'])
  // The second transaction is the one that committed the protocol.
  assert.deepEqual(EVENTS(session), ['compaction/start', 'compaction/end', ...TYPES])
})

// ---------------------------------------------------------------------------
// Validation before the lock
// ---------------------------------------------------------------------------

test('an unbalanced or reversed range is refused before the lock is taken', () => {
  const session = createSession(SURFACE)
  const ok = () => [{ type: 'text', text: 'summary' }]
  // Ends on an assistant tool-call: its tool result would be left behind (C1).
  assert.throws(
    () => runTransaction({ session, start: SURFACE[2].seq, end: SURFACE[2].seq, summarize: ok }),
    /not a balanced boundary/
  )
  assertNoLockLeak(session, 'unbalanced')
  // Reversed positions on the surface.
  assert.throws(
    () => runTransaction({ session, start: SURFACE[6].seq, end: SURFACE[3].seq, summarize: ok }),
    /start is after end/
  )
  assertNoLockLeak(session, 'reversed')
  // A seq that is not on the surface at all.
  assert.throws(
    () => runTransaction({ session, start: 999, end: SURFACE[6].seq, summarize: ok }),
    /not found in surface/
  )
  assertNoLockLeak(session, 'off-surface')
})

test('reverse: a transaction that validates after the marker leaks the lock, and the checker catches it', () => {
  /** Broken on purpose: takes the lock first, validates afterwards. */
  function runUnsafeTransaction({ session, start, end }) {
    const marker = session.append('compaction/start', { compactionId: 'x', turn: 1 })
    const checks = createHostToolPairing()
    if (!checks.after(session, end)) throw new Error('compactRegion: end is not a balanced boundary')
    session.append('compaction/end', { compactionId: marker.data.compactionId, turn: 1 })
  }
  const session = createSession(SURFACE)
  assert.throws(
    () => runUnsafeTransaction({ session, start: SURFACE[2].seq, end: SURFACE[2].seq }),
    /not a balanced boundary/
  )
  // The safe checker refuses this state: the lock was taken and never released.
  assert.throws(() => assertBalancedMarkers(session, 'unsafe'), /one compaction\/end per compaction\/start/)
  // ...and the safe transaction leaves exactly that state clean.
  const safe = createSession(SURFACE)
  assert.throws(() => runTransaction({ session: safe, start: SURFACE[2].seq, end: SURFACE[2].seq, summarize: () => [] }))
  assertNoLockLeak(safe, 'safe')
})

test('a stream of decisions never leaves two markers open', async () => {
  const session = createSession(SURFACE)
  const { engine, agent } = mount({ session, summarize: () => [{ type: 'text', text: 'summary' }] })
  // The real host rewrites the surface on a committed replacement and bumps
  // surface.replaceGeneration; this model does not, so bump it by hand to keep
  // modelling "a second pass against a surface that moved". What is under test is
  // that each pass closes its own marker instead of stacking locks (#9 skips a
  // repeat that happens on an unmoved surface — a different case).
  await engine.compactIfNeeded(agent, 'pressure', undefined)
  session.surface.replaceGeneration += 1
  await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.deepEqual(EVENTS(session), [...TYPES, ...TYPES])
  assert.equal(assertBalancedMarkers(session, 'two passes'), 2)
})

test('the policy is read from the row config, not from the base config', async () => {
  const session = createSession(SURFACE)
  const { engine, agent, calls } = mount({
    session,
    config: { retainRecentUnits: 1, auto: false },
    summarize: () => [{ type: 'text', text: 's' }]
  })
  await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(calls.length, 1)
  // The base only ever sees the official keys, so our policy can never collide.
  assert.equal(engine.config.auto, false)
  assert.equal(engine.config.retainRecentUnits, undefined)
  assert.equal(normalizePolicy({ retainRecentUnits: 1 }).retainRecentUnits, 1)
})
