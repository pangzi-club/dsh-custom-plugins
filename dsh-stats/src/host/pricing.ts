/**
 * Price table for the usage pill: model rates in a currency per one million
 * tokens, resolved from built-in defaults plus the plugin row's `pricing`
 * override.
 *
 * DeepSeek bills three prompt/output positions and has no separate cache-write
 * price, so a rate carries `cacheRead`, `input`, and `output` only; a cache
 * write is charged as uncached input. Every model entry holds a peak rate and
 * an idle rate (official idle billing is half of peak, which is the default
 * when `idle` is omitted).
 *
 * The built-in snapshot mirrors `dsh-cost/host/pricing.js`; when the provider
 * reprices, override per model from the plugin row instead of editing here.
 */

import type { UsageBuckets, UsageRow } from './fold.js'

/** Currency the built-in table is denominated in. */
export const DEFAULT_CURRENCY = 'CNY'

/** One tier's rates: currency units per 1M tokens. */
export interface Rate {
  cacheRead: number
  input: number
  output: number
}

/** Both billing tiers for one model. */
export interface ModelRates {
  peak: Rate
  idle: Rate
}

/** A priced `(provider, model)` route as it appears in the summary. */
export interface PricedRoute extends UsageBuckets {
  provider: string
  model: string
  peakTokens: number
  peakAmount: number
  idleTokens: number
  idleAmount: number
  amount: number
}

/** A route no effective rate covers. */
export interface UnpricedRoute {
  provider: string
  model: string
  tokens: number
}

/** Result of {@link priceRows}. */
export interface PriceResult {
  total: number
  routes: PricedRoute[]
  unpriced: UnpricedRoute[]
}

/** Official DeepSeek peak rates (CNY per 1M tokens) for the shipped model ids. */
const FLASH_PEAK = Object.freeze<Rate>({ cacheRead: 0.04, input: 2, output: 8 })
const PRO_PEAK = Object.freeze<Rate>({ cacheRead: 0.3, input: 9, output: 13.5 })

/** A model entry as written in the built-in table or in a user override. */
interface PricingSource {
  peak?: unknown
  idle?: unknown
}

/**
 * Built-in rates keyed by the model id a session log records. The legacy Flash
 * ids are billed as Flash, per the provider's own pricing note; `deepseek-v4-pro`
 * keeps its own list price (a deployment whose account bills it as Flash sets
 * that override in the plugin row).
 */
export const DEFAULT_PRICING: Readonly<Record<string, Readonly<PricingSource>>> = Object.freeze({
  'deepseek-flash': Object.freeze({ peak: FLASH_PEAK }),
  'deepseek-v4-flash': Object.freeze({ peak: FLASH_PEAK }),
  'deepseek-v4-flash-vision-exp': Object.freeze({ peak: FLASH_PEAK }),
  'deepseek-v4-pro': Object.freeze({ peak: PRO_PEAK }),
})

const RATE_KEYS = ['cacheRead', 'input', 'output'] as const
type RateKey = (typeof RATE_KEYS)[number]

/** Read one non-negative finite rate field. */
function rateField(value: Record<string, unknown>, model: string, tier: string, key: RateKey): number {
  const raw = value[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`dsh-stats: pricing.${model}.${tier}.${key} must be a non-negative number`)
  }
  return raw
}

/** Validate one tier's rate object. */
function normalizeRate(value: unknown, model: string, tier: string): Rate {
  if (value === null || typeof value !== 'object') {
    throw new Error(`dsh-stats: pricing.${model}.${tier} must be an object with ${RATE_KEYS.join('/')}`)
  }
  const source = value as Record<string, unknown>
  const rate = {} as Record<RateKey, number>
  for (const key of RATE_KEYS) rate[key] = rateField(source, model, tier, key)
  return rate
}

