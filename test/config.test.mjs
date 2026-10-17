import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import {
  CONFIG_FIELDS,
  DEFAULT_POLICY,
  normalizePolicy,
  resolveModelPolicy
} from '../lib/core/config.js'
import { POLICY_KEYS, SUMMARY_FIELDS, SUMMARY_TEMPLATES } from '../lib/core/keys.js'
import { buildConfigSchema } from '../lib/index.js'

/** Chainable schemastery stand-in: enough to prove every descriptor kind maps. */
function fakeZ() {
  const node = () => {
    const api = {
      min: () => api,
      max: () => api,
      description: () => api,
      default: () => api,
      required: () => api
    }
    return api
  }
  return {
    natural: () => node(),
    number: () => node(),
    boolean: () => node(),
    string: () => node(),
    const: (value) => ({ const: value, ...node() }),
    union: (nodes) => ({ union: nodes, ...node() }),
    array: (inner) => ({ array: inner, ...node() }),
    object: (shape) => ({ shape, ...node() })
  }
}

test('every policy key has a descriptor, and no descriptor is orphaned', () => {
  assert.deepEqual(Object.keys(CONFIG_FIELDS).sort(), [...POLICY_KEYS].sort())
  for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
    assert.equal(typeof field.kind, 'string', key)
    assert.equal(typeof field.description, 'string', key + ' needs a description for --dump-config-schema')
  }
})

test('the defaults cover every key and are the Codex ones', () => {
  assert.deepEqual(Object.keys(DEFAULT_POLICY).sort(), [...POLICY_KEYS].sort())
  const policy = normalizePolicy({})
  assert.equal(policy.triggerLimitRatio, 0.9)
  assert.equal(policy.effectiveWindowPercent, 0.95)
  assert.equal(policy.triggerBufferTokens, 0)
  assert.equal(policy.turnEndPercent, 0)
  assert.equal(policy.overflowRecovery, true)
  assert.equal(policy.retainRecentUnits, 3)
  assert.equal(policy.retainTokens, undefined)
  assert.equal(policy.triggerLimitTokens, undefined)
  assert.equal(policy.modelPolicies, undefined)
  assert.ok(Object.isFrozen(policy))
})

test('the schema is generated from the same descriptors and covers every key', () => {
  const schema = buildConfigSchema(fakeZ())
  assert.deepEqual(Object.keys(schema.shape).sort(), [...POLICY_KEYS].sort())
})

test('the published types name every policy key', async () => {
  const declarations = await readFile(new URL('../lib/types/index.d.ts', import.meta.url), 'utf8')
  for (const key of POLICY_KEYS) {
    assert.ok(declarations.includes(key), 'lib/types/index.d.ts is missing ' + key)
  }
  assert.ok(declarations.includes('CodexCompactionConfig'))
  assert.ok(declarations.includes('CompactionDecision'))
})

test('the summary enums are the ones #6 implements', () => {
  assert.deepEqual([...SUMMARY_TEMPLATES], ['codex-v1'])
  assert.deepEqual([...SUMMARY_FIELDS], ['files', 'pitfalls'])
})

