/**
 * Compaction policy shape and load-time validation.
 *
 * One source of truth: CONFIG_FIELDS describes every key once, and both
 * normalizePolicy() (runtime, dependency-free) and lib/index.js (the schemastery
 * Config handed to the loader) are built from it. The generated schema therefore
 * cannot drift from the validation that actually runs.
 *
 * **Zero dependencies on purpose.** Nothing under lib/core may import a
 * @deepseek-ai/* package: the gate pipeline runs node --test without an install
 * step, so any host import here would turn every future PR red.
 */

import { POLICY_KEYS, SUMMARY_FIELDS, SUMMARY_TEMPLATES } from './keys.js'

/** Codex-style defaults (docs/codex-impl-checklist.md §1.1). */
export const DEFAULT_POLICY = Object.freeze({
  triggerLimitTokens: undefined,
  triggerLimitRatio: 0.9,
  effectiveWindowPercent: 0.95,
  triggerBufferTokens: 0,
  turnEndPercent: 0,
  overflowRecovery: true,
  modelPolicies: undefined,
  retainMode: 'structural',
  retainRecentUnits: 3,
  retainTokens: undefined,
  summaryTemplate: 'codex-v1',
  // Missing means "all extra fields on"; an explicit [] means the plain Codex
  // four. Defaulting to [] would silently switch off 'files'/'pitfalls', which
  // are the reason this project exists.
  summaryExtraFields: Object.freeze(['files', 'pitfalls'])
})

/**
 * Field descriptors. kind selects both the validator below and the schemastery
 * constructor in lib/index.js; every key of POLICY_KEYS must appear here.
 */
export const CONFIG_FIELDS = Object.freeze({
  triggerLimitTokens: { kind: 'positiveInteger', optional: true, description: 'Absolute cap on the trigger limit, in tokens. Unset means only the ratio applies.' },
  triggerLimitRatio: { kind: 'ratio', description: 'Floor(W * ratio) caps the scope side of the trigger.' },
  effectiveWindowPercent: { kind: 'ratio', description: 'Floor(W * percent) is the hard-full ceiling that needs no scope baseline.' },
  triggerBufferTokens: { kind: 'nonNegativeInteger', description: 'Safety margin added on the limit side only. Codex keeps this 0 unless a fallback prompt is configured.' },
  turnEndPercent: { kind: 'percent', description: 'Turn-end check against the full ceiling; 0 disables it. DSH has no turn-end seam yet, so #4 only reports it.' },
  overflowRecovery: { kind: 'boolean', description: 'Keep the context-overflow self-healing bypass. false hands that path back to the official backend.' },
  modelPolicies: { kind: 'modelPolicies', optional: true, description: 'Exact provider/model policy overrides. Duplicate targets are rejected.' },
  retainMode: { kind: 'enum', values: Object.freeze(['structural']), description: 'D3 retention mode.' },
  retainRecentUnits: { kind: 'positiveInteger', description: 'Structural units kept verbatim from the newest end.' },
  retainTokens: { kind: 'positiveInteger', optional: true, description: 'Soft budget for the retained tail: whole units go in or out, so it may be exceeded rather than split a tool-call pair.' },
  summaryTemplate: { kind: 'enum', values: SUMMARY_TEMPLATES, description: 'D4 summary template.' },
  summaryExtraFields: { kind: 'stringArray', values: SUMMARY_FIELDS, description: 'Extra summary fields. Omitted means all of them; [] degrades to the plain Codex four.' }
})

/** Keys a modelPolicies entry may override (everything but modelPolicies itself). */
export const OVERRIDABLE_KEYS = Object.freeze(
  POLICY_KEYS.filter((key) => key !== 'modelPolicies')
)

function fail(message) {
  throw new TypeError('dsh-compress-codex: ' + message)
}

function failRange(message) {
  throw new RangeError('dsh-compress-codex: ' + message)
}

