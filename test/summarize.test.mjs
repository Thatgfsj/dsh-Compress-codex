/**
 * #7 acceptance: the call replays the prefix, routes, forwards cancellation,
 * projects the reply (C5), and leaves recovery to the inherited region
 * transaction. Every test drives a fake \`ctx.llm\` and asserts on the exact option
 * bag handed to the adapter — where a wrong prefix, route, purpose or lost signal
 * would otherwise pass unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizePolicy } from '../lib/core/config.js'
import { SUMMARY_PREFIX, buildSummaryRequest } from '../lib/core/prompt.js'
import {
  NO_CONTENT_CODE,
  NO_ROUTE_CODE,
  StreamAssembler,
  SummarizationRouteError,
  TRUNCATED_CODE,
  UNPROJECTED_CODE,
  assertSummaryBlocks,
  buildSummarizationCall,
  finishFailure,
  resolveSummarizationMaxTokens,
  resolveSummarizationRoute,
  runSummarization,
  throwIfAborted
} from '../lib/core/summarize.js'
import { createCodexCompactionEngine } from '../lib/engine.js'
import { createFakeBase } from './support/fake-base.mjs'

const SYSTEM_HEAD = { role: 'system', content: [{ type: 'text', text: 'SYSTEM HEAD' }] }
const SHADOWED = [
  { role: 'user', content: [{ type: 'text', text: 'EARLIER USER TURN' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'EARLIER ASSISTANT TURN' }] }
]
const TOOL_SCHEMA = { name: 'read', description: 'read a file', parameters: { type: 'object' } }
const TOOL_HISTORY = { tools: [], updates: [] }

/** A fresh replay payload: system head first, then the shadowed region in order. */
const replayInput = () => ({ tools: [{ ...TOOL_SCHEMA }], messages: [SYSTEM_HEAD, ...SHADOWED] })

/** The #6 request built by the real template, so the two issues stay aligned. */
const requestFor = (input, policy = normalizePolicy({})) => buildSummaryRequest({ input, policy })

/** Agent carrying the routed request target the official backend reads. */
function createAgent({ provider = 'acme', model = 'chat', header, sessionId = 'session-1' } = {}) {
  return {
    options: { provider, model },
    session: { id: sessionId, requestHeader: () => header, toolHistory: () => TOOL_HISTORY }
  }
}

/** Fake \`ctx.llm\`: records the option bag and streams one scripted response. */
function createLlm(produce) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return produce(options)
    }
  }
}

/** Run the real pipeline over the shared replay payload with scripted chunks. */
function runChunks(chunks, over = {}) {
  const input = replayInput()
  return runSummarization({
    input,
    request: requestFor(input),
    agent: createAgent(),
    config: {},
    llm: createLlm(() => chunks),
    ...over
  })
}

const textChunks = (text, index = 0) => [
  { type: 'block-start', index, blockType: 'text' },
  { type: 'text-delta', index, text },
  { type: 'block-end', index, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } }
]

const dirtyChunks = () => [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'SECRET-REASONING' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'SECRET-REASONING' } },
  { type: 'text-delta', index: 1, text: 'Progress: wired.' },
  { type: 'block-end', index: 1, block: { type: 'text', text: 'Progress: wired.' } },
  { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'exec', argumentsDelta: '{"cmd":"boom"}' },
  { type: 'text-delta', index: 3, text: 'Next: verify.' },
  { type: 'block-end', index: 3, block: { type: 'text', text: 'Next: verify.' } },
  { type: 'usage', usage: { inputTokens: 42, outputTokens: 7 } },
  { type: 'finish', reason: { kind: 'stop' } }
]

