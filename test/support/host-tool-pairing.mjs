/**
 * Host-semantics equivalent for the two tool-pairing edge checks.
 *
 * Production must inject the real `toolPairingBalancedBefore/After` exports from
 * `@deepseek-ai/dsh-compaction` — the C1 verdict belongs to the host. This module
 * lets the decision layer's tests run under the install-free gate and falsifies
 * the test-only local fallback against host semantics.
 *
 * Verdict-for-verdict reproduction of dsh 0.2.1-rc.2
 * `dsh-compaction/lib/types/tool-pairing.js`: `eventDelta` counts assistant
 * `tool-call` blocks (+N) and `tool/result` (-1); the fold starts from the leading
 * cut `true` and throws on a missing event, a seq mismatch, or a negative count;
 * `cutBalance` indexes by surface position and throws when the seq is not a member
 * (before = offset 0, after = offset 1). The host's per-session balance cache is
 * omitted: test surfaces are immutable, so no verdict can change.
 */

/** Return how one surface event changes the in-progress tool-call count. */
function eventDelta(event) {
  switch (event.type) {
    case 'assistant/message':
      return event.data.message.content.filter((block) => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/** Fold the current surface into its cut-balance table, host-style. */
function surfaceCuts(session) {
  const cutBalanced = [true]
  let inProgress = 0
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) {
      throw new Error('tool-pairing balance: surface seq ' + String(seq) + ' has no matching session event (corrupt surface)')
    }
    inProgress += eventDelta(event)
    if (inProgress < 0) {
      throw new Error('tool-pairing balance: tool/result at surface seq ' + String(seq) + ' has no matching tool-call (corrupt surface)')
    }
    cutBalanced.push(inProgress === 0)
  }
  return cutBalanced
}

/** Balance of the cut at a sequence's position plus offset, host-style. */
function cutBalance(session, seq, offset) {
  const index = session.surface.nodes.indexOf(seq)
  const balanced = index === -1 ? undefined : surfaceCuts(session)[index + offset]
  if (balanced === undefined) throw new Error('tool-pairing balance: surface seq ' + String(seq) + ' not found')
  return balanced
}

/**
 * @returns `{ before, after }` with the host's contract, directly usable as
 * `selectCompactionRange({ edgeChecks })`.
 */
export function createHostToolPairing() {
  return {
    before: (session, seq) => cutBalance(session, seq, 0),
    after: (session, seq) => cutBalance(session, seq, 1)
  }
}
