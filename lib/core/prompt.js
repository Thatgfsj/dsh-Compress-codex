/**
 * D4 — summarization policy (docs/PLAN.md §1.3).
 *
 * Skeleton for #2: the Codex template and the output projection land in #6/#7.
 * Until then the hook answers `null`, which the engine reads as "no custom
 * summary request" and turns back into the official summarizer.
 *
 * Zero dependencies on purpose (see config.js).
 */

/**
 * Build the summarization request for the replayed region.
 *
 * @param context - decision inputs supplied by the engine.
 * @param context.input - SummarizationInput (system head + shadowed region).
 * @param context.agent - live agent; #7 reads routing from it.
 * @param context.policy - normalized policy from normalizePolicy().
 * @returns `null` while the template is a skeleton, else `{ prompt, projection }`.
 * @throws {TypeError} when the replay input is missing.
 */
export function buildSummaryRequest(context) {
  const input = context === undefined || context === null ? undefined : context.input
  if (input === null || typeof input !== 'object') {
    throw new TypeError('dsh-compress-codex: buildSummaryRequest requires the replay input')
  }
  // TODO(#6): Codex structured prompt + #7: pure-text projection (C5).
  return null
}