// Table-driven load-time rejections. Every row must fail loudly with a message
// that names the offending key or constraint.
const rejected = [
  ['a non-object config', 'nope', TypeError, /config must be an object/],
  ['an array', [], TypeError, /config must be an object/],
  ['an unknown key', { triggerRatio: 0.5 }, TypeError, /unknown config key/],
  ['a misspelled key', { triggerLimitRatios: 0.9 }, TypeError, /unknown config key/],
  ['triggerLimitRatio 0', { triggerLimitRatio: 0 }, RangeError, /triggerLimitRatio/],
  ['triggerLimitRatio above 1', { triggerLimitRatio: 1.5 }, RangeError, /triggerLimitRatio/],
  ['triggerLimitRatio as a string', { triggerLimitRatio: '0.9' }, RangeError, /triggerLimitRatio/],
  ['effectiveWindowPercent 0', { effectiveWindowPercent: 0 }, RangeError, /effectiveWindowPercent/],
  ['effectiveWindowPercent above 1', { effectiveWindowPercent: 1.2 }, RangeError, /effectiveWindowPercent/],
  ['turnEndPercent below 0', { turnEndPercent: -1 }, RangeError, /turnEndPercent/],
  ['turnEndPercent above 100', { turnEndPercent: 101 }, RangeError, /turnEndPercent/],
  ['triggerBufferTokens negative', { triggerBufferTokens: -1 }, RangeError, /triggerBufferTokens/],
  ['triggerBufferTokens fractional', { triggerBufferTokens: 1.5 }, RangeError, /triggerBufferTokens/],
  ['triggerLimitTokens 0', { triggerLimitTokens: 0 }, RangeError, /triggerLimitTokens/],
  ['retainRecentUnits 0', { retainRecentUnits: 0 }, RangeError, /retainRecentUnits/],
  ['retainRecentUnits fractional', { retainRecentUnits: 2.5 }, RangeError, /retainRecentUnits/],
  ['retainTokens 0', { retainTokens: 0 }, RangeError, /retainTokens/],
  ['overflowRecovery as a string', { overflowRecovery: 'yes' }, RangeError, /overflowRecovery/],
  ['an unknown retainMode', { retainMode: 'token' }, RangeError, /retainMode/],
  ['an unknown summaryTemplate', { summaryTemplate: 'codex-v2' }, RangeError, /summaryTemplate/],
  ['summaryExtraFields as a string', { summaryExtraFields: 'files' }, RangeError, /summaryExtraFields/],
  ['an unknown summary field', { summaryExtraFields: ['files', 'nope'] }, RangeError, /does not know "nope"/],
  ['a repeated summary field', { summaryExtraFields: ['files', 'files'] }, RangeError, /must not repeat/]
]

for (const [name, config, errorType, pattern] of rejected) {
  test('rejects ' + name, () => {
    assert.throws(() => normalizePolicy(config), (error) => {
      assert.ok(error instanceof errorType, 'expected ' + errorType.name + ', got ' + error.constructor.name)
      assert.match(error.message, /^dsh-compress-codex: /, 'every message must be attributable to this plugin')
      assert.match(error.message, pattern)
      return true
    })
  })
}

test('accepts the minimal and the maximal legal shape', () => {
  assert.equal(normalizePolicy({}).triggerLimitRatio, 0.9)

  const maximal = normalizePolicy({
    triggerLimitTokens: 200000,
    triggerLimitRatio: 0.5,
    effectiveWindowPercent: 0.6,
    triggerBufferTokens: 4096,
    turnEndPercent: 100,
    overflowRecovery: false,
    retainMode: 'structural',
    retainRecentUnits: 1,
    retainTokens: 1000,
    summaryTemplate: 'codex-v1',
    summaryExtraFields: [],
    modelPolicies: [{ provider: 'acme', model: 'big', triggerLimitRatio: 0.4, effectiveWindowPercent: 0.5 }]
  })
  assert.equal(maximal.triggerLimitTokens, 200000)
  assert.deepEqual([...maximal.summaryExtraFields], [], '[] is the explicit degradation to the Codex four')
  assert.equal(maximal.modelPolicies.length, 1)
  assert.ok(Object.isFrozen(maximal))
})

test('summaryExtraFields keeps the canonical order and is an enum subset', () => {
  assert.deepEqual([...normalizePolicy({ summaryExtraFields: ['pitfalls'] }).summaryExtraFields], ['pitfalls'])
  assert.deepEqual([...normalizePolicy({ summaryExtraFields: ['pitfalls', 'files'] }).summaryExtraFields], ['files', 'pitfalls'])
})

// Cross-key constraints: the ones a per-key schema cannot express.
const crossKeyRejected = [
  ['effectiveWindowPercent equal to triggerLimitRatio', { triggerLimitRatio: 0.9, effectiveWindowPercent: 0.9 }, /must be greater than/],
  ['effectiveWindowPercent below triggerLimitRatio', { triggerLimitRatio: 0.8, effectiveWindowPercent: 0.5 }, /must be greater than/],
  ['retainTokens at the trigger limit', { triggerLimitTokens: 1000, retainTokens: 1000 }, /must stay below triggerLimitTokens/],
  ['retainTokens above the trigger limit', { triggerLimitTokens: 1000, retainTokens: 5000 }, /must stay below triggerLimitTokens/]
]

