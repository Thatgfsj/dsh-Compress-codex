/**
 * Dependency-free stand-in for @deepseek-ai/dsh-compaction-basic.
 *
 * Records every base-class call so a test can assert exactly what the engine's
 * override did and did not delegate to. Touches no host service, imports nothing.
 */

/**
 * @returns `{ FakeBase, calls }`; `calls` accumulates [method, ...args] rows.
 */
export function createFakeBase() {
  const calls = []
  class FakeBase {
    constructor(ctx, config = {}) {
      this.ctx = ctx
      this.config = config
    }

    async compactIfNeeded(agent, trigger) {
      calls.push(['compactIfNeeded', trigger])
      return { base: true, trigger }
    }

    compactNow(agent, signal, sourceCommandId) {
      calls.push(['compactNow', sourceCommandId])
      return { base: true, manual: true }
    }

    async summarize() {
      calls.push(['summarize'])
      return { summary: [{ type: 'text', text: 'base summary' }], provider: 'fake', model: 'fake' }
    }

    compactRegion(start, end) {
      calls.push(['compactRegion', start, end])
      return { region: [start, end] }
    }
  }
  return { FakeBase, calls }
}

/** A base whose ctx throws the moment a hook touches the token meter. */
export function createHostileCtx() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error('host service touched by the skeleton: ' + String(prop))
      }
    }
  )
}
