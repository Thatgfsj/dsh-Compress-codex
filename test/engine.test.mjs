import assert from 'node:assert/strict'
import { test } from 'node:test'

import { POLICY_KEYS } from '../lib/core/keys.js'
import { decideCompaction as realDecideCompaction } from '../lib/core/trigger.js'
import {
  BASE_CONFIG_KEYS,
  DECISION_ACTIONS,
  DEFAULT_HOOKS,
  createCodexCompactionEngine,
  toBaseConfig
} from '../lib/engine.js'
import { createFakeAgent, createFakeBase, createFakeCtx, createHostileCtx } from './support/fake-base.mjs'

/**
 * Every assertion below injects its own hooks. The defaults are a moving target
 * between #4/#5/#6, so nothing here may depend on what the skeleton happens to
 * return — only on the contract the engine enforces around it.
 */
const hooksFor = (over = {}) => ({
  decideCompaction: () => ({ action: 'delegate', reason: 'test' }),
  selectCompactionRange: () => null,
  buildSummaryRequest: () => null,
  ...over
})

function mount({ hooks = hooksFor(), helpers, ctx = createFakeCtx(), config = {}, agent = createFakeAgent() } = {}) {
  const { FakeBase, calls } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase, hooks, helpers)
  return { engine: new Engine(ctx, config), calls, ctx, agent, Engine }
}

test('the shipped defaults are the real decision-layer hooks', () => {
  assert.equal(DEFAULT_HOOKS.decideCompaction, realDecideCompaction)
  for (const key of ['decideCompaction', 'selectCompactionRange', 'buildSummaryRequest']) {
    assert.equal(typeof DEFAULT_HOOKS[key], 'function', key)
  }
  assert.deepEqual(DECISION_ACTIONS, ['delegate', 'skip', 'compact'])
})

test('delegate hands the pressure path back to the base', async () => {
  const { engine, calls, agent } = mount()
  assert.deepEqual(await engine.compactIfNeeded(agent, 'pressure', undefined), { base: true, trigger: 'pressure' })
  assert.deepEqual(calls, [['compactIfNeeded', 'pressure']])
})

test('compact with a range commits through the inherited transaction', async () => {
  const { engine, calls, agent } = mount({
    hooks: hooksFor({
      decideCompaction: () => ({ action: 'compact', reason: 'test' }),
      selectCompactionRange: () => ({ start: 3, end: 9 })
    })
  })
  assert.deepEqual(await engine.compactIfNeeded(agent, 'pressure', undefined), { region: [3, 9] })
  assert.deepEqual(calls, [['compactRegion', 3, 9]])
})

test('skip on the pressure path is a zero-write decision', async () => {
  const { engine, calls, agent } = mount({
    hooks: hooksFor({ decideCompaction: () => ({ action: 'skip', reason: 'below' }) })
  })
  assert.equal(await engine.compactIfNeeded(agent, 'pressure', undefined), null)
  assert.deepEqual(calls, [], 'a skip must not touch the transaction or the base')
})

test('a null range on the pressure path is also a zero-write decision', async () => {
  const { engine, calls, agent } = mount({
    hooks: hooksFor({
      decideCompaction: () => ({ action: 'compact', reason: 'test' }),
      selectCompactionRange: () => null
    })
  })
  assert.equal(await engine.compactIfNeeded(agent, 'pressure', undefined), null)
  assert.deepEqual(calls, [])
})

test('LOCK: a null range on the overflow path falls back to the base, never to null', async () => {
  // Regression lock for the self-healing path: #5's selector is a skeleton, and
  // returning null here would silently disable context-overflow recovery.
  const { engine, calls, agent } = mount({
    hooks: hooksFor({
      decideCompaction: () => ({ action: 'compact', reason: 'overflow-bypass' }),
      selectCompactionRange: () => null
    })
  })
  assert.deepEqual(await engine.compactIfNeeded(agent, 'context-overflow', undefined), {
    base: true,
    trigger: 'context-overflow'
  })
  assert.deepEqual(calls, [['compactIfNeeded', 'context-overflow']])
})

test('the resolved window is injected as capacity, and only for pressure', async () => {
  const seen = []
  const ctx = createFakeCtx({ windowTokens: 200000 })
  const { engine, agent } = mount({
    ctx,
    hooks: hooksFor({
      decideCompaction: (context) => {
        seen.push(context.capacity)
        return { action: 'skip', reason: 'probe' }
      }
    })
  })

  await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.deepEqual(seen, [{ windowTokens: 200000 }])
  assert.deepEqual(ctx.calls.resolveModelInfo, [['acme', 'big']])

  await engine.compactIfNeeded(agent, 'context-overflow', undefined)
  assert.equal(seen[1], null, 'the overflow bypass must not pay for a model-info round trip')
  assert.equal(ctx.calls.resolveModelInfo.length, 1)
})

test('an unresolvable window becomes null capacity, and the decision degrades', async () => {
  const ctx = createFakeCtx({ failResolve: true })
  const { engine, calls, agent } = mount({
    ctx,
    hooks: hooksFor({
      decideCompaction: (context) => {
        assert.equal(context.capacity, null)
        return { action: 'delegate', reason: 'd1-no-window' }
      }
    })
  })
  assert.deepEqual(await engine.compactIfNeeded(agent, 'pressure', undefined), { base: true, trigger: 'pressure' })
  assert.deepEqual(calls, [['compactIfNeeded', 'pressure']])
})

