import assert from "node:assert/strict"
import { test } from "node:test"

import { createCodexCompactionEngine } from "../lib/engine.js"
import { CODEX_SUMMARY_FIELDS, EXTRA_SUMMARY_FIELDS, SUMMARY_PREFIX } from "../lib/core/prompt.js"
import { createFakeBase, createFakeCtx } from "./support/fake-base.mjs"
import {
  REAL_CHAINED_SUMMARY,
  REAL_CHAINED_SUMMARY_WITHOUT_PITFALLS,
  REAL_SECTION_HEADINGS
} from "./support/chain-summary-fixtures.mjs"
import { NO_CONTENT_CODE } from "../lib/core/summarize.js"
import { NON_RETRYABLE_SUMMARY_CODES, decideCompactionFailure } from "../lib/core/errors.js"
import {
  CHAIN_DIRECTIVES,
  CHAIN_MODES,
  CORE_FIELD_IDS,
  FIELD_HEADING_ALIASES,
  OPTIONAL_FIELD_IDS,
  admitCompaction,
  assertAntiDrift,
  auditAntiDrift,
  checkpointPositions,
  createCompactionLedger,
  defaultFieldMatcher,
  extractFields,
  isDuplicateCompaction,
  missingCarryFields,
  planChainedSummary,
  requiredCarryFields,
  sectionHeadings,
  summaryFingerprint
} from "../lib/core/idempotence.js"

const ALL_FIELDS = [...CODEX_SUMMARY_FIELDS, ...Object.values(EXTRA_SUMMARY_FIELDS)]
const BULLET_BY_ID = Object.fromEntries(ALL_FIELDS.map((field) => [field.id, field.bullet]))

/** Render a checkpoint body the way the #6 template asks the model to. */
const render = (ids) => ids.map((id) => "- " + BULLET_BY_ID[id]).join("\n")

/**
 * Model a lossy summarizer over three consecutive compactions.
 *
 * A faithful model reproduces exactly what it is told to carry (the anti-drift
 * directive) plus the fields of the newest history; without the directive it only
 * writes the newest fields, so anything deeper fades round by round. That is the
 * mechanism the REVERSE test removes.
 */
const ROUNDS = [
  ["progress", "context", "next-steps", "references", "files", "pitfalls"],
  ["progress", "next-steps"],
  ["progress"]
]

function simulateChain({ antiDrift }) {
  let checkpoint = null
  let seq = 100
  for (const newestFields of ROUNDS) {
    const checkpoints = checkpoint === null ? [] : [{ seq, text: checkpoint }]
    const plan = planChainedSummary({
      checkpoints,
      newMessageCount: checkpoints.length === 0 ? 0 : 2
    })
    const carried = antiDrift && plan.mode === "chain" ? plan.requiredFields : []
    const fields = [...new Set([...carried, ...newestFields])]
    checkpoint = render(fields)
    seq += 1
  }
  return extractFields(checkpoint)
}

test("the field vocabulary is the template vocabulary, not a copy", () => {
  assert.deepEqual([...CORE_FIELD_IDS], ["progress", "context", "next-steps", "references"])
  assert.deepEqual([...OPTIONAL_FIELD_IDS], ["files", "pitfalls"])
})

test("CORE: three chained compactions keep every deep field", () => {
  const finalFields = simulateChain({ antiDrift: true })
  for (const id of [...CORE_FIELD_IDS, ...OPTIONAL_FIELD_IDS]) {
    assert.ok(finalFields.includes(id), id + " survived the chain")
  }
})

test("REVERSE: removing the anti-drift directives loses the deep fields", () => {
  // If this passes, the CORE test above measures the anti-drift logic rather than
  // the harness: without the directive the model writes only the newest fields.
  const degraded = simulateChain({ antiDrift: false })
  assert.deepEqual([...degraded], ["progress"], "only the newest round survives")
  assert.ok(!degraded.includes("files"), "the deep field is exactly what anti-drift protects")
  const kept = simulateChain({ antiDrift: true })
  assert.ok(kept.length > degraded.length)
})

test("R1: a region holding only a checkpoint is a no-op, never a re-summary", () => {
  const plan = planChainedSummary({ checkpoints: [{ seq: 7, text: render(CORE_FIELD_IDS) }], newMessageCount: 0 })
  assert.equal(plan.mode, "noop")
  assert.equal(plan.reason, "r1-pure-checkpoint-region")
  assert.deepEqual([...plan.carry], [])
  assert.deepEqual([...plan.directives], [])
})

