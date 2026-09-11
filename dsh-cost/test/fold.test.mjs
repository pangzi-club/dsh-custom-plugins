/**
 * Fold tests: per-route/per-tier attribution, sample replacement, retry
 * addition, fork inheritance exclusion, and the peak/idle classifier.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyTier, foldUsage } from '../host/fold.js'

/** Friday 2026-09-11 10:00 Asia/Shanghai (peak window). */
const PEAK_TIME = Date.UTC(2026, 8, 11, 2, 0, 0)
/** Friday 2026-09-11 20:00 Asia/Shanghai (idle). */
const IDLE_TIME = Date.UTC(2026, 8, 11, 12, 0, 0)

function header(provider, model) {
  return { type: 'request/header', seq: 1, time: PEAK_TIME, data: { header: { config: { provider, model } } } }
}

function message({ seq, time, turn = 1, step = 1, usage, provider = 'deepseek', model = 'deepseek-flash' }) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, message: { source: { provider, model } }, ...(usage === undefined ? {} : { usage }) },
  }
}

function attempt({ seq, time, turn = 1, step = 1, usage }) {
  return {
    type: 'assistant/attempt',
    seq,
    time,
    data: {
      turn,
      step,
      stream: usage === undefined ? [] : [{ type: 'chunk', chunk: { type: 'usage', usage } }],
    },
  }
}

function rowOf(rows, model, tier) {
  return rows.find(row => row.model === model && row.tier === tier)
}

test('classifies the provider peak windows in the configured zone', () => {
  assert.equal(classifyTier(PEAK_TIME), 'peak')
  assert.equal(classifyTier(IDLE_TIME), 'idle')
  // Friday 12:30 Beijing — between the two windows.
  assert.equal(classifyTier(Date.UTC(2026, 8, 11, 4, 30, 0)), 'idle')
  // Saturday 10:00 Beijing — weekend.
  assert.equal(classifyTier(Date.UTC(2026, 8, 12, 2, 0, 0)), 'idle')
  // Friday 17:59 Beijing — still peak; 18:00 is not.
  assert.equal(classifyTier(Date.UTC(2026, 8, 11, 9, 59, 0)), 'peak')
  assert.equal(classifyTier(Date.UTC(2026, 8, 11, 10, 0, 0)), 'idle')
})

test('attributes samples to their route and billing tier', () => {
  const events = [
    header('deepseek', 'deepseek-flash'),
    message({ seq: 2, time: PEAK_TIME, step: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 } }),
    message({ seq: 3, time: IDLE_TIME, step: 2, usage: { inputTokens: 0, outputTokens: 10 } }),
    header('deepseek', 'deepseek-v4-pro'),
    message({
      seq: 4, time: PEAK_TIME, step: 3, provider: 'deepseek', model: 'deepseek-v4-pro',
      usage: { inputTokens: 10, outputTokens: 7, cacheWriteTokens: 5 },
    }),
  ]
  const { rows, samples, skipped } = foldUsage(events)
  assert.equal(samples, 3)
  assert.equal(skipped, 0)
  assert.equal(rows.length, 3)
  assert.deepEqual(rowOf(rows, 'deepseek-flash', 'peak'), {
    provider: 'deepseek', model: 'deepseek-flash', tier: 'peak',
    uncachedInputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 500,
  })
  assert.deepEqual(rowOf(rows, 'deepseek-flash', 'idle'), {
    provider: 'deepseek', model: 'deepseek-flash', tier: 'idle',
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10,
  })
  assert.deepEqual(rowOf(rows, 'deepseek-v4-pro', 'peak'), {
    provider: 'deepseek', model: 'deepseek-v4-pro', tier: 'peak',
    uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 5, outputTokens: 7,
  })
})

test('a restated sample replaces the previous one for the same step', () => {
  const events = [
    header('deepseek', 'deepseek-flash'),
    message({ seq: 2, time: PEAK_TIME, usage: { inputTokens: 100, outputTokens: 10 } }),
    message({ seq: 3, time: PEAK_TIME, usage: { inputTokens: 300, outputTokens: 30 } }),
  ]
  const { rows, samples } = foldUsage(events)
  assert.equal(samples, 2)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].uncachedInputTokens, 300)
  assert.equal(rows[0].outputTokens, 30)
})

test('a retried attempt adds to the same step instead of replacing it', () => {
  const events = [
    header('deepseek', 'deepseek-flash'),
    message({ seq: 2, time: PEAK_TIME, usage: { inputTokens: 100, outputTokens: 10 } }),
    { type: 'llm/retry-started', seq: 3, time: PEAK_TIME, data: { turn: 1, step: 1, retry: 1 } },
    message({ seq: 4, time: IDLE_TIME, usage: { inputTokens: 200, outputTokens: 20 } }),
  ]
  const { rows } = foldUsage(events)
  assert.equal(rowOf(rows, 'deepseek-flash', 'peak').uncachedInputTokens, 100)
  assert.equal(rowOf(rows, 'deepseek-flash', 'idle').uncachedInputTokens, 200)
})

test('an attempt event without a message source uses the effective request header', () => {
  const events = [
    header('deepseek', 'deepseek-flash'),
    attempt({ seq: 2, time: PEAK_TIME, usage: { inputTokens: 42, outputTokens: 4 } }),
  ]
  const { rows } = foldUsage(events)
  assert.deepEqual(rows[0], {
    provider: 'deepseek', model: 'deepseek-flash', tier: 'peak',
    uncachedInputTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 4,
  })
})

test('fork-inherited events are excluded from the owned cost', () => {
  const events = [
    header('deepseek', 'deepseek-flash'),
    message({ seq: 2, time: PEAK_TIME, usage: { inputTokens: 9_999, outputTokens: 9_999 } }),
    message({ seq: 3, time: PEAK_TIME, step: 2, usage: { inputTokens: 7, outputTokens: 3 } }),
  ]
  const { rows, samples } = foldUsage(events, { inheritedEventCount: 2 })
  assert.equal(samples, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].uncachedInputTokens, 7)
  assert.equal(rows[0].outputTokens, 3)
})

test('unusable samples are skipped, never guessed', () => {
  const events = [
    header('deepseek', 'deepseek-flash'),
    message({ seq: 2, time: PEAK_TIME, usage: { inputTokens: 10 } }),
    message({ seq: 3, time: PEAK_TIME, step: 2, usage: { inputTokens: 10, outputTokens: -1 } }),
  ]
  const { rows, samples, skipped } = foldUsage(events)
  assert.equal(samples, 0)
  assert.equal(skipped, 2)
  assert.equal(rows.length, 0)
})

test('an attempt with no effective route is skipped', () => {
  const events = [attempt({ seq: 1, time: PEAK_TIME, usage: { inputTokens: 10, outputTokens: 1 } })]
  const { rows, samples, skipped } = foldUsage(events)
  assert.equal(samples, 0)
  assert.equal(skipped, 1)
  assert.equal(rows.length, 0)
})

test('rows that net to zero after replacement are dropped', () => {
  const events = [
    header('deepseek', 'deepseek-flash'),
    message({ seq: 2, time: PEAK_TIME, usage: { inputTokens: 100, outputTokens: 10 } }),
    // A restated sample for the same step that reports nothing.
    message({ seq: 3, time: PEAK_TIME, usage: { inputTokens: 0, outputTokens: 0 } }),
  ]
  const { rows, samples, skipped } = foldUsage(events)
  assert.equal(samples, 2)
  assert.equal(skipped, 0)
  assert.equal(rows.length, 0)
})