test('a ctx without llm/tokenMeter still degrades instead of throwing', async () => {
  const { FakeBase } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase, hooksFor())
  const engine = new Engine(createHostileCtx(), {})
  assert.equal(await engine.compactIfNeeded(createFakeAgent(), 'pressure', undefined).then(() => 'ok'), 'ok')
})

test('the measure thunk is only called when a hook asks for it', async () => {
  const ctx = createFakeCtx()
  const { engine, agent } = mount({
    ctx,
    hooks: hooksFor({ decideCompaction: () => ({ action: 'skip', reason: 'below' }) })
  })
  await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(ctx.calls.measure, 0)

  const probing = mount({
    hooks: hooksFor({
      decideCompaction: (context) => {
        context.measure()
        return { action: 'skip', reason: 'probe' }
      }
    })
  })
  await probing.engine.compactIfNeeded(probing.agent, 'pressure', undefined)
  assert.equal(probing.ctx.calls.measure, 1)
})

test('the injected C1 edge checks reach the selector', async () => {
  const edgeChecks = { before: () => true, after: () => true }
  let seen = null
  const { engine, agent } = mount({
    helpers: { edgeChecks },
    hooks: hooksFor({
      decideCompaction: () => ({ action: 'compact', reason: 'test' }),
      selectCompactionRange: (context) => {
        seen = context.edgeChecks
        return null
      }
    })
  })
  await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(seen, edgeChecks)

  const withoutHelpers = mount({
    hooks: hooksFor({
      decideCompaction: () => ({ action: 'compact', reason: 'test' }),
      selectCompactionRange: (context) => {
        seen = context.edgeChecks
        return null
      }
    })
  })
  await withoutHelpers.engine.compactIfNeeded(withoutHelpers.agent, 'pressure', undefined)
  assert.equal(seen, null, 'a missing host helper downgrades to the pure fallback')
})

test('a decision hook that breaks the three-state contract fails loud', async () => {
  for (const bad of [{}, { action: 'maybe' }, null, 'compact']) {
    const { engine, agent } = mount({ hooks: hooksFor({ decideCompaction: () => bad }) })
    await assert.rejects(() => engine.compactIfNeeded(agent, 'pressure', undefined), /must return { action/)
  }
})

test('compactNow delegates while #5 owns the manual transaction', () => {
  const { engine, calls, agent } = mount()
  assert.deepEqual(engine.compactNow(agent, undefined, undefined), { base: true, manual: true })
  assert.deepEqual(calls, [['compactNow', undefined]])
})

test('compactNow refuses to commit a custom range through compactRegion', () => {
  const { engine, calls, agent } = mount({
    hooks: hooksFor({ selectCompactionRange: () => ({ start: 1, end: 2 }) })
  })
  assert.throws(() => engine.compactNow(agent, undefined, undefined), /owned by #5/)
  assert.deepEqual(calls, [], 'refusing must not write through the wrong transaction')
})

test('the summary path delegates on a null request, and refuses a request without a projection', async () => {
  const delegating = mount()
  assert.equal((await delegating.engine.summarize({ messages: [] }, delegating.agent)).provider, 'fake')
  assert.deepEqual(delegating.calls, [['summarize']])

  // #7 replaced the skeleton refusal with the C5 contract lock: a request whose
  // projection is missing is still refused before any model call, and the real
  // pipeline is covered by test/summarize.test.mjs.
  const building = mount({ hooks: hooksFor({ buildSummaryRequest: () => ({ prompt: 'codex' }) }) })
  await assert.rejects(() => building.engine.summarize({ messages: [] }, building.agent), /without a projection/)
})

test('toBaseConfig forwards only the official keys, so our policy keys never trip it', () => {
  // The two surfaces must not overlap, or one of them silently loses a key.
  const overlap = BASE_CONFIG_KEYS.filter((key) => POLICY_KEYS.includes(key))
  assert.deepEqual(overlap, [])

  const forwarded = toBaseConfig({ triggerLimitRatio: 0.5, auto: false, maxTokens: 100 })
  assert.deepEqual(forwarded, { auto: false, maxTokens: 100 })
  assert.deepEqual(toBaseConfig(null), {})
  assert.deepEqual(toBaseConfig('nope'), {})
})

test('a row config is validated at mount time, not on the first turn', () => {
  const { FakeBase } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase, hooksFor())
  assert.throws(() => new Engine(createFakeCtx(), { notAPolicyKey: 1 }), /unknown config key/)

  const engine = new Engine(createFakeCtx(), { triggerLimitRatio: 0.5, auto: false })
  assert.deepEqual(engine.config, { auto: false }, 'the base only sees the official keys')
})

test('the engine keeps the inject list the official backend declares', () => {
  const { FakeBase } = createFakeBase()
  FakeBase.inject = ['llm', 'tokenMeter', 'sessions']
  assert.deepEqual(createCodexCompactionEngine(FakeBase).inject, ['llm', 'tokenMeter', 'sessions'])
})

test('the factory rejects a bad base, a bad hook and malformed edge checks', () => {
  for (const bad of [null, undefined, {}, 'Base', 42]) {
    assert.throws(() => createCodexCompactionEngine(bad), TypeError)
  }
  const { FakeBase } = createFakeBase()
  assert.throws(() => createCodexCompactionEngine(FakeBase, { decideCompaction: 42 }), /must be a function/)
  assert.throws(
    () => createCodexCompactionEngine(FakeBase, DEFAULT_HOOKS, { edgeChecks: { before: () => true } }),
    /edgeChecks must provide/
  )
})
