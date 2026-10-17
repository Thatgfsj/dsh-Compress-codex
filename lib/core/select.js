/**
 * D2/D3 — split and retention policy (docs/PLAN.md §1.3).
 *
 * Highest-risk decision in the project: Codex keeps user messages verbatim and
 * summarizes assistant/tool messages because its in-memory `normalize_history()`
 * repairs unpaired calls afterwards. DSH's surface replacement has no such net,
 * so a span that shadows an assistant `tool-call` while retaining its
 * `tool/result` (or the reverse) is provider-illegal (C1). The retention unit
 * here is therefore a C1-balanced structural unit, never a message role.
 *
 * Frozen contract (see selectCompactionRange): `[start, end]` is an inclusive
 * surface-position span, exactly what `CompactionEngine.compactRegion()` expects;
 * both edges are tool-pairing balanced; no safe range means `null` and zero
 * writes; `retainTokens` is a soft bound, so the newest unit is kept whole.
 *
 * Deliberate, Lead-approved deviations from the official selector:
 *   1. surface position 0 is never shadowed, even when it is not a
 *      `system/message` (the official selector allows `firstIdx = 0`); one node
 *      stays verbatim so node 0 can never be projected away.
 *   2. an in-history `system/message` is a soft preference, not a barrier: the
 *      cut is pulled back to keep it visible only while that still releases at
 *      least SYSTEM_BARRIER_MIN_SHADOW_RATIO of the policy span and fits the soft
 *      budget; otherwise the span crosses it and the plan says so. A hard barrier
 *      would let an early prompt update make long sessions uncompactable.
 *
 * Zero dependencies on purpose (see config.js). The host's tool-pairing cuts
 * arrive as `edgeChecks: { before, after } | null`; the fallback below is
 * test-only and is never consulted while an injected pair is present.
 */

import { DEFAULT_POLICY } from './config.js'

const SYSTEM_MESSAGE = 'system/message'
const USER_MESSAGE = 'user/message'
const ASSISTANT_MESSAGE = 'assistant/message'
const TOOL_RESULT = 'tool/result'
const DEFAULT_RETAIN_MODE = DEFAULT_POLICY.retainMode
const DEFAULT_RETAIN_RECENT_UNITS = DEFAULT_POLICY.retainRecentUnits

/** A context-overflow recovery keeps the smallest safe tail: the newest unit. */
const OVERFLOW_RETAINED_UNITS = 1

/**
 * Share of the policy span's shadowed nodes a system-barrier detour must still
 * release before it is preferred over crossing the `system/message`.
 *
 * This is a **policy constant, not a correctness condition**: whatever its value,
 * every cut handed to `compactRegion()` stays a whole-unit, C1-balanced boundary,
 * so 0.5 only biases one trade-off (over-retain vs. shadow an in-history prompt
 * update). It is the initial value the Lead approved; 0.5 carries no theoretical
 * grounding and may be retuned from measurements. What a detour gives up is
 * reported per decision as `systemBarrierSkippedUnits` / `systemBarrierSkippedNodes`
 * so issue #13 can observe and tune it.
 *
 * The comparison is **inclusive**: a detour that releases exactly this share is
 * accepted. test/select.test.mjs pins the exact-threshold case *and* the
 * ratio-declined case, so neither retuning the value nor flipping the comparison
 * can pass unnoticed (final-verification F1).
 */
export const SYSTEM_BARRIER_MIN_SHADOW_RATIO = 0.5

/**
 * Signed tool-call delta of one surface event, algorithm-identical to
 * `dsh-compaction/lib/types/tool-pairing.js` (0.2.1-rc.2): one `tool-call` block
 * answers one `tool/result` event.
 * @returns the delta (0 for every non-tool event).
 */
export function surfaceEventDelta(event) {
  switch (event.type) {
    case ASSISTANT_MESSAGE: {
      const message = event.data === undefined || event.data === null ? undefined : event.data.message
      const content = message === undefined || message === null ? undefined : message.content
      if (!Array.isArray(content)) return 0
      let calls = 0
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'tool-call') calls += 1
      }
      return calls
    }
    case TOOL_RESULT:
      return -1
    default:
      return 0
  }
}

