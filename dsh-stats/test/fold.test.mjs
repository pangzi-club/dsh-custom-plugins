/**
 * Tests for the usage fold: per-route accumulation, bucket normalization,
 * and the skipping of unusable samples.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeUsage } from '../host/fold.js'

const TIME = Date.UTC(2026, 8, 11, 2, 0, 0)

/** One assistant message sample. */
function message(seq, route, usage) {
  return {
    type: 'assistant/message',
    seq,
    time: TIME,
    data: { turn: 1, step: seq, message: { source: route }, usage },
  }
}

test('folds usage samples per model route', () => {
  const events = [
    message(1, { provider: 'deepseek', model: 'flash' }, { inputTokens: 100, outputTokens: 200 }),
    message(2, { provider: 'deepseek', model: 'flash' }, { inputTokens: 1, cacheReadTokens: 10 }),
    message(3, { provider: 'deepseek', model: 'pro' }, { outputTokens: 5 }),
  ]
  const fold = summarizeUsage(events)
  assert.equal(fold.samples, 3)
  assert.equal(fold.skipped, 0)
  assert.equal(fold.rows.length, 2)
  const flash = fold.rows.find(row => row.model === 'flash')
  assert.equal(flash.uncachedInputTokens, 101)
  assert.equal(flash.cacheReadTokens, 10)
  assert.equal(flash.outputTokens, 200)
  assert.deepEqual(fold.totals, {
    uncachedInputTokens: 101,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 205,
  })
})

test('skips assistant messages without usable usage', () => {
  const events = [
    {
      type: 'request/header', seq: 1, time: TIME,
      data: { header: { config: { provider: 'deepseek', model: 'flash' } } },
    },
    message(2, { provider: 'deepseek', model: 'flash' }, {}),
    message(3, { provider: 'deepseek', model: 'flash' }, undefined),
  ]
  const fold = summarizeUsage(events)
  assert.equal(fold.samples, 0)
  assert.equal(fold.skipped, 2)
  assert.deepEqual(fold.rows, [])
})

test('tolerates non-array event logs', () => {
  assert.deepEqual(summarizeUsage(undefined).rows, [])
  assert.deepEqual(summarizeUsage(null).totals, {
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  })
})
