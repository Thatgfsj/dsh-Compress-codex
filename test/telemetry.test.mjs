/**
 * #13 acceptance: the report answers "why (not)", "which span" and "how many tokens"
 * for every outcome — including the untriggered half, which is where observability
 * usually degrades into silence.
 *
 * The reverse cases below are the point: a report whose reason is missing, empty or
 * invented must turn red, and a missing measurement must read as unmeasured rather
 * than as zero.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REPORT_OUTCOMES,
  buildCompactionReport,
  describeTriggerDecision,
  measureReleasedTokens,
  normalizeSelection,
  renderCompactionReport,
  reportLevel
} from '../lib/core/telemetry.js'
import { createCodexCompactionEngine } from '../lib/engine.js'
import { SUMMARY_PREFIX } from '../lib/core/prompt.js'

const NUMBERS = {
  windowTokens: 200000,
  activeTokens: 150000,
  scopeTokens: 185000,
  limitTokens: 180000,
  fullTokens: 190000,
  thresholdTokens: 180000,
  bufferTokens: 0,
  turnEndPercent: 0,
  limitReached: true,
  fullReached: false,
  turnEndReached: false
}

const PLAN = {
  status: 'shadow',
  reason: 'structural retention: keep the newest 3 of 11 units',
  trigger: 'pressure',
  start: 12,
  end: 48,
  retainFrom: 50,
  windowTokens: 200000,
  surfaceNodes: 60,
  unitCount: 11,
  shadowedUnitCount: 8,
  retainedUnitCount: 3,
  shadowedNodeCount: 37,
  retainedTokens: 4800,
  tokenBudgetApplied: true,
  systemBarrier: 'none',
  systemBarrierPreference: 'not-needed',
  systemBarrierSkippedUnits: 0,
  systemBarrierSkippedNodes: 0,
  edgeChecks: 'injected'
}

const MEASUREMENT = {
  totalTokens: 150000,
  surfaceTokens: 120000,
  nodes: [
    ...Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, tokens: 100 })),
    ...Array.from({ length: 37 }, (_, index) => ({ seq: index + 12, tokens: 200 })),
    ...Array.from({ length: 13 }, (_, index) => ({ seq: index + 49, tokens: 50 }))
  ]
}

const report = (over = {}) => buildCompactionReport({ trigger: 'pressure', ...over })

/** An error carrying an explicit code, like the adapter errors #7 surfaces. */
const coded = (code, message = code) => Object.assign(new Error(message), { code })

test('the outcome union, its levels and its input guard are closed', () => {
  assert.deepEqual(REPORT_OUTCOMES, ['delegated', 'skipped', 'blocked', 'noop', 'compacted', 'degraded', 'failed'])
  for (const outcome of ['skipped', 'delegated', 'noop']) {
    assert.equal(reportLevel(outcome), 'debug', outcome)
  }
  for (const outcome of ['blocked', 'compacted', 'degraded', 'failed']) {
    assert.equal(reportLevel(outcome), 'info', outcome)
  }
  for (const bad of [undefined, null, 'nope', 7, {}]) {
    assert.throws(() => buildCompactionReport({ outcome: bad }), TypeError)
  }
  for (const bad of [undefined, null, 'skip', 7, []]) {
    assert.throws(() => buildCompactionReport(bad), TypeError)
  }
})

// ── the untriggered half ───────────────────────────────────────────────────

test('a skipped decision names both thresholds and the numbers behind them', () => {
  const skipped = report({
    outcome: 'skipped',
    decision: { action: 'skip', reason: 'd1-below-threshold', numbers: { ...NUMBERS, scopeTokens: 90000, limitReached: false } }
  })
  assert.equal(skipped.triggered, false)
  assert.equal(skipped.level, 'debug')
  assert.match(skipped.why, /no compaction needed/)
  assert.match(skipped.why, /below both thresholds/)
  for (const value of ['200000', '150000', '90000', '180000', '190000']) {
    assert.ok(skipped.why.includes(value), 'the why must name ' + value + ': ' + skipped.why)
  }
  const text = renderCompactionReport(skipped)
  assert.match(text, /^dsh-compress-codex: compaction report: pressure \/ skipped$/m)
  assert.match(text, /^ {2}why {3}: no compaction needed/m)
})