test("R2: new history plus a checkpoint chains, and carries the previous summary", () => {
  const previous = render([...CORE_FIELD_IDS, "files"])
  const plan = planChainedSummary({ checkpoints: [{ seq: 7, text: previous }], newMessageCount: 3 })
  assert.equal(plan.mode, "chain")
  assert.equal(plan.reason, "r2-new-history-plus-checkpoint")
  assert.equal(plan.carry.length, 1)
  assert.equal(plan.carry[0].text, previous)
  assert.deepEqual([...plan.directives], [...CHAIN_DIRECTIVES])
  assert.ok(plan.requiredFields.includes("files"), "an extra that was present must survive")
  assert.ok(!plan.requiredFields.includes("pitfalls"), "an extra that was absent is not required")
})

test("R3: no checkpoint in range is a fresh summary with only the core required", () => {
  const plan = planChainedSummary({ checkpoints: [], newMessageCount: 9 })
  assert.equal(plan.mode, "fresh")
  assert.deepEqual([...plan.requiredFields], [...CORE_FIELD_IDS])
  assert.deepEqual([...plan.carry], [])
})

test("the plan is pure: identical input gives an identical plan", () => {
  const input = { checkpoints: [{ seq: 3, text: render(["progress", "files"]) }], newMessageCount: 1 }
  assert.deepEqual(planChainedSummary(input), planChainedSummary(input))
  assert.ok(Object.isFrozen(planChainedSummary(input)))
})

test("requiredCarryFields keeps the core four and only the extras that were present", () => {
  assert.deepEqual([...requiredCarryFields([])], [...CORE_FIELD_IDS])
  assert.deepEqual([...requiredCarryFields(["files"])], [...CORE_FIELD_IDS, "files"])
  assert.deepEqual([...requiredCarryFields(["pitfalls", "files"])], [...CORE_FIELD_IDS, "files", "pitfalls"])
})

test("the field matcher recognises ids and template bullets", () => {
  const progress = CODEX_SUMMARY_FIELDS[0]
  assert.equal(defaultFieldMatcher(render(["progress"]), progress), true)
  assert.equal(defaultFieldMatcher("nothing to see here", progress), false)
  assert.equal(defaultFieldMatcher("mentions progress in passing", progress), false)
})

test("extractFields rejects an id the template does not know", () => {
  assert.throws(() => extractFields("anything", ["nope"]), TypeError)
})

test("assertAntiDrift fails loud, listing every lost field", () => {
  const required = [...CORE_FIELD_IDS, "files"]
  const healthy = render(["progress", "context", "next-steps", "references", "files"])
  assert.deepEqual(assertAntiDrift(required, healthy), required)

  const degraded = render(["progress"])
  assert.deepEqual([...missingCarryFields(required, healthy)], [])
  assert.deepEqual([...missingCarryFields(required, degraded)], ["context", "next-steps", "references", "files"])

  assert.throws(() => assertAntiDrift(required, degraded), (error) => {
    assert.ok(error instanceof RangeError)
    assert.match(error.message, /dropped required field\(s\)/)
    for (const id of ["context", "next-steps", "references", "files"]) {
      assert.match(error.message, new RegExp(id))
    }
    return true
  })
})

test("the fingerprint is stable, discriminating and 8 hex digits", () => {
  assert.equal(summaryFingerprint("abc"), summaryFingerprint("abc"))
  assert.notEqual(summaryFingerprint("abc"), summaryFingerprint("abd"))
  assert.match(summaryFingerprint("anything"), /^[0-9a-f]{8}$/)
  assert.match(summaryFingerprint(""), /^[0-9a-f]{8}$/)
})

test("the ledger admits a range once and treats a repeat as a duplicate", () => {
  const ledger = createCompactionLedger()
  const fingerprint = summaryFingerprint(render(CORE_FIELD_IDS))
  const first = admitCompaction(ledger, { start: 1, end: 9, fingerprint })
  assert.equal(first.action, "run")
  assert.equal(first.reason, "i1-first-attempt")
  assert.equal(first.key, "1:9")

  const repeat = admitCompaction(ledger, { start: 1, end: 9, fingerprint })
  assert.equal(repeat.action, "duplicate", "the same range and checkpoint must not compact twice")
  assert.equal(repeat.reason, "i2-same-range-same-checkpoint")

  const rewritten = admitCompaction(ledger, { start: 1, end: 9, fingerprint: summaryFingerprint("other") })
  assert.equal(rewritten.action, "run", "the same range with different content is a real compaction")
  assert.equal(rewritten.reason, "i3-range-rewritten")

  const other = admitCompaction(ledger, { start: 2, end: 9, fingerprint })
  assert.equal(other.action, "run")
})

