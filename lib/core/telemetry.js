/**
 * M4-13 — compaction telemetry (issue #13).
 *
 * The decision layer already explains itself: D1 returns `{ action, reason, numbers }`
 * (lib/core/trigger.js), the structural selector returns a plan with unit accounting
 * and the system-barrier cost (lib/core/select.js, #31), and #10 logs classified
 * failures. What was missing is one report that answers the three questions an
 * operator actually asks:
 *
 *   1. why did compaction fire — or why did it NOT fire? (the half that is usually
 *      left silent, and the one that matters most at 3am)
 *   2. which span was chosen, and on what boundary grounds (including whether an
 *      in-history system/message barrier was crossed or held back)
 *   3. how many tokens that releases
 *
 * This module is pure: it consumes those fields and renders text. It never writes
 * IO, never mutates a decision, and never invents numbers it was not given — a
 * missing measurement is reported as unmeasured, not as zero.
 *
 * The engine owns the channel (#10 established `ctx.logger`; PLAN §4.7 forbids new
 * session event types). `reportLevel()` keeps routine per-step outcomes at debug so
 * observability does not turn into log spam.
 *
 * Zero dependencies on purpose (see config.js).
 */

/**
 * Every outcome the engine can report. A closed union keeps logs greppable.
 *
 * `noop` is #9's deliberate "we own the decision and ran nothing": the region holds
 * only an existing checkpoint (R1) or that exact region already compacted. It is
 * distinct from `skipped` (D1 never asked for a compaction) and from `blocked`
 * (compaction was wanted but no C1/C2-safe range existed).
 */
export const REPORT_OUTCOMES = Object.freeze([
  'delegated',
  'skipped',
  'blocked',
  'noop',
  'compacted',
  'degraded',
  'failed'
])

/** Why D1 answered what it answered, in operator language. */
const D1_REASON_TEXT = Object.freeze({
  'd1-no-window': 'the routed context window is unknown, so this layer does not take over',
  'd1-below-threshold': 'below both thresholds',
  'd1-full-reached': 'the active context reached the hard-full ceiling',
  'd1-limit-reached': 'the scoped context reached the buffered limit',
  'd1-context-overflow-bypass': 'provider-confirmed context overflow bypasses every threshold',
  'd1-overflow-recovery-disabled': 'overflow recovery is disabled by policy, so the official backend takes over'
})

/** Render numbers that may legitimately be absent. */
function number(value) {
  return Number.isFinite(value) ? String(value) : 'unknown'
}

/** Read one field of a possibly-absent object. */
function field(source, key) {
  return source === null || source === undefined || typeof source !== 'object' ? undefined : source[key]
}

/**
 * Human sentence for one D1 decision, always naming the numbers that produced it.
 *
 * @param decision - D1's `{ action, reason, numbers }`, or anything else.
 * @returns a non-empty sentence; an unrecognized reason is reported verbatim rather
 *   than swallowed.
 */
export function describeTriggerDecision(decision) {
  const reason = field(decision, 'reason')
  const numbers = field(decision, 'numbers')
  // Own-property lookup: a reason of '__proto__' or 'constructor' must echo itself,
  // not reach into Object.prototype for a "known" label.
  const known = typeof reason === 'string' && Object.hasOwn(D1_REASON_TEXT, reason) ? D1_REASON_TEXT[reason] : undefined
  const label = known === undefined
    ? (reason === undefined || reason === null || reason === '' ? 'unreported reason' : String(reason))
    : known
  if (numbers === undefined || numbers === null) return label + ' (no numeric detail reported)'
  const common =
    'window ' + number(numbers.windowTokens) +
    ', active ' + number(numbers.activeTokens) +
    ', scope ' + number(numbers.scopeTokens) +
    ', limit ' + number(numbers.limitTokens) +
    ', full ' + number(numbers.fullTokens) +
    ', threshold ' + number(numbers.thresholdTokens) +
    ', buffer ' + number(numbers.bufferTokens)
  if (numbers.windowTokens === null || numbers.windowTokens === undefined) {
    return label + ' (' + common + ')' + (numbers.turnEndPercent > 0 ? ', turn-end ' + number(numbers.turnEndPercent) + '%' : '')
  }
  const reached = []
  if (numbers.fullReached === true) reached.push('full reached')
  if (numbers.limitReached === true) reached.push('limit reached')
  if (numbers.turnEndReached === true) reached.push('turn-end reached')
  return label + ' (' + common + ')' + (reached.length === 0 ? '' : ' [' + reached.join(', ') + ']')
}