/**
 * Fold one surface into its cut-balance table: `cutBalanced[i]` is the cut
 * before position i, so `balancedAfter(i) === cutBalanced[i + 1]`.
 * @returns `{ entries, cutBalanced }`, or null for an unreadable/corrupt surface
 * (a missing event, or a tool result without a preceding call) — callers must
 * read null as "no safe range", never as "balanced".
 */
export function foldSurfaceBalance(nodes, eventAt) {
  if (!Array.isArray(nodes) || typeof eventAt !== 'function') return null
  const entries = []
  const cutBalanced = [true]
  let open = 0
  for (const seq of nodes) {
    const event = eventAt(seq)
    if (event === null || typeof event !== 'object' || event.seq !== seq) return null
    open += surfaceEventDelta(event)
    if (open < 0) return null
    entries.push({ seq, type: event.type })
    cutBalanced.push(open === 0)
  }
  return { entries, cutBalanced }
}

/** Read one cut's balance, mirroring the host helper's throws. */
function localCutBalance(session, seq, offset) {
  const surface = session === null || session === undefined ? undefined : session.surface
  const nodes = surface === undefined || surface === null ? undefined : surface.nodes
  const eventAt = session === null || session === undefined ? undefined : session.eventAt
  const folded = foldSurfaceBalance(
    nodes,
    typeof eventAt === 'function' ? (value) => eventAt.call(session, value) : undefined
  )
  if (folded === null) throw new Error('tool-pairing balance: surface is not readable')
  const index = Array.isArray(nodes) ? nodes.indexOf(seq) : -1
  const balanced = index === -1 ? undefined : folded.cutBalanced[index + offset]
  if (balanced === undefined) throw new Error('tool-pairing balance: surface seq ' + String(seq) + ' not found')
  return balanced
}

/**
 * **Test-only fallback** for `toolPairingBalancedBefore`; production injects the
 * host helper, which always wins. Mirrors the host contract, including "seq
 * absent from the surface throws".
 * @returns true when no unanswered tool call crosses the cut.
 */
export function localToolPairingBalancedBefore(session, seq) {
  return localCutBalance(session, seq, 0)
}

/** **Test-only fallback** for `toolPairingBalancedAfter`; see above. */
export function localToolPairingBalancedAfter(session, seq) {
  return localCutBalance(session, seq, 1)
}

/**
 * Split one surface window into C1-balanced structural units (checklist §2.3): a
 * unit starts at a `user/message` seen while no tool call is open, so every unit
 * boundary is a balanced cut by construction.
 *
 * The `cutBalanced` clause is defensive for the *selection*: the loop's edge
 * checks would repair an unbalanced candidate anyway (measured: removing it
 * changes no returned span). It is kept because this exported function's own
 * contract says "balanced by construction", and test/select.test.mjs pins that
 * contract against an independent reference (final-verification F2).
 * @returns frozen, contiguous, non-empty units covering `[startIndex, endIndex]`.
 */
export function splitSurfaceUnits(entries, cutBalanced, startIndex, endIndex) {
  const units = []
  let unitStart = startIndex
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    if (entries[index].type !== USER_MESSAGE || cutBalanced[index] !== true) continue
    units.push(Object.freeze({ start: unitStart, end: index - 1 }))
    unitStart = index
  }
  units.push(Object.freeze({ start: unitStart, end: endIndex }))
  return units
}

/** Build the "no range" plan with an explanatory reason (the zero-write answer). */
function noRange(reason, details) {
  return { status: 'none', reason, ...details }
}

/**
 * The host's authoritative tool-pairing cuts, or the test-only fallback pair.
 * The engine hands over `edgeChecks: { before(session, seq), after(session, seq) } | null`
 * (it validates the pair at construction), so a present-but-partial pair is a
 * wiring bug this layer must not paper over — it falls back only when absent.
 */
function resolveEdgeChecks(context) {
  const pair = context.edgeChecks
  const injected =
    pair !== null && pair !== undefined && typeof pair === 'object' &&
    typeof pair.before === 'function' && typeof pair.after === 'function'
  return {
    injected,
    before: injected ? pair.before : localToolPairingBalancedBefore,
    after: injected ? pair.after : localToolPairingBalancedAfter
  }
}