test('a delegated decision explains why this layer did not take over', () => {
  const delegated = report({ outcome: 'delegated', decision: { action: 'delegate', reason: 'd1-no-window', numbers: { ...NUMBERS, windowTokens: null, activeTokens: null, scopeTokens: null } } })
  assert.equal(delegated.level, 'debug')
  assert.match(delegated.why, /not taken over/)
  assert.match(delegated.why, /routed context window is unknown/)
  assert.match(delegated.why, /window unknown/)

  const overflowOff = report({ trigger: 'context-overflow', outcome: 'delegated', decision: { action: 'delegate', reason: 'd1-overflow-recovery-disabled' } })
  assert.match(overflowOff.why, /overflow recovery is disabled/)
})

test('a noop decision explains why running nothing was deliberate', () => {
  const noop = report({
    outcome: 'noop',
    decision: { action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS },
    selection: { status: 'none', reason: 'r1-pure-checkpoint-region' }
  })
  assert.equal(noop.triggered, true, 'D1 did ask for a compaction')
  assert.equal(noop.level, 'debug', 'a per-step deliberate skip must not spam info')
  assert.match(noop.why, /deliberately ran nothing/)
  assert.match(noop.why, /r1-pure-checkpoint-region/)
  assert.match(noop.span, /^none — r1-pure-checkpoint-region$/)
})

test('a blocked decision carries the selector reason, never silence', () => {
  const blocked = report({
    outcome: 'blocked',
    decision: { action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS },
    selection: { status: 'none', reason: 'structural retention keeps every one of the 3 compactable unit(s); nothing to shadow', surfaceNodes: 12, unitCount: 3 }
  })
  assert.equal(blocked.triggered, true)
  assert.equal(blocked.level, 'info')
  assert.equal(blocked.selection.status, 'none')
  assert.match(blocked.why, /compaction requested but nothing safe to shadow/)
  assert.match(blocked.why, /keeps every one of the 3 compactable unit\(s\)/)
  assert.match(blocked.span, /^none — structural retention keeps every one/)
  assert.equal(blocked.accounting.releasedTokens, null)
  assert.match(blocked.tokens, /released unmeasured/)
})

// ── the triggered half ─────────────────────────────────────────────────────

test('a compacted report explains the span, its boundary grounds and the barrier cost', () => {
  const compacted = report({
    outcome: 'compacted',
    decision: { action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS },
    selection: {
      ...PLAN,
      systemBarrier: 'kept',
      systemBarrierPreference: 'declined',
      systemBarrierSkippedNodes: 2,
      systemBarrierSkippedUnits: 1
    },
    measurement: MEASUREMENT
  })
  assert.equal(compacted.triggered, true)
  assert.equal(compacted.level, 'info')
  assert.match(compacted.why, /compaction ran/)
  assert.match(compacted.why, /scoped context reached the buffered limit/)
  assert.match(compacted.why, /\[limit reached\]/)
  assert.match(compacted.span, /\[12\.\.48\]/)
  assert.match(compacted.span, /8 unit\(s\) \/ 37 node\(s\)/)
  assert.match(compacted.span, /retaining 3 unit\(s\)/)
  assert.match(compacted.span, /token budget applied/)
  assert.match(compacted.span, /system\/message kept visible/)
  assert.match(compacted.span, /barrier cost: 2 node\(s\) not released \(preference declined\)/)
  assert.match(compacted.span, /edge checks injected/)
  assert.equal(compacted.accounting.releasedTokens, 37 * 200, 'the released span is priced from the measurement')
  assert.match(compacted.tokens, /released 7400 token\(s\)/)
  assert.match(compacted.tokens, /retained tail 4800 token\(s\)/)
})

test('a crossed barrier is named as such and carries no phantom cost', () => {
  const crossed = report({
    outcome: 'compacted',
    decision: { action: 'compact', reason: 'd1-full-reached', numbers: { ...NUMBERS, fullReached: true, limitReached: false } },
    selection: { ...PLAN, systemBarrier: 'crossed', systemBarrierSkippedNodes: 0 }
  })
  assert.match(crossed.span, /in-history system\/message crossed/)
  assert.ok(!crossed.span.includes('barrier cost'), 'no detour was taken, so no cost may be invented')
  assert.match(crossed.why, /\[full reached\]/)
})