async function capture(promise) {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

test('the call replays the prefix and appends the #6 prompt as the last user message', async () => {
  const input = replayInput()
  const request = requestFor(input)
  const llm = createLlm(() => textChunks('summary body'))
  const signal = new AbortController().signal
  const result = await runSummarization({
    input,
    request,
    agent: createAgent({ header: { config: { provider: 'routed', model: 'durable' } } }),
    llm,
    signal,
    config: { summarizationProvider: 'sum', summarizationModel: 'small', maxTokens: 1234 }
  })

  assert.equal(llm.calls.length, 1, 'exactly one auxiliary call')
  const options = llm.calls[0]
  assert.equal(options.provider, 'sum', 'the configured pair wins')
  assert.equal(options.model, 'small')
  assert.equal(options.purpose, 'compaction')
  assert.equal(options.maxTokens, 1234)
  assert.equal(options.sessionId, 'session-1')
  assert.equal(options.signal, signal, 'cancellation is forwarded by identity')
  assert.equal(options.toolHistory, TOOL_HISTORY)
  assert.deepEqual(options.tools, [TOOL_SCHEMA])

  assert.equal(options.messages[0], SYSTEM_HEAD, 'the system head stays first')
  assert.deepEqual(options.messages.slice(0, input.messages.length), input.messages, 'the shadowed region is replayed in order')
  assert.equal(options.messages.length, input.messages.length + 1)
  assert.deepEqual(options.messages.at(-1), { role: 'user', content: [{ type: 'text', text: request.prompt }] })
  assert.match(request.prompt, /^You are performing a CONTEXT CHECKPOINT COMPACTION\./)

  assert.deepEqual(result.summary, [{ type: 'text', text: SUMMARY_PREFIX + '\nsummary body' }])
  assert.deepEqual(result.rawOutput, [{ type: 'text', text: 'summary body' }])
  assert.equal(result.provider, 'sum')
  assert.equal(result.model, 'small')
  assert.equal(result.maxTokens, 1234)
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 })
  assert.equal(result.llmStreamCall, true, 'the SummaryResult discriminator the event layer reads')
  assert.deepEqual(Object.keys(result).sort(), ['llmStreamCall', 'maxTokens', 'model', 'provider', 'rawOutput', 'summary', 'usage'])

  const deltaOnly = await runChunks([{ type: 'text-delta', index: 0, text: 'deltas' }, { type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(deltaOnly.summary[0].text, SUMMARY_PREFIX + '\ndeltas', 'a delta-only stream still assembles')
})

test('C5: a dirty reply is projected before it becomes the summary, rawOutput stays raw', async () => {
  const result = await runChunks(dirtyChunks())
  assert.deepEqual(result.summary, [{ type: 'text', text: SUMMARY_PREFIX + '\nProgress: wired.\nNext: verify.' }])
  for (const leaked of ['SECRET-REASONING', 'call-1', 'boom']) {
    assert.ok(!result.summary[0].text.includes(leaked), 'leaked into the checkpoint: ' + leaked)
  }
  assert.ok(result.rawOutput.some((block) => block.type === 'reasoning'), 'rawOutput keeps the raw reply for replay')
  assert.ok(result.rawOutput.some((block) => block.type === 'tool-call'))
  assert.equal(result.llmStreamCall, true)
})

test('an empty reply fails closed with NO_SUMMARY_CONTENT and writes no shell', async () => {
  for (const chunks of [
    [],
    [{ type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'reasoning-delta', index: 0, text: 'thinking' }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'text-delta', index: 0, text: '   ' }, { type: 'finish', reason: { kind: 'stop' } }]
  ]) {
    const error = await capture(runChunks(chunks))
    assert.ok(error, 'expected a failure for ' + JSON.stringify(chunks))
    assert.equal(error.code, NO_CONTENT_CODE)
    assert.match(error.message, /no text summary content/)
  }
})

test('a projection that breaks C5 is refused, never persisted', async () => {
  const input = replayInput()
  const base = requestFor(input)
  const scenarios = [
    { projection: undefined, code: UNPROJECTED_CODE },
    { projection: () => [{ type: 'tool-call', id: 'call-1', name: 'exec', arguments: '{}' }], code: UNPROJECTED_CODE },
    { projection: () => [{ type: 'text', text: '   ' }], code: UNPROJECTED_CODE },
    { projection: () => [], code: NO_CONTENT_CODE },
    { projection: () => null, code: NO_CONTENT_CODE }
  ]
  for (const scenario of scenarios) {
    const error = await capture(
      runSummarization({ input, request: { prompt: base.prompt, projection: scenario.projection }, agent: createAgent(), llm: createLlm(() => textChunks('x')), config: {} })
    )
    assert.ok(error, 'expected a failure for projection ' + String(scenario.projection))
    assert.equal(error.code, scenario.code, error.message)
  }
})

test('the route resolves configured -> latest routed request -> AgentOptions', async () => {
  const input = replayInput()
  const request = requestFor(input)
  const llm = createLlm(() => textChunks('x'))
  const header = { config: { provider: 'routed', model: 'durable' } }

  await runSummarization({ input, request, agent: createAgent({ header }), llm, config: { summarizationProvider: 'sum', summarizationModel: 'small' } })
  await runSummarization({ input, request, agent: createAgent({ header }), llm, config: {} })
  await runSummarization({ input, request, agent: createAgent({}), llm, config: {} })

  assert.deepEqual(llm.calls.map((options) => [options.provider, options.model]), [
    ['sum', 'small'],
    ['routed', 'durable'],
    ['acme', 'chat']
  ])
  assert.throws(() => resolveSummarizationRoute({ config: {}, agent: createAgent({ provider: '', model: '' }) }), SummarizationRouteError)
})

test('no route anywhere is an actionable failure, not a silent skip', async () => {
  for (const agent of [
    createAgent({ provider: '', model: '' }),
    createAgent({ provider: 'acme', model: '' }),
    createAgent({ provider: '', model: 'chat', header: { config: { provider: '', model: '' } } })
  ]) {
    const llm = createLlm(() => textChunks('x'))
    const error = await capture(runSummarization({ input: replayInput(), request: requestFor(replayInput()), agent, llm, config: {} }))
    assert.ok(error instanceof SummarizationRouteError, error?.message)
    assert.equal(error.code, NO_ROUTE_CODE)
    for (const token of ['summarizationProvider', 'summarizationModel', 'route one request', 'AgentOptions']) {
      assert.match(error.message, new RegExp(token), 'missing recovery path: ' + token)
    }
    assert.equal(llm.calls.length, 0, 'an unresolvable route must not reach the model')
  }
})

test('maxTokens comes from the resolved config and is omitted when unusable', async () => {
  assert.equal(resolveSummarizationMaxTokens({ config: { maxTokens: 512 } }), 512)
  for (const config of [{}, { maxTokens: 0 }, { maxTokens: -1 }, { maxTokens: 1.5 }, undefined]) {
    assert.equal(resolveSummarizationMaxTokens({ config }), undefined, JSON.stringify(config))
  }

  const input = replayInput()
  const llm = createLlm(() => textChunks('x'))
  const result = await runSummarization({ input, request: requestFor(input), agent: createAgent(), llm, config: {} })
  assert.ok(!('maxTokens' in llm.calls[0]), 'an absent cap must not be sent as undefined')
  assert.ok(!('maxTokens' in result))
})

test('error, aborted and truncated finishes are fail-closed', async () => {
  const failed = await capture(runChunks([{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'E_PROVIDER' } } }]))
  assert.equal(failed.message, 'provider exploded')
  assert.equal(failed.code, 'E_PROVIDER')

  const aborted = await capture(runChunks([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'adapter aborted', code: 'ABORT_ERR' } } }]))
  assert.equal(aborted.message, 'adapter aborted')
  assert.equal(aborted.code, 'ABORT_ERR')

  const truncated = await capture(runChunks([{ type: 'text-delta', index: 0, text: 'partial checkpoint' }, { type: 'finish', reason: { kind: 'max-tokens' } }]))
  assert.equal(truncated.code, TRUNCATED_CODE)

  const truncatedAssembler = new StreamAssembler()
  for (const chunk of [
    { type: 'text-delta', index: 0, text: 'body' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'exec', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'max-tokens' } }
  ]) {
    truncatedAssembler.push(chunk)
  }
  assert.deepEqual(truncatedAssembler.blocks(), [{ type: 'text', text: 'body' }], 'a truncated reply drops tool calls, like the official assembler')

  const tolerant = new StreamAssembler()
  tolerant.push({ type: 'future-chunk-kind', index: 0 })
  tolerant.push({ type: 'text-delta', index: 0, text: 'ok' })
  assert.deepEqual(tolerant.blocks(), [{ type: 'text', text: 'ok' }], 'unknown chunk types are ignored, not fatal')

  assert.equal(finishFailure({ kind: 'stop' }), undefined)
  assert.equal(finishFailure({ kind: 'tool-calls' }), undefined)
  assert.equal(finishFailure(undefined), undefined)
})

