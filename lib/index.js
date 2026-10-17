/**
 * dsh-compress-codex — host half.
 *
 * A DeepSeek Harness bundle (dsh.bundle.patch -> cordis.patch.yml) that replaces
 * the official @deepseek-ai/dsh-compaction-basic policy behind the ctx.compaction
 * seam with a Codex-style one. Policy dimensions: docs/PLAN.md §1.3;
 * implementation contract: docs/design-m1-m2.md.
 *
 * Layering, and why it is not negotiable:
 *
 *   lib/core/**   pure decision layer, no '@deepseek-ai/*' import at all
 *   lib/engine.js injection-based engine factory, still no host import
 *   lib/index.js  THIS file — the only place that names the host package, and it
 *                 does so with a dynamic import so that 'import "./lib/index.js"'
 *                 keeps working in the zero-install gate pipeline
 *
 * @module dsh-compress-codex
 */

import { normalizePolicy } from './core/config.js'
import { createCodexCompactionEngine } from './engine.js'

export { createCodexCompactionEngine, DEFAULT_HOOKS } from './engine.js'

/** Plugin name, reported by the loader in diagnostics and --dump-config. */
export const name = 'dsh-compress-codex'

/** The umbrella row reads no service itself; the mounted engine declares its own. */
export const inject = []

/** Package whose class we extend; the only host specifier in the repository. */
export const BASE_PACKAGE = '@deepseek-ai/dsh-compaction-basic'

/**
 * Mount the bundle row.
 *
 * Cordis awaits a plugin's apply, so the dynamic import below happens before the
 * entry is considered mounted (verified on cordis 4.0.5: an async apply that
 * awaits import() and then calls ctx.plugin() mounts its service).
 *
 * @param ctx - cordis Context handed over by the loader.
 * @param config - already-normalized row config from cordis.patch.yml.
 * @returns the mounted child fiber, or null when the host package is unavailable.
 */
export function apply(ctx, config = {}) {
  assertContext(ctx)
  // Fail fast on a config the decision layer cannot read; #3 owns the full schema.
  normalizePolicy(config)
  return mountEngine(ctx, config)
}

/**
 * Mount the engine built from an injected base class.
 *
 * Exported as the dependency-injection seam: tests pass a fake loader, so both
 * the success and the failure path are exercisable without a host install.
 *
 * @param ctx - cordis Context.
 * @param config - row config.
 * @param loadBase - async () => BasicCompactionEngine class.
 * @returns the child fiber, or null when loadBase failed.
 */
export async function mountEngine(ctx, config = {}, loadBase = loadBaseClass) {
  assertContext(ctx)
  let Base
  try {
    Base = await loadBase()
  } catch (error) {
    reportMountFailure(ctx, error)
    return null
  }
  const Engine = createCodexCompactionEngine(Base)
  // ctx.plugin() creates a child fiber, disposed with ours; ctx.effect() would be
  // a second owner of the same resource (verified on cordis 4.0.5).
  return ctx.plugin(Engine, config)
}

/** Import the host base class. Reached only in a real dsh runtime. */
async function loadBaseClass() {
  const module = await import(BASE_PACKAGE)
  const Base = module.BasicCompactionEngine ?? module.default
  if (typeof Base !== 'function') {
    throw new TypeError(BASE_PACKAGE + ' did not export the BasicCompactionEngine class')
  }
  return Base
}

/**
 * Report a failed mount. A rejected apply is swallowed by the loader on
 * 0.2.1-rc.2 — no unhandled rejection, no visible error — so this log line is
 * the only signal an operator gets, and it has to say what is NOT running.
 */
function reportMountFailure(ctx, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const message =
    name + ': cannot load ' + BASE_PACKAGE + ' (' + detail + '); the compaction seam is NOT ' +
    'installed, so the official compaction backend keeps running'
  const logger = ctx.logger
  if (typeof logger?.error === 'function') logger.error(message)
  else if (typeof logger?.warn === 'function') logger.warn(message)
  else console.error(message)
}

function assertContext(ctx) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError(name + ': apply(ctx, config) requires a cordis Context')
  }
}

export default { name, inject, apply }
