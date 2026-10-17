/** Shared fixtures for the D2/D3 selector tests: a surface-only fake session, an
 * independent reference of the host tool-pairing algorithm, the shared C1/C2
 * acceptance check, and a random surface generator. The reference follows
 * dsh-compaction/lib/types/tool-pairing.js (0.2.1-rc.2), never select.js. */

import assert from 'node:assert/strict'

import { DEFAULT_POLICY } from '../../lib/core/config.js'
import { planCompactionRange, selectCompactionRange } from '../../lib/core/select.js'

/** Session events from a descriptor DSL: system|user|result|callN|assistant. */
export function build(kinds) {
  return kinds.map((kind, seq) => {
    if (kind === 'system') return { seq, type: 'system/message', data: { message: { content: [] } } }
    if (kind === 'user') return { seq, type: 'user/message', data: { role: 'user', content: [] } }
    if (kind === 'result') return { seq, type: 'tool/result', data: { message: { content: [] } } }
    if (kind.startsWith('call')) {
      const count = Number(kind.slice(4))
      const content = Array.from({ length: count }, (_, index) => ({ type: 'tool-call', id: 'c' + seq + '-' + index }))
      return { seq, type: 'assistant/message', data: { message: { content } } }
    }
    return { seq, type: 'assistant/message', data: { message: { content: [] } } }
  })
}

export const sequences = (events) => events.map((event) => event.seq)
export const indexOfSeq = (events, seq) => events.findIndex((event) => event.seq === seq)

/** Read-only session: any write attempt throws. */
export function sessionOf(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    surface: { nodes: sequences(events), replaceGeneration: 0, contentGeneration: 0 },
    eventAt: (seq) => bySeq.get(seq),
    append() {
      throw new Error('the selector must never write a session event')
    }
  }
}

/** Session that throws on every capability the selector has no business reading. */
export function guardedSession(events, touched) {
  return new Proxy(sessionOf(events), {
    get(target, property) {
      touched.push(String(property))
      if (property !== 'surface' && property !== 'eventAt') {
        throw new Error('the selector touched a non-session capability: ' + String(property))
      }
      return Reflect.get(target, property)
    }
  })
}

/** Independent reference delta, from dsh-compaction/lib/types/tool-pairing.js. */
export function referenceDelta(event) {
  if (event.type === 'tool/result') return -1
  if (event.type !== 'assistant/message') return 0
  return event.data.message.content.filter((block) => block.type === 'tool-call').length
}

/** Independent reference cut table: cuts[i] is the cut before surface position i. */
export function referenceCuts(events) {
  const cuts = [true]
  let open = 0
  for (const event of events) {
    open += referenceDelta(event)
    assert.ok(open >= 0, 'reference: corrupt surface')
    cuts.push(open === 0)
  }
  return cuts
}

/**
 * Shared C1/C2 acceptance check. The real selector and every naive reverse-test
 * implementation are judged by this exact function, so a throw here proves the
 * assertion discriminates.
 */
export function assertSafeRange(events, range, label) {
  const where = label === undefined ? '' : label + ': '
  assert.notEqual(range, null, where + 'expected a range')
  const startIndex = indexOfSeq(events, range.start)
  const endIndex = indexOfSeq(events, range.end)
  assert.notEqual(startIndex, -1, where + 'start must be on the surface')
  assert.notEqual(endIndex, -1, where + 'end must be on the surface')
  assert.ok(startIndex >= 1, where + 'surface node 0 must never be shadowed')
  assert.ok(startIndex <= endIndex, where + 'the span must not be reversed')
  const cuts = referenceCuts(events)
  assert.equal(cuts[startIndex], true, where + 'leading cut must be tool-pairing balanced')
  assert.equal(cuts[endIndex + 1], true, where + 'trailing cut must be tool-pairing balanced')
  // Both the shadowed span and the retained tail must be self-contained.
  for (const [from, to] of [[startIndex, endIndex], [endIndex + 1, events.length - 1]]) {
    let open = 0
    for (let index = from; index <= to; index += 1) {
      open += referenceDelta(events[index])
      assert.ok(open >= 0, where + 'an orphan tool result would be split from its call')
    }
  }
  let shadowed = 0
  for (let index = startIndex; index <= endIndex; index += 1) shadowed += referenceDelta(events[index])
  assert.equal(shadowed, 0, where + 'the shadowed span must close every call it contains')
}

export const policy = (overrides) => ({ ...DEFAULT_POLICY, ...overrides })
export const planOf = (events, overrides, extra) =>
  planCompactionRange({ session: sessionOf(events), policy: policy(overrides), ...extra })
export const rangeOf = (events, overrides, extra) =>
  selectCompactionRange({ session: sessionOf(events), policy: policy(overrides), ...extra })

/** Deterministic PRNG so a failing property case is reproducible. */
export function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Random but structurally valid surface descriptors (open calls may remain). */
export function randomKinds(rng) {
  const kinds = [rng() < 0.6 ? 'system' : 'user']
  let open = 0
  for (let step = 0, steps = 3 + Math.floor(rng() * 16); step < steps; step += 1) {
    const roll = rng()
    if (open > 0 && roll < 0.5) {
      kinds.push('result')
      open -= 1
    } else if (roll < 0.26) {
      kinds.push('user')
    } else if (roll < 0.33) {
      kinds.push('system')
    } else {
      const calls = Math.floor(rng() * 4)
      kinds.push('call' + calls)
      open += calls
    }
  }
  while (open > 0 && rng() < 0.7) {
    kinds.push('result')
    open -= 1
  }
  return kinds
}