test('cancellation is forwarded and the exact abort reason survives', async () => {
  const input = replayInput()
  const request = requestFor(input)

  const preAborted = new AbortController()
  const preReason = new Error('caller cancelled the turn')
  preAborted.abort(preReason)
  const idle = createLlm(() => textChunks('x'))
  assert.equal(await capture(runSummarization({ input, request, agent: createAgent(), llm: idle, signal: preAborted.signal, config: {} })), preReason, 'the caller catches its own abort reason')
  assert.equal(idle.calls.length, 0, 'an aborted call must not reach the model')

  const midStream = new AbortController()
  const midReason = { code: 'CANCELLED_BY_TEST' }
  const streaming = createLlm(() =>
    (async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      midStream.abort(midReason)
      throw new Error('adapter observed the abort')
    })()
  )
  assert.equal(await capture(runSummarization({ input, request, agent: createAgent(), llm: streaming, signal: midStream.signal, config: {} })), midReason, 'a torn-down stream must not replace the caller reason')
  assert.equal(streaming.calls[0].signal, midStream.signal)

  const normalized = new AbortController()
  const normalizedReason = new Error('aborted between chunks')
  const finishing = createLlm(() =>
    (async function* () {
      normalized.abort(normalizedReason)
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'x', code: 'ABORT_ERR' } } }
    })()
  )
  assert.equal(await capture(runSummarization({ input, request, agent: createAgent(), llm: finishing, signal: normalized.signal, config: {} })), normalizedReason, 'an adapter-normalized abort still yields the signal reason')

  const transport = new Error('transport reset')
  const failing = createLlm(() => {
    throw transport
  })
  assert.equal(await capture(runSummarization({ input, request, agent: createAgent(), llm: failing, config: {} })), transport, 'a non-abort failure is not rewritten')

  assert.throws(() => throwIfAborted(preAborted.signal), (error) => error === preReason)
  assert.doesNotThrow(() => throwIfAborted(undefined))
})

