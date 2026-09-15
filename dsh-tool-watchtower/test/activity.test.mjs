/**
 * Pure-function tests for the activity fold: assistant-stream frame folding,
 * ring truncation, the decision/prompt records, the route slot, and the
 * revision counter the live provider compares.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityLog, foldTotals, promptChars } from '../lib/host/activity.js'

test('a model attempt folds start → usage chunk → end', () => {
  const log = new ActivityLog(8)
  log.recordFrame({ type: 'start', attemptId: 'a1', turn: 2, step: 1 }, 1000)
  log.recordFrame({ type: 'chunk', attemptId: 'a1', time: 1050, chunk: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } } }, 1060)
  log.recordFrame({ type: 'end', attemptId: 'a1', outcome: { kind: 'committed' } }, 1100)
  const { records, totals } = log.snapshot()
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 })
  assert.equal(records[0].outcome, 'committed')
  assert.equal(records[0].endedAt, 1100)
  assert.equal(totals.modelAttempts, 1)
  assert.equal(totals.inputTokens, 10)

  // Chunks for an unknown attempt are ignored, end never double-counts.
  log.recordFrame({ type: 'end', attemptId: 'a1', outcome: { kind: 'abandoned' } }, 1200)
  assert.equal(log.snapshot().records[0].outcome, 'committed')
})

test('an attempt without a usage chunk still counts, without moving the token buckets', () => {
  const log = new ActivityLog(8)
  log.recordFrame({ type: 'start', attemptId: 'a1' }, 1000)
  log.recordFrame({ type: 'chunk', attemptId: 'a1', time: 1050, chunk: { type: 'text-delta', delta: 'hi' } }, 1060)
  log.recordFrame({ type: 'end', attemptId: 'a1', outcome: { kind: 'abandoned' } }, 1100)
  const { records, totals } = log.snapshot()
  assert.equal(records[0].usage, undefined)
  assert.equal(records[0].outcome, 'abandoned')
  assert.equal(totals.modelAttempts, 1)
  assert.equal(totals.inputTokens, 0)
  assert.equal(totals.outputTokens, 0)
})

test('records are newest-first and the ring truncates at the limit', () => {
  const log = new ActivityLog(2)
  log.recordTool(1, 'c1', 'read', false)
  log.recordTool(2, 'c2', 'write', false)
  log.recordTool(3, 'c3', 'list', false)
  const { records } = log.snapshot()
  assert.deepEqual(records.map(record => record.callId), ['c3', 'c2'])
})

test('tool records carry the error code and the wrapper duration only when present', () => {
  const log = new ActivityLog(8)
  log.recordTool(1, 'c1', 'read', true, 'ABORTED', 42)
  log.recordTool(2, 'c2', 'write', false)
  const [ok, aborted] = log.snapshot().records // newest first
  assert.equal(aborted.code, 'ABORTED')
  assert.equal(aborted.durationMs, 42)
  assert.equal(aborted.isError, true)
  assert.equal(ok.code, undefined)
  assert.equal(ok.durationMs, undefined)
})

test('gate verdicts and prompts fold into their own totals', () => {
  const log = new ActivityLog(8)
  log.recordDecision(1, 'write', 'deny', 'read-only session')
  log.recordDecision(2, 'web_fetch', 'ask')
  log.recordPrompt(3, 120)
  log.recordTool(4, 'c1', 'read', false)
  const { totals } = log.snapshot()
  assert.equal(totals.denied, 1)
  assert.equal(totals.asked, 1)
  assert.equal(totals.prompts, 1)
  assert.equal(totals.tools, 1)
  assert.equal(totals.toolErrors, 0)
})

test('the route slot replaces — never appends — and is served by the snapshot', () => {
  const log = new ActivityLog(8)
  assert.equal(log.snapshot().route, undefined)
  log.setRoute(1, 'provider-a', 'model-a')
  log.setRoute(2, 'provider-b', 'model-b')
  const { route, records } = log.snapshot()
  assert.deepEqual(route, { time: 2, provider: 'provider-b', model: 'model-b' })
  assert.equal(records.length, 0, 'route changes are not activity records')
})

test('every snapshot-visible mutation bumps the revision', () => {
  const log = new ActivityLog(8)
  const revision = () => log.snapshot().revision
  assert.equal(revision(), 0)
  log.recordTool(1, 'c1', 'read', false)
  const afterTool = revision()
  assert.ok(afterTool > 0)
  log.setRoute(2, 'p', 'm')
  assert.ok(revision() > afterTool, 'route changes must reach the poll provider')
})

test('promptChars counts text-block characters only, and defensively', () => {
  assert.equal(promptChars(undefined), 0)
  assert.equal(promptChars('nope'), 0)
  assert.equal(
    promptChars([
      { type: 'text', text: 'abc' },
      { type: 'image', url: 'x' },
      { type: 'text', text: 'de' },
    ]),
    5,
  )
})

test('foldTotals over an empty list is the zero fold', () => {
  assert.deepEqual(foldTotals([]), {
    tools: 0,
    toolErrors: 0,
    denied: 0,
    asked: 0,
    prompts: 0,
    modelAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
})
