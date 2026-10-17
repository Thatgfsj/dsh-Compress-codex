import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const plugin = await import('../lib/index.js')

test('lib/index.js exposes the cordis plugin contract', () => {
  assert.equal(typeof plugin.apply, 'function', 'a plugin must export apply(ctx, config)')
  assert.equal(plugin.name, manifest.name, 'the plugin name must match the npm name')
  assert.ok(Array.isArray(plugin.inject), 'inject must be an array so the loader can resolve services')
})

test('apply() mounts against a Context-like object and stays inert in M0', () => {
  const touched = []
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        touched.push(`get ${String(prop)}`)
        return undefined
      },
      set(_target, prop) {
        touched.push(`set ${String(prop)}`)
        return true
      },
    },
  )

  assert.equal(plugin.apply(ctx, {}), undefined)
  assert.deepEqual(
    touched,
    [],
    'the M0 placeholder must not read or write ctx: undeclared service access aborts the plugin silently',
  )
})

test('apply() rejects anything that is not a cordis Context', () => {
  for (const bad of [undefined, null, 42, 'ctx']) {
    assert.throws(() => plugin.apply(bad, {}), TypeError)
  }
})

test('apply() rejects a non-object config', () => {
  for (const bad of [null, 'config', 7, []]) {
    assert.throws(() => plugin.apply({}, bad), TypeError)
  }
})

test('apply() tolerates a missing config, like a patch row without config', () => {
  assert.equal(plugin.apply({}), undefined)
})
