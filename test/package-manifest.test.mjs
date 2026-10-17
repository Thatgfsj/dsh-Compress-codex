import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('..', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

/** Names of the shared-host packages declared in one dependency block. */
const sharedHostPackages = (block) =>
  Object.keys(block ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))

test('red line: @deepseek-ai/* never lands in dependencies', () => {
  assert.deepEqual(
    sharedHostPackages(manifest.dependencies),
    [],
    'shared host packages must not be bundled: the profile hoists them, a declared dependency shadows that',
  )
})

test('red line: every @deepseek-ai/* peer is also a devDependency', () => {
  const peers = sharedHostPackages(manifest.peerDependencies)
  assert.ok(peers.length > 0, 'at least @deepseek-ai/cordis must be a peer')
  for (const name of peers) {
    assert.ok(
      Object.hasOwn(manifest.devDependencies ?? {}, name),
      `${name} is a peerDependency but not a devDependency`,
    )
  }
})

test('dsh.bundle.patch points at a patch layer that exists', async () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  await access(new URL('cordis.patch.yml', root))
})

test('exports keep the entry, ./package.json and ./locale/*.json reachable', () => {
  const exported = manifest.exports
  assert.ok(exported && typeof exported === 'object', 'an exports map is required')
  for (const key of ['.', './package.json', './locale/*.json']) {
    assert.ok(Object.hasOwn(exported, key), `exports is missing "${key}"`)
  }
})

test('npm name is lowercase and the test script is the one CI runs', () => {
  assert.equal(manifest.name, 'dsh-compress-codex')
  assert.equal(manifest.name, manifest.name.toLowerCase())
  assert.equal(manifest.scripts?.test, 'node --test "test/**/*.test.mjs"')
})

test('the bundle manifest declares an entry point and a node engine', () => {
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(typeof manifest.engines?.node, 'string')
})

test('the patch layer mounts this package, uncommented, as an insert', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  const active = patch
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  assert.match(active, /^- insert:/m, 'the layer must carry an active insert op')
  assert.match(active, /id: compaction-codex/)
  assert.match(active, new RegExp(`name: '${manifest.name}'`))
})
