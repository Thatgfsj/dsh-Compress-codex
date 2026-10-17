/**
 * #10 acceptance: every failure class is named, the engine's reaction to each is
 * bounded, and no failure path can ever leak the session compaction lock.
 *
 * The transaction that owns the lock lives in the official base class, so the fake
 * base below mirrors its discipline exactly (basic/lib/index.js compactSurfaceRegion
 * L450-L522): one `compaction/start` per attempt, one `compaction/end` on both the
 * success and the failure path, and the `compaction/summary-error` recover loop
 * inside the same attempt. Every engine test then asserts start === end.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMPACTION_ERROR_CODES,
  FAILURE_ACTIONS,
  SUMMARY_FAILURE_CODES,
  SUMMARY_RETRY_LIMIT,
  classifyCompactionError,
  decideCompactionFailure,
  describeCompactionError,
  errorChain,
  isAbortError,
  isBusyError,
  isCancelledError,
  isChangedError,
  isCommitError,
  isPersistenceError,
  isSummaryError
} from '../lib/core/errors.js'
import { NO_CONTENT_CODE, NO_ROUTE_CODE, TRUNCATED_CODE, UNPROJECTED_CODE } from '../lib/core/summarize.js'
import { createCodexCompactionEngine } from '../lib/engine.js'

const ROUTE = { summarizationProvider: 'sum', summarizationModel: 'small' }

/** An error carrying an explicit code, like ManualCompactionError does. */
const coded = (code, message = code) => Object.assign(new Error(message), { code })

/** Minimal agent: no routed request header, so the configured route is used. */
const agent = () => ({
  options: { provider: 'acme', model: 'chat' },
  session: { id: 's1', requestHeader: () => undefined, toolHistory: () => ({ tools: [], updates: [] }) }
})

/** Fake \`ctx.llm\`: throws the scripted error, or streams a short text summary. */
function createLlm(script) {
  let call = 0
  return {
    calls: [],
    stream() {
      call += 1
      const step = typeof script === 'function' ? script(call) : script
      if (step instanceof Error) throw step
      return [
        { type: 'text-delta', index: 0, text: 'summary' },
        { type: 'finish', reason: { kind: 'stop' } }
      ]
    }
  }
}

/** Recording logger: the engine's only permitted diagnostic channel (PLAN §4.7). */
function createLogger() {
  const journal = []
  return {
    journal,
    warn(...args) {
      journal.push({ level: 'warn', args })
    },
    error(...args) {
      journal.push({ level: 'error', args })
    },
    info() {}
  }
}

/** Transactional fake base mirroring the official lock and recover discipline. */
function createTxBase({ recover = () => false, manualError } = {}) {
  const events = []
  const seen = { recover: [], summarize: 0 }
  class TxBase {
    constructor(ctx, config = {}) {
      this.ctx = ctx
      this.config = config
    }

    regionDependencies() {
      return {
        summarize: (input, agent_, signal) => this.summarize(input, agent_, signal),
        recover: (error, agent_, seqs, signal) => {
          seen.recover.push(error)
          return recover(error, agent_, seqs, signal)
        }
      }
    }

    async compactRegion(start, end, agent_, signal) {
      events.push({ type: 'start', start, end })
      try {
        let result
        for (;;) {
          seen.summarize += 1
          try {
            result = await this.regionDependencies().summarize({ tools: [], messages: [] }, agent_, signal)
            break
          } catch (error) {
            if (signal !== null && signal !== undefined && signal.aborted === true) throw error
            if (!this.regionDependencies().recover(error, agent_, [start, end], signal)) throw error
          }
        }
        events.push({ type: 'end', start, end })
        return { ...result, region: [start, end] }
      } catch (error) {
        events.push({ type: 'end', start, end, error })
        throw error
      }
    }

    compactNow() {
      if (manualError !== undefined) throw manualError
      return { base: true, manual: true }
    }
  }
  return { TxBase, events, seen }
}

