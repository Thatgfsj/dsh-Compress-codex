import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_HOOKS, createCodexCompactionEngine } from '../lib/engine.js'
import { createFakeBase, createHostileCtx } from './support/fake-base.mjs'

const agent = { session: { id: 'session-1' } }

test('the skeleton overrides all three hooks and delegates to the base', async () => {
  const { FakeBase, calls } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase)
  const engine = new Engine({}, {})

  assert.deepEqual(await engine.compactIfNeeded(agent, 'pressure', undefined), {
    base: true,
    trigger: 'pressure'
  })
  assert.deepEqual(engine.compactNow(agent, undefined, undefined), { base: true, manual: true })
  assert.equal((await engine.summarize({ messages: [] }, agent)).provider, 'fake')
  assert.deepEqual(calls, [
    ['compactIfNeeded', 'pressure'],
    ['compactNow', undefined],
    ['summarize']
  ])
})

test('the skeleton path never touches a host service', async () => {
  const { FakeBase } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase)
  // Accessing any property of this ctx throws: measure() must stay uncalled.
  const engine = new Engine(createHostileCtx(), {})

  await engine.compactIfNeeded(agent, 'context-overflow', undefined)
  engine.compactNow(agent, undefined, undefined)
  await engine.summarize({ messages: [] }, agent)
})

test('an injected decision hook replaces the inherited fallback', async () => {
  const { FakeBase, calls } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase, {
    decideCompaction: () => ({ delegate: false, reason: 'test' }),
    selectCompactionRange: () => ({ start: 3, end: 9 })
  })
  const engine = new Engine({}, {})

  assert.deepEqual(await engine.compactIfNeeded(agent, 'pressure', undefined), { region: [3, 9] })
  assert.deepEqual(calls, [['compactRegion', 3, 9]])
})

test('a null range is a zero-write decision, never a base fallback', async () => {
  const { FakeBase, calls } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase, {
    decideCompaction: () => ({ delegate: false, reason: 'test' })
  })
  const engine = new Engine({}, {})

  assert.equal(await engine.compactIfNeeded(agent, 'pressure', undefined), null)
  assert.deepEqual(calls, [], 'no safe range must not touch the transaction at all')
})

test('the manual path refuses to commit a custom range through compactRegion', () => {
  const { FakeBase, calls } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase, {
    selectCompactionRange: () => ({ start: 1, end: 2 })
  })
  const engine = new Engine({}, {})

  assert.throws(() => engine.compactNow(agent, undefined, undefined), /owned by #5/)
  assert.deepEqual(calls, [], 'refusing must not write through the wrong transaction')
})

test('the summary path refuses to emit an unprojected summary', async () => {
  const { FakeBase } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase, {
    buildSummaryRequest: () => ({ prompt: 'codex' })
  })
  const engine = new Engine({}, {})

  await assert.rejects(() => engine.summarize({ messages: [] }, agent), /owned by #6\/#7/)
})

test('the factory rejects a non-class base and a non-callable hook', () => {
  for (const bad of [null, undefined, {}, 'Base', 42]) {
    assert.throws(() => createCodexCompactionEngine(bad), TypeError)
  }
  const { FakeBase } = createFakeBase()
  assert.throws(
    () => createCodexCompactionEngine(FakeBase, { decideCompaction: 42 }),
    /must be a function/
  )
})

test('the engine keeps the inject list the official backend declares', () => {
  const { FakeBase } = createFakeBase()
  FakeBase.inject = ['llm', 'tokenMeter', 'sessions']
  const Engine = createCodexCompactionEngine(FakeBase)
  assert.deepEqual(Engine.inject, ['llm', 'tokenMeter', 'sessions'])
  assert.equal(typeof DEFAULT_HOOKS.decideCompaction, 'function')
})
