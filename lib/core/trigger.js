/**
 * D1 — trigger policy (docs/PLAN.md §1.3, docs/codex-impl-checklist.md §1).
 *
 * Codex's three-stage check, ported to the capacity DSH actually exposes:
 *
 *   full  = floor(W * effectiveWindowPercent)          hard-full ceiling
 *   limit = min(triggerLimitTokens ?? inf, floor(W * triggerLimitRatio))
 *   fire  = scopeTokens >= limit + triggerBufferTokens  (limit side, buffer added here)
 *        || activeTokens >= full                        (full side, no baseline needed)
 *
 * The full branch is evaluated first because it needs no scope baseline: in a
 * restored long session the replayed prefix alone can push activeTokens past
 * full while the conversation body is still small, so a limit-only check would
 * silently never fire (docs/codex-impl-checklist.md §1.3).
 *
 * All threshold arithmetic is integer-only. Percentages use exact decimal
 * fractions and cross multiplication (scaleByRatio / the turn-end compare)
 * rather than float multiplication, which drifts for windows like 1000001
 * (1e6 * 0.9 === 899999.9999999999 in IEEE-754).
 *
 * Three-state result, by contract:
 *   'delegate' — this layer does not take over; the official backend keeps
 *                deciding. Used whenever the window is unknown, because
 *                'skip' would disable compaction for the official policy too,
 *                which is a worse failure than not taking over at all.
 *   'skip'     — we own the decision and nothing crossed a threshold: zero writes.
 *   'compact'  — we own the decision and ask for one compaction.
 *
 * Zero dependencies on purpose (see config.js): the gate pipeline imports this
 * module with no node_modules present.
 */

/** Triggers the mechanical layer is allowed to ask about. */
export const COMPACTION_TRIGGERS = Object.freeze(['pressure', 'context-overflow'])

/** Codex defaults; overridden per mount by the plugin config (docs §1.1). */
export const D1_DEFAULTS = Object.freeze({
  triggerLimitTokens: undefined,
  triggerLimitRatio: 0.9,
  effectiveWindowPercent: 0.95,
  triggerBufferTokens: 0,
  turnEndPercent: 0,
  overflowRecovery: true
})

/** Turn-end percentage is measured against full, so 100 is the inclusive top. */
const TURN_END_MAX_PERCENT = 100

/** Split a finite decimal into an exact [numerator, denominator] fraction. */
function decimalFraction(value) {
  const text = String(value)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (match === null) {
    throw new RangeError('dsh-compress-codex: expected a finite non-negative decimal, got ' + text)
  }
  const fraction = match[2] === undefined ? '' : match[2]
  return [Number(match[1] + fraction), 10 ** fraction.length]
}

/**
 * Exact floor(value * ratio) for a ratio with a finite decimal expansion.
 * @throws {RangeError} for a ratio that is not a finite decimal.
 */
export function scaleByRatio(value, ratio) {
  const [numerator, denominator] = decimalFraction(ratio)
  return Math.floor((value * numerator) / denominator)
}

/** Validate and default the D1 slice of the plugin policy. */
function readD1Policy(policy) {
  const source = policy === null || typeof policy !== 'object' ? {} : policy
  const triggerLimitTokens = source.triggerLimitTokens ?? D1_DEFAULTS.triggerLimitTokens
  const triggerLimitRatio = source.triggerLimitRatio ?? D1_DEFAULTS.triggerLimitRatio
  const effectiveWindowPercent = source.effectiveWindowPercent ?? D1_DEFAULTS.effectiveWindowPercent
  const triggerBufferTokens = source.triggerBufferTokens ?? D1_DEFAULTS.triggerBufferTokens
  const turnEndPercent = source.turnEndPercent ?? D1_DEFAULTS.turnEndPercent
  const overflowRecovery = source.overflowRecovery ?? D1_DEFAULTS.overflowRecovery

  if (triggerLimitTokens !== undefined && (!Number.isInteger(triggerLimitTokens) || triggerLimitTokens <= 0)) {
    throw new RangeError('dsh-compress-codex: triggerLimitTokens must be a positive integer, got ' + String(triggerLimitTokens))
  }
  if (typeof triggerLimitRatio !== 'number' || !(triggerLimitRatio > 0) || !(triggerLimitRatio <= 1)) {
    throw new RangeError('dsh-compress-codex: triggerLimitRatio must be in (0, 1], got ' + String(triggerLimitRatio))
  }
  if (typeof effectiveWindowPercent !== 'number' || !(effectiveWindowPercent > 0) || !(effectiveWindowPercent <= 1)) {
    throw new RangeError('dsh-compress-codex: effectiveWindowPercent must be in (0, 1], got ' + String(effectiveWindowPercent))
  }
  if (!Number.isInteger(triggerBufferTokens) || triggerBufferTokens < 0) {
    throw new RangeError('dsh-compress-codex: triggerBufferTokens must be a non-negative integer, got ' + String(triggerBufferTokens))
  }
  if (typeof turnEndPercent !== 'number' || !(turnEndPercent >= 0) || !(turnEndPercent <= TURN_END_MAX_PERCENT)) {
    throw new RangeError('dsh-compress-codex: turnEndPercent must be in [0, 100], got ' + String(turnEndPercent))
  }
  if (typeof overflowRecovery !== 'boolean') {
    throw new RangeError('dsh-compress-codex: overflowRecovery must be a boolean, got ' + String(overflowRecovery))
  }
  return { triggerLimitTokens, triggerLimitRatio, effectiveWindowPercent, triggerBufferTokens, turnEndPercent, overflowRecovery }
}

