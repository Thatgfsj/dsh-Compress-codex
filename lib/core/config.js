/**
 * Compaction policy shape shared by the decision layer.
 *
 * docs/design-m1-m2.md §5 freezes the eventual config surface; issue #3 owns the
 * full schema (modelPolicies, cross-key checks) and the engine's Config schema.
 * This module carries the D1/D4 slice the decision layer reads today.
 *
 * **Zero dependencies on purpose.** Nothing under lib/core may import a
 * `@deepseek-ai/*` package: the gate pipeline runs `node --test` without an
 * install step, so any host import here would turn every future PR red.
 */

import { POLICY_KEYS } from './keys.js'

/** Codex-style defaults (docs/codex-impl-checklist.md §1.1). */
export const DEFAULT_POLICY = Object.freeze({
  // D1
  triggerLimitTokens: undefined,
  triggerLimitRatio: 0.9,
  effectiveWindowPercent: 0.95,
  triggerBufferTokens: 0,
  turnEndPercent: 0,
  overflowRecovery: true,
  // D3
  retainMode: 'structural',
  retainRecentUnits: 3,
  retainTokens: undefined,
  // D4
  summaryTemplate: 'codex-v1',
  // Missing/undefined means "all extra fields on"; an explicit [] means the plain
  // Codex four. Defaulting to [] would silently switch off 'files'/'pitfalls',
  // which are the reason this project exists — so the default is the full set.
  summaryExtraFields: Object.freeze(['files', 'pitfalls'])
})

/**
 * Project a raw plugin config onto the decision-layer policy.
 *
 * Unknown keys are rejected rather than dropped: a mistyped row must fail at
 * mount time instead of running with defaults the operator never chose.
 *
 * @param config - raw row configuration (the engine passes the unvalidated row,
 *   not the base class's resolved config, so our keys survive).
 * @returns frozen policy carrying every key of DEFAULT_POLICY.
 * @throws {TypeError} when config is not a plain object or names an unknown key.
 */
export function normalizePolicy(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('dsh-compress-codex: config must be an object')
  }
  const unknown = Object.keys(config).filter((key) => !POLICY_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new TypeError(
      'dsh-compress-codex: unknown config key(s) ' + unknown.join(', ') +
      '; known keys are ' + POLICY_KEYS.join(', ')
    )
  }
  const policy = { ...DEFAULT_POLICY }
  for (const key of POLICY_KEYS) {
    if (config[key] !== undefined) policy[key] = config[key]
  }
  return Object.freeze(policy)
}
