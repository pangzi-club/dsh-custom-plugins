/**
 * Price-table tests: default rates, overrides, per-tier resolution, and the
 * arithmetic that turns folded token rows into money.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CURRENCY, normalizePricing, priceRows } from '../host/pricing.js'

function rows(...entries) {
  return entries
}

test('ships the official DeepSeek CNY rates with idle defaulting to half', () => {
  const table = normalizePricing(undefined)
  assert.equal(DEFAULT_CURRENCY, 'CNY')
  assert.deepEqual(table.get('deepseek-flash').peak, { cacheRead: 0.04, input: 2, output: 8 })
  assert.deepEqual(table.get('deepseek-flash').idle, { cacheRead: 0.02, input: 1, output: 4 })
  assert.deepEqual(table.get('deepseek-v4-pro').peak, { cacheRead: 0.3, input: 9, output: 13.5 })
  // Legacy Flash ids bill as Flash.
  assert.deepEqual(table.get('deepseek-v4-flash-vision-exp').peak, table.get('deepseek-flash').peak)
})

test('a bare rate object is a peak rate; an explicit idle rate wins', () => {
  const table = normalizePricing({
    'deepseek-flash': { cacheRead: 1, input: 2, output: 4 },
    'deepseek-v4-pro': { peak: { cacheRead: 0.3, input: 9, output: 13.5 }, idle: { cacheRead: 0.1, input: 1, output: 2 } },
  })
  assert.deepEqual(table.get('deepseek-flash').idle, { cacheRead: 0.5, input: 1, output: 2 })
  assert.deepEqual(table.get('deepseek-v4-pro').idle, { cacheRead: 0.1, input: 1, output: 2 })
})

test('a null entry drops a built-in rate so the model reports as unpriced', () => {
  const table = normalizePricing({ 'deepseek-v4-pro': null })
  assert.equal(table.has('deepseek-v4-pro'), false)
  const priced = priceRows(rows({ provider: 'deepseek', model: 'deepseek-v4-pro', tier: 'peak', uncachedInputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), table)
  assert.equal(priced.total, 0)
  assert.deepEqual(priced.unpriced, [{ provider: 'deepseek', model: 'deepseek-v4-pro', tokens: 5 }])
})

test('malformed pricing fails loudly', () => {
  assert.throws(() => normalizePricing({ 'deepseek-flash': { input: 2, output: 8 } }), /cacheRead/)
  assert.throws(() => normalizePricing({ 'deepseek-flash': { cacheRead: -1, input: 2, output: 8 } }), /non-negative/)
  assert.throws(() => normalizePricing({ 'deepseek-flash': 'cheap' }), /must be an object/)
  assert.throws(() => normalizePricing([]), /must be an object mapping/)
})

test('prices each tier and charges cache writes as uncached input', () => {
  const table = normalizePricing(undefined)
  const priced = priceRows(rows(
    {
      provider: 'deepseek', model: 'deepseek-flash', tier: 'peak',
      uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000,
    },
    {
      provider: 'deepseek', model: 'deepseek-flash', tier: 'idle',
      uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    },
  ), table)
  // Peak: 0.04 + (2 + 2) + 8 = 12.04; idle: 1.
  assert.equal(priced.routes.length, 1)
  const flash = priced.routes[0]
  assert.equal(flash.peakAmount, 12.04)
  assert.equal(flash.idleAmount, 1)
  assert.equal(flash.amount, 13.04)
  assert.equal(flash.peakTokens, 4_000_000)
  assert.equal(flash.idleTokens, 1_000_000)
  assert.equal(priced.total, 13.04)
})

test('a provider-qualified key wins over the bare model id', () => {
  const table = normalizePricing({
    'legacy/flash': { cacheRead: 0, input: 1, output: 0 },
  })
  const priced = priceRows(rows({
    provider: 'legacy', model: 'flash', tier: 'peak',
    uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  }), table)
  assert.equal(priced.total, 1)
})

test('unpriced routes are reported with their token totals', () => {
  const table = normalizePricing(undefined)
  const priced = priceRows(rows(
    {
      provider: 'other', model: 'mystery', tier: 'peak',
      uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 1,
    },
    {
      provider: 'deepseek', model: 'deepseek-v4-pro', tier: 'peak',
      uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    },
  ), table)
  assert.deepEqual(priced.unpriced, [{ provider: 'other', model: 'mystery', tokens: 16 }])
  assert.equal(priced.routes.length, 1)
  assert.equal(priced.total, 9)
})