/** The always-present part of the diagnostic payload. */
function emptyNumbers(policy) {
  return {
    windowTokens: null,
    activeTokens: null,
    scopeTokens: null,
    limitTokens: null,
    fullTokens: null,
    thresholdTokens: null,
    bufferTokens: policy.triggerBufferTokens,
    turnEndPercent: policy.turnEndPercent,
    limitReached: false,
    fullReached: false,
    turnEndReached: false
  }
}

/**
 * Decide whether this trigger should compact.
 *
 * @param context - decision inputs supplied by the engine.
 * @param context.trigger - 'pressure' or 'context-overflow'.
 * @param context.policy - normalized policy from normalizePolicy().
 * @param context.capacity - { windowTokens } resolved from the routed adapter by
 *   the engine, or null when it could not be resolved.
 * @param context.measure - lazy () => TokenMeasurement; never called on paths
 *   that do not need it (the overflow bypass and the unknown-window delegate).
 * @returns { action: 'delegate' | 'skip' | 'compact', reason, numbers } — every
 *   reason names the numbers that produced it, for the #13 diagnostics log.
 * @throws {TypeError} on an unknown trigger — a closed union must stay closed.
 * @throws {RangeError} on a policy value outside its documented range.
 */
export function decideCompaction(context) {
  const trigger = context === undefined || context === null ? undefined : context.trigger
  if (!COMPACTION_TRIGGERS.includes(trigger)) {
    throw new TypeError('dsh-compress-codex: unknown compaction trigger ' + String(trigger))
  }

  const policy = readD1Policy(context.policy)

  if (trigger === 'context-overflow') {
    // Self-healing path. It bypasses every threshold so a provider-confirmed
    // overflow still gets one balanced reduction, and it needs no measurement,
    // so it stays valid even when the window is unknown.
    if (policy.overflowRecovery === false) {
      // An explicit opt-out still self-heals: hand the path back to the official
      // backend instead of letting our (possibly incomplete) policy swallow it.
      return { action: 'delegate', reason: 'd1-overflow-recovery-disabled', numbers: emptyNumbers(policy) }
    }
    return { action: 'compact', reason: 'd1-context-overflow-bypass', numbers: emptyNumbers(policy) }
  }

  const windowTokens = context.capacity === undefined || context.capacity === null
    ? undefined
    : context.capacity.windowTokens

  // Codex answers None here as well (openai_models.rs#L529-L541). Delegating is
  // the only safe answer: skipping would disable the official policy too.
  if (!Number.isInteger(windowTokens) || windowTokens <= 0) {
    return { action: 'delegate', reason: 'd1-no-window', numbers: emptyNumbers(policy) }
  }

  const measurement = context.measure()
  const activeTokens = measurement.totalTokens
  const scopeTokens = measurement.surfaceTokens

  const fullTokens = scaleByRatio(windowTokens, policy.effectiveWindowPercent)
  const limitByRatio = scaleByRatio(windowTokens, policy.triggerLimitRatio)
  const limitTokens = policy.triggerLimitTokens === undefined
    ? limitByRatio
    : Math.min(policy.triggerLimitTokens, limitByRatio)
  const thresholdTokens = limitTokens + policy.triggerBufferTokens

  const fullReached = activeTokens >= fullTokens
  const limitReached = scopeTokens >= thresholdTokens
  const turnEndReached = policy.turnEndPercent > 0 && activeTokens * TURN_END_MAX_PERCENT >= fullTokens * policy.turnEndPercent

  const numbers = {
    windowTokens,
    activeTokens,
    scopeTokens,
    limitTokens,
    fullTokens,
    thresholdTokens,
    bufferTokens: policy.triggerBufferTokens,
    turnEndPercent: policy.turnEndPercent,
    limitReached,
    fullReached,
    turnEndReached
  }

  // full first: it needs no scope baseline, and a restored session's replayed
  // prefix can reach it while the body is still small.
  if (fullReached) return { action: 'compact', reason: 'd1-full-reached', numbers }
  if (limitReached) return { action: 'compact', reason: 'd1-limit-reached', numbers }
  return { action: 'skip', reason: 'd1-below-threshold', numbers }
}