/** Normalize a rich selector plan or the frozen range object into one shape. */
export function normalizeSelection(selection) {
  if (selection === null || selection === undefined) return null
  const status = field(selection, 'status')
  const start = field(selection, 'start')
  const end = field(selection, 'end')
  const shadowed = status === 'shadow' || (Number.isInteger(start) && Number.isInteger(end))
  return {
    status: shadowed ? 'shadow' : 'none',
    reason: field(selection, 'reason') ?? 'no reason reported',
    start: shadowed ? start : null,
    end: shadowed ? end : null,
    shadowedUnitCount: field(selection, 'shadowedUnitCount') ?? null,
    retainedUnitCount: field(selection, 'retainedUnitCount') ?? null,
    // Only the rich plan reports this; the frozen range object does not, and a seq
    // difference would be wrong (surface seqs are sparse). buildCompactionReport
    // recovers it from the measurement when one is supplied.
    shadowedNodeCount: field(selection, 'shadowedNodeCount') ?? null,
    retainFrom: field(selection, 'retainFrom') ?? null,
    surfaceNodes: field(selection, 'surfaceNodes') ?? null,
    unitCount: field(selection, 'unitCount') ?? null,
    retainedTokens: field(selection, 'retainedTokens') ?? null,
    tokenBudgetApplied: field(selection, 'tokenBudgetApplied') ?? null,
    systemBarrier: field(selection, 'systemBarrier') ?? null,
    systemBarrierPreference: field(selection, 'systemBarrierPreference') ?? null,
    systemBarrierSkippedUnits: field(selection, 'systemBarrierSkippedUnits') ?? 0,
    systemBarrierSkippedNodes: field(selection, 'systemBarrierSkippedNodes') ?? 0,
    edgeChecks: field(selection, 'edgeChecks') ?? null
  }
}

/**
 * Measure the tokens one shadowed span releases.
 *
 * Reads the surface-ordered priced nodes the same way the selector does, so the
 * report's number is the selector's own currency. A missing, mismatched or
 * unpriced measurement answers null — the report then says unmeasured instead of
 * inventing a zero.
 *
 * @param selection - normalized selection.
 * @param measurement - `{ nodes: [{ seq, tokens|heuristicTokens }] }`, or anything.
 * @returns released tokens, or null when they cannot be measured.
 */
export function measureReleasedTokens(selection, measurement) {
  const span = spanIndices(selection, measurement)
  if (span === null) return null
  const nodes = field(measurement, 'nodes')
  let total = 0
  for (let index = span.startIdx; index <= span.endIdx; index += 1) {
    const value = field(nodes[index], 'tokens') ?? field(nodes[index], 'heuristicTokens')
    if (!Number.isFinite(value)) return null
    total += value
  }
  return total
}

/** Surface positions of a shadow span in a priced node list, or null. */
function spanIndices(selection, measurement) {
  if (selection === null || selection.status !== 'shadow') return null
  const nodes = field(measurement, 'nodes')
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  let startIdx = -1
  let endIdx = -1
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = field(nodes[index], 'seq')
    if (seq === selection.start) startIdx = index
    if (seq === selection.end) endIdx = index
  }
  return startIdx === -1 || endIdx === -1 || endIdx < startIdx ? null : { startIdx, endIdx }
}

/** Sentence explaining the chosen span, its boundary grounds and the barrier cost. */
export function describeSelection(selection) {
  if (selection === null) return 'none — no range was selected for this decision'
  if (selection.status !== 'shadow') return 'none — ' + selection.reason
  const nodes = selection.shadowedNodeCount === null
    ? 'node count unreported'
    : number(selection.shadowedNodeCount) + ' node(s)'
  const parts = [
    '[' + selection.start + '..' + selection.end + '] shadowing ' +
      number(selection.shadowedUnitCount) + ' unit(s) / ' + nodes +
      ', retaining ' + number(selection.retainedUnitCount) + ' unit(s)'
  ]
  parts.push(selection.tokenBudgetApplied === true ? 'token budget applied' : 'structure only (no token budget)')
  if (selection.systemBarrier === 'crossed') parts.push('in-history system/message crossed')
  else if (selection.systemBarrier === 'kept') parts.push('in-history system/message kept visible')
  if (selection.systemBarrierSkippedNodes > 0) {
    const preference = selection.systemBarrierPreference === null
      ? ''
      : ' (preference ' + String(selection.systemBarrierPreference) + ')'
    parts.push('barrier cost: ' + selection.systemBarrierSkippedNodes + ' node(s) not released' + preference)
  }
  if (selection.edgeChecks !== null) parts.push('edge checks ' + String(selection.edgeChecks))
  return parts.join('; ')
}

/** Sentence for the token ledger. */
export function describeAccounting(report) {
  const released = report.accounting.releasedTokens
  const retained = report.accounting.retainedTokens
  const pieces = [released === null ? 'released unmeasured' : 'released ' + released + ' token(s)']
  if (retained !== null && retained !== undefined) pieces.push('retained tail ' + retained + ' token(s)')
  if (report.accounting.windowTokens !== null) pieces.push('window ' + report.accounting.windowTokens)
  if (report.attempts !== null && report.attempts > 1) pieces.push(report.attempts + ' attempt(s)')
  return pieces.join(', ')
}

