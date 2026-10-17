/**
 * M3-10 — compaction failure classification and degradation (issue #10).
 *
 * #7 established the precise failure semantics of the summarization call. This
 * module turns those (and the inherited transaction's failures) into one stable
 * vocabulary so the engine, and later the /compact command layer, can branch on
 * an error's *class* instead of matching strings.
 *
 * The classes are exactly the official ManualCompactionErrorCode union
 * (dsh-compaction lib/types/index.d.ts L27): busy / cancelled / changed / summary /
 * commit / persistence. We do not import that class — lib/core stays host-free —
 * so the predicates read the structural markers a ManualCompactionError exposes
 * (`code`, `name`), the summaries #7 raises, abort errors, and the cause chain.
 *
 * Failure is classified, never hidden: only a *summary* failure may be retried
 * once and then degraded (the session keeps running, the lock is already released
 * by the transaction, and the engine logs a structured diagnostic). Busy, changed,
 * commit, persistence and cancellation always propagate — swallowing them would
 * hide a stuck lock, a changed surface, a failed commit or the caller's own abort.
 *
 * LOCK INVARIANT: the inherited transaction owns the compaction lock and emits
 * exactly one `compaction/end` per `compaction/start` (basic/lib/index.js
 * compactSurfaceRegion L450-L522); every attempt — including the retry below — is a
 * fresh transaction, so a failure can never leave the session unable to compact
 * again. test/errors.test.mjs asserts that equality per attempt.
 *
 * VISIBILITY: a background failure must not be silent, but PLAN §4.7 forbids new
 * session event types, so the engine reports through `ctx.logger` (console only as
 * the last resort when no logger exists) — never by appending an invented event.
 *
 * VERIFICATION STATUS: the D4 path (#6/#7 + this crate) is covered by unit tests
 * and mutation runs, NOT end to end. Issue #12's live in-session compaction is
 * still unverified: it needs model credentials, and on this host those live in the
 * dsh credential store (~/.dsh/.credentials.yaml refs) rather than environment
 * variables, which conflicts with the temporary-DSH_HOME isolation rule. No
 * document may claim an end-to-end session test until #12 produces one.
 *
 * Zero dependencies on purpose except ./summarize.js (also host-free).
 */

import { NO_CONTENT_CODE, NO_ROUTE_CODE, TRUNCATED_CODE, UNPROJECTED_CODE } from './summarize.js'

/** The official ManualCompactionErrorCode union, frozen for exhaustiveness tests. */
export const COMPACTION_ERROR_CODES = Object.freeze([
  'busy',
  'cancelled',
  'changed',
  'summary',
  'commit',
  'persistence'
])

/** What the engine does with a classified failure. */
export const FAILURE_ACTIONS = Object.freeze(['retry', 'degrade', 'propagate'])

/** Retries after the first attempt; issue #10 allows exactly one. */
export const SUMMARY_RETRY_LIMIT = 1

/** The codes #7 raises while producing a summary. */
export const SUMMARY_FAILURE_CODES = Object.freeze([
  NO_ROUTE_CODE,
  NO_CONTENT_CODE,
  TRUNCATED_CODE,
  UNPROJECTED_CODE
])

/** A string error code, or undefined for primitives, nulls and code-less errors. */
function codeOf(value) {
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  return typeof value.code === 'string' && value.code.length > 0 ? value.code : undefined
}

/** An error name, or undefined when there is none. */
function nameOf(value) {
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  return typeof value.name === 'string' && value.name.length > 0 ? value.name : undefined
}

/** A readable message for any thrown value. */
function messageOf(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.message === 'string') return value.message
  return String(value)
}

/**
 * The thrown value and its `.cause` chain, newest first, cycle safe.
 *
 * @param error - any thrown value.
 * @returns array starting with the error itself; empty for undefined/null.
 */
export function errorChain(error) {
  const chain = []
  const seen = new Set()
  let current = error
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = typeof current === 'object' ? current.cause : undefined
  }
  return chain
}

/** True when the code (or any cause) is one of `codes`. */
function chainHasCode(error, codes) {
  return errorChain(error).some((link) => codes.includes(codeOf(link)))
}

/** True when any cause carries the given name. */
function chainHasName(error, name) {
  return errorChain(error).some((link) => nameOf(link) === name)
}

