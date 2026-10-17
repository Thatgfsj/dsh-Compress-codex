import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)

/** Static and dynamic import specifiers found in one module. */
async function importsOf(relative) {
  const source = await readFile(new URL(relative, root), 'utf8')
  const staticFrom = [...source.matchAll(/^[ \t]*(?:import|export)[^'\n]*?from[ \t]+'([^']+)'/gm)]
  const sideEffect = [...source.matchAll(/^[ \t]*import[ \t]+'([^']+)'/gm)]
  return { specs: [...staticFrom, ...sideEffect].map((m) => m[1]), source }
}

test('the decision layer imports nothing from the host', async () => {
  const entries = await readdir(new URL('lib/core', root))
  assert.ok(entries.length > 0)
  for (const name of entries) {
    const { specs } = await importsOf('lib/core/' + name)
    for (const spec of specs) {
      assert.ok(!spec.startsWith('@deepseek-ai/'), 'lib/core/' + name + ' must not import ' + spec)
    }
  }
})

test('lib/engine.js takes the base class by injection, not by import', async () => {
  const { specs } = await importsOf('lib/engine.js')
  assert.ok(specs.length > 0)
  for (const spec of specs) {
    assert.ok(!spec.startsWith('@deepseek-ai/'), 'lib/engine.js must not import ' + spec)
  }
})

test('lib/index.js reaches the host only lazily, so the gate can import it with zero install', async () => {
  const { specs, source } = await importsOf('lib/index.js')
  for (const spec of specs) {
    assert.ok(spec.startsWith('./'), 'a static import in lib/index.js must stay first-party: ' + spec)
  }
  // A static host import here would break 'node --test' in the zero-install gate.
  assert.match(source, /await import\(/, 'the host package must be reached through a dynamic import')
})
