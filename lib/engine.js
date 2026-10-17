/**
 * CodexCompactionEngine — the strategy layer of docs/design-m1-m2.md §2 (plan B:
 * subclass the official engine, replace only the decision layer, reuse the
 * transaction mechanics).
 *
 * Dependency injection instead of import: the base class is handed in by
 * lib/index.js, which is the only module allowed to name a '@deepseek-ai/*'
 * specifier. That is what lets the gate pipeline (node --test, no install step)
 * import this file, and it is what makes the D1-D4 seam testable against a fake
 * base and fake hooks.
 *
 * Two things this class must get right beyond the policy itself:
 *
 *  1. capacity. W (the routed adapter's context window) is only reachable through
 *     an async llm call, so the engine resolves it and injects it into the
 *     decision hooks as { windowTokens } | null. The decision layer stays pure
 *     and synchronous.
 *  2. self-healing. While #5's range selector is still a skeleton, the
 *     context-overflow path must fall back to the official engine instead of
 *     being swallowed as "nothing to compact".
 */

import { normalizePolicy } from './core/config.js'
import { POLICY_KEYS } from './core/keys.js'
import { decideCompaction } from './core/trigger.js'
import { selectCompactionRange } from './core/select.js'
import { SUMMARY_PREFIX, buildSummaryRequest } from './core/prompt.js'
import { runSummarization } from './core/summarize.js'
import {
  admitCompaction,
  assertAntiDrift,
  createCompactionLedger,
  isDuplicateCompaction,
  planChainedSummary,
  summaryFingerprint
} from './core/idempotence.js'
import { decideCompactionFailure, describeCompactionError } from './core/errors.js'

/** Decision hooks used when the caller does not inject its own. */
export const DEFAULT_HOOKS = Object.freeze({
  decideCompaction,
  selectCompactionRange,
  buildSummaryRequest
})

/**
 * Config keys the official resolveConfig() validates. Our own policy keys are
 * stripped before super() so a D1/D4 row does not trip the official validator;
 * the overlap-free split is asserted in test/engine.test.mjs.
 * Issue #3 replaces this shim with a real Config schema.
 */
export const BASE_CONFIG_KEYS = Object.freeze([
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'auto'
])

/** Actions a decision hook may return. */
export const DECISION_ACTIONS = Object.freeze(['delegate', 'skip', 'compact'])

/**
 * Every key a patch row may carry: our policy surface plus the keys the official
 * backend resolves for itself. The two are disjoint (asserted in the engine
 * tests), so forwarding one can never shadow the other.
 */
export const KNOWN_CONFIG_KEYS = Object.freeze([...POLICY_KEYS, ...BASE_CONFIG_KEYS])

/** Our slice of a row config, ready for normalizePolicy(). */
function policySlice(config) {
  const slice = {}
  for (const key of POLICY_KEYS) {
    if (config[key] !== undefined) slice[key] = config[key]
  }
  return slice
}

/**
 * Validate one patch row: reject anything neither surface understands, so a typo
 * fails at mount time instead of silently behaving like the default.
 *
 * @throws {TypeError} on a non-object config or an unknown key.
 * @returns the normalized policy for this row.
 */
export function validateRowConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('dsh-compress-codex: config must be an object')
  }
  const unknown = Object.keys(config).filter((key) => !KNOWN_CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new TypeError(
      'dsh-compress-codex: unknown config key(s) ' + unknown.join(', ') +
      '; known keys are ' + KNOWN_CONFIG_KEYS.join(', ')
    )
  }
  return normalizePolicy(policySlice(config))
}

const REFUSE = Object.freeze({
  manual:
    'dsh-compress-codex: manual range selection is owned by #5; refusing to fall back to ' +
    'compactRegion(), whose transaction is current-turn owned',
  summary:
    'dsh-compress-codex: buildSummaryRequest returned a request without a projection function; ' +
    'refusing to emit a summary the projection has not filtered (C5)'
})

/** Keep only the keys the official backend validates. */
export function toBaseConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return {}
  const forwarded = {}
  for (const key of BASE_CONFIG_KEYS) {
    if (config[key] !== undefined) forwarded[key] = config[key]
  }
  return forwarded
}

/** Read one hook, falling back to the default when the caller omitted it. */
function pickHook(hooks, key, fallback) {
  const value = hooks === undefined || hooks === null ? undefined : hooks[key]
  if (value === undefined) return fallback
  if (typeof value !== 'function') {
    throw new TypeError('dsh-compress-codex: hook ' + key + ' must be a function')
  }
  return value
}