// ── engine wiring ──────────────────────────────────────────────────────────

/** Mount our engine over the shared fake base with a fake ctx.llm. */
function mountEngine({ llm, config = {}, hooks, agent = createAgent() } = {}) {
  const { FakeBase, calls } = createFakeBase()
  const Engine = createCodexCompactionEngine(FakeBase, hooks)
  const ctx = { llm, tokenMeter: { measure: () => ({ totalTokens: 0 }) }, logger: { info() {}, warn() {}, error() {} } }
  return { engine: new Engine(ctx, config), calls, ctx, agent }
}

test('engine.summarize runs the real pipeline instead of the skeleton refusal', async () => {
  const input = replayInput()
  const llm = createLlm(() => textChunks('engine summary'))
  const { engine, calls, agent } = mountEngine({ llm, config: { summarizationProvider: 'sum', summarizationModel: 'small', maxTokens: 99 } })

  const result = await engine.summarize(input, agent, undefined)
  assert.deepEqual(calls, [], 'the custom path must not fall back to the base summarizer')
  assert.deepEqual(result.summary, [{ type: 'text', text: SUMMARY_PREFIX + '\nengine summary' }])
  assert.equal(result.llmStreamCall, true)
  assert.equal(llm.calls[0].maxTokens, 99)
  assert.deepEqual(llm.calls[0].messages.at(-1).content, [{ type: 'text', text: buildSummaryRequest({ input, policy: normalizePolicy({}) }).prompt }])
})

test('engine.summarize still delegates when the template answers null', async () => {
  const { engine, calls, agent } = mountEngine({
    llm: createLlm(() => textChunks('unused')),
    hooks: { decideCompaction: () => ({ action: 'skip', reason: 'test' }), selectCompactionRange: () => null, buildSummaryRequest: () => null }
  })
  const result = await engine.summarize({ messages: [] }, agent)
  assert.equal(result.provider, 'fake')
  assert.deepEqual(calls, [['summarize']])
})

test('engine.summarize refuses a request whose projection is missing (C5)', async () => {
  const building = mountEngine({
    llm: createLlm(() => textChunks('unused')),
    hooks: { decideCompaction: () => ({ action: 'skip', reason: 'test' }), selectCompactionRange: () => null, buildSummaryRequest: () => ({ prompt: 'codex' }) }
  })
  await assert.rejects(() => building.engine.summarize({ messages: [] }, building.agent), /without a projection/)
  assert.equal(building.ctx.llm.calls.length, 0, 'a refused request must not reach the model')
})

