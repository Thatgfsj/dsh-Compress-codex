/**
 * Public types for dsh-compress-codex.
 *
 * Kept in sync with lib/core/keys.js by hand; test/config.test.mjs asserts every
 * policy key appears here, so a new key cannot ship undocumented.
 */

/** Extra summary fields #6 can emit. */
export type SummaryExtraField = 'files' | 'pitfalls'

/** Summary templates #6 can render. */
export type SummaryTemplate = 'codex-v1'

/** Retention mode (D3). */
export type RetainMode = 'structural'

/** What the mechanical layer asks the policy about. */
export type CompactionTrigger = 'pressure' | 'context-overflow'

/** Three-state decision result. */
export type DecisionAction = 'delegate' | 'skip' | 'compact'

/** Exact provider/model override; duplicates are rejected at load time. */
export interface ModelPolicyOverride {
  provider: string
  model: string
  triggerLimitTokens?: number
  triggerLimitRatio?: number
  effectiveWindowPercent?: number
  triggerBufferTokens?: number
  turnEndPercent?: number
  overflowRecovery?: boolean
  retainMode?: RetainMode
  retainRecentUnits?: number
  retainTokens?: number
  summaryTemplate?: SummaryTemplate
  summaryExtraFields?: SummaryExtraField[]
}

/** Row configuration accepted from cordis.patch.yml. */
export interface CodexCompactionConfig {
  triggerLimitTokens?: number
  triggerLimitRatio?: number
  effectiveWindowPercent?: number
  triggerBufferTokens?: number
  turnEndPercent?: number
  overflowRecovery?: boolean
  modelPolicies?: ModelPolicyOverride[]
  retainMode?: RetainMode
  retainRecentUnits?: number
  retainTokens?: number
  summaryTemplate?: SummaryTemplate
  summaryExtraFields?: SummaryExtraField[]
}

/** Resolved policy handed to the decision layer. */
export interface CodexCompactionPolicy {
  triggerLimitTokens: number | undefined
  triggerLimitRatio: number
  effectiveWindowPercent: number
  triggerBufferTokens: number
  turnEndPercent: number
  overflowRecovery: boolean
  modelPolicies: readonly ModelPolicyOverride[] | undefined
  retainMode: RetainMode
  retainRecentUnits: number
  retainTokens: number | undefined
  summaryTemplate: SummaryTemplate
  summaryExtraFields: readonly SummaryExtraField[]
}

/** Capacity resolved by the engine from the routed adapter. */
export interface CompactionCapacity {
  windowTokens: number
}

/** Numbers behind one decision, for the diagnostics log. */
export interface DecisionNumbers {
  windowTokens: number | null
  activeTokens: number | null
  scopeTokens: number | null
  limitTokens: number | null
  fullTokens: number | null
  thresholdTokens: number | null
  bufferTokens: number
  turnEndPercent: number
  limitReached: boolean
  fullReached: boolean
  turnEndReached: boolean
}

/** Result of the D1 trigger hook. */
export interface CompactionDecision {
  action: DecisionAction
  reason: string
  numbers: DecisionNumbers
}

/** Authoritative C1 tool-pairing cuts, injected by lib/index.js. */
export interface EdgeChecks {
  before(session: unknown, seq: number): boolean
  after(session: unknown, seq: number): boolean
}

/** A surface span to replace. `start` is always greater than 0 (C2). */
export interface CompactionRange {
  start: number
  end: number
}

/** Result of the D4 summary-template hook. */
export interface SummaryRequest {
  prompt: string
  projection(blocks: unknown): unknown[] | null
  template: SummaryTemplate
  fields: SummaryExtraField[]
}

export declare function decideCompaction(context: {
  trigger: CompactionTrigger
  policy: CodexCompactionPolicy | Record<string, unknown>
  capacity: CompactionCapacity | null
  measure: () => unknown
}): CompactionDecision

export declare function selectCompactionRange(context: {
  session: unknown
  policy: CodexCompactionPolicy | Record<string, unknown>
  trigger: CompactionTrigger | 'manual'
  capacity: CompactionCapacity | null
  measure: () => unknown
  edgeChecks?: EdgeChecks | null
}): CompactionRange | null

export declare function buildSummaryRequest(context: {
  input: { messages: readonly unknown[], tools?: readonly unknown[] }
  agent: unknown
  policy: CodexCompactionPolicy | Record<string, unknown>
}): SummaryRequest | null

export declare function normalizePolicy(config: CodexCompactionConfig): CodexCompactionPolicy
export declare function resolveModelPolicy(
  policy: CodexCompactionPolicy,
  target: { provider: string; model: string } | undefined
): CodexCompactionPolicy
export declare function validateRowConfig(config: Record<string, unknown>): CodexCompactionPolicy
export declare function createCodexCompactionEngine(
  Base: unknown,
  hooks?: Record<string, unknown>,
  helpers?: { edgeChecks?: EdgeChecks | null }
): unknown
export declare const POLICY_KEYS: readonly string[]
export declare const SUMMARY_FIELDS: readonly SummaryExtraField[]
export declare const SUMMARY_TEMPLATES: readonly SummaryTemplate[]
export declare const DEFAULT_POLICY: CodexCompactionPolicy
export declare const CONFIG_FIELDS: Readonly<Record<string, { kind: string; description?: string; values?: readonly string[] }>>