/** Validate one model entry, defaulting the idle tier to half of peak. */
function normalizeModel(value: unknown, model: string): ModelRates {
  if (value === null || typeof value !== 'object') {
    throw new Error(`dsh-stats: pricing.${model} must be an object or null to drop the built-in rate`)
  }
  const source = value as PricingSource
  const peak = normalizeRate(source.peak ?? source, model, 'peak')
  const idle = source.idle === undefined
    ? { cacheRead: peak.cacheRead / 2, input: peak.input / 2, output: peak.output / 2 }
    : normalizeRate(source.idle, model, 'idle')
  return { peak, idle }
}

/**
 * Build the effective price table: built-in defaults with the row's `pricing`
 * merged over them per model (a `null` entry drops a model so it reports as
 * unpriced instead of silently keeping a stale rate).
 * @param pricing - the plugin row's `pricing` mapping, when provided.
 * @returns model key (bare id or `provider/model`) to validated rates.
 */
export function normalizePricing(pricing: unknown): Map<string, ModelRates> {
  const entries = new Map<string, unknown>(Object.entries(DEFAULT_PRICING))
  if (pricing !== undefined) {
    if (pricing === null || typeof pricing !== 'object' || Array.isArray(pricing)) {
      throw new Error('dsh-stats: config.pricing must be an object mapping model ids to rates')
    }
    for (const [key, value] of Object.entries(pricing)) {
      if (value === null) entries.delete(key)
      else entries.set(key, normalizeModel(value, key))
    }
  }
  const table = new Map<string, ModelRates>()
  for (const [key, value] of entries) table.set(key, normalizeModel(value, key))
  return table
}

/** Money owed for one tier's buckets under one rate. */
function amountOf(rate: Rate, buckets: UsageBuckets): number {
  return (
    buckets.cacheReadTokens * rate.cacheRead
    + (buckets.uncachedInputTokens + buckets.cacheWriteTokens) * rate.input
    + buckets.outputTokens * rate.output
  ) / 1_000_000
}

/**
 * Price folded `(provider, model, tier)` token rows.
 * @param rows - folded rows from `summarizeUsage`.
 * @param table - effective price table from {@link normalizePricing}.
 * @returns total, currency rows, per-route rows, and unpriced routes.
 */
export function priceRows(rows: readonly UsageRow[], table: Map<string, ModelRates>): PriceResult {
  const routes = new Map<string, PricedRoute>()
  const unpriced = new Map<string, UnpricedRoute>()
  for (const row of rows) {
    const prices = table.get(`${row.provider}/${row.model}`) ?? table.get(row.model)
    const tokens = row.uncachedInputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens
    const routeKey = `${row.provider}\u0000${row.model}`
    if (prices === undefined) {
      const existing = unpriced.get(routeKey) ?? {
        provider: row.provider, model: row.model, tokens: 0,
      }
      existing.tokens += tokens
      unpriced.set(routeKey, existing)
      continue
    }
    const existing = routes.get(routeKey) ?? {
      provider: row.provider,
      model: row.model,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      peakTokens: 0,
      peakAmount: 0,
      idleTokens: 0,
      idleAmount: 0,
      amount: 0,
    }
    const rate = prices[row.tier]
    const amount = amountOf(rate, row)
    existing.uncachedInputTokens += row.uncachedInputTokens
    existing.cacheReadTokens += row.cacheReadTokens
    existing.cacheWriteTokens += row.cacheWriteTokens
    existing.outputTokens += row.outputTokens
    if (row.tier === 'peak') {
      existing.peakTokens += tokens
      existing.peakAmount += amount
    } else {
      existing.idleTokens += tokens
      existing.idleAmount += amount
    }
    existing.amount += amount
    routes.set(routeKey, existing)
  }
  const list = [...routes.values()].sort((left, right) => right.amount - left.amount)
  return {
    total: list.reduce((sum, route) => sum + route.amount, 0),
    routes: list,
    unpriced: [...unpriced.values()].sort((left, right) => right.tokens - left.tokens),
  }
}