/** Answer one edge question, treating a throwing helper as an unbalanced edge. */
function edgeBalanced(check, session, seq) {
  try {
    return check(session, seq) === true
  } catch {
    return false
  }
}

/**
 * Per-node token measurement for the soft budget; a missing, throwing, or
 * surface-mismatched measurement degrades to structure-only retention
 * (`tokenBudgetApplied: false`) rather than failing a C1/C2-safe selection.
 * @returns `Map<seq, tokens>`, or null when unavailable.
 */
function readMeasurement(context, nodes) {
  if (context.retainTokens === undefined || typeof context.measure !== 'function') return null
  let measurement
  try {
    measurement = context.measure()
  } catch {
    return null
  }
  const priced = measurement === null || measurement === undefined ? undefined : measurement.nodes
  if (!Array.isArray(priced) || priced.length !== nodes.length) return null
  const tokens = new Map()
  for (let index = 0; index < priced.length; index += 1) {
    const node = priced[index]
    if (node === null || typeof node !== 'object' || node.seq !== nodes[index]) return null
    const value = node.tokens === undefined ? node.heuristicTokens : node.tokens
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
    tokens.set(node.seq, value)
  }
  return tokens
}

/** Sum one unit's measured tokens; zero without a measurement. */
function unitTokens(unit, nodes, tokens) {
  if (tokens === null) return 0
  let total = 0
  for (let index = unit.start; index <= unit.end; index += 1) total += tokens.get(nodes[index]) ?? 0
  return total
}

/** Sum the newest `keep` units' measured tokens. */
function tailTokens(units, nodes, tokens, keep) {
  let total = 0
  for (let index = units.length - keep; index < units.length; index += 1) {
    total += unitTokens(units[index], nodes, tokens)
  }
  return total
}

/** Describe the injected async-resolved capacity without inventing a budget. */
function readCapacity(capacity) {
  if (capacity === null || capacity === undefined) return null
  const windowTokens = capacity.windowTokens
  if (!Number.isInteger(windowTokens) || windowTokens <= 0) return null
  return windowTokens
}

/**
 * Full D2/D3 decision for one session: never throws for a decision reason, never
 * writes, and always explains itself. This is the view behind
 * {@link selectCompactionRange}, whose frozen `null` cannot carry a reason.
 *
 * Manual compaction answers "no custom range" because `/compact` owns an idle
 * `owner: null` transaction this selector cannot commit.
 *
 * @param context - `{ session, policy, trigger, capacity, measure, edgeChecks }`;
 *   `edgeChecks` is the host's `{ before, after } | null` C1 authority, and
 *   `capacity` is diagnostics-only (the retention budget stays a policy value).
 * @returns `status: 'shadow'` with the inclusive span and its accounting, or
 * `status: 'none'` with a reason.
 * @throws {TypeError} when no session is supplied.
 */