test('the frozen range shape renders too, with the node count recovered from the measurement', () => {
  const frozen = report({
    outcome: 'compacted',
    decision: { action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS },
    selection: {
      start: 12,
      end: 48,
      retainFrom: 50,
      reason: 'structural retention: keep the newest 3 of 11 units',
      shadowedUnitCount: 8,
      retainedUnitCount: 3,
      tokenBudgetApplied: true,
      systemBarrier: 'none',
      systemBarrierSkippedNodes: 0
    },
    measurement: MEASUREMENT
  })
  assert.equal(frozen.selection.status, 'shadow', 'a frozen range is still a shadow selection')
  assert.match(frozen.span, /37 node\(s\)/, 'the count comes from the priced positions')
  assert.equal(frozen.accounting.releasedTokens, 7400)

  const unmeasured = report({
    outcome: 'compacted',
    decision: { action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS },
    selection: { start: 12, end: 48, reason: 'span without a plan' }
  })
  assert.match(unmeasured.span, /node count unreported/)
  assert.match(unmeasured.tokens, /released unmeasured/)

  // The frozen range reports the barrier cost but not the preference; the report
  // must not print the string "undefined" for a field the shape does not carry.
  const frozenBarrier = report({
    outcome: 'compacted',
    decision: { action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS },
    selection: { start: 12, end: 48, reason: 'frozen range', systemBarrier: 'kept', systemBarrierSkippedNodes: 2 }
  })
  assert.match(frozenBarrier.span, /barrier cost: 2 node\(s\) not released/)
  assert.ok(!frozenBarrier.span.includes('undefined'), frozenBarrier.span)
})

// ── token ledger honesty ───────────────────────────────────────────────────

test('a missing or mismatched measurement reads as unmeasured, never as zero', () => {
  const base = { outcome: 'compacted', decision: { action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS }, selection: PLAN }
  assert.equal(report({ ...base, measurement: undefined }).accounting.releasedTokens, null)
  assert.equal(report({ ...base, measurement: { nodes: [] } }).accounting.releasedTokens, null)
  assert.equal(report({ ...base, measurement: { nodes: [{ seq: 1, tokens: 5 }] } }).accounting.releasedTokens, null)
  assert.equal(
    report({ ...base, measurement: { nodes: [{ seq: 12, tokens: 5 }, { seq: 20, heuristicTokens: 7 }, { seq: 48, tokens: 9 }] } }).accounting.releasedTokens,
    21,
    'unpriced nodes fall back to the heuristic price'
  )
  assert.equal(
    report({ ...base, measurement: { nodes: [{ seq: 12, tokens: 5 }, { seq: 20 }, { seq: 48, tokens: 9 }] } }).accounting.releasedTokens,
    null,
    'one unpriced node must fail the whole sum closed, not understate it'
  )
  assert.match(report(base).tokens, /released unmeasured/)
})

test('measureReleasedTokens answers null for anything that is not a priced shadow span', () => {
  const normalized = normalizeSelection(PLAN)
  assert.equal(measureReleasedTokens(normalized, MEASUREMENT), 7400)
  assert.equal(measureReleasedTokens(null, MEASUREMENT), null)
  assert.equal(measureReleasedTokens(normalizeSelection({ status: 'none', reason: 'x' }), MEASUREMENT), null)
  assert.equal(measureReleasedTokens(normalized, undefined), null)
  assert.equal(normalizeSelection(null), null)
})

// ── failures ───────────────────────────────────────────────────────────────

test('degraded and failed outcomes explain the failure and the attempt count', () => {
  const degraded = report({
    outcome: 'degraded',
    decision: { action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS },
    selection: PLAN,
    attempts: 2,
    error: { code: 'summary', name: 'Error', message: 'provider exploded' }
  })
  assert.equal(degraded.level, 'info')
  assert.match(degraded.why, /degraded, the session continues after 2 attempt\(s\): summary: provider exploded/)
  assert.equal(degraded.error.code, 'summary')
  assert.match(degraded.tokens, /2 attempt\(s\)/)

  const failed = report({ outcome: 'failed', error: { name: 'TypeError', message: 'no route' } })
  assert.match(failed.why, /failed: TypeError: no route/)
  assert.equal(failed.error.code, null)

  const silent = report({ outcome: 'failed' })
  assert.match(silent.why, /no failure detail was reported/)
})

// ── the reverse case: reasons must never be silently dropped ────────────────

