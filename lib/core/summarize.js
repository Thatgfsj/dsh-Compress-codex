/**
 * D4 — the summarization call (#7, docs/PLAN.md §1.3, docs/design-m1-m2.md §2.3).
 *
 * #6 owns what the summarizer is asked for and how its reply is projected; this
 * module owns the call: replay the prefix (C4 — the instruction rides after the
 * system head, tools and shadowed region, so the provider KV cache is reused),
 * append it as the final user message, stream one response, and return a
 * SummaryResult whose `summary` is projected text (C5).
 *
 * Nothing here retries: the inherited region transaction already calls
 * `regionDependencies().recover()` -> `ctx.waterfall('compaction/summary-error')`
 * and re-derives the region when a handler answers true (basic summarizeCompaction
 * L582-L595); a second loop here would call that waterfall twice per failure.
 *
 * Zero dependencies on purpose (see config.js): the llm client is injected.
 */

/** No usable provider/model route; #10 grades on this code. */
export const NO_ROUTE_CODE = 'NO_SUMMARIZATION_ROUTE'

/** The projection produced no usable text (C5 fail-closed); #10 grades on this code. */
export const NO_CONTENT_CODE = 'NO_SUMMARY_CONTENT'

/** The adapter hit the token cap before finishing the checkpoint. */
export const TRUNCATED_CODE = 'MAX_TOKENS'

/** A request whose projection cannot be trusted is refused by code, not silently emitted. */
export const UNPROJECTED_CODE = 'UNPROJECTED_SUMMARY'

/** Read one field of a possibly-absent, possibly-hostile object. */
function field(source, key) {
  return source === null || source === undefined || typeof source !== 'object' ? undefined : source[key]
}

/** A usable provider/model pair, or undefined when either half is missing. */
function routePair(provider, model) {
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/** The `config` of the latest durably routed request, when the session exposes one. */
function latestRoutedConfig(agent) {
  const session = field(agent, 'session')
  if (typeof field(session, 'requestHeader') !== 'function') return undefined
  return field(session.requestHeader(), 'config')
}

/** Raised when no route can be resolved; the message names every recovery path. */
export class SummarizationRouteError extends Error {
  /** @param message - actionable detail naming the three ways to configure a route. */
  constructor(message) {
    super(message)
    this.name = 'SummarizationRouteError'
    this.code = NO_ROUTE_CODE
  }
}

/**
 * Resolve the provider/model the auxiliary call uses: the configured pair, then
 * the latest durably routed request, then AgentOptions (mirrors the official
 * summarizeWithLlm, basic/lib/index.js L292-L303). `config` is the resolved
 * backend config — the target lives on the official surface, not on the policy.
 *
 * TODO(#3, infra/task-8): per-target `modelPolicies` overrides
 * (`resolveTargetPolicy`) belong to #3's schema; #7 deliberately does not parse
 * that table a second time. #3 threads the resolved target through here.
 *
 * @param inputs - `{ config, agent }`.
 * @returns `{ provider, model }`.
 * @throws {SummarizationRouteError} when no level has a usable pair.
 */
export function resolveSummarizationRoute(inputs) {
  const config = field(inputs, 'config')
  const agent = field(inputs, 'agent')
  const configured = routePair(
    field(config, 'summarizationProvider'),
    field(config, 'summarizationModel')
  )
  const latest = latestRoutedConfig(agent)
  const routed = routePair(field(latest, 'provider'), field(latest, 'model'))
  const options = field(agent, 'options')
  const fromOptions = routePair(field(options, 'provider'), field(options, 'model'))
  const route = configured ?? routed ?? fromOptions
  if (route === undefined) {
    throw new SummarizationRouteError(
      'dsh-compress-codex: no provider/model available for summarization; configure both ' +
        'summarizationProvider and summarizationModel, route one request first, or set both ' +
        'AgentOptions provider and model'
    )
  }
  return route
}

/**
 * Resolve the output cap for the auxiliary call.
 *
 * TODO(#3, infra/task-8): an exact-target `modelPolicies` entry can also cap
 * maxTokens in the official backend; see resolveSummarizationRoute.
 *
 * @param inputs - `{ config }`; extra fields are ignored.
 * @returns a positive integer, or undefined when the config declares none.
 */
export function resolveSummarizationMaxTokens(inputs) {
  const value = field(field(inputs, 'config'), 'maxTokens')
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Build the one-shot request exactly as the official backend does, except that the
 * final user message carries our #6 instruction.
 *
 * @param inputs - `{ input, prompt, agent, route, maxTokens, signal }`.
 * @returns GenerateOptions for `ctx.llm.stream()`.
 * @throws {TypeError} when the prompt or the replayed message list is unusable.
 */
export function buildSummarizationCall(inputs) {
  const input = field(inputs, 'input')
  const prompt = field(inputs, 'prompt')
  const messages = field(input, 'messages')
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new TypeError('dsh-compress-codex: the summarization prompt must be a non-empty string')
  }
  if (!Array.isArray(messages)) {
    throw new TypeError('dsh-compress-codex: SummarizationInput.messages must be an array')
  }
  const route = field(inputs, 'route')
  const agent = field(inputs, 'agent')
  const session = field(agent, 'session')
  const tools = field(input, 'tools')
  const maxTokens = field(inputs, 'maxTokens')
  const signal = field(inputs, 'signal')
  const toolHistory = typeof field(session, 'toolHistory') === 'function' ? session.toolHistory() : undefined
  const sessionId = field(session, 'id')
  return {
    provider: field(route, 'provider'),
    model: field(route, 'model'),
    messages: [
      ...messages,
      Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: prompt })]) })
    ],
    ...(toolHistory === undefined ? {} : { toolHistory }),
    ...(tools === undefined ? {} : { tools: [...tools] }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(sessionId === undefined ? {} : { sessionId }),
    purpose: 'compaction',
    ...(signal === undefined || signal === null ? {} : { signal })
  }
}

