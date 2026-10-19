/**
 * dsh-compress-codex — host half.
 *
 * A DeepSeek Harness bundle (dsh.bundle.patch -> cordis.patch.yml) that replaces
 * the official @deepseek-ai/dsh-compaction-basic policy behind the ctx.compaction
 * seam with one whose D1-D5 policy follows Codex (D3 retention and the #9 anti-drift
 * layer are DSH-original; Codex has no anti-drift mechanism). Dimensions: docs/PLAN.md §1.3;
 * implementation contract: docs/design-m1-m2.md.
 *
 * Layering, and why it is not negotiable:
 *
 *   lib/core/**   pure decision layer, no '@deepseek-ai/*' import at all
 *   lib/engine.js injection-based engine factory, still no host import
 *   lib/index.js  THIS file — the only place that names a host package, and it
 *                 does so with a dynamic import so that 'import "./lib/index.js"'
 *                 keeps working in the zero-install gate pipeline
 *
 * @module dsh-compress-codex
 */

import { CONFIG_FIELDS, DEFAULT_POLICY } from './core/config.js'
import { DEFAULT_HOOKS, createCodexCompactionEngine, validateRowConfig } from './engine.js'

export { createCodexCompactionEngine, DEFAULT_HOOKS } from './engine.js'
export { CONFIG_FIELDS, DEFAULT_POLICY, normalizePolicy, resolveModelPolicy } from './core/config.js'
export { POLICY_KEYS, SUMMARY_FIELDS, SUMMARY_TEMPLATES } from './core/keys.js'

/** Plugin name, reported by the loader in diagnostics and --dump-config. */
export const name = 'dsh-compress-codex'

/** The umbrella row reads no service itself; the mounted engine declares its own. */
export const inject = []

/** Package whose class we extend. */
export const BASE_PACKAGE = '@deepseek-ai/dsh-compaction-basic'

/** Package that exports the authoritative tool-pairing cut helpers (C1). */
export const EDGE_CHECKS_PACKAGE = '@deepseek-ai/dsh-compaction'

/** Package providing the config schema vocabulary. */
export const SCHEMASTERY_PACKAGE = '@deepseek-ai/schemastery'

/**
 * Build the row schema from CONFIG_FIELDS, so the schema the loader validates
 * with and the validation normalizePolicy() performs are generated from the same
 * description and cannot drift.
 *
 * Only per-key shape is expressed here; the cross-key constraints (percent above
 * ratio, retain budget below the trigger limit, duplicate model targets) stay in
 * normalizePolicy(), which runs at mount time. The schema is necessary, not
 * sufficient — deliberate, because schemastery objects have no cross-field hooks.
 *
 * @param z - the schemastery namespace (injected so tests need no dependency).
 * @returns an object schema keyed exactly like POLICY_KEYS.
 * @throws {TypeError} when a descriptor kind has no mapping.
 */
export function buildConfigSchema(z) {
  const shape = {}
  for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
    let node
    switch (field.kind) {
      case 'positiveInteger':
        node = z.natural().min(1)
        break
      case 'nonNegativeInteger':
        node = z.natural()
        break
      case 'ratio':
        node = z.number().min(0).max(1)
        break
      case 'percent':
        node = z.number().min(0).max(100)
        break
      case 'boolean':
        node = z.boolean()
        break
      case 'enum':
        node = z.union(field.values.map((value) => z.const(value)))
        break
      case 'stringArray':
        node = z.array(z.union(field.values.map((value) => z.const(value))))
        break
      case 'modelPolicies':
        node = z.array(z.object({ provider: z.string().required(), model: z.string().required() }))
        break
      default:
        throw new TypeError('dsh-compress-codex: no schema mapping for kind ' + String(field.kind) + ' (' + key + ')')
    }
    if (field.description !== undefined && typeof node.description === 'function') {
      node = node.description(field.description)
    }
    const fallback = DEFAULT_POLICY[key]
    if (fallback !== undefined && typeof node.default === 'function') {
      node = node.default(Array.isArray(fallback) ? [...fallback] : fallback)
    }
    shape[key] = node
  }
  return z.object(shape)
}