/** The lock invariant every engine test asserts. */
function assertExactlyOneEndPerStart(events) {
  const open = []
  for (const event of events) {
    if (event.type === 'start') open.push(event)
    else if (event.type === 'end') {
      assert.ok(open.length > 0, 'compaction/end without a matching start')
      open.pop()
    } else {
      assert.fail('unexpected lifecycle event ' + String(event.type))
    }
  }
  assert.equal(open.length, 0, 'session compaction lock leaked: start without end')
  assert.equal(
    events.filter((event) => event.type === 'end').length,
    events.filter((event) => event.type === 'start').length
  )
}

function mount({ llm, logger = createLogger(), base = createTxBase(), config = ROUTE, hooks } = {}) {
  const Engine = createCodexCompactionEngine(
    base.TxBase,
    hooks ?? { decideCompaction: () => ({ action: 'compact', reason: 'test' }), selectCompactionRange: () => ({ start: 1, end: 2 }) }
  )
  const ctx = { llm, logger, tokenMeter: { measure: () => ({ totalTokens: 0 }) } }
  return { engine: new Engine(ctx, config), ctx, logger, ...base }
}

async function capture(promise) {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

// ── classification ─────────────────────────────────────────────────────────

test('the vocabulary mirrors the official ManualCompactionErrorCode union', () => {
  assert.deepEqual(COMPACTION_ERROR_CODES, ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence'])
  assert.deepEqual(FAILURE_ACTIONS, ['retry', 'degrade', 'propagate'])
  assert.equal(SUMMARY_RETRY_LIMIT, 1, 'issue #10 allows exactly one retry')
  assert.deepEqual(SUMMARY_FAILURE_CODES, [NO_ROUTE_CODE, NO_CONTENT_CODE, TRUNCATED_CODE, UNPROJECTED_CODE])
})

const CLASSIFICATION = [
  ['busy code', coded('busy'), 'busy', 'propagate'],
  ['cancelled code', coded('cancelled'), 'cancelled', 'propagate'],
  ['abort error', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'cancelled', 'propagate'],
  ['changed code', coded('changed'), 'changed', 'propagate'],
  ['SurfaceChangedError', Object.assign(new Error('moved'), { name: 'SurfaceChangedError' }), 'changed', 'propagate'],
  ['commit code', coded('commit'), 'commit', 'propagate'],
  ['persistence code', coded('persistence'), 'persistence', 'propagate'],
  ['summary code', coded('summary'), 'summary', 'retry'],
  ['#7 NO_SUMMARIZATION_ROUTE', coded(NO_ROUTE_CODE), 'summary', 'retry'],
  ['#7 NO_SUMMARY_CONTENT', coded(NO_CONTENT_CODE), 'summary', 'retry'],
  ['#7 MAX_TOKENS', coded(TRUNCATED_CODE), 'summary', 'retry'],
  ['#7 UNPROJECTED_SUMMARY', coded(UNPROJECTED_CODE), 'summary', 'retry'],
  ['adapter provider failure', coded('E_PROVIDER', 'provider exploded'), 'summary', 'retry'],
  ['plain Error', new Error('boom'), 'summary', 'retry'],
  ['thrown string', 'boom', 'summary', 'retry'],
  ['wrapped busy', new Error('outer', { cause: coded('busy') }), 'busy', 'propagate']
]

test('every failure class maps to one code and one bounded action', () => {
  for (const [label, error, code, action] of CLASSIFICATION) {
    assert.equal(classifyCompactionError(error), code, label)
    assert.equal(decideCompactionFailure(error, 0), action, label)
    if (action === 'retry') {
      assert.equal(decideCompactionFailure(error, 1), 'degrade', label + ' spends its retry budget')
      assert.equal(decideCompactionFailure(error, 2), 'degrade', label)
    }
  }
})

test('each predicate answers only for its own class', () => {
  const errors = {
    busy: coded('busy'),
    cancelled: coded('cancelled'),
    changed: coded('changed'),
    commit: coded('commit'),
    persistence: coded('persistence'),
    summary: coded('summary')
  }
  const predicates = {
    busy: isBusyError,
    cancelled: isCancelledError,
    changed: isChangedError,
    commit: isCommitError,
    persistence: isPersistenceError,
    summary: isSummaryError
  }
  for (const [code, error] of Object.entries(errors)) {
    for (const [name, predicate] of Object.entries(predicates)) {
      assert.equal(predicate(error), name === code, name + ' on a ' + code + ' error')
    }
  }
  assert.equal(isAbortError(coded('ABORT_ERR')), true)
  assert.equal(isAbortError(coded('busy')), false)
})

test('cancellation identity, cause chains and cyclic causes are handled', () => {
  const controller = new AbortController()
  const reason = new Error('turn cancelled')
  controller.abort(reason)
  assert.equal(isCancelledError(reason, controller.signal), true, 'identity is cancellation')
  assert.equal(isCancelledError(new Error('other'), controller.signal), true, 'an aborted signal outranks the surfaced error')
  assert.equal(isCancelledError(new Error('other'), new AbortController().signal), false, 'a live signal is not cancellation')
  assert.equal(decideCompactionFailure(new Error('other'), 0, controller.signal), 'propagate', 'no retry after an abort')
  assert.equal(classifyCompactionError(new Error('other'), controller.signal), 'cancelled')

  const cyclic = new Error('loop')
  cyclic.cause = cyclic
  assert.equal(errorChain(cyclic).length, 1, 'a self-referential cause must terminate')
  assert.equal(errorChain(undefined).length, 0)
})

test('describeCompactionError is loggable and leaks no live objects', () => {
  assert.deepEqual(describeCompactionError(new Error('outer', { cause: coded('summary', 'inner') })), {
    code: 'summary',
    name: 'Error',
    message: 'outer',
    causes: [{ name: 'Error', code: 'summary', message: 'inner' }]
  })
  assert.deepEqual(describeCompactionError('plain'), { code: 'summary', name: 'ThrownString', message: 'plain', causes: [] })
  assert.deepEqual(describeCompactionError(undefined), { code: 'summary', name: 'Error', message: 'undefined', causes: [] })
})

// ── engine reaction ────────────────────────────────────────────────────────

test('a summary failure is retried once, then degrades with a visible diagnostic', async () => {
  const failure = coded('E_PROVIDER', 'provider exploded')
  const { engine, events, seen, logger } = mount({ llm: createLlm(() => failure) })

  assert.equal(await engine.compactIfNeeded(agent(), 'pressure', undefined), null, 'a degraded compaction reports nothing compacted')
  assert.equal(seen.summarize, 2, 'exactly one retry')
  assert.equal(seen.recover.length, 2, 'the transaction waterfall saw each attempt')
  assertExactlyOneEndPerStart(events)
  assert.equal(events.filter((event) => event.type === 'start').length, 2, 'the retry is a fresh transaction')

  assert.deepEqual(logger.journal.map((entry) => entry.level), ['warn', 'error'])
  assert.match(logger.journal[0].args[0], /retry after a summary compaction failure on the pressure trigger \(attempt 1\)/)
  assert.equal(logger.journal[1].args[1].action, 'degrade')
  assert.equal(logger.journal[1].args[1].attempt, 2)
  assert.deepEqual(logger.journal[1].args[1].range, { start: 1, end: 2 })
  assert.equal(logger.journal[1].args[1].error.code, 'summary')
  assert.equal(logger.journal[1].args[1].error.message, 'provider exploded')
})

test('a retry that succeeds returns the summary and logs only the retry', async () => {
  const { engine, events, seen, logger } = mount({ llm: createLlm((call) => (call === 1 ? coded('E_PROVIDER') : undefined)) })

  const result = await engine.compactIfNeeded(agent(), 'pressure', undefined)
  assert.ok(result.summary, 'the retried attempt produced the checkpoint')
  assert.equal(seen.summarize, 2)
  assertExactlyOneEndPerStart(events)
  assert.deepEqual(logger.journal.map((entry) => entry.level), ['warn'])
})

test('busy, changed, commit and persistence propagate untouched, unretried and unlogged', async () => {
  const cases = [
    ['busy', coded('busy', 'compaction already in progress')],
    ['changed', Object.assign(new Error('surface moved'), { name: 'SurfaceChangedError' })],
    ['commit', coded('commit', 'commit failed')],
    ['persistence', coded('persistence', 'flush failed')]
  ]
  for (const [label, failure] of cases) {
    const { engine, events, seen, logger } = mount({ llm: createLlm(() => failure) })
    const caught = await capture(engine.compactIfNeeded(agent(), 'pressure', undefined))
    assert.equal(caught, failure, label + ' must propagate by identity')
    assert.equal(seen.summarize, 1, label + ' must not be retried')
    assertExactlyOneEndPerStart(events)
    assert.deepEqual(logger.journal, [], label + ' must not be reported as a degradation')
  }
})

test('cancellation keeps the exact abort reason and is never degraded', async () => {
  const controller = new AbortController()
  const reason = new Error('turn cancelled')
  const logger = createLogger()
  const llm = {
    stream() {
      controller.abort(reason)
      throw reason
    }
  }
  const { engine, events, seen } = mount({ llm, logger })

  const caught = await capture(engine.compactIfNeeded(agent(), 'pressure', controller.signal))
  assert.equal(caught, reason, 'the caller catches its own reason object')
  assert.equal(seen.summarize, 1, 'a cancelled attempt is never retried')
  assertExactlyOneEndPerStart(events)
  assert.deepEqual(logger.journal, [], 'cancellation is not a degradation')
})

test('the session keeps compacting after a degraded failure', async () => {
  let failing = true
  const { engine, events } = mount({ llm: createLlm(() => (failing ? coded('E_PROVIDER') : undefined)) })

  assert.equal(await engine.compactIfNeeded(agent(), 'pressure', undefined), null)
  failing = false
  const result = await engine.compactIfNeeded(agent(), 'pressure', undefined)
  assert.ok(result.summary, 'the next turn still compacts')
  assert.equal(events.filter((event) => event.type === 'start').length, 3)
  assertExactlyOneEndPerStart(events)
})

test('the inherited recover loop retries inside one transaction, so the lock closes once', async () => {
  let attempt = 0
  const base = createTxBase({ recover: () => true })
  const { engine, events } = mount({
    base,
    llm: createLlm(() => {
      attempt += 1
      return attempt === 1 ? coded('E_PROVIDER') : undefined
    })
  })

  const result = await engine.compactIfNeeded(agent(), 'pressure', undefined)
  assert.ok(result.summary)
  assert.equal(events.filter((event) => event.type === 'start').length, 1, 'the waterfall retry reuses the transaction')
  assertExactlyOneEndPerStart(events)
})

test('the manual path keeps its ManualCompactionError code and is never degraded', () => {
  const busy = Object.assign(new Error('manual compaction: lock already active'), {
    name: 'ManualCompactionError',
    code: 'busy'
  })
  const base = createTxBase({ manualError: busy })
  const Engine = createCodexCompactionEngine(base.TxBase, { selectCompactionRange: () => null })
  const engine = new Engine({ logger: createLogger(), tokenMeter: { measure: () => ({ totalTokens: 0 }) } }, ROUTE)

  assert.throws(() => engine.compactNow(agent(), undefined, undefined), (error) => error === busy)
})

// ── the lock invariant has teeth ───────────────────────────────────────────

test('the lock assertion rejects a leaked and an orphaned marker', () => {
  assert.throws(() => assertExactlyOneEndPerStart([{ type: 'start' }]), /lock leaked/)
  assert.throws(() => assertExactlyOneEndPerStart([{ type: 'end' }]), /without a matching start/)
  assert.throws(() => assertExactlyOneEndPerStart([{ type: 'start' }, { type: 'start' }, { type: 'end' }]), /lock leaked/)
  assertExactlyOneEndPerStart([{ type: 'start' }, { type: 'end' }, { type: 'start' }, { type: 'end' }])
})

test('a fake base that leaks the lock is caught by the same assertion', async () => {
  const leaky = createTxBase()
  // Simulate an incompatible base: the failure path forgets to close the attempt.
  const original = leaky.TxBase.prototype.compactRegion
  leaky.TxBase.prototype.compactRegion = async function leakingRegion() {
    leaky.events.push({ type: 'start' })
    throw coded('summary')
  }
  try {
    const { engine, events } = mount({ base: leaky, llm: createLlm(() => coded('summary')) })
    assert.equal(await engine.compactIfNeeded(agent(), 'pressure', undefined), null)
    assert.throws(() => assertExactlyOneEndPerStart(events), /lock leaked/)
  } finally {
    leaky.TxBase.prototype.compactRegion = original
  }
})
