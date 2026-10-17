/**
 * D1 — trigger policy (docs/PLAN.md §1.3, docs/codex-impl-checklist.md §1).
 *
 * Contract migration only. The three-stage check
 *   full  = floor(W * effectiveWindowPercent)
 *   limit = min(triggerLimitTokens ?? inf, floor(W * triggerLimitRatio))
 *   fire  = scopeTokens >= limit + triggerBufferTokens || activeTokens >= full
 * lands in #4, in the follow-up PR that owns this file. Until then every
 * decision answers 'delegate', so the engine leaves the official policy in
 * charge and installing the bundle still changes no behaviour.
 *
 * Three-state result, by contract:
 *   'delegate' — this layer does not take over; the official backend keeps
 *                deciding. Used whenever the window is unknown, because 'skip'
 *                would disable the official policy too, which is a worse failure
 *                than not taking over at all.
 *   'skip'     — we own the decision and nothing crossed a threshold: zero writes.
 *   'compact'  — we own the decision and ask for one compaction.
 *
 * Zero dependencies on purpose (see config.js): the gate pipeline imports this
 * module with no node_modules present.
 */

/** Triggers the mechanical layer is allowed to ask about. */
export const COMPACTION_TRIGGERS = Object.freeze(['pressure', 'context-overflow'])

/**
 * Decide whether this trigger should compact.
 *
 * @param context - decision inputs supplied by the engine.
 * @param context.trigger - 'pressure' or 'context-overflow'.
 * @param context.policy - normalized policy from normalizePolicy().
 * @param context.capacity - { windowTokens } resolved from the routed adapter by
 *   the engine, or null when it could not be resolved.
 * @param context.measure - lazy () => TokenMeasurement; #4 consumes it.
 * @returns { action: 'delegate' | 'skip' | 'compact', reason, numbers } — every
 *   reason names the numbers that produced it, for the #13 diagnostics log.
 * @throws {TypeError} on an unknown trigger — a closed union must stay closed.
 */
export function decideCompaction(context) {
  const trigger = context === undefined || context === null ? undefined : context.trigger
  if (!COMPACTION_TRIGGERS.includes(trigger)) {
    throw new TypeError('dsh-compress-codex: unknown compaction trigger ' + String(trigger))
  }
  // TODO(#4): replace with the three-stage check over context.capacity/measure().
  return { action: 'delegate', reason: 'd1-pending-#4', numbers: {} }
}
