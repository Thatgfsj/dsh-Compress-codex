/**
 * Compaction policy shape shared by the decision layer.
 *
 * docs/design-m1-m2.md §5 freezes the eventual config surface; issue #3 owns the
 * full schema and the fail-fast validation. Issue #2 only needs the defaults so
 * the engine has something well-typed to hand the D1-D4 hooks.
 *
 * **Zero dependencies on purpose.** Nothing under lib/core may import a
 * `@deepseek-ai/*` package: the gate pipeline runs `node --test` without an
 * install step, so any host import here would turn every future PR red.
 */

import { POLICY_KEYS } from './keys.js'

/** Codex-style defaults; issue #4/#5/#6 replace the numbers with source-backed ones. */
export const DEFAULT_POLICY = Object.freeze({
  triggerRatio: 0.8,
  overflowRecovery: true,
  retainMode: 'structural',
  retainRecentUnits: 3,
  summaryTemplate: 'codex-v1'
})

/**
 * Project a raw plugin config onto the decision-layer policy.
 *
 * Unknown keys are ignored here rather than rejected: the loader already
 * validates the row against the mounted engine's Config schema, and this module
 * must stay usable in isolation. Issue #3 owns the rejection policy.
 *
 * @param config - raw plugin configuration (already normalized by cordis).
 * @returns frozen policy carrying every key of DEFAULT_POLICY.
 * @throws {TypeError} when config is not a plain object.
 */
export function normalizePolicy(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('dsh-compress-codex: config must be an object')
  }
  const policy = { ...DEFAULT_POLICY }
  for (const key of POLICY_KEYS) {
    if (config[key] !== undefined) policy[key] = config[key]
  }
  return Object.freeze(policy)
}
