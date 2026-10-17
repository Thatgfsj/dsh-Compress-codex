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
 * Issue #2 ships the skeleton: every decision hook answers "delegate", so the
 * mounted engine behaves exactly like the official one until #4/#5/#6 land.
 */

import { normalizePolicy } from './core/config.js'
import { decideCompaction } from './core/trigger.js'
import { selectCompactionRange } from './core/select.js'
import { buildSummaryRequest } from './core/prompt.js'

/** Decision hooks used when the caller does not inject its own. */
export const DEFAULT_HOOKS = Object.freeze({
  decideCompaction,
  selectCompactionRange,
  buildSummaryRequest
})

const REFUSE = Object.freeze({
  manual:
    'dsh-compress-codex: manual range selection is owned by #5; refusing to fall back to ' +
    'compactRegion(), whose transaction is current-turn owned',
  summary:
    'dsh-compress-codex: the custom summary pipeline is owned by #6/#7; refusing to emit ' +
    'a summary the projection has not filtered'
})

/** Read one hook, falling back to the default when the caller omitted it. */
function pickHook(hooks, key, fallback) {
  const value = hooks === undefined || hooks === null ? undefined : hooks[key]
  if (value === undefined) return fallback
  if (typeof value !== 'function') {
    throw new TypeError('dsh-compress-codex: hook ' + key + ' must be a function')
  }
  return value
}

/**
 * Build the engine class bound to one injected base.
 *
 * @param Base - the BasicCompactionEngine class (or a stand-in in tests).
 * @param hooks - optional overrides for the D1/D2-D3/D4 decision hooks.
 * @returns a CompactionEngine subclass ready for `ctx.plugin()`.
 * @throws {TypeError} when Base is not a class/function, or a hook is not callable.
 */
export function createCodexCompactionEngine(Base, hooks = DEFAULT_HOOKS) {
  if (typeof Base !== 'function') {
    throw new TypeError(
      'dsh-compress-codex: createCodexCompactionEngine(Base) requires the BasicCompactionEngine class'
    )
  }
  const decide = pickHook(hooks, 'decideCompaction', decideCompaction)
  const select = pickHook(hooks, 'selectCompactionRange', selectCompactionRange)
  const build = pickHook(hooks, 'buildSummaryRequest', buildSummaryRequest)

  return class CodexCompactionEngine extends Base {
    /** Decision-layer view of the config the loader already resolved. */
    #policy() {
      return normalizePolicy(this.config)
    }

    /**
     * Lazy measurement thunk for the D1-D3 hooks.
     *
     * Nothing here touches ctx until the hook calls it, which is what keeps the
     * skeleton path free of host services.
     */
    #measure(agent) {
      return () => this.ctx.tokenMeter.measure(agent.session)
    }

    /** D1 + D2/D3, then the inherited transaction. */
    async compactIfNeeded(agent, trigger, signal) {
      const decision = decide({
        trigger,
        policy: this.#policy(),
        measure: this.#measure(agent)
      })
      if (decision.delegate) return super.compactIfNeeded(agent, trigger, signal)
      const range = select({
        session: agent.session,
        policy: this.#policy(),
        trigger,
        measure: this.#measure(agent)
      })
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }

    /**
     * Manual (/compact) path. The official implementation selects a range with an
     * unexported helper and commits it with owner:null / stability:'selected-span';
     * neither is reachable from a subclass (docs/design-m1-m2.md §1.2), so a custom
     * range must not be committed through compactRegion() here.
     */
    compactNow(agent, signal, sourceCommandId) {
      const range = select({
        session: agent.session,
        policy: this.#policy(),
        trigger: 'manual',
        measure: this.#measure(agent)
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