export function planCompactionRange(context) {
  const supplied = context === undefined || context === null ? undefined : context
  const session = supplied === undefined ? undefined : supplied.session
  if (session === undefined || session === null) {
    throw new TypeError('dsh-compress-codex: selectCompactionRange requires a session')
  }
  const policy = supplied.policy === undefined || supplied.policy === null ? {} : supplied.policy
  const trigger = supplied.trigger === undefined ? 'pressure' : supplied.trigger
  const retainMode = policy.retainMode === undefined ? DEFAULT_RETAIN_MODE : policy.retainMode
  const retainRecentUnits =
    policy.retainRecentUnits === undefined ? DEFAULT_RETAIN_RECENT_UNITS : policy.retainRecentUnits
  const retainTokens = policy.retainTokens
  const overflow = trigger === 'context-overflow'
  const base = {
    trigger,
    overflow,
    windowTokens: readCapacity(supplied.capacity),
    surfaceNodes: 0,
    unitCount: 0
  }

  if (trigger === 'manual') {
    return noRange('manual compaction delegates to the official engine; /compact keeps its own transaction', base)
  }
  if (retainMode !== 'structural') {
    return noRange('retainMode ' + JSON.stringify(retainMode) + ' has no structural selector; refusing to guess', base)
  }
  if (!Number.isInteger(retainRecentUnits) || retainRecentUnits < 1) {
    return noRange('retainRecentUnits must be an integer >= 1, got ' + String(retainRecentUnits), base)
  }
  // Same domain as the #3 schema (a positive integer): a zero or negative budget
  // is out of range and fails closed here exactly as the loader would refuse it.
  if (retainTokens !== undefined && (!Number.isInteger(retainTokens) || retainTokens <= 0)) {
    return noRange('retainTokens must be a positive integer, got ' + String(retainTokens), base)
  }

  const surface = session.surface
  const nodes = surface === undefined || surface === null ? undefined : surface.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return noRange('surface has no nodes', base)
  const folded = foldSurfaceBalance(
    nodes,
    typeof session.eventAt === 'function' ? (seq) => session.eventAt(seq) : undefined
  )
  if (folded === null) {
    return noRange('surface is corrupt: a node has no matching event, or a tool result has no open call', base)
  }
  const { entries, cutBalanced } = folded
  const lastIndex = nodes.length - 1
  const size = { ...base, surfaceNodes: nodes.length }

  // C2: node 0 always stays visible (deviation 1), and the leading cut must be
  // balanced, so every earlier node stays verbatim.
  let startIndex = 1
  while (startIndex <= lastIndex && entries[startIndex].type === SYSTEM_MESSAGE) startIndex += 1
  while (startIndex <= lastIndex && cutBalanced[startIndex] !== true) startIndex += 1
  if (startIndex > lastIndex) return noRange('no balanced, compactable start after the protected head', size)

  const units = splitSurfaceUnits(entries, cutBalanced, startIndex, lastIndex)
  const tokens = readMeasurement({ retainTokens, measure: supplied.measure }, nodes)
  const keepLimit = overflow ? OVERFLOW_RETAINED_UNITS : retainRecentUnits
  let keep = 0
  let retainedTokens = 0
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (keep >= keepLimit) break
    const cost = unitTokens(units[index], nodes, tokens)
    // retainTokens is a soft bound: the first (newest) unit is always kept whole.
    if (keep > 0 && tokens !== null && retainedTokens + cost > retainTokens) break
    keep += 1
    retainedTokens += cost
  }
  const accounts = {
    ...size,
    unitCount: units.length,
    retainedTokens: tokens === null ? null : retainedTokens,
    tokenBudgetApplied: tokens !== null
  }
  const budgetLabel = overflow ? 'context-overflow keeps 1' : 'retainRecentUnits=' + retainRecentUnits
  if (keep >= units.length) {
    const only = 'structural retention keeps every one of the ' + units.length + ' compactable unit(s) (' + budgetLabel + '); nothing to shadow'
    return noRange(only, { ...accounts, systemBarrier: 'none' })
  }

  // Deviation 2: keep an in-history system/message visible while the detour
  // still releases most of the policy span and fits the soft budget.
  let systemIndex = -1
  for (let index = startIndex; index <= lastIndex; index += 1) {
    if (entries[index].type === SYSTEM_MESSAGE) {
      systemIndex = index
      break
    }
  }
  let barrierPreference = 'not-needed'
  let barrierSkippedUnits = 0
  let barrierSkippedNodes = 0
  if (systemIndex !== -1) {
    const policyCut = units[units.length - keep].start
    const policyKeep = keep
    if (systemIndex < policyCut) {
      barrierPreference = 'declined'
      const barrierUnit = units.findIndex((unit) => systemIndex >= unit.start && systemIndex <= unit.end)
      const barrierKeep = units.length - barrierUnit
      const barrierCut = units[barrierUnit].start
      const releasesEnough = (barrierCut - startIndex) * 2 >= policyCut - startIndex
      const budget = tokens === null || retainTokens === undefined ? 0 : retainTokens
      const fitsBudget = tokens === null || retainTokens === undefined || tailTokens(units, nodes, tokens, barrierKeep) <= budget
      if (barrierCut > startIndex && releasesEnough && fitsBudget) {
        keep = barrierKeep
        retainedTokens = tailTokens(units, nodes, tokens, keep)
        barrierPreference = 'applied'
        barrierSkippedUnits = barrierKeep - policyKeep
        barrierSkippedNodes = policyCut - barrierCut
      }
    }
  }

  const checks = resolveEdgeChecks(supplied)
  for (; keep < units.length; keep += 1) {
    const firstRetained = units[units.length - keep]
    const candidateEnd = firstRetained.start - 1
    if (candidateEnd < startIndex) break
    const start = nodes[startIndex]
    const end = nodes[candidateEnd]
    // Only whole-unit retreat: an unbalanced candidate keeps one more unit.
    if (!edgeBalanced(checks.before, session, start)) break
    if (!edgeBalanced(checks.after, session, end)) continue
    const shadowedUnits = units.length - keep
    const shadowedSystem = systemIndex !== -1 && systemIndex <= candidateEnd
    const barrierNote =
      systemIndex === -1
        ? ''
        : ', in-history system/message ' + (shadowedSystem ? 'crossed' : 'kept') +
          ' (barrier preference ' + barrierPreference +
          (barrierSkippedNodes === 0 ? '' : ', ' + barrierSkippedNodes + ' node(s) kept back for it') + ')'
    const reason =
      'structural retention: keep the newest ' + keep + ' of ' + units.length + ' units (' + budgetLabel +
      (tokens === null ? ', no token budget' : ', retainTokens=' + retainTokens) + '), shadow ' + shadowedUnits +
      ' whole unit(s) [' + start + '..' + end + ']' + barrierNote
    return {
      status: 'shadow',
      reason,
      trigger,
      overflow,
      start,
      end,
      retainFrom: nodes[firstRetained.start],
      startIndex,
      endIndex: candidateEnd,
      windowTokens: base.windowTokens,
      surfaceNodes: nodes.length,
      unitCount: units.length,
      shadowedUnitCount: shadowedUnits,
      retainedUnitCount: keep,
      shadowedNodeCount: candidateEnd - startIndex + 1,
      retainedTokens: tokens === null ? null : retainedTokens,
      tokenBudgetApplied: tokens !== null,
      systemBarrier: systemIndex === -1 ? 'none' : shadowedSystem ? 'crossed' : 'kept',
      systemBarrierPreference: barrierPreference,
      systemBarrierSkippedUnits: barrierSkippedUnits,
      systemBarrierSkippedNodes: barrierSkippedNodes,
      edgeChecks: checks.injected ? 'injected' : 'local'
    }
  }
  return noRange('no verifiably balanced cut: every shadow candidate would split a tool-call pair', {
    ...accounts,
    systemBarrier: 'none'
  })
}

