# dsh-compress-codex

A DSH **bundle** that replaces the compaction policy behind the `ctx.compaction` seam
with a **Codex-style** one — same DSH transaction contract, different strategy.

- Policy dimensions **D1 触发 / D2 切分 / D3 保留 / D4 摘要 / D5 注入**: [`docs/PLAN.md`](docs/PLAN.md) §1.3
- Codex source-level spec (every claim carries file+line evidence): [`docs/codex-notes.md`](docs/codex-notes.md)
- Codex → DSH mapping, incl. what must **not** be copied: [`docs/codex-dsh-mapping.md`](docs/codex-dsh-mapping.md)
- Layering, seam and transaction: [`docs/architecture.md`](docs/architecture.md)
- What is verified vs not: [`docs/runtime-verification.md`](docs/runtime-verification.md)

> **Read this first if you are wiring this into a runtime.** Four things bite people, and
> they matter more than the feature list:
> 1. **Host packages only resolve inside a booting dsh process** — see [§5.1](#51-host-packages-do-not-resolve-from-a-profile-directory).
> 2. **Never smoke-test on the `web` template** — it already disables `compaction-basic`, so you get a false green ([§5.2](#52-the-web-template-is-a-false-green)).
> 3. **`disabled: true` is load-bearing**: without it two engines provide `compaction` and the boot fails fatally ([§5.3](#53-disabling-the-official-row-is-load-bearing)).
> 4. **Not everything is verified yet** — see [§6](#6-status-what-works-today).

Interfaces, config and layer semantics follow the DSH plugin contract; for the plugin
toolchain itself see the `dsh-plugin-construction` skill in your DSH install.

---

## 1. Why this exists

The official `@deepseek-ai/dsh-compaction-basic` is a solid backend, but its policy has
three properties this project treats as defects ([`docs/PLAN.md`](docs/PLAN.md) §1.4):

| # | Official behaviour | Why it hurts |
|---|---|---|
| 1 | Retention is a **token ratio** (`retainRatio: 0.16` of `W − O`) | It cannot tell "the last three task turns" from "50k tokens of older tool logs". Structure is not modelled. |
| 2 | The summary is **free text** | There is no stable, resumable field set (progress / decisions / next steps / files touched), so a resumed session relearns context. |
| 3 | Repeated compaction has **no drift convention** | Each round re-encodes; quality decays silently. |

Codex answers all three — but only some of its answers survive DSH's contract constraints
C1–C5. The mapping table marks every one of them as *copyable*, *needs adaptation* or
*do not copy*.

## 2. How it plugs in

It is a bundle: `package.json` declares `dsh.bundle.patch` → `cordis.patch.yml`, which
performs exactly two operations on the layer `dsh-base` owns:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true                 # keep exactly one implementation of ctx.compaction
- insert:
    - id: compaction-codex
      name: 'dsh-compress-codex'
      config: {}
```

`command-compact` (`/compact`) and `tool-result-pruner` are intentionally untouched:
they are backend-independent.

## 3. Install

Requires a DSH with the plugin CLI (`dsh 0.2.1-rc.2` verified) and `pnpm` on `PATH`.

```sh
# from a checkout
dsh plugin --profile <your-profile> add /path/to/dsh-Compress-codex

# or from a registry/tarball
dsh plugin --profile <your-profile> add dsh-compress-codex
```

Then confirm the layer landed **without booting anything**:

```sh
dsh --profile <your-profile> --dump-config | grep -B1 -A3 -E 'id: compaction-(basic|codex)'
```

Expected: `compaction-basic` is `disabled: true` **and** annotated
`patched by dsh-compress-codex`; `compaction-codex` resolves to `dsh-compress-codex`.
The annotation matters — `disabled: true` alone could come from the template ([§5.2](#52-the-web-template-is-a-false-green)).

### Peer dependencies

`@deepseek-ai/cordis`, `@deepseek-ai/dsh-compaction-basic` and
`@deepseek-ai/schemastery` are **peer dependencies** (and dev dependencies). They must
never be moved into `dependencies`: the host shares one instance, and a second copy fails
module resolution. A link install keeps them unresolved in the profile's
`node_modules`; that is normal and is why [§5.1](#51-host-packages-do-not-resolve-from-a-profile-directory) exists.

### Configuration

Row config is a **whole replacement**, not a deep merge. All keys optional; unknown keys
fail at mount time instead of silently behaving like the default.

| Key | Default | Meaning |
|---|---|---|
| `triggerLimitTokens` | — | Absolute trigger limit (Codex `config.limit`) |
| `triggerLimitRatio` | `0.9` | `limit = min(triggerLimitTokens ?? ∞, floor(W × ratio))` |
| `effectiveWindowPercent` | `0.95` | Hard-full ceiling: `full = floor(W × percent)` |
| `triggerBufferTokens` | `0` | Buffer added **on the limit side** |
| `turnEndPercent` | `0` | Turn-end check; `0` disables it |
| `overflowRecovery` | `true` | Bypass thresholds on `CONTEXT_WINDOW_EXCEEDED` |
| `retainMode` | `'structural'` | Retention by dialogue structure, not by token ratio |
| `retainRecentUnits` | `3` | Recent structural units kept verbatim |
| `retainTokens` | — | **Soft** ceiling: whole units in or out, never half a tool pair |
| `summaryTemplate` | `'codex-v1'` | Template version, for measuring drift |
| `summaryExtraFields` | `['files','pitfalls']` | Codex's four fields + our two |

Defaults and rationale: [`docs/codex-impl-checklist.md`](docs/codex-impl-checklist.md) §1.1.

## 4. Verify

Three levels, cheapest first:

1. **Composition** — `dsh --profile <p> --dump-config` (see §3). Any stale override prints
   `patch: entry "<id>" not found`. This warning appears **only** in `--dump-config`.
2. **Real boot, offline** — `node scripts/smoke-runtime.mjs` runs a throwaway
   `DSH_HOME`, installs this bundle into a minimal profile, and asserts composition,
   the negative control, **and that the real mount resolves the real base class inside a
   booting dsh process**.
3. **Session level** — not yet available; see §6.

```sh
node scripts/smoke-runtime.mjs          # A1-A6; A7 SKIPPED until M2 lands
SMOKE_KEEP=1 node scripts/smoke-runtime.mjs   # keep the temp home for debugging
```

A skip is **not** a pass: when `dsh` or `pnpm` is missing the script prints
`SMOKE RESULT: SKIPPED` and exits 0 so it can never block the gate — report it as
unverified.

## 5. Four things that bite

### 5.1 Host packages do not resolve from a profile directory

```sh
cd "$DSH_HOME/profiles/<p>" && node --input-type=module -e "await import('@deepseek-ai/dsh-compaction-basic')"
# -> ERR_MODULE_NOT_FOUND
```

Yet inside a booting dsh process the same import **succeeds**: the loader supplies
installation-scope resolution at boot. A profile's `node_modules` holds only the linked
plugin. **A "resolve the host package from a bare node process" assertion is a false
negative**; assert the mount from inside a boot instead (that is what `smoke-runtime.mjs`
A6 does). Evidence: [`docs/runtime-verification.md`](docs/runtime-verification.md) §5.1.

### 5.2 The `web` template is a false green

The `web` profile template **already disables `compaction-basic`** (that row belongs to
`@deepseek-ai/dsh-web-app`). Dump-config on `web` therefore shows `disabled: true` even
with this bundle absent — the assertion is vacuous. Use `dsh plugin add` (minimal stack)
and always keep a negative control profile. Evidence: [`docs/runtime-verification.md`](docs/runtime-verification.md) §1.

### 5.3 Disabling the official row is load-bearing

Without `disabled: true` both engines provide `compaction` and the composition dies:

```
dsh: fatal load failure: Error: service "compaction" has been registered at <BasicCompactionEngine>
  at new CodexCompactionEngine (lib/engine.js)
```

So do not "clean up" that op. Evidence: [`docs/runtime-verification.md`](docs/runtime-verification.md) §5.2.

### 5.4 `--help` is not a smoke entry point

`dsh --profile <p> --help` hangs on a plugin-add profile (observed 60s and 120s). Use the
offline boot instead — no prompt, no network, no credential, ~2s:

```sh
dsh --profile <p> --patch <overlay.yml> </dev/null
```

## 6. Status: what works today

| Dimension | Codex target | State |
|---|---|---|
| D1 trigger | three-stage (`0.9` / `0.95` / turn-end / buffer) | **implemented** (#4) |
| D2 split | structural units, C1-paired cuts | **in progress** (#5) — selector still returns `null` and delegates to the official selection (safe: it cannot split a pair or shadow node 0) |
| D3 retention | recent structural units verbatim | **in progress** (#5) |
| D4 summary | `codex-v1` template + projection | **template implemented** (#6); the cache-reusing call is #7 (not started) |
| D5 injection | DSH framing (must not be re-invented) | constrained by the base transaction — by design |

**Verified** ([`docs/runtime-verification.md`](docs/runtime-verification.md) §3): install into a
minimal profile; `compaction-basic` disabled *and attributed*; `compaction-codex` mounted;
no stale-override warning; negative control still live; real base resolved and
`CodexCompactionEngine` constructed **inside a real boot**.

**Not verified**: a real session emitting
`compaction/start → compaction/summary → user/message → compaction/end`.
This needs M2 complete (#5, #7) plus a model credential. Do not read this project as
"end-to-end compaction works" yet.

## 7. Rollback

```sh
dsh plugin --profile <your-profile> remove dsh-compress-codex   # dependency + layer
dsh --profile <your-profile> --dump-config | grep -B1 -A3 'id: compaction-basic'
```

`compaction-basic` must come back **enabled** and **without** the
`patched by dsh-compress-codex` annotation. Nuclear option: recreate the profile with
`dsh plugin --profile <your-profile> --from-default-profile <template> add ...` — or just
delete `$DSH_HOME/profiles/<your-profile>` after confirming the absolute path. Nothing is
written outside `$DSH_HOME`.

## 8. Repository layout

```
lib/core/**    pure decision layer — no '@deepseek-ai/*' import at all
lib/engine.js  engine factory; host pieces are injected, still no host import
lib/index.js   the only module that names a host package, via dynamic import
cordis.patch.yml  the bundle layer (disable + insert)
scripts/       isolated-home guard, dump-config smoke, runtime smoke
test/          node --test suite, runnable with zero node_modules
docs/          PLAN, Codex spec, mapping, impl checklist, architecture, verification
```

The layering is not cosmetic: the gate runs `node --test` **without an install step**, so
any host import under `lib/core` would turn every future PR red (asserted in
`test/layering.test.mjs`).

## 9. License

MIT — see [LICENSE](LICENSE).