test('a report can never render an empty reason, whatever it is fed', () => {
  const matrix = [
    { outcome: 'skipped', decision: { action: 'skip' } },
    { outcome: 'skipped', decision: undefined },
    { outcome: 'delegated', decision: { action: 'delegate', reason: 'd1-future-reason' } },
    { outcome: 'blocked', decision: { action: 'compact', reason: 'd1-limit-reached' }, selection: null },
    { outcome: 'blocked', selection: { status: 'none' } },
    { outcome: 'compacted', decision: { action: 'compact', reason: 'd1-limit-reached' }, selection: PLAN },
    { outcome: 'degraded', error: {} },
    { outcome: 'failed', error: undefined }
  ]
  for (const input of matrix) {
    const built = report(input)
    assert.ok(built.why.trim().length > 0, 'empty why for ' + JSON.stringify(input))
    const text = renderCompactionReport(built)
    const whyLine = text.split('\n').find((line) => line.includes('why'))
    assert.ok(whyLine !== undefined && whyLine.split(':').slice(1).join(':').trim().length > 0, text)
  }
  assert.match(report({ outcome: 'skipped', decision: { action: 'skip' } }).why, /unreported reason/)
  assert.match(report({ outcome: 'skipped', decision: { action: 'skip' } }).why, /no numeric detail reported/)
  assert.match(report({ outcome: 'delegated', decision: { action: 'delegate', reason: 'd1-future-reason' } }).why, /d1-future-reason/)
  assert.match(report({ outcome: 'blocked', selection: { status: 'none' } }).why, /no reason reported/)
})

test('describeTriggerDecision echoes unknown reasons verbatim instead of swallowing them', () => {
  assert.match(describeTriggerDecision({ reason: 'd1-future-reason' }), /d1-future-reason/)
  assert.match(describeTriggerDecision({}), /unreported reason/)
  assert.equal(describeTriggerDecision(undefined).trim().length > 0, true)
})

// ── purity and shape ───────────────────────────────────────────────────────

test('building a report mutates neither its inputs nor its output shape', () => {
  const decision = Object.freeze({ action: 'compact', reason: 'd1-limit-reached', numbers: Object.freeze({ ...NUMBERS }) })
  const selection = Object.freeze({ ...PLAN })
  const measurement = Object.freeze({ nodes: Object.freeze(MEASUREMENT.nodes.map((node) => Object.freeze({ ...node }))) })

  const first = report({ outcome: 'compacted', decision, selection, measurement })
  const second = report({ outcome: 'compacted', decision, selection, measurement })
  assert.deepEqual(first, second, 'the report is deterministic')
  assert.equal(selection.shadowedNodeCount, 37, 'the input plan is not rewritten')
  assert.equal(decision.numbers.scopeTokens, 185000)
  assert.notEqual(first.selection, selection, 'the report carries its own normalized selection')

  const lines = renderCompactionReport(first).split('\n')
  assert.equal(lines.length, 4)
  assert.equal(lines[0], 'dsh-compress-codex: compaction report: pressure / compacted')
  for (const line of lines) assert.equal(line, line.trimEnd(), 'no trailing whitespace: ' + JSON.stringify(line))
  assert.deepEqual(Object.keys(first).sort(), [
    'accounting', 'action', 'attempts', 'decision', 'error', 'level', 'outcome',
    'selection', 'span', 'tokens', 'trigger', 'triggered', 'why'
  ])
})

// ── engine wiring: the report reaches the log on the live path ──────────────

/** Fake base exposing the one transaction hook the engine calls. */
function createWiringBase() {
  const calls = { compactRegion: [] }
  class WiringBase {
    constructor(ctx, config = {}) {
      this.ctx = ctx
      this.config = config
    }

    async compactIfNeeded() {
      return { base: true }
    }

    compactNow() {
      return { base: true }
    }

    async compactRegion(start, end, agent, signal) {
      calls.compactRegion.push([start, end])
      const result = await this.summarize({ tools: [], messages: [] }, agent, signal)
      return { ...result, region: [start, end] }
    }
  }
  return { WiringBase, calls }
}

/** Recording logger with all four levels; `debug: false` models a logger below debug. */
function createWiringLogger({ debug = true } = {}) {
  const journal = []
  const logger = {
    journal,
    info: (...args) => journal.push({ level: 'info', args }),
    warn: (...args) => journal.push({ level: 'warn', args }),
    error: (...args) => journal.push({ level: 'error', args })
  }
  if (debug) logger.debug = (...args) => journal.push({ level: 'debug', args })
  return logger
}