test("the ledger rejects malformed entries instead of guessing", () => {
  const ledger = createCompactionLedger()
  assert.throws(() => admitCompaction(ledger, { start: 1, end: 0, fingerprint: "x" }), TypeError)
  assert.throws(() => admitCompaction(ledger, { start: 1.5, end: 9, fingerprint: "x" }), TypeError)
  assert.throws(() => admitCompaction(ledger, { start: 1, end: 9, fingerprint: "" }), TypeError)
  assert.throws(() => admitCompaction(ledger, {}), TypeError)
})

test("checkpointPositions finds every checkpoint through the injected predicate", () => {
  const nodes = [{ seq: 1 }, { seq: 2, checkpoint: true }, { seq: 3 }, { seq: 4, checkpoint: true }]
  assert.deepEqual([...checkpointPositions(nodes, (node) => node.checkpoint === true)], [1, 3])
  assert.deepEqual([...checkpointPositions(nodes, () => false)], [])
  assert.throws(() => checkpointPositions("nodes", () => true), TypeError)
  assert.throws(() => checkpointPositions(nodes, null), TypeError)
})

test("the mode vocabulary is closed and every rule is reachable", () => {
  assert.deepEqual([...CHAIN_MODES], ["fresh", "chain", "noop"])
  const seen = new Set([
    planChainedSummary({}).mode,
    planChainedSummary({ checkpoints: [{ seq: 1, text: "x" }], newMessageCount: 1 }).mode,
    planChainedSummary({ checkpoints: [{ seq: 1, text: "x" }], newMessageCount: 0 }).mode
  ])
  assert.deepEqual([...seen].sort(), [...CHAIN_MODES].sort())
})

test("a malformed plan context fails loud", () => {
  assert.throws(() => planChainedSummary({ checkpoints: "no" }), TypeError)
  assert.throws(() => planChainedSummary({ checkpoints: [], newMessageCount: -1 }), TypeError)
  assert.throws(() => planChainedSummary({ checkpoints: [], newMessageCount: 1.5 }), TypeError)
})

/* ------------------------------------------------------------------ */
/* engine wiring (#9)                                                  */
/* ------------------------------------------------------------------ */

/** A session whose surface is exactly the given events. */
function sessionOf(events) {
  return {
    requestHeader: () => undefined,
    surface: { nodes: events.map((event) => event.seq) },
    eventAt: (seq) => events.find((event) => event.seq === seq)
  }
}

const checkpointEvent = (seq, fields) => ({
  seq,
  type: "user/message",
  data: {
    message: {
      role: "user",
      content: [{ type: "text", text: SUMMARY_PREFIX + "\n" + render(fields) }]
    }
  }
})

const plainEvent = (seq, text) => ({
  seq,
  type: "user/message",
  data: { message: { role: "user", content: [{ type: "text", text }] } }
})

/** A ctx whose logger records what the engine reports, with the payload. */
function recordingCtx() {
  const logged = []
  const ctx = createFakeCtx()
  ctx.logger = {
    info: () => {},
    warn: (message, payload) => logged.push({ message, payload }),
    error: (message, payload) => logged.push({ message, payload })
  }
  return { ctx, logged }
}

function mountEngine({ events = [], hooks = {}, helpers, ctx } = {}) {
  const { FakeBase, calls } = createFakeBase()
  const Engine = createCodexCompactionEngine(
    FakeBase,
    {
      decideCompaction: () => ({ action: "compact", reason: "test" }),
      selectCompactionRange: () => ({ start: 1, end: 9 }),
      buildSummaryRequest: () => null,
      ...hooks
    },
    helpers
  )
  const agent = { session: sessionOf(events), options: { provider: "acme", model: "big" } }
  return { engine: new Engine(ctx === undefined ? createFakeCtx() : ctx, {}), calls, agent }
}

