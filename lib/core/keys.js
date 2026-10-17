/**
 * The decision-layer key surface, split out so config.js and the eventual #3
 * schema cannot drift apart.
 *
 * normalizePolicy() rejects anything not listed here (fail loud): a typo in a
 * patch row must not silently behave like the default.
 *
 * Zero dependencies on purpose (see config.js).
 */

/** Keys that belong to the D1-D4 policy projected by normalizePolicy(). */
export const POLICY_KEYS = Object.freeze([
  // D1 — Codex three-stage trigger (docs/codex-impl-checklist.md §1.1)
  'triggerLimitTokens',
  'triggerLimitRatio',
  'effectiveWindowPercent',
  'triggerBufferTokens',
  'turnEndPercent',
  // D1 — self-healing overflow path
  'overflowRecovery',
  // D3 — retention, owns #5
  'retainMode',
  'retainRecentUnits',
  // Soft ceiling, not a hard cap: whole structural units go in or out, so the
  // selector may exceed it rather than split a C1 tool-call pair.
  'retainTokens',
  // D4 — summarization, owns #6
  'summaryTemplate',
  // undefined/omitted = every extra field; [] = the plain Codex four.
  'summaryExtraFields'
])