/**
 * Minimal reassembly of `ctx.llm.stream()`'s chunk protocol (dsh-llm
 * lib/types/assembler.js), kept first-party so lib/core stays host-free.
 *
 * Tolerant by design: the chunk union is merge-extensible (unknown types are
 * ignored), and an open text/reasoning block assembles from its deltas.
 */
export class StreamAssembler {
  #partials = new Map()
  #order = []
  #usage
  #finish

  /** Feed one raw chunk in stream order. */
  push(chunk) {
    if (chunk === null || typeof chunk !== 'object') return
    switch (chunk.type) {
      case 'block-start': {
        this.#ensure(chunk.index, chunk.blockType)
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.#ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block === undefined && typeof chunk.text === 'string') partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.#ensure(chunk.index, 'tool-call')
        if (partial.block !== undefined) return
        if (chunk.id !== undefined) partial.toolCallId = chunk.id
        if (chunk.name !== undefined) partial.toolCallName = chunk.name
        if (typeof chunk.argumentsDelta === 'string') partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.#ensure(chunk.index, field(chunk.block, 'type'))
        if (partial.block === undefined) partial.block = chunk.block
        return
      }
      case 'usage': {
        this.#usage = chunk.usage
        return
      }
      case 'finish': {
        this.#finish = chunk.reason
        return
      }
      default:
        return
    }
  }

  /** Usage from the terminal `usage` chunk, if the adapter sent one. */
  get usage() {
    return this.#usage
  }

  /** Finish reason; `{ kind: 'stop' }` when the stream ended without one. */
  get finish() {
    return this.#finish === undefined || this.#finish === null ? { kind: 'stop' } : this.#finish
  }

  /**
   * Assemble every seen block in stream order, mirroring the official keep/drop
   * rule: a truncated response drops tool calls that were never dispatched.
   */
  blocks() {
    const blocks = this.#order.map((index) => this.#assemble(this.#partials.get(index), index))
    return this.finish.kind === 'max-tokens' ? blocks.filter((block) => block.type !== 'tool-call') : blocks
  }

  #ensure(index, blockType) {
    let partial = this.#partials.get(index)
    if (partial === undefined) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.#partials.set(index, partial)
      this.#order.push(index)
    }
    return partial
  }

  #assemble(partial, index) {
    if (partial.block !== undefined) return partial.block
    switch (partial.blockType) {
      case 'text':
        return { type: 'text', text: partial.text }
      case 'reasoning':
        return { type: 'reasoning', text: partial.text }
      case 'tool-call':
        return {
          type: 'tool-call',
          id: partial.toolCallId ?? 'call-' + String(index),
          name: partial.toolCallName ?? '',
          arguments: partial.toolCallArguments
        }
      default:
        throw new Error(
          'dsh-compress-codex: cannot assemble an unterminated ' + String(partial.blockType) + ' block'
        )
    }
  }
}

/**
 * Map a terminal finish to its fail-closed error (mirrors the official mapping).
 * @param finish - the assembled FinishReason.
 * @returns an Error to throw, or undefined when the response is usable.
 */