test("engine R1: a region holding only a checkpoint is never re-summarized", async () => {
  const { engine, calls, agent } = mountEngine({ events: [checkpointEvent(1, [...CORE_FIELD_IDS, "files"])] })
  assert.equal(await engine.compactIfNeeded(agent, "pressure", undefined), null)
  assert.deepEqual(calls, [], "a pure checkpoint region must not open a transaction")
})

test("engine idempotence: the same range with the same content compacts once", async () => {
  const { engine, calls, agent } = mountEngine({
    events: [checkpointEvent(1, [...CORE_FIELD_IDS, "files"]), plainEvent(2, "new work")]
  })
  assert.notEqual(await engine.compactIfNeeded(agent, "pressure", undefined), null)
  assert.deepEqual(calls, [["compactRegion", 1, 9]])
  assert.equal(await engine.compactIfNeeded(agent, "pressure", undefined), null)
  assert.deepEqual(calls, [["compactRegion", 1, 9]], "the repeat must not open a second transaction")
})

test("engine anti-drift: a chained summary that loses a field is reported, not fatal", async () => {
  const input = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: SUMMARY_PREFIX + "\n" + render([...CORE_FIELD_IDS, "files"]) }]
      },
      { role: "user", content: [{ type: "text", text: "new work happened" }] }
    ]
  }
  const request = { prompt: "p", projection: (blocks) => blocks }
  const degraded = async () => ({ summary: [{ type: "text", text: render(["progress"]) }] })
  const faithful = async () => ({ summary: [{ type: "text", text: render([...CORE_FIELD_IDS, "files"]) }] })

  // issue #50: detection stays strict, the consequence is no longer fatal.
  const { ctx, logged } = recordingCtx()
  const strict = mountEngine({
    ctx,
    hooks: { buildSummaryRequest: () => request },
    helpers: { runSummarization: degraded }
  })
  const kept = await strict.engine.summarize(input, strict.agent, undefined)
  assert.equal(kept.summary[0].text, render(["progress"]), "the checkpoint is kept")
  assert.equal(logged.length, 1, "the drift leaves exactly one diagnostic")
  assert.match(logged[0].message, /did not account for field\(s\)/)
  assert.deepEqual(logged[0].payload.missing, ["context", "next-steps", "references", "files"])

  const lenient = mountEngine({
    hooks: { buildSummaryRequest: () => request },
    helpers: { runSummarization: faithful }
  })
  const result = await lenient.engine.summarize(input, lenient.agent, undefined)
  assert.equal(result.summary[0].text, render([...CORE_FIELD_IDS, "files"]))
})

test("engine anti-drift does not audit a fresh summary", async () => {
  const input = { messages: [{ role: "user", content: [{ type: "text", text: "no checkpoint here" }] }] }
  const request = { prompt: "p", projection: (blocks) => blocks }
  const minimal = async () => ({ summary: [{ type: "text", text: "anything at all" }] })
  const fresh = mountEngine({
    hooks: { buildSummaryRequest: () => request },
    helpers: { runSummarization: minimal }
  })
  const result = await fresh.engine.summarize(input, fresh.agent, undefined)
  assert.equal(result.summary[0].text, "anything at all")
})

/* ------------------------------------------------------------------ */
/* issue #50: the regression fixture taken from REAL model output      */
/* ------------------------------------------------------------------ */

test("REAL FIXTURE: a chained summary worded in Chinese still carries every field", () => {
  // The genuine checkpoint body from session-292e6b17. Every field is present, under
  // Chinese headings — the case our own strictly-templated fixtures could never reach,
  // and which made 5 of 9 real attempts fail.
  assert.deepEqual([...extractFields(REAL_CHAINED_SUMMARY)], [...CORE_FIELD_IDS, ...OPTIONAL_FIELD_IDS])
  const audit = auditAntiDrift([...CORE_FIELD_IDS, ...OPTIONAL_FIELD_IDS], REAL_CHAINED_SUMMARY)
  assert.equal(audit.action, "ok")
  assert.deepEqual([...audit.missing], [])
})

test("REAL FIXTURE: the headings it used are exactly the shapes the matcher reads", () => {
  assert.deepEqual([...sectionHeadings(REAL_CHAINED_SUMMARY)], [...REAL_SECTION_HEADINGS])
  assert.ok(REAL_SECTION_HEADINGS.includes("## 当前任务与状态"))
  assert.ok(REAL_SECTION_HEADINGS.includes("## 已知陷阱"))
})

