import assert from "node:assert/strict"
import { test } from "node:test"

import { createCodexCompactionEngine } from "../lib/engine.js"
import { CODEX_SUMMARY_FIELDS, EXTRA_SUMMARY_FIELDS, SUMMARY_PREFIX } from "../lib/core/prompt.js"
import { createFakeBase, createFakeCtx } from "./support/fake-base.mjs"
import {
  CHAIN_DIRECTIVES,
  CHAIN_MODES,
  CORE_FIELD_IDS,
  OPTIONAL_FIELD_IDS,
  admitCompaction,
  assertAntiDrift,
  checkpointPositions,
  createCompactionLedger,
  defaultFieldMatcher,
  extractFields,
  isDuplicateCompaction,
  missingCarryFields,
  planChainedSummary,
  requiredCarryFields,
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

function mountEngine({ events = [], hooks = {}, helpers } = {}) {
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
  return { engine: new Engine(createFakeCtx(), {}), calls, agent }
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

test("engine anti-drift: a chained summary that loses a field is refused", async () => {
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

  const strict = mountEngine({
    hooks: { buildSummaryRequest: () => request },
    helpers: { runSummarization: degraded }
  })
  await assert.rejects(
    () => strict.engine.summarize(input, strict.agent, undefined),
    /dropped required field\(s\) .*files/
  )

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

test("the duplicate check is read-only, so a failed compaction can be retried", () => {
  const ledger = createCompactionLedger()
  const entry = { start: 1, end: 9, fingerprint: "abcd1234" }
  assert.equal(isDuplicateCompaction(ledger, entry), false)
  assert.equal(isDuplicateCompaction(ledger, entry), false, "peeking must not record")
  admitCompaction(ledger, entry)
  assert.equal(isDuplicateCompaction(ledger, entry), true)
})