test('runSummarization requires the injected llm service and a projection', async () => {
  const input = replayInput()
  const noLlm = await capture(runSummarization({ input, request: requestFor(input), agent: createAgent(), config: {} }))
  assert.ok(noLlm instanceof TypeError)
  assert.match(noLlm.message, /ctx\.llm\.stream/)

  const noProjection = await capture(runSummarization({ input, request: { prompt: 'x' }, agent: createAgent(), llm: createLlm(() => []), config: {} }))
  assert.equal(noProjection.code, UNPROJECTED_CODE)
  assert.match(noProjection.message, /request\.projection/)

  assert.throws(() => buildSummarizationCall({ input, prompt: '  ', agent: createAgent(), route: { provider: 'p', model: 'm' } }), TypeError)
  assert.throws(() => buildSummarizationCall({ input: { messages: 'nope' }, prompt: 'x', agent: createAgent(), route: { provider: 'p', model: 'm' } }), TypeError)
  assert.throws(() => assertSummaryBlocks('not blocks'), (error) => error.code === NO_CONTENT_CODE)
})

/**
 * Model of the inherited failure loop (basic summarizeCompaction L582-L595): a
 * summarization failure goes to regionDependencies().recover() — the engine's
 * compaction/summary-error waterfall — and the loop retries only on a true answer.
 */
function createLoopBase(recover) {
  const seen = { recover: [] }
  class LoopBase {
    constructor(ctx, config = {}) {
      this.ctx = ctx
      this.config = config
    }

    regionDependencies() {
      return {
        summarize: (input, agent, signal) => this.summarize(input, agent, signal),
        recover: (error, agent, sourceEventSeqs, signal) => {
          seen.recover.push({ error, sourceEventSeqs, signal })
          return recover(error, agent, sourceEventSeqs, signal)
        }
      }
    }

    async compactRegion(start, end, agent, signal) {
      for (;;) {
        try {
          const result = await this.regionDependencies().summarize({ tools: [], messages: [] }, agent, signal)
          return { ...result, region: [start, end] }
        } catch (error) {
          if (signal?.aborted === true) throw error
          if (!this.regionDependencies().recover(error, agent, [start, end], signal)) throw error
        }
      }
    }
  }
  return { LoopBase, seen }
}

test('LOCK: the compaction/summary-error waterfall can retry, and a false answer propagates', async () => {
  let attempt = 0
  const transient = new Error('transient provider failure')
  const retrying = createLlm(() => {
    attempt += 1
    if (attempt === 1) throw transient
    return textChunks('recovered summary')
  })
  const { LoopBase, seen } = createLoopBase(() => true)
  const Engine = createCodexCompactionEngine(LoopBase)
  const engine = new Engine(
    { llm: retrying, logger: { info() {}, warn() {}, error() {} } },
    { summarizationProvider: 'sum', summarizationModel: 'small' }
  )

  const recovered = await engine.compactRegion(1, 2, createAgent(), undefined)
  assert.equal(retrying.calls.length, 2, 'a recovered failure retries the summarization call')
  assert.equal(seen.recover.length, 1)
  assert.equal(seen.recover[0].error, transient, 'the waterfall receives the original error')
  assert.deepEqual(seen.recover[0].sourceEventSeqs, [1, 2])
  assert.deepEqual(recovered.summary, [{ type: 'text', text: SUMMARY_PREFIX + '\nrecovered summary' }])

  const fatal = new Error('provider is down')
  const failing = createLlm(() => {
    throw fatal
  })
  const { LoopBase: RefusingBase, seen: refusing } = createLoopBase(() => false)
  const RefusingEngine = createCodexCompactionEngine(RefusingBase)
  const refusingEngine = new RefusingEngine(
    { llm: failing, logger: { info() {}, warn() {}, error() {} } },
    { summarizationProvider: 'sum', summarizationModel: 'small' }
  )
  const error = await capture(refusingEngine.compactRegion(1, 2, createAgent(), undefined))
  assert.equal(error, fatal, 'a waterfall that answers false must not be swallowed')
  assert.equal(failing.calls.length, 1, 'no retry without a handler saying yes')
  assert.equal(refusing.recover.length, 1)
})