const VALIDATORS = {
  positiveInteger(value, name) {
    if (!Number.isInteger(value) || value < 1) failRange(name + ' must be a positive integer, got ' + String(value))
    return value
  },
  nonNegativeInteger(value, name) {
    if (!Number.isInteger(value) || value < 0) failRange(name + ' must be a non-negative integer, got ' + String(value))
    return value
  },
  ratio(value, name) {
    if (typeof value !== 'number' || Number.isNaN(value) || !(value > 0) || !(value <= 1)) {
      failRange(name + ' must be a number in (0, 1], got ' + String(value))
    }
    return value
  },
  percent(value, name) {
    if (typeof value !== 'number' || Number.isNaN(value) || !(value >= 0) || !(value <= 100)) {
      failRange(name + ' must be a number in [0, 100], got ' + String(value))
    }
    return value
  },
  boolean(value, name) {
    if (typeof value !== 'boolean') failRange(name + ' must be a boolean, got ' + String(value))
    return value
  },
  enum(value, name, field) {
    if (!field.values.includes(value)) {
      failRange(name + ' must be one of ' + field.values.join(', ') + ', got ' + String(value))
    }
    return value
  },
  stringArray(value, name, field) {
    if (!Array.isArray(value)) failRange(name + ' must be an array, got ' + String(value))
    for (const entry of value) {
      if (typeof entry !== 'string') failRange(name + ' entries must be strings, got ' + String(entry))
      if (!field.values.includes(entry)) {
        failRange(name + ' does not know ' + JSON.stringify(entry) + '; known values are ' + field.values.join(', '))
      }
    }
    if (new Set(value).size !== value.length) failRange(name + ' must not repeat a value')
    return Object.freeze([...field.values].filter((entry) => value.includes(entry)))
  },
  modelPolicies(value, name) {
    if (!Array.isArray(value)) failRange(name + ' must be an array of { provider, model, ... } entries, got ' + String(value))
    const seen = new Set()
    const normalized = value.map((entry, index) => {
      const at = name + '[' + index + ']'
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(at + ' must be an object')
      const { provider, model } = entry
      if (typeof provider !== 'string' || provider.length === 0) fail(at + '.provider must be a non-empty string')
      if (typeof model !== 'string' || model.length === 0) fail(at + '.model must be a non-empty string')
      const target = provider + '/' + model
      if (seen.has(target)) fail(name + ' defines ' + target + ' more than once; merge the entries or drop one')
      seen.add(target)
      const overrides = {}
      for (const key of Object.keys(entry)) {
        if (key === 'provider' || key === 'model') continue
        if (!OVERRIDABLE_KEYS.includes(key)) fail(at + ' cannot override ' + key)
        if (entry[key] !== undefined) overrides[key] = entry[key]
      }
      for (const [key, value] of Object.entries(overrides)) validateField(key, value)
      validateCrossKeys(overrides, at)
      return Object.freeze({ provider, model, ...overrides })
    })
    return Object.freeze(normalized)
  }
}

/** Validate one keyed value against its descriptor. */
function validateField(key, value) {
  const field = CONFIG_FIELDS[key]
  if (field === undefined) fail('unknown config key ' + key)
  const validator = VALIDATORS[field.kind]
  if (validator === undefined) fail('no validator for ' + key + ' (' + field.kind + ')')
  return validator(value, key, field)
}

/**
 * Cross-key constraints: the ones a per-key schema cannot express.
 *
 * Deliberately free of "which keys may appear here" checks — normalizePolicy()
 * and the modelPolicies validator own that, so a top-level policy (which
 * legitimately carries modelPolicies) is not mistaken for an override entry.
 */
function validateCrossKeys(overrides, where) {
  const ratio = overrides.triggerLimitRatio
  const percent = overrides.effectiveWindowPercent
  if (ratio !== undefined && percent !== undefined && !(percent > ratio)) {
    failRange(
      where + ': effectiveWindowPercent (' + percent + ') must be greater than triggerLimitRatio (' +
      ratio + '), otherwise the full ceiling fires before the limit side and the three-stage check collapses'
    )
  }
  const retainTokens = overrides.retainTokens
  const limitTokens = overrides.triggerLimitTokens
  if (retainTokens !== undefined && limitTokens !== undefined && retainTokens >= limitTokens) {
    failRange(
      where + ': retainTokens (' + retainTokens + ') must stay below triggerLimitTokens (' + limitTokens +
      '), otherwise the tail we keep verbatim is already past the trigger'
    )
  }
}

/**
 * Project a raw plugin config onto the decision-layer policy.
 *
 * Unknown keys are rejected rather than dropped: a mistyped row must fail at load
 * time instead of running with defaults the operator never chose.
 *
 * @param config - raw row configuration (the engine passes the unvalidated row,
 *   not the base class's resolved config, so our keys survive).
 * @returns frozen policy carrying every key of DEFAULT_POLICY.
 * @throws {TypeError} when config is not a plain object or names an unknown key.
 * @throws {RangeError} when a value is outside its documented range, or a
 *   cross-key constraint is violated.
 */
export function normalizePolicy(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('dsh-compress-codex: config must be an object')
  }
  const unknown = Object.keys(config).filter((key) => !POLICY_KEYS.includes(key))
  if (unknown.length > 0) {
    fail('unknown config key(s) ' + unknown.join(', ') + '; known keys are ' + POLICY_KEYS.join(', '))
  }

  const policy = {}
  for (const key of POLICY_KEYS) {
    const supplied = config[key]
    if (supplied === undefined) {
      policy[key] = DEFAULT_POLICY[key]
      continue
    }
    policy[key] = validateField(key, supplied)
  }
  validateCrossKeys(policy, 'CodexCompactionConfig')
  return Object.freeze(policy)
}

/**
 * Effective policy for one routed target: the exact provider/model override when
 * it exists, merged over the top-level policy, else the top-level policy.
 *
 * @param policy - normalized policy.
 * @param target - { provider, model } or undefined.
 * @returns frozen policy for that target.
 */
export function resolveModelPolicy(policy, target) {
  if (target === undefined || target === null) return policy
  const entries = policy.modelPolicies
  if (!Array.isArray(entries)) return policy
  const match = entries.find((entry) => entry.provider === target.provider && entry.model === target.model)
  if (match === undefined) return policy
  const resolved = { ...policy }
  for (const [key, value] of Object.entries(match)) {
    if (key === 'provider' || key === 'model') continue
    resolved[key] = value
  }
  delete resolved.modelPolicies
  return Object.freeze(resolved)
}
