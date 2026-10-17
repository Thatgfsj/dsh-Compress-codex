/**
 * Dependency-free stand-ins for the host objects the engine touches.
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

/**
 * Cordis-Context stand-in carrying the only two services the engine reads.
 * @returns ctx whose `calls` records resolveModelInfo / measure usage.
 */
export function createFakeCtx({ windowTokens = 100000, measurement = { totalTokens: 0, surfaceTokens: 0 }, failResolve = false } = {}) {
  const calls = { resolveModelInfo: [], measure: 0 }
  return {
    calls,
    llm: {
      async resolveModelInfo(provider, model) {
        calls.resolveModelInfo.push([provider, model])
        if (failResolve) throw new Error('no route for ' + provider + '/' + model)
        return { context: { contextWindow: windowTokens } }
      }
    },
    tokenMeter: {
      measure() {
        calls.measure += 1
        return measurement
      }
    },
    logger: { info() {}, warn() {}, error() {} }
  }
}

/** Minimal agent: routed target from options, no request header by default. */
export function createFakeAgent({ provider = 'acme', model = 'big', header } = {}) {
  return {
    session: { requestHeader: () => header },
    options: { provider, model }
  }
}

/** A ctx that throws the moment any property is read. */
export function createHostileCtx() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error('host service touched: ' + String(prop))
      }
    }
  )
}