/** Fail loud on a hook that does not honour the three-state contract. */
function readAction(decision, hookName) {
  const action = decision === null || typeof decision !== 'object' ? undefined : decision.action
  if (!DECISION_ACTIONS.includes(action)) {
    throw new TypeError(
      'dsh-compress-codex: ' + hookName + ' must return { action: ' +
      DECISION_ACTIONS.map((value) => "'" + value + "'").join(' | ') + ' }, got ' + String(action)
    )
  }
  return action
}

/** Concatenated model-visible text of one message event, or an empty string. */
function eventText(event) {
  const content = event === null || event === undefined || event.data === undefined ||
    event.data.message === undefined ? undefined : event.data.message.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text
}

/**
 * Default checkpoint predicate (#9).
 *
 * A structural check via the host's isCompactCheckpointSource is preferred and can
 * be injected as helpers.isCompactCheckpointSource; lib/index.js is the only layer
 * that may import it. Absent that injection we recognise our own checkpoints by
 * the projection prefix every replacement message is built with (prompt.js
 * SUMMARY_PREFIX). Either way both checks look at the same thing — "is this node a
 * checkpoint we produced" — and neither reads a service.
 */
function isOwnCheckpoint(event) {
  const text = eventText(event)
  return text.length > 0 && text.includes(SUMMARY_PREFIX)
}

