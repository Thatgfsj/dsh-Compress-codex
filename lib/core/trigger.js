/**
 * D1 — trigger policy (docs/PLAN.md §1.3).
 *
 * Skeleton for #2: the Codex threshold formula lands in #4. Until then the hook
 * always answers `delegate`, so the engine defers to the official policy and
 * installing the bundle changes no behaviour.
 *
 * Zero dependencies on purpose (see config.js).
 */

/** Triggers the mechanical layer is allowed to ask about. */
export const COMPACTION_TRIGGERS = Object.freeze(['pressure', 'context-overflow'])

/**
 * Decide whether this trigger should compact.
 *
 * `measure` is a lazy thunk onto `ctx.tokenMeter`. The skeleton never calls it —
 * that is what keeps the decision layer free of host services, and
 * test/core-decisions.test.mjs asserts it by passing a thunk that throws.
 *
 * @param context - decision inputs supplied by the engine.
 * @param context.trigger - 'pressure' or 'context-overflow'.
 * @param context.policy - normalized policy from normalizePolicy().
 * @param context.measure - lazy () => measurement thunk; #4 consumes it.
 * @returns `{ delegate: true, reason }` while the policy is a skeleton.
 * @throws {TypeError} on an unknown trigger — a closed union must stay closed.
 */
export function decideCompaction(context) {
  const trigger = context === undefined || context === null ? undefined : context.trigger
  if (!COMPACTION_TRIGGERS.includes(trigger)) {
    throw new TypeError('dsh-compress-codex: unknown compaction trigger ' + String(trigger))
  }
  // TODO(#4): replace with the Codex threshold formula over context.measure().
  return { delegate: true, reason: 'd1-pending-#4' }
}
