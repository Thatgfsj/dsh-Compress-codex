/**
 * M3-9 (#9) — idempotence and anti-drift for chained compaction.
 *
 * HONEST LABEL: Codex has **no explicit anti-drift mechanism**
 * (docs/codex-notes.md §6.2). It re-summarizes the previous summary together with
 * the new history and emits a WarningEvent; nothing in its source pins the fields
 * across a chain. **Everything in this module is DSH-original**, derived from the
 * projection problem itself rather than ported. Do not describe it as Codex-style.
 *
 * The problem: compaction is a lossy projection pi: H -> H-prime. One projection is
 * acceptable; cascading it amplifies the loss. If every round re-summarizes the
 * previous summary, deep decisions fade round by round until the checkpoint is a
 * contentless platitude — the exact failure this project exists to avoid.
 *
 * Three rules, evaluated in order:
 *
 *   R1 noop   the region holds existing checkpoint(s) and **no new history**.
 *             Re-summarizing a pure checkpoint is pure loss and is not idempotent.
 *   R2 chain  new history plus at least one existing checkpoint. The previous
 *             summary becomes a MANDATORY input segment, not history to be
 *             summarized away, and every field it carried must survive.
 *             Merging beats rejecting (a rejection wedges the session: the region
 *             keeps growing) and beats dropping (that loses recovery ability).
 *   R3 fresh  no checkpoint in range. A plain summary — but the anti-drift audit
 *             still applies, because a fresh round can lose a field too.
 *
 * Zero dependencies on purpose (see config.js): the gate pipeline imports this
 * module with no node_modules present.
 */

import { CODEX_SUMMARY_FIELDS, EXTRA_SUMMARY_FIELDS } from './prompt.js'

/** Field ids that must appear in every checkpoint. */
export const CORE_FIELD_IDS = Object.freeze(CODEX_SUMMARY_FIELDS.map((field) => field.id))

/** Field ids covered by the omit-if-none rule: they may be absent, never lost once present. */
export const OPTIONAL_FIELD_IDS = Object.freeze(Object.keys(EXTRA_SUMMARY_FIELDS))

/** The three outcomes of a chained-summary plan. */
export const CHAIN_MODES = Object.freeze(['fresh', 'chain', 'noop'])

/** Directives prepended for a chain. Ours: Codex has no counterpart. */
export const CHAIN_DIRECTIVES = Object.freeze([
  'The previous checkpoint below is an input you must preserve, not history to summarize away.',
  'Carry every field the previous checkpoint carried into the new summary, with at least the same specificity.',
  'Never generalise a concrete decision into a platitude; if a previous item is now obsolete, say so explicitly instead of omitting it.'
])

/** All known field descriptors, keyed by id. */
const FIELD_BY_ID = Object.freeze({
  ...Object.fromEntries(CODEX_SUMMARY_FIELDS.map((field) => [field.id, field])),
  ...EXTRA_SUMMARY_FIELDS
})

/**
 * Default field matcher: a field counts as present only when the checkpoint
 * reproduces the template bullet the model was asked to write.
 *
 * Deliberately strict. A bare id ("files") appearing in prose is NOT accepted: a
 * false positive would report a field as carried when it was not, which hides
 * exactly the drift this module exists to catch. A false negative is safe here —
 * it fails loud and a human resolves it. Pass a template-aware matcher to relax
 * the rule for a specific template.
 *
 * @param text - checkpoint body.
 * @param field - field descriptor with id and bullet.
 * @returns whether the field bullet is recognisable in the text.
 */
export function defaultFieldMatcher(text, field) {
  const lead = field.bullet.toLowerCase().split(' ').slice(0, 3).join(' ')
  return String(text).toLowerCase().includes(lead)
}

/**
 * Field ids recognisable in one checkpoint body.
 *
 * @param text - checkpoint body.
 * @param ids - field ids to test; defaults to every known field.
 * @param matcher - (text, field) => boolean; defaults to defaultFieldMatcher.
 * @returns frozen ids in the order they were asked for.
 */