/** Concatenated text of one SummaryResult's projected blocks. */
function summaryText(result) {
  const blocks = result === null || result === undefined || !Array.isArray(result.summary) ? [] : result.summary
  let text = ''
  for (const block of blocks) {
    if (block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text
}

/** Route provider/model the way the official backend does, from public state. */
function routedTarget(agent) {
  const header = agent === null || agent === undefined ? undefined : agent.session
  const config = header === null || header === undefined || typeof header.requestHeader !== 'function'
    ? undefined
    : header.requestHeader() === null || header.requestHeader() === undefined
      ? undefined
      : header.requestHeader().config
  if (config !== undefined && typeof config.provider === 'string' && config.provider.length > 0 &&
      typeof config.model === 'string' && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  const options = agent === null || agent === undefined ? undefined : agent.options
  if (options !== undefined && typeof options.provider === 'string' && options.provider.length > 0 &&
      typeof options.model === 'string' && options.model.length > 0) {
    return { provider: options.provider, model: options.model }
  }
  return undefined
}

/**
 * Build the engine class bound to one injected base.
 *
 * @param Base - the BasicCompactionEngine class (or a stand-in in tests).
 * @param hooks - optional overrides for the D1/D2-D3/D4 decision hooks.
 * @param helpers - host helpers lib/index.js resolved by dynamic import. Only
 *   `edgeChecks` is read: the authoritative tool-pairing cuts
 *   (toolPairingBalancedBefore / After) handed to the selector. This module must
 *   not import them itself — the zero-install gate imports it.
 * @returns a CompactionEngine subclass ready for `ctx.plugin()`.
 * @throws {TypeError} when Base is not a class/function, a hook is not callable,
 *   edgeChecks is malformed, or the row config names a policy key we do not know.
 */
export function createCodexCompactionEngine(Base, hooks = DEFAULT_HOOKS, helpers = {}) {
  if (typeof Base !== 'function') {
    throw new TypeError(
      'dsh-compress-codex: createCodexCompactionEngine(Base) requires the BasicCompactionEngine class'
    )
  }
  const decide = pickHook(hooks, 'decideCompaction', decideCompaction)
  const select = pickHook(hooks, 'selectCompactionRange', selectCompactionRange)
  const build = pickHook(hooks, 'buildSummaryRequest', buildSummaryRequest)
  // The one-shot summarization call is injectable so the anti-drift audit below is
  // exercisable without a provider.
  const runSummary = pickHook(helpers, 'runSummarization', runSummarization)
  const isCheckpoint = helpers === null || typeof helpers !== 'object' ||
    typeof helpers.isCompactCheckpointSource !== 'function'
    ? isOwnCheckpoint
    : helpers.isCompactCheckpointSource
  const edgeChecks = helpers === null || typeof helpers !== 'object' || helpers.edgeChecks === undefined
    ? null
    : helpers.edgeChecks
  if (edgeChecks !== null && (typeof edgeChecks.before !== 'function' || typeof edgeChecks.after !== 'function')) {
    throw new TypeError(
      'dsh-compress-codex: helpers.edgeChecks must provide before(session, seq) and after(session, seq)'
    )
  }

  return class CodexCompactionEngine extends Base {
    /** Raw row config, kept apart from the base's resolved config. */
    #rawConfig

    /** #9 idempotence ledger: one entry per range that already compacted. */
    #ledger = createCompactionLedger()

    constructor(ctx, config = {}) {
      const raw = config === null || typeof config !== 'object' || Array.isArray(config) ? {} : config
      // Fail at mount time, not on the first turn.
      validateRowConfig(raw)
      super(ctx, toBaseConfig(raw))
      this.#rawConfig = raw
    }

    /** Decision-layer view of the row config. */
    #policy() {
      return validateRowConfig(this.#rawConfig === undefined ? {} : this.#rawConfig)
    }

    /**
     * Lazy measurement thunk for the D1-D3 hooks.
     *
     * Nothing here touches ctx until the hook calls it, which keeps the decision
     * layer free of host services.
     */
    #measure(agent) {
      return () => this.ctx.tokenMeter.measure(agent.session)
    }

    /**
     * Resolve the routed adapter's context window, or null when it is unknown.
     * Resolution failures are swallowed on purpose: we delegate in that case, and
     * the official engine then raises its own (diagnostic) error.
     */
    async #resolveCapacity(agent, signal) {
      try {
        const target = routedTarget(agent)
        if (target === undefined) return null
        const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
        const windowTokens = info === null || info === undefined || info.context === undefined
          ? undefined
          : info.context.contextWindow
        return Number.isInteger(windowTokens) && windowTokens > 0 ? { windowTokens } : null
      } catch {
        return null
      }
    }

    /**
     * #9 plan for one selected region: which existing checkpoints sit inside it,
     * how much new history surrounds them, and a content fingerprint. Reads the
     * session surface through public accessors only.
     */
    #regionPlan(agent, range) {
      const session = agent === undefined || agent === null ? undefined : agent.session
      const nodes = session === undefined || session === null || session.surface === undefined
        ? undefined
        : session.surface.nodes
      if (!Array.isArray(nodes) || typeof session.eventAt !== 'function') {
        return { plan: planChainedSummary({}), fingerprint: null }
      }
      const checkpoints = []
      let newMessageCount = 0
      let text = ''
      for (const seq of nodes) {
        if (!Number.isInteger(seq) || seq < range.start || seq > range.end) continue
        const event = session.eventAt(seq)
        if (event === undefined || event === null) continue
        const body = eventText(event)
        text += body
        if (isCheckpoint(event)) checkpoints.push({ seq, text: body })
        else newMessageCount += 1
      }
      // The fingerprint includes the surface generation, so a repeat is only a
      // duplicate when the host has NOT rewritten the surface since. A successful
      // compaction bumps surface.replaceGeneration; ignoring that would make a
      // legitimate follow-up compaction look redundant.
      const generation = session.surface.replaceGeneration === undefined
        ? 'unknown'
        : String(session.surface.replaceGeneration)
      return {
        plan: planChainedSummary({ checkpoints, newMessageCount }),
        fingerprint: summaryFingerprint(range.start + ':' + range.end + ':' + generation + ':' + text)
      }
    }

    /** #9 plan for an already-replayed summarization input. */
    #inputPlan(input) {
      const messages = input === undefined || input === null || !Array.isArray(input.messages)
        ? []
        : input.messages
      const checkpoints = []
      let newMessageCount = 0
      messages.forEach((message, index) => {
        const event = { type: 'user/message', data: { message } }
        if (isCheckpoint(event)) checkpoints.push({ seq: index, text: eventText(event) })
        else if (message === null || message === undefined || message.role !== 'system') newMessageCount += 1
      })
      return planChainedSummary({ checkpoints, newMessageCount })
    }

    /** D1 + D2/D3, then the inherited transaction. */
    async compactIfNeeded(agent, trigger, signal) {
      const policy = this.#policy()
      // The overflow bypass never needs the window, so only the pressure path pays
      // for the resolveModelInfo round trip.
      const capacity = trigger === 'pressure' ? await this.#resolveCapacity(agent, signal) : null
      const action = readAction(
        decide({ trigger, policy, capacity, measure: this.#measure(agent) }),
        'decideCompaction'
      )
      if (action === 'delegate') return super.compactIfNeeded(agent, trigger, signal)
      if (action === 'skip') return null

      const range = select({
        session: agent.session,
        policy,
        trigger,
        capacity,
        measure: this.#measure(agent),
        edgeChecks
      })
      if (range === null) {
        // A null range is a real decision now that #5 selects structurally: on the
        // self-healing overflow path, hand it back rather than losing recovery.
        if (trigger === 'context-overflow') return super.compactIfNeeded(agent, trigger, signal)
        return null
      }
      // #9 R1: a region that holds nothing but an existing checkpoint has nothing
      // to gain from another projection — re-summarizing it is pure loss.
      const { plan, fingerprint } = this.#regionPlan(agent, range)
      if (plan.mode === 'noop') return null
      // #9 idempotence: peek only. The ledger records after the transaction
      // commits, so a failed compaction can still be retried.
      const entry = { start: range.start, end: range.end, fingerprint }
      if (fingerprint !== null && isDuplicateCompaction(this.#ledger, entry)) return null

      const result = await this.#compactWithDegradation(range, agent, signal, trigger)
      if (result !== null && fingerprint !== null) admitCompaction(this.#ledger, entry)
      return result
    }

    /**
     * Run the region transaction under #10's degradation policy.
     *
     * The transaction owns the lock and emits exactly one `compaction/end` per
     * attempt (basic/lib/index.js compactSurfaceRegion L450-L522), so every path
     * here — including the retry, which opens a fresh transaction — releases it. A
     * summary failure is retried once; when it still fails the engine logs a
     * structured diagnostic and answers "nothing compacted" so the session keeps
     * running. Busy, changed, commit, persistence and cancellation always
     * propagate: swallowing them would hide a stuck lock, a changed surface, a
     * failed commit or the caller's own abort reason.
     */
    async #compactWithDegradation(range, agent, signal, trigger) {
      let attempt = 0
      for (;;) {
        try {
          return await this.compactRegion(range.start, range.end, agent, signal)
        } catch (error) {
          const action = decideCompactionFailure(error, attempt, signal)
          if (action === 'propagate') throw error
          this.#reportCompactionFailure(error, { action, attempt, trigger, range })
          if (action === 'retry') {
            attempt += 1
            continue
          }
          return null
        }
      }
    }

    /**
     * Make a background failure visible without inventing a session event type
     * (PLAN §4.7 forbids new event types): `ctx.logger` is the diagnostic channel,
     * and console is only the last resort when a host hands us no logger at all.
     * A retry is a warning; a degrade is an error, because the session continues
     * with less context than the policy wanted.
     */
    #reportCompactionFailure(error, { action, attempt, trigger, range }) {
      const detail = describeCompactionError(error)
      const message =
        'dsh-compress-codex: ' + action + ' after a ' + detail.code + ' compaction failure on the ' +
        trigger + ' trigger (attempt ' + (attempt + 1) + '): ' + detail.message
      const payload = {
        action,
        attempt: attempt + 1,
        trigger,
        range: { start: range.start, end: range.end },
        error: detail
      }
      const logger = this.ctx === null || this.ctx === undefined ? undefined : this.ctx.logger
      if (logger !== null && logger !== undefined) {
        const emit = action === 'degrade' ? logger.error : logger.warn
        if (typeof emit === 'function') {
          emit.call(logger, message, payload)
          return
        }
        if (typeof logger.warn === 'function') {
          logger.warn(message, payload)
          return
        }
      }
      console.error(message, payload)
    }

    /**
     * Manual (/compact) path. The official implementation selects a range with an
     * unexported helper and commits it with owner:null / stability:'selected-span';
     * neither is reachable from a subclass (docs/design-m1-m2.md §1.2), so a custom
     * range must not be committed through compactRegion() here.
     *
     * Synchronous by contract, so capacity is not resolved; #5/#10 own this path.
     */
    compactNow(agent, signal, sourceCommandId) {
      const range = select({
        session: agent.session,
        policy: this.#policy(),
        trigger: 'manual',
        capacity: null,
        measure: this.#measure(agent),
        edgeChecks
      })
      if (range === null) return super.compactNow(agent, signal, sourceCommandId)
      throw new Error(REFUSE.manual)
    }

    /**
     * D4: build the summary request from #6's template and run the real one-shot
     * call (#7). A null request still delegates to the official summarizer, so an
     * install that never configured us keeps the official behaviour.
     *
     * Failure recovery is deliberately NOT repeated here: the inherited region
     * transaction catches summarization errors, calls
     * regionDependencies().recover() -> ctx.waterfall('compaction/summary-error')
     * and re-derives the region when a handler answers true. Swallowing or
     * retrying inside this hook would call that waterfall twice for one failure.
     */
    async summarize(input, agent, signal) {
      const request = build({ input, agent, policy: this.#policy() })
      if (request === null) return super.summarize(input, agent, signal)
      // C5 fail-loud: only a request carrying #6's projection may be emitted.
      if (typeof request.projection !== 'function') throw new Error(REFUSE.summary)
      const result = await runSummary({ input, request, agent, signal, config: this.config, llm: this.ctx.llm })
      // #9 anti-drift: a chained summary inherits every field the previous
      // checkpoint carried. Fail loud rather than persist a degraded checkpoint —
      // the loss would otherwise compound silently round after round. A fresh
      // summary is not audited: a field that was never there cannot be lost.
      const chain = this.#inputPlan(input)
      if (chain.mode === 'chain') {
        assertAntiDrift(chain.requiredFields, summaryText(result), 'chained summary')
      }
      return result
    }
  }
}