/**
 * Choose the surface span to replace and the tail to retain verbatim.
 *
 * @param context - decision inputs supplied by the engine.
 * @param context.session - live session (surface access only; never mutated here).
 * @param context.policy - normalized policy from normalizePolicy().
 * @param context.trigger - 'pressure', 'context-overflow' or 'manual'.
 * @param context.capacity - { windowTokens } | null, resolved by the engine.
 * @param context.measure - lazy () => measurement thunk; #5 consumes it.
 * @param context.edgeChecks - authoritative tool-pairing cuts supplied by the
 *   engine ({ before, after }), or null when the host helper is unavailable. The
 *   selector must then fall back to its own pure C1 check.
 * @returns `null` with zero writes when no C1/C2-safe span exists, else
 *   `{ start, end, retainFrom }` with `start > 0`: surface node 0 is never
 *   shadowed, system or not (C2). `start`/`end` are the inclusive
 *   surface-position span handed to `compactRegion()`, `retainFrom` is the first
 *   retained node, and diagnostic fields explain the choice.
 * @throws {TypeError} when no session is supplied.
 */
export function selectCompactionRange(context) {
  const plan = planCompactionRange(context)
  if (plan.status !== 'shadow') return null
  return {
    start: plan.start,
    end: plan.end,
    retainFrom: plan.retainFrom,
    reason: plan.reason,
    shadowedUnitCount: plan.shadowedUnitCount,
    retainedUnitCount: plan.retainedUnitCount,
    tokenBudgetApplied: plan.tokenBudgetApplied,
    systemBarrier: plan.systemBarrier,
    systemBarrierSkippedNodes: plan.systemBarrierSkippedNodes
  }
}