export function extractFields(text, ids = [...CORE_FIELD_IDS, ...OPTIONAL_FIELD_IDS], matcher = defaultFieldMatcher) {
  const found = []
  for (const id of ids) {
    const field = FIELD_BY_ID[id]
    if (field === undefined) {
      throw new TypeError('dsh-compress-codex: unknown summary field id ' + String(id))
    }
    if (matcher(text, field)) found.push(id)
  }
  return Object.freeze(found)
}

/**
 * Fields that must survive the next round: the core four always, plus every
 * optional field the previous checkpoint actually carried. Losing something you
 * had is drift; never having had it is not.
 *
 * @param previousFields - ids extracted from the existing checkpoint.
 * @returns frozen required ids, core first.
 */
export function requiredCarryFields(previousFields = []) {
  const carried = OPTIONAL_FIELD_IDS.filter((id) => previousFields.includes(id))
  return Object.freeze([...CORE_FIELD_IDS, ...carried])
}

/**
 * Positions of the existing checkpoints inside a surface region.
 *
 * @param nodes - surface nodes in head-to-tail order.
 * @param isCheckpoint - (node) => boolean, e.g. a wrapper over the injected
 *   isCompactCheckpointSource; this module never imports the host predicate.
 * @returns frozen indices, in order.
 */
export function checkpointPositions(nodes, isCheckpoint) {
  if (!Array.isArray(nodes)) throw new TypeError('dsh-compress-codex: checkpointPositions requires an array of nodes')
  if (typeof isCheckpoint !== 'function') {
    throw new TypeError('dsh-compress-codex: checkpointPositions requires an isCheckpoint(node) predicate')
  }
  const positions = []
  nodes.forEach((node, index) => {
    if (isCheckpoint(node)) positions.push(index)
  })
  return Object.freeze(positions)
}

/**
 * Decide how to fold an existing checkpoint into the next summary.
 *
 * @param context - plan inputs.
 * @param context.checkpoints - existing checkpoints inside the region, in order,
 *   each { seq, text }. Their text is the previous checkpoint body.
 * @param context.newMessageCount - surface nodes in the region that are not checkpoints.
 * @param context.matcher - optional field matcher.
 * @returns frozen { mode, reason, requiredFields, directives, carry, previousFields }.
 * @throws {TypeError} on a malformed context.
 */
export function planChainedSummary(context = {}) {
  const checkpoints = context.checkpoints === undefined ? [] : context.checkpoints
  const newMessageCount = context.newMessageCount === undefined ? 0 : context.newMessageCount
  if (!Array.isArray(checkpoints)) throw new TypeError('dsh-compress-codex: checkpoints must be an array')
  if (!Number.isInteger(newMessageCount) || newMessageCount < 0) {
    throw new TypeError('dsh-compress-codex: newMessageCount must be a non-negative integer')
  }
  const matcher = context.matcher === undefined ? defaultFieldMatcher : context.matcher

  if (checkpoints.length === 0) {
    return Object.freeze({
      mode: 'fresh',
      reason: 'r3-no-checkpoint-in-range',
      requiredFields: requiredCarryFields([]),
      directives: Object.freeze([]),
      carry: Object.freeze([]),
      previousFields: Object.freeze([])
    })
  }

  if (newMessageCount === 0) {
    return Object.freeze({
      mode: 'noop',
      reason: 'r1-pure-checkpoint-region',
      requiredFields: requiredCarryFields([]),
      directives: Object.freeze([]),
      carry: Object.freeze([]),
      previousFields: Object.freeze([])
    })
  }

  const previousFields = []
  for (const checkpoint of checkpoints) {
    for (const id of extractFields(checkpoint.text, undefined, matcher)) {
      if (!previousFields.includes(id)) previousFields.push(id)
    }
  }
  return Object.freeze({
    mode: 'chain',
    reason: 'r2-new-history-plus-checkpoint',
    requiredFields: requiredCarryFields(previousFields),
    directives: CHAIN_DIRECTIVES,
    carry: Object.freeze(checkpoints.map((checkpoint) => Object.freeze({ ...checkpoint }))),
    previousFields: Object.freeze(previousFields)
  })
}

