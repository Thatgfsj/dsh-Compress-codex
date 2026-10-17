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
import { buildSummaryRequest } from './core/prompt.js'

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
  'modelPolicies',
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
    'dsh-compress-codex: the custom summary pipeline is owned by #6/#7; refusing to emit ' +
    'a summary the projection has not filtered'
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
        // #5 owns range selection. Until it lands, hand the self-healing path back
        // rather than reporting "nothing to compact" and losing overflow recovery.
        if (trigger === 'context-overflow') return super.compactIfNeeded(agent, trigger, signal)
        return null
      }
      return this.compactRegion(range.start, range.end, agent, signal)
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

    /** D4: build the summary request, or hand the work back to the official path. */
    async summarize(input, agent, signal) {
      const request = build({ input, agent, policy: this.#policy() })
      if (request === null) return super.summarize(input, agent, signal)
      throw new Error(REFUSE.summary)
    }
  }
}