const WIRING_AGENT = () => ({
  options: { provider: 'acme', model: 'chat' },
  session: { id: 's1', requestHeader: () => undefined, toolHistory: () => ({ tools: [], updates: [] }) }
})

/** Fake stream that throws the scripted errors in order, then succeeds. */
function createWiringLlm(errors = []) {
  let call = 0
  return {
    stream() {
      const failure = errors[call]
      call += 1
      if (failure !== undefined) throw failure
      return [
        { type: 'text-delta', index: 0, text: 'summary' },
        { type: 'finish', reason: { kind: 'stop' } }
      ]
    }
  }
}

function mountWiring({ errors = [], logger = createWiringLogger(), hooks = {}, measurement } = {}) {
  const { WiringBase, calls } = createWiringBase()
  const Engine = createCodexCompactionEngine(WiringBase, {
    decideCompaction: () => ({ action: 'skip', reason: 'd1-below-threshold', numbers: NUMBERS }),
    selectCompactionRange: () => null,
    planCompactionRange: () => ({ status: 'none', reason: 'no surface to shadow' }),
    ...hooks
  })
  const ctx = {
    llm: createWiringLlm(errors),
    tokenMeter: { measure: () => measurement ?? { totalTokens: 0 } },
    logger
  }
  const engine = new Engine(ctx, { summarizationProvider: 'sum', summarizationModel: 'small' })
  return { engine, logger, calls }
}

test('an untriggered decision reaches the log with its reason (skipped / delegated)', async () => {
  const skipped = mountWiring()
  assert.equal(await skipped.engine.compactIfNeeded(WIRING_AGENT(), 'pressure', undefined), null)
  assert.deepEqual(skipped.calls.compactRegion, [], 'a skip is a zero-write decision')
  assert.equal(skipped.logger.journal.length, 1)
  const [entry] = skipped.logger.journal
  assert.equal(entry.level, 'debug')
  assert.match(entry.args[0], /^dsh-compress-codex: compaction report: pressure \/ skipped$/m)
  assert.match(entry.args[0], /below both thresholds/)
  assert.match(entry.args[0], /active 150000/)
  assert.equal(entry.args[1].outcome, 'skipped')

  const delegated = mountWiring({
    hooks: { decideCompaction: () => ({ action: 'delegate', reason: 'd1-no-window', numbers: { ...NUMBERS, windowTokens: null } }) }
  })
  assert.deepEqual(await delegated.engine.compactIfNeeded(WIRING_AGENT(), 'pressure', undefined), { base: true })
  assert.match(delegated.logger.journal[0].args[0], /not taken over: the routed context window is unknown/)
})

test('a blocked decision pays for one read-only plan and logs the reason at info', async () => {
  let planCalls = 0
  const blocked = mountWiring({
    hooks: {
      decideCompaction: () => ({ action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS }),
      planCompactionRange: () => {
        planCalls += 1
        return { status: 'none', reason: 'structural retention keeps every one of the 2 compactable unit(s); nothing to shadow' }
      }
    }
  })
  assert.equal(await blocked.engine.compactIfNeeded(WIRING_AGENT(), 'pressure', undefined), null)
  assert.equal(planCalls, 1, 'the plan runs only on the blocked path')
  const [entry] = blocked.logger.journal
  assert.equal(entry.level, 'info')
  assert.match(entry.args[0], /pressure \/ blocked/)
  assert.match(entry.args[0], /nothing safe to shadow/)
  assert.match(entry.args[0], /keeps every one of the 2 compactable unit\(s\)/)
})

test('a compacted decision logs the span and the measured token ledger at info', async () => {
  const measurement = { totalTokens: 300, surfaceTokens: 300, nodes: [{ seq: 12, tokens: 100 }, { seq: 48, tokens: 200 }] }
  const compacted = mountWiring({
    measurement,
    hooks: {
      decideCompaction: () => ({ action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS }),
      selectCompactionRange: () => ({
        start: 12,
        end: 48,
        retainFrom: 50,
        reason: 'structural retention: keep the newest 3 of 11 units',
        shadowedUnitCount: 8,
        retainedUnitCount: 3,
        tokenBudgetApplied: true,
        systemBarrier: 'kept',
        systemBarrierSkippedNodes: 2
      })
    }
  })
  const result = await compacted.engine.compactIfNeeded(WIRING_AGENT(), 'pressure', undefined)
  assert.ok(result.summary, 'the transaction committed')
  const [entry] = compacted.logger.journal
  assert.equal(entry.level, 'info')
  assert.match(entry.args[0], /pressure \/ compacted/)
  assert.match(entry.args[0], /\[12\.\.48\] shadowing 8 unit\(s\)/)
  assert.match(entry.args[0], /barrier cost: 2 node\(s\) not released/)
  assert.match(entry.args[0], /tokens: released 300 token\(s\)/)
  assert.equal(entry.args[1].accounting.releasedTokens, 300)
})