/**
 * Fields the next checkpoint lost. Empty means the projection held.
 *
 * @param required - ids that must survive.
 * @param text - the new checkpoint body.
 * @param matcher - optional field matcher.
 * @returns frozen missing ids.
 */
export function missingCarryFields(required, text, matcher = defaultFieldMatcher) {
  const present = extractFields(text, required, matcher)
  return Object.freeze(required.filter((id) => !present.includes(id)))
}

/**
 * Fail loud when a chained summary dropped a field it was required to carry.
 * The engine calls this before persisting, so a degraded checkpoint is never
 * written and the loss cannot compound silently.
 *
 * @param required - ids that must survive.
 * @param text - the candidate checkpoint body.
 * @param where - caller label used in the message.
 * @param matcher - optional field matcher.
 * @returns the required ids, for chaining.
 * @throws {RangeError} listing every missing field.
 */
export function assertAntiDrift(required, text, where = 'checkpoint', matcher = defaultFieldMatcher) {
  const missing = missingCarryFields(required, text, matcher)
  if (missing.length > 0) {
    throw new RangeError(
      'dsh-compress-codex: ' + where + ' dropped required field(s) ' + missing.join(', ') +
      '; chained summaries must carry every field the previous checkpoint had'
    )
  }
  return required
}

/**
 * Stable fingerprint of one checkpoint, used to tell the same compaction from
 * the same range rewritten. FNV-1a: deterministic across runs and processes,
 * no crypto dependency, no need for collision resistance.
 *
 * @param text - checkpoint body.
 * @returns 8-hex-digit fingerprint.
 */
export function summaryFingerprint(text) {
  let hash = 0x811c9dc5
  const input = String(text)
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Idempotence ledger: the same range re-admitted with the same fingerprint is a
 * duplicate and must not produce a second event or a second summary. A different
 * fingerprint means the range was rewritten, so the compaction is legitimate.
 *
 * @returns an empty ledger (plain data; callers own persistence).
 */
export function createCompactionLedger() {
  return { entries: new Map() }
}

/** Validate a ledger entry and return its { key, fingerprint }. */
function readLedgerEntry(entry = {}) {
  const { start, end, fingerprint } = entry
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw new TypeError('dsh-compress-codex: ledger entries require integer start/end with end >= start')
  }
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError('dsh-compress-codex: ledger entries require a fingerprint')
  }
  return { key: start + ':' + end, fingerprint }
}

/**
 * Read-only duplicate check.
 *
 * The engine peeks before running and records only after the transaction
 * committed, so a compaction that failed is never mistaken for one that already
 * happened — otherwise the first failure would permanently block the retry.
 *
 * @param ledger - ledger from createCompactionLedger().
 * @param entry - { start, end, fingerprint }.
 * @returns true when this exact range and content already compacted.
 */
export function isDuplicateCompaction(ledger, entry = {}) {
  const { key, fingerprint } = readLedgerEntry(entry)
  return ledger.entries.get(key) === fingerprint
}

/**
 * Admit one compaction attempt.
 *
 * @param ledger - ledger from createCompactionLedger().
 * @param entry - { start, end, fingerprint }.
 * @returns frozen { action: run | duplicate, reason, key, ledger }.
 * @throws {TypeError} on a malformed entry.
 */
export function admitCompaction(ledger, entry = {}) {
  const { key, fingerprint } = readLedgerEntry(entry)
  const previous = ledger.entries.get(key)
  if (previous === fingerprint) {
    return Object.freeze({ action: 'duplicate', reason: 'i2-same-range-same-checkpoint', key, ledger })
  }
  ledger.entries.set(key, fingerprint)
  return Object.freeze({
    action: 'run',
    reason: previous === undefined ? 'i1-first-attempt' : 'i3-range-rewritten',
    key,
    ledger
  })
}
