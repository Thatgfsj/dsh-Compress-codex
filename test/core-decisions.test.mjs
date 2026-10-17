import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_POLICY, normalizePolicy } from '../lib/core/config.js'
import { buildSummaryRequest } from '../lib/core/prompt.js'
import { selectCompactionRange } from '../lib/core/select.js'
import { COMPACTION_TRIGGERS, decideCompaction } from '../lib/core/trigger.js'

test('D1 delegates, and does so without reading the host measurement', () => {
  const result = decideCompaction({
    trigger: 'pressure',
    policy: DEFAULT_POLICY,
    measure: () => {
      throw new Error('the D1 skeleton must not measure the host')
    }
  })
  assert.equal(result.delegate, true)
  assert.match(result.reason, /#4/)
})

test('D1 keeps the trigger union closed', () => {
  for (const bad of [undefined, null, 'manual', 'boom', 0]) {
    assert.throws(() => decideCompaction({ trigger: bad }), TypeError)
  }
  for (const good of COMPACTION_TRIGGERS) {
    assert.equal(decideCompaction({ trigger: good }).delegate, true)
  }
})

test('D2/D3 answers "no range" — the C1/C2-safe answer while #5 is open', () => {
  assert.equal(selectCompactionRange({ session: { surface: { nodes: [] } } }), null)
  assert.throws(() => selectCompactionRange({}), TypeError)
})

test('D4 has no request to make yet', () => {
  assert.equal(buildSummaryRequest({ input: { messages: [] } }), null)
  assert.throws(() => buildSummaryRequest({}), TypeError)
})

test('normalizePolicy fills every default and freezes the result', () => {
  const policy = normalizePolicy({ triggerRatio: 0.5 })
  assert.equal(policy.triggerRatio, 0.5)
  assert.equal(policy.retainMode, 'structural')
  for (const key of Object.keys(DEFAULT_POLICY)) assert.ok(key in policy, key)
  assert.ok(Object.isFrozen(policy))
  assert.deepEqual(normalizePolicy({ unknownKey: true }), DEFAULT_POLICY)
})

test('normalizePolicy rejects a config the engine cannot read', () => {
  for (const bad of [null, undefined, 'config', 7, []]) {
    assert.throws(() => normalizePolicy(bad), TypeError)
  }
})