test('an idempotence noop is reported with its plan reason, at debug', async () => {
  // #9 R1: a region holding only an existing checkpoint gains nothing from another
  // projection, so the engine runs nothing — but it must still explain itself.
  const session = {
    id: 's1',
    requestHeader: () => undefined,
    toolHistory: () => ({ tools: [], updates: [] }),
    surface: { nodes: [1, 2] },
    // Both nodes read as checkpoints: #9's default predicate recognises our own
    // projection prefix (SUMMARY_PREFIX), which every replacement message carries.
    eventAt: (seq) => ({
      type: 'user/message',
      data: {
        message: {
          role: 'user',
          content: [{ type: 'text', text: SUMMARY_PREFIX + '\ncheckpoint ' + seq }]
        }
      }
    })
  }
  const noop = mountWiring({
    // Both nodes read as checkpoints when the injected predicate says so.
    hooks: {
      decideCompaction: () => ({ action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS }),
      selectCompactionRange: () => ({ start: 1, end: 2 })
    }
  })
  const agent = { ...WIRING_AGENT(), session }
  assert.equal(await noop.engine.compactIfNeeded(agent, 'pressure', undefined), null)
  const [entry] = noop.logger.journal
  assert.equal(entry.level, 'debug')
  assert.match(entry.args[0], /pressure \/ noop/)
  assert.match(entry.args[0], /deliberately ran nothing|no compaction needed|could not/i)
})

test('degraded and failed outcomes are reported beside the #10 alerts', async () => {
  const degraded = mountWiring({
    errors: [coded('E_PROVIDER'), coded('E_PROVIDER')],
    hooks: {
      decideCompaction: () => ({ action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS }),
      selectCompactionRange: () => ({ start: 12, end: 48 })
    }
  })
  assert.equal(await degraded.engine.compactIfNeeded(WIRING_AGENT(), 'pressure', undefined), null)
  const degradedReport = degraded.logger.journal.find((entry) => entry.args[1]?.outcome === 'degraded')
  assert.ok(degradedReport, 'the degraded outcome is reported')
  assert.equal(degradedReport.level, 'info')
  assert.match(degradedReport.args[0], /degraded, the session continues after 2 attempt\(s\)/)
  assert.ok(degraded.logger.journal.some((entry) => entry.level === 'error'), '#10 still raises its degrade alert')

  const busy = coded('busy', 'compaction already in progress')
  const failed = mountWiring({
    errors: [busy],
    hooks: {
      decideCompaction: () => ({ action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS }),
      selectCompactionRange: () => ({ start: 12, end: 48 })
    }
  })
  let caught
  try {
    await failed.engine.compactIfNeeded(WIRING_AGENT(), 'pressure', undefined)
  } catch (error) {
    caught = error
  }
  assert.equal(caught, busy, 'the failure still propagates by identity')
  const failedReport = failed.logger.journal.find((entry) => entry.args[1]?.outcome === 'failed')
  assert.ok(failedReport, 'the failed outcome is reported')
  assert.match(failedReport.args[0], /failed after 1 attempt\(s\): busy: compaction already in progress/)
})

test('a logger below debug stays quiet for per-step outcomes but still gets blocked/compacted', async () => {
  const quiet = mountWiring({ logger: createWiringLogger({ debug: false }) })
  await quiet.engine.compactIfNeeded(WIRING_AGENT(), 'pressure', undefined)
  assert.deepEqual(quiet.logger.journal, [], 'no debug channel means no per-step spam')

  const loud = mountWiring({
    hooks: {
      decideCompaction: () => ({ action: 'compact', reason: 'd1-limit-reached', numbers: NUMBERS })
    }
  })
  await loud.engine.compactIfNeeded(WIRING_AGENT(), 'pressure', undefined)
  assert.deepEqual(loud.logger.journal.map((entry) => entry.level), ['info'], 'the blocked report is still delivered')
})

