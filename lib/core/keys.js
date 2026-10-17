/**
 * The decision-layer key surface, split out so config.js and the generated
 * schemastery schema cannot drift apart.
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
  // D1 — exact provider/model overrides; duplicates are rejected at load time
  'modelPolicies',
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

/** The extra summary fields #6 knows how to emit. */
export const SUMMARY_FIELDS = Object.freeze(['files', 'pitfalls'])

/** The summary templates #6 knows how to render. */
export const SUMMARY_TEMPLATES = Object.freeze(['codex-v1'])
