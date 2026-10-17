/**
 * The decision-layer key surface, split out so config.js and the future #3 schema
 * cannot drift apart.
 *
 * Zero dependencies on purpose (see config.js).
 */

/** Keys that belong to the D1-D4 policy projected by normalizePolicy(). */
export const POLICY_KEYS = Object.freeze([
  'triggerRatio',
  'overflowRecovery',
  'retainMode',
  'retainRecentUnits',
  'summaryTemplate'
])