/**
 * Normalize one decision into a reportable record.
 *
 * @param input - `{ trigger, outcome, decision, selection, error, measurement, attempts }`.
 *   `selection` accepts the rich selector plan, the frozen range object, or null;
 *   `decision` is D1's `{ action, reason, numbers }` (or undefined when the layer
 *   never ran).
 * @returns the normalized report; `why`, `span` and `tokens` are never empty.
 * @throws {TypeError} on an outcome outside the closed union.
 */
export function buildCompactionReport(input) {
  if (input === null || input === undefined || typeof input !== 'object') {
    throw new TypeError('dsh-compress-codex: buildCompactionReport requires a report input object')
  }
  const source = input
  const outcome = field(source, 'outcome')
  if (!REPORT_OUTCOMES.includes(outcome)) {
    throw new TypeError('dsh-compress-codex: unknown compaction report outcome ' + String(outcome))
  }
  const decision = field(source, 'decision')
  const selection = normalizeSelection(field(source, 'selection'))
  const numbers = field(decision, 'numbers')
  const error = field(source, 'error')
  const measurement = field(source, 'measurement')
  const attempts = Number.isInteger(field(source, 'attempts')) ? source.attempts : null
  const released = measureReleasedTokens(selection, measurement)
  if (selection !== null && selection.shadowedNodeCount === null) {
    const span = spanIndices(selection, measurement)
    if (span !== null) selection.shadowedNodeCount = span.endIdx - span.startIdx + 1
  }
  const report = {
    trigger: field(source, 'trigger') ?? 'pressure',
    outcome,
    triggered: (field(decision, 'action') ?? null) === 'compact',
    action: field(decision, 'action') ?? null,
    attempts,
    decision: decision === undefined || decision === null ? null : { action: field(decision, 'action') ?? null, reason: field(decision, 'reason') ?? null, numbers: numbers ?? null },
    selection,
    error: error === undefined || error === null ? null : {
      code: field(error, 'code') ?? null,
      name: field(error, 'name') ?? 'Error',
      message: String(field(error, 'message') ?? error)
    },
    accounting: {
      releasedTokens: released,
      retainedTokens: field(selection, 'retainedTokens'),
      windowTokens: Number.isFinite(field(numbers, 'windowTokens'))
        ? field(numbers, 'windowTokens')
        : Number.isFinite(field(selection, 'windowTokens')) ? field(selection, 'windowTokens') : null,
      surfaceNodes: field(selection, 'surfaceNodes')
    }
  }
  report.why = describeWhy(report)
  report.span = describeSelection(selection)
  report.tokens = describeAccounting(report)
  report.level = reportLevel(outcome)
  return report
}

/** The one-line "why" that must never be silent, whatever the outcome. */
function describeWhy(report) {
  if (report.outcome === 'delegated') {
    return 'not taken over: ' + describeTriggerDecision(report.decision)
  }
  if (report.outcome === 'skipped') {
    return 'no compaction needed: ' + describeTriggerDecision(report.decision)
  }
  if (report.outcome === 'blocked') {
    const selectorReason = report.selection === null ? 'the selector reported no reason' : report.selection.reason
    return 'compaction requested but nothing safe to shadow: ' + selectorReason
  }
  if (report.outcome === 'noop') {
    const planReason = report.selection === null ? 'the idempotence plan reported no reason' : report.selection.reason
    return 'deliberately ran nothing: ' + planReason
  }
  if (report.outcome === 'compacted') {
    return 'compaction ran: ' + describeTriggerDecision(report.decision)
  }
  const failure = report.error === null
    ? 'no failure detail was reported'
    : String(report.error.code ?? report.error.name) + ': ' + report.error.message
  const tried = report.attempts === null ? '' : ' after ' + report.attempts + ' attempt(s)'
  return (report.outcome === 'degraded' ? 'degraded, the session continues' : 'failed') + tried + ': ' + failure
}

/**
 * Log level for one outcome.
 *
 * Loud outcomes are the ones that changed or blocked something: blocked, compacted,
 * degraded and failed are info. Per-step answers — skipped, delegated and #9's
 * deliberate noop — stay at debug so a long session does not drown in them.
 */
export function reportLevel(outcome) {
  return outcome === 'blocked' || outcome === 'compacted' || outcome === 'degraded' || outcome === 'failed'
    ? 'info'
    : 'debug'
}

/**
 * Render the report as operator-readable text.
 *
 * @param report - a report from buildCompactionReport().
 * @returns a four-line block: header, why, span, tokens.
 */
export function renderCompactionReport(report) {
  return [
    'dsh-compress-codex: compaction report: ' + report.trigger + ' / ' + report.outcome,
    '  why   : ' + report.why,
    '  span  : ' + report.span,
    '  tokens: ' + report.tokens
  ].join('\n')
}