/** Abort-shaped error: a DOMException AbortError or an adapter ABORT_ERR. */
export function isAbortError(error) {
  return nameOf(error) === 'AbortError' || codeOf(error) === 'ABORT_ERR'
}

/**
 * Cancellation, with the caller's signal taken into account.
 *
 * An aborted signal is cancellation whatever the adapter surfaced while the abort
 * raced it: reporting a provider failure for a call the caller cancelled would
 * invite a pointless retry. Cancellation therefore outranks every other class.
 *
 * @param error - the thrown value.
 * @param signal - the signal that guarded the call, when there was one.
 * @returns true when the signal aborted, the error is an AbortError, or it wraps a
 *   `cancelled` ManualCompactionError.
 */
export function isCancelledError(error, signal) {
  if (codeOf(error) === 'cancelled') return true
  if (signal !== null && signal !== undefined && signal.aborted === true) return true
  if (isAbortError(error)) return true
  return chainHasCode(error, ['cancelled'])
}

/** True for the transaction's "lock already active" / "no idle agent" class. */
export function isBusyError(error) {
  return chainHasCode(error, ['busy'])
}

/** True for a surface that changed under the summary (raw or wrapped). */
export function isChangedError(error) {
  return chainHasCode(error, ['changed']) || chainHasName(error, 'SurfaceChangedError')
}

/** True when the commit stage failed after the body was written. */
export function isCommitError(error) {
  return chainHasCode(error, ['commit'])
}

/** True when a durability checkpoint failed after commit. */
export function isPersistenceError(error) {
  return chainHasCode(error, ['persistence'])
}

/**
 * Classify one failure into the official code union.
 *
 * Precedence is deliberate: cancellation wins over everything (an aborted call
 * must never be reported as a provider failure), then the explicit ManualCompaction
 * codes, then the summarization stage. Any error without a structural marker is
 * treated as `summary`: it can only have come from the region transaction after
 * the lock was taken (provider/transport failures carry adapter-specific codes).
 *
 * @param error - any thrown value.
 * @param signal - the signal that guarded the call, when there was one.
 * @returns one of COMPACTION_ERROR_CODES.
 */
export function classifyCompactionError(error, signal) {
  if (isCancelledError(error, signal)) return 'cancelled'
  if (isBusyError(error)) return 'busy'
  if (isChangedError(error)) return 'changed'
  if (isCommitError(error)) return 'commit'
  if (isPersistenceError(error)) return 'persistence'
  return 'summary'
}

/** True when the failure belongs to the summarization stage. */
export function isSummaryError(error) {
  return classifyCompactionError(error) === 'summary'
}

/**
 * Decide what the engine does with one failed attempt.
 *
 * An already-aborted signal always propagates: retrying a cancelled call is never
 * right, whatever error the adapter surfaced while the abort raced it. Cancellation
 * also keeps its exact reason — the engine must not wrap or replace it.
 *
 * @param error - the failure.
 * @param attempt - zero-based attempt index that produced it.
 * @param signal - the signal that guarded the attempt, when there was one.
 * @returns 'retry' (summary failure, retry budget left), 'degrade' (summary
 *   failure, budget spent — the session keeps running) or 'propagate' (everything
 *   else, including cancellation).
 */
export function decideCompactionFailure(error, attempt = 0, signal) {
  if (signal !== null && signal !== undefined && signal.aborted === true) return 'propagate'
  const code = classifyCompactionError(error, signal)
  if (code !== 'summary') return 'propagate'
  return attempt < SUMMARY_RETRY_LIMIT ? 'retry' : 'degrade'
}

/**
 * Plain, loggable description of a failure: no host types, no live objects.
 *
 * @param error - any thrown value.
 * @returns `{ code, name, message, causes }` where `causes` is the tail of the
 *   cause chain as `{ name, code, message }` records.
 */
export function describeCompactionError(error) {
  const chain = errorChain(error)
  const head = chain[0]
  return {
    code: classifyCompactionError(error),
    name: nameOf(head) ?? (typeof head === 'string' ? 'ThrownString' : 'Error'),
    message: messageOf(head),
    causes: chain.slice(1).map((link) => ({
      name: nameOf(link) ?? 'Error',
      code: codeOf(link) ?? null,
      message: messageOf(link)
    }))
  }
}