for (const [name, config, pattern] of crossKeyRejected) {
  test('rejects ' + name, () => {
    assert.throws(() => normalizePolicy(config), pattern)
  })
}

test('accepts a percentage above the ratio and a budget below the limit', () => {
  assert.doesNotThrow(() => normalizePolicy({ triggerLimitRatio: 0.5, effectiveWindowPercent: 0.95 }))
  assert.doesNotThrow(() => normalizePolicy({ triggerLimitTokens: 1000, retainTokens: 999 }))
})

// modelPolicies: exact overrides, duplicates rejected.
test('accepts exact provider/model overrides', () => {
  const policy = normalizePolicy({
    modelPolicies: [
      { provider: 'acme', model: 'big', triggerLimitRatio: 0.5, effectiveWindowPercent: 0.8 }
    ]
  })
  assert.deepEqual(policy.modelPolicies, [
    { provider: 'acme', model: 'big', triggerLimitRatio: 0.5, effectiveWindowPercent: 0.8 }
  ])
})

const modelPolicyRejected = [
  ['a duplicate target', { modelPolicies: [{ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' }] }, TypeError, /more than once/],
  ['a missing provider', { modelPolicies: [{ model: 'b' }] }, TypeError, /provider must be a non-empty string/],
  ['an empty model', { modelPolicies: [{ provider: 'a', model: '' }] }, TypeError, /model must be a non-empty string/],
  ['a non-array', { modelPolicies: { provider: 'a', model: 'b' } }, RangeError, /must be an array/],
  ['a nested modelPolicies override', { modelPolicies: [{ provider: 'a', model: 'b', modelPolicies: [] }] }, TypeError, /cannot override modelPolicies/],
  ['an unknown override key', { modelPolicies: [{ provider: 'a', model: 'b', nope: 1 }] }, TypeError, /cannot override nope/],
  ['an override violating the cross-key rule', { modelPolicies: [{ provider: 'a', model: 'b', triggerLimitRatio: 0.9, effectiveWindowPercent: 0.5 }] }, RangeError, /must be greater than/],
  ['an override with an out-of-range value', { modelPolicies: [{ provider: 'a', model: 'b', turnEndPercent: 200 }] }, RangeError, /turnEndPercent/]
]

for (const [name, config, errorType, pattern] of modelPolicyRejected) {
  test('rejects modelPolicies with ' + name, () => {
    assert.throws(() => normalizePolicy(config), (error) => {
      assert.ok(error instanceof errorType, 'expected ' + errorType.name + ', got ' + error.constructor.name)
      assert.match(error.message, pattern)
      return true
    })
  })
}

test('resolveModelPolicy returns the exact override, merged over the top level', () => {
  const policy = normalizePolicy({
    triggerLimitRatio: 0.9,
    modelPolicies: [{ provider: 'acme', model: 'big', triggerLimitRatio: 0.4 }]
  })

  const exact = resolveModelPolicy(policy, { provider: 'acme', model: 'big' })
  assert.equal(exact.triggerLimitRatio, 0.4)
  assert.equal(exact.effectiveWindowPercent, policy.effectiveWindowPercent, 'unspecified keys inherit')
  assert.equal(exact.modelPolicies, undefined, 'the resolved view has no nested table')
  assert.ok(Object.isFrozen(exact))

  assert.equal(resolveModelPolicy(policy, { provider: 'acme', model: 'small' }), policy)
  assert.equal(resolveModelPolicy(policy, undefined), policy)
})

test('the plugin export carries a native schema for --dump-config-schema, or none', async () => {
  // The dump resolves Config synchronously from the module export, so it cannot
  // come from a dynamic import; see nativeConfigSchema(). In the zero-install
  // gate the host package is absent and the getter must degrade, not throw.
  const plugin = (await import('../lib/index.js')).default
  const schema = plugin.Config
  assert.ok(schema === undefined || typeof schema === 'function', 'a native Schemastery schema is callable')
  if (schema !== undefined) {
    assert.deepEqual(Object.keys(schema.dict ?? {}).sort(), [...POLICY_KEYS].sort())
  }
})

test('resolveModelPolicy is a no-op when no table is configured', () => {
  const policy = normalizePolicy({})
  assert.equal(resolveModelPolicy(policy, { provider: 'a', model: 'b' }), policy)
})
