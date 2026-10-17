/**
 * dsh-compress-codex — host half.
 *
 * A DeepSeek Harness **bundle** (`dsh.bundle.patch` -> cordis.patch.yml) that
 * ultimately replaces the official `@deepseek-ai/dsh-compaction-basic` policy
 * behind the `ctx.compaction` service seam. The five policy dimensions this
 * project owns are documented in docs/PLAN.md §1.3; the repository conventions
 * (PR <= 1000 lines, mandatory CI, dependency red lines) in docs/PLAN.md §4.
 *
 * M0 (#1) deliberately ships a placeholder. It is a real plugin — the cordis
 * loader normalises the module namespace, finds the `apply` export and mounts
 * it — but it registers nothing, so the bundle is loadable and inert rather
 * than half-wired. Nothing here may import a `@deepseek-ai/*` package yet: this
 * file has to stay importable with zero installed dependencies so that the
 * gate pipeline can run before any install step exists.
 *
 * @module dsh-compress-codex
 */

/** Plugin name, reported by the loader in diagnostics and `--dump-config`. */
export const name = 'dsh-compress-codex'

/**
 * Services this plugin reads through `ctx`. Empty on purpose: the placeholder
 * must not touch `ctx.<service>` for anything it has not declared, and it
 * declares nothing yet. M1-2 (#2) adds `compaction`, `llm`, `sessions`, ...
 */
export const inject = []

/**
 * Mount the bundle row.
 *
 * @param ctx - cordis Context handed over by the loader.
 * @param config - already-normalised row config from cordis.patch.yml.
 * @throws {TypeError} when called outside the cordis plugin contract.
 */
export function apply(ctx, config = {}) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError(`${name}: apply(ctx, config) requires a cordis Context`)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`${name}: config must be an object`)
  }

  // M1-2 (#2) replaces the body of this function with the CodexCompactionEngine
  // mount, roughly:
  //
  //   ctx.set('compaction', new CodexCompactionEngine(ctx, config))
  //   ctx.effect(() => () => { /* release engine-owned resources */ })
  //
  // Until then this function is intentionally side-effect free, which
  // test/plugin-contract.test.mjs asserts with a property-access trap.
}

export default { name, inject, apply }