/**
 * Mount the bundle row.
 *
 * Cordis awaits a plugin's apply, so the dynamic imports below happen before the
 * entry is considered mounted (verified on cordis 4.0.5: an async apply that
 * awaits import() and then calls ctx.plugin() mounts its service).
 *
 * @param ctx - cordis Context handed over by the loader.
 * @param config - row config from cordis.patch.yml.
 * @returns the mounted child fiber, or null when the host package is unavailable.
 */
export function apply(ctx, config = {}) {
  assertContext(ctx)
  // Fail fast on a row the plugin cannot read; #3 owns the full schema.
  validateRowConfig(config)
  return mountEngine(ctx, config)
}

/**
 * Mount the engine built from an injected base class.
 *
 * Exported as the dependency-injection seam: tests pass fake loaders, so the
 * success and the failure path are both exercisable without a host install.
 *
 * @param ctx - cordis Context.
 * @param config - row config.
 * @param loadBase - async () => BasicCompactionEngine class.
 * @param loadHelpers - async () => host helpers; must never throw, because a
 *   missing helper only downgrades the selector to its own pure C1 check.
 * @returns the child fiber, or null when loadBase failed.
 */
export async function mountEngine(
  ctx,
  config = {},
  loadBase = loadBaseClass,
  loadHelpers = loadEdgeChecks
) {
  assertContext(ctx)
  let Base
  try {
    Base = await loadBase()
  } catch (error) {
    reportMountFailure(ctx, error)
    return null
  }
  const helpers = await loadHelpers()
  const Engine = createCodexCompactionEngine(Base, DEFAULT_HOOKS, helpers)
  // Attach the row schema the loader validates against (issue #3). Absent
  // schemastery we leave the base class's schema in place: it is also a
  // schemastery object, so unknown keys still pass through and our row survives.
  const Config = await loadConfigSchema()
  if (Config !== null) Engine.Config = Config
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
 * Import the authoritative tool-pairing cut helpers (C1) and hand them to the
 * selector. This is the only way lib/core can use them without importing a host
 * package itself.
 *
 * A failure here is not fatal: the selector falls back to its own pure check, so
 * we return {} instead of taking the whole compaction seam down.
 */
async function loadEdgeChecks() {
  try {
    const module = await import(EDGE_CHECKS_PACKAGE)
    const before = module.toolPairingBalancedBefore
    const after = module.toolPairingBalancedAfter
    if (typeof before !== 'function' || typeof after !== 'function') return {}
    return {
      edgeChecks: {
        before: (session, seq) => before(session, seq),
        after: (session, seq) => after(session, seq)
      }
    }
  } catch {
    return {}
  }
}

/**
 * Native config schema for --dump-config-schema, or undefined.
 *
 * The schema dump resolves a plugin's Config synchronously and rejects anything
 * that is not a native Schemastery schema, so it cannot come from a dynamic
 * import. It also cannot be a static import: this module must stay importable
 * with zero installed dependencies, because the gate runs node --test before any
 * install. A guarded require via process.getBuiltinModule() satisfies both — and
 * process.getBuiltinModule needs no import statement, so this file keeps its
 * "only first-party static imports" property.
 *
 * @returns the native schema, or undefined when the host package is absent.
 */
let cachedConfigSchema
function nativeConfigSchema() {
  if (cachedConfigSchema === undefined) {
    try {
      const { createRequire } = process.getBuiltinModule('node:module')
      const require = createRequire(import.meta.url)
      const module = require(SCHEMASTERY_PACKAGE)
      cachedConfigSchema = buildConfigSchema(module.default ?? module) ?? null
    } catch {
      cachedConfigSchema = null
    }
  }
  return cachedConfigSchema ?? undefined
}

/** Build the row schema, or null when schemastery is unavailable. */
async function loadConfigSchema() {
  try {
    const module = await import(SCHEMASTERY_PACKAGE)
    return buildConfigSchema(module.default ?? module)
  } catch {
    return null
  }
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

export default {
  name,
  inject,
  apply,
  /**
   * Read by dsh's --dump-config-schema, which resolves it *synchronously* off this
   * export and rejects anything that is not a native Schemastery schema
   * (docs/runtime-verification.md §5.4). The property name and the getter shape
   * are load-bearing: an accessor that "disappears" degrades exactly like the
   * legitimate zero-install case, so test/config.test.mjs asserts the descriptor
   * itself, not just the returned value.
   */
  get Config() {
    return nativeConfigSchema()
  }
}
