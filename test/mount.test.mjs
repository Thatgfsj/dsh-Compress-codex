import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, mountEngine } from '../lib/index.js'
import { createFakeBase } from './support/fake-base.mjs'

/** Minimal cordis Context stand-in that records what the mount did. */
function fakeCtx() {
  const plugged = []
  const logged = []
  return {
    plugged,
    logged,
    plugin(Engine, config) {
      plugged.push({ Engine, config })
      return { mounted: true }
    },
    logger: {
      error: (message) => logged.push(message),
      warn: (message) => logged.push(message)
    }
  }
}

test('mountEngine mounts a subclass of the injected base class', async () => {
  const { FakeBase } = createFakeBase()
  const ctx = fakeCtx()

  const fiber = await mountEngine(ctx, { triggerRatio: 0.5 }, async () => FakeBase)

  assert.deepEqual(fiber, { mounted: true })
  assert.equal(ctx.plugged.length, 1)
  const { Engine, config } = ctx.plugged[0]
  assert.equal(Object.getPrototypeOf(Engine.prototype), FakeBase.prototype)
  assert.deepEqual(config, { triggerRatio: 0.5 })
  assert.deepEqual(ctx.logged, [])
})

test('an unloadable host package is reported instead of failing silently', async () => {
  const ctx = fakeCtx()

  const result = await mountEngine(ctx, {}, async () => {
    throw new Error('ERR_MODULE_NOT_FOUND')
  })

  assert.equal(result, null)
  assert.deepEqual(ctx.plugged, [], 'nothing may be mounted without the base class')
  assert.equal(ctx.logged.length, 1)
  assert.match(ctx.logged[0], /NOT installed/)
  assert.match(ctx.logged[0], /ERR_MODULE_NOT_FOUND/)
})

test('mountEngine rejects a base class that is not a class', async () => {
  await assert.rejects(() => mountEngine(fakeCtx(), {}, async () => 'not-a-class'), TypeError)
})

test('apply never rejects, even where the host package is absent', async () => {
  // CI runs this with no node_modules, so the dynamic import fails; apply must
  // report the failure and resolve rather than reject into a swallowed fiber.
  const ctx = fakeCtx()
  await apply(ctx, {})
  assert.ok(ctx.plugged.length + ctx.logged.length >= 1)
})

test('apply fails fast on a context or config the decision layer cannot read', () => {
  for (const bad of [undefined, null, 42, 'ctx']) assert.throws(() => apply(bad, {}), TypeError)
  for (const bad of [null, 'config', 7, []]) assert.throws(() => apply(fakeCtx(), bad), TypeError)
})