test("REAL FIXTURE: the plan requires every field the real checkpoint carried", () => {
  const plan = planChainedSummary({
    checkpoints: [{ seq: 11, text: REAL_CHAINED_SUMMARY }],
    newMessageCount: 3
  })
  assert.equal(plan.mode, "chain")
  assert.deepEqual([...plan.requiredFields], [...CORE_FIELD_IDS, ...OPTIONAL_FIELD_IDS])
})

test("REAL FIXTURE: the engine reports no drift, so the chain is no longer aborted", async () => {
  const input = {
    messages: [
      { role: "user", content: [{ type: "text", text: SUMMARY_PREFIX + "\n" + REAL_CHAINED_SUMMARY }] },
      { role: "user", content: [{ type: "text", text: "new work happened" }] }
    ]
  }
  const request = { prompt: "p", projection: (blocks) => blocks }
  const reworded = async () => ({ summary: [{ type: "text", text: REAL_CHAINED_SUMMARY }] })
  const { ctx, logged } = recordingCtx()
  const run = mountEngine({ ctx, hooks: { buildSummaryRequest: () => request }, helpers: { runSummarization: reworded } })
  const result = await run.engine.summarize(input, run.agent, undefined)
  assert.equal(result.summary[0].text, REAL_CHAINED_SUMMARY)
  assert.deepEqual(logged, [], "equivalent wording must not be reported as drift")
})

test("REAL FIXTURE reverse: a section that really is gone is still caught", async () => {
  const required = [...CORE_FIELD_IDS, ...OPTIONAL_FIELD_IDS]
  const audit = auditAntiDrift(required, REAL_CHAINED_SUMMARY_WITHOUT_PITFALLS)
  assert.equal(audit.action, "degrade", "the detection must not have been loosened away")
  assert.deepEqual([...audit.missing], ["pitfalls"])

  const input = {
    messages: [
      { role: "user", content: [{ type: "text", text: SUMMARY_PREFIX + "\n" + REAL_CHAINED_SUMMARY }] },
      { role: "user", content: [{ type: "text", text: "new work happened" }] }
    ]
  }
  const request = { prompt: "p", projection: (blocks) => blocks }
  const truncated = async () => ({ summary: [{ type: "text", text: REAL_CHAINED_SUMMARY_WITHOUT_PITFALLS }] })
  const { ctx, logged } = recordingCtx()
  const run = mountEngine({ ctx, hooks: { buildSummaryRequest: () => request }, helpers: { runSummarization: truncated } })
  await run.engine.summarize(input, run.agent, undefined)
  assert.equal(logged.length, 1)
  assert.deepEqual(logged[0].payload.missing, ["pitfalls"])
})

test("the alias table never matches ordinary prose", () => {
  const prose = "我们在讨论 progress 与 files 这两件事，但完全没有章节标题。"
  assert.deepEqual([...extractFields(prose)], [], "prose must not be mistaken for a section")
  assert.ok(FIELD_HEADING_ALIASES.progress.includes("当前任务与状态"))
  assert.ok(FIELD_HEADING_ALIASES.pitfalls.includes("已知陷阱"))
})

/* ------------------------------------------------------------------ */
/* issue #50 defect B: a no-text summary is not worth retrying         */
/* ------------------------------------------------------------------ */

test("defect B: a no-text summary degrades immediately instead of retrying", () => {
  const noContent = Object.assign(new Error("summarization produced no text summary content"), {
    code: NO_CONTENT_CODE
  })
  assert.deepEqual([...NON_RETRYABLE_SUMMARY_CODES], [NO_CONTENT_CODE])
  assert.equal(
    decideCompactionFailure(noContent, 0),
    "degrade",
    "re-issuing the same request cannot conjure text; the next step's trigger retries on a fresh request"
  )
  // A generic summary failure still spends the single retry #10 allows.
  assert.equal(decideCompactionFailure(new Error("transport hiccup"), 0), "retry")
  assert.equal(decideCompactionFailure(new Error("transport hiccup"), 1), "degrade")
})

test("the duplicate check is read-only, so a failed compaction can be retried", () => {
  const ledger = createCompactionLedger()
  const entry = { start: 1, end: 9, fingerprint: "abcd1234" }
  assert.equal(isDuplicateCompaction(ledger, entry), false)
  assert.equal(isDuplicateCompaction(ledger, entry), false, "peeking must not record")
  admitCompaction(ledger, entry)
  assert.equal(isDuplicateCompaction(ledger, entry), true)
})
