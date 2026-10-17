/**
 * D2/D3 — split and retention policy (docs/PLAN.md §1.3).
 *
 * Skeleton for #2: the structural selector lands in #5. Until then the hook
 * always answers `null`, which the engine reads as "no custom range" and turns
 * back into the official selection. Returning null is also the C1/C2-safe answer:
 * it can never select a range that splits a tool-call pair or shadows node 0.
 *
 * Zero dependencies on purpose (see config.js).
 */

/**
 * Choose the surface span to replace and the tail to retain verbatim.
 *
 * @param context - decision inputs supplied by the engine.
 * @param context.session - live session (surface access only; never mutated here).
 * @param context.policy - normalized policy from normalizePolicy().
 * @param context.trigger - 'pressure', 'context-overflow' or 'manual'.
 * @param context.capacity - { windowTokens } | null, resolved by the engine.
 * @param context.measure - lazy () => measurement thunk; #5 consumes it.
 * @param context.edgeChecks - authoritative tool-pairing cuts supplied by the
 *   engine ({ before, after }), or null when the host helper is unavailable. The
 *   selector must then fall back to its own pure C1 check.
 * @returns `null` while the selector is a skeleton, else `{ start, end, retainFrom }`
 *   with `start > 0`: surface node 0 is never shadowed, system or not (C2).
 * @throws {TypeError} when no session is supplied.
 */
export function selectCompactionRange(context) {
  const session = context === undefined || context === null ? undefined : context.session
  if (session === undefined || session === null) {
    throw new TypeError('dsh-compress-codex: selectCompactionRange requires a session')
  }
  // TODO(#5): structural range selection honouring C1 (paired tool calls) and
  // C2 (surface node 0 is never shadowed).
  return null
}