export function finishFailure(finish) {
  const kind = field(finish, 'kind')
  if (kind === 'error' || kind === 'aborted') {
    const failure = field(finish, 'failure')
    const error = new Error(field(failure, 'message') ?? 'dsh-compress-codex: summarization failed')
    const code = field(failure, 'code')
    if (code !== undefined) error.code = code
    if (failure !== undefined) error.failure = failure
    return error
  }
  if (kind === 'max-tokens') {
    const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
    error.code = TRUNCATED_CODE
    return error
  }
  return undefined
}

/** The exact abort reason, or a synthesized one when the signal carries none. */
function abortReason(signal) {
  const reason = field(signal, 'reason')
  return reason === undefined ? new Error('dsh-compress-codex: summarization was aborted') : reason
}

/** True when the signal is already aborted. */
export function isAborted(signal) {
  return signal !== null && signal !== undefined && signal.aborted === true
}

/**
 * Throw the signal's exact reason when it is already aborted. Identity matters: a
 * caller that aborted with a specific error must catch that same object back.
 */
export function throwIfAborted(signal) {
  if (isAborted(signal)) throw abortReason(signal)
}

/**
 * Enforce the C5 output contract on whatever the projection returned. Two distinct
 * failures, because #10 grades them differently: an empty reply is a *content*
 * failure, while a structurally wrong reply means the projection broke C5 itself.
 *
 * @param summary - the projection's return value.
 * @returns the same array when every block is non-empty text.
 * @throws {Error} `NO_SUMMARY_CONTENT` for an empty reply, `UNPROJECTED_SUMMARY` otherwise.
 */
export function assertSummaryBlocks(summary) {
  const fail = (message, code) => {
    const error = new Error(message)
    error.code = code
    return error
  }
  if (summary === undefined || summary === null || !Array.isArray(summary) || summary.length === 0) {
    throw fail(
      'dsh-compress-codex: summarization produced no text summary content; refusing to write an ' +
        'empty checkpoint',
      NO_CONTENT_CODE
    )
  }
  for (const block of summary) {
    if (field(block, 'type') !== 'text') {
      throw fail('dsh-compress-codex: the summary projection must return text blocks only (C5)', UNPROJECTED_CODE)
    }
    const text = field(block, 'text')
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw fail('dsh-compress-codex: the summary projection must not return empty text blocks (C5)', UNPROJECTED_CODE)
    }
  }
  return summary
}

/**
 * Run one summarization call and return the SummaryResult contract.
 *
 * `summary` is projected text only (C5); `rawOutput` keeps the assembled raw
 * blocks because `compaction/summary` records them for replay. A missing or empty
 * projection throws, so the transaction's recover waterfall decides whether the
 * failure is fatal and no empty checkpoint is ever written.
 *
 * @param inputs - `{ input, request, agent, llm, config, signal }`; `request` is
 *   the #6 request, `llm` the injected `ctx.llm` (only `stream()` is used), and
 *   `signal` the cancellation forwarded verbatim to the adapter.
 * @returns `{ summary, provider, model, maxTokens?, usage?, rawOutput, llmStreamCall: true }`.
 * @throws {SummarizationRouteError} when no route can be resolved; {TypeError} on a
 *   missing projection or llm; other errors for a failed or truncated finish.
 */
export async function runSummarization(inputs) {
  const request = field(inputs, 'request')
  const projection = field(request, 'projection')
  if (typeof projection !== 'function') {
    const error = new TypeError('dsh-compress-codex: runSummarization requires request.projection')
    error.code = UNPROJECTED_CODE
    throw error
  }
  const llm = field(inputs, 'llm')
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
    throw new TypeError('dsh-compress-codex: summarization requires the host llm service (ctx.llm.stream)')
  }
  const signal = field(inputs, 'signal')
  throwIfAborted(signal)

  const config = field(inputs, 'config')
  const agent = field(inputs, 'agent')
  const route = resolveSummarizationRoute({ config, agent })
  const maxTokens = resolveSummarizationMaxTokens({ config })
  const options = buildSummarizationCall({
    input: field(inputs, 'input'),
    prompt: field(request, 'prompt'),
    agent,
    route,
    maxTokens,
    signal
  })

  const assembler = new StreamAssembler()
  try {
    for await (const chunk of llm.stream(options)) assembler.push(chunk)
  } catch (error) {
    // A stream torn down by cancellation must not replace the caller's reason.
    if (isAborted(signal)) throw abortReason(signal)
    throw error
  }
  throwIfAborted(signal)
  const failure = finishFailure(assembler.finish)
  if (failure !== undefined) throw failure

  const rawOutput = assembler.blocks()
  const summary = assertSummaryBlocks(projection(rawOutput))
  return {
    summary,
    provider: route.provider,
    model: route.model,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    rawOutput,
    llmStreamCall: true
  }
}
