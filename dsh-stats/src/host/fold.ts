/**
 * Fold a session's durable event log into per-model, per-tier token totals.
 * Pure: no clock, no I/O, no ctx — trivially unit-testable.
 */

/** Peak billing windows in local time: inclusive hour, exclusive end hour. */
export const PEAK_WINDOWS = Object.freeze([[9, 12], [14, 18]])

/** Time zone the provider's billing tiers are defined in. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** Billing tier one usage sample falls in. */
export type Tier = 'peak' | 'idle'

/** The four token buckets every aggregate in this module carries. */
export interface UsageBuckets {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** Folded totals for one (provider, model, tier) route. */
export interface UsageRow extends UsageBuckets {
  provider: string
  model: string
  tier: Tier
}

/** Result of {@link summarizeUsage}. */
export interface UsageSummary {
  rows: UsageRow[]
  totals: UsageBuckets
  samples: number
  skipped: number
}

/** Options for {@link summarizeUsage}. */
export interface SummarizeOptions {
  timeZone?: string
}

/** One usage sample as recorded on the event; every bucket is optional. */
interface UsageSample {
  inputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  outputTokens?: unknown
}

/** The `assistant/message` event shape the fold reads; other events are skipped. */
interface SessionEvent {
  type?: unknown
  time?: unknown
  data?: {
    usage?: UsageSample
    message?: { source?: MessageSource }
  }
}

/** Model-route fields read from a sample's `message.source`. */
interface MessageSource {
  provider?: unknown
  model?: unknown
}

const WEEKEND = new Set(['Sat', 'Sun'])

/**
 * Which billing tier one timestamp falls in.
 * @param timeMs - event timestamp in Unix epoch milliseconds.
 * @param timeZone - IANA zone the windows are expressed in.
 * @returns 'peak' inside a weekday window, otherwise 'idle'.
 */
export function classifyTier(timeMs: number, timeZone: string = DEFAULT_TIME_ZONE): Tier {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timeMs))
  const field = (type: string): string | undefined => parts.find(part => part.type === type)?.value
  if (WEEKEND.has(field('weekday') ?? '')) return 'idle'
  const minutes = Number(field('hour') ?? '0') * 60 + Number(field('minute') ?? '0')
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from * 60 && minutes < to * 60) ? 'peak' : 'idle'
}

/** One usage sample with every bucket present; missing buckets read as zero. */
function normalizeUsage(usage: UsageSample | undefined): UsageBuckets {
  const value = (bucket: unknown): number => (typeof bucket === 'number' && Number.isFinite(bucket) ? bucket : 0)
  const source = usage ?? {}
  return {
    uncachedInputTokens: value(source.inputTokens),
    cacheReadTokens: value(source.cacheReadTokens),
    cacheWriteTokens: value(source.cacheWriteTokens),
    outputTokens: value(source.outputTokens),
  }
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)

/**
 * Fold assistant messages into per-route, per-tier token rows.
 * @param events - the session's durable event log (`readSession().events`).
 * @param options - `timeZone` for the peak/idle classification.
 * @returns per-(route, tier) rows, grand token totals, sample counters.
 */
export function summarizeUsage(events: unknown, options: SummarizeOptions = {}): UsageSummary {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
  const routes = new Map<string, UsageRow>()
  let samples = 0
  let skipped = 0
  for (const event of (Array.isArray(events) ? events : []) as SessionEvent[]) {
    if (event?.type !== 'assistant/message') continue
    const data = event.data ?? {}
    const usage = normalizeUsage(data.usage)
    const billed = usage.uncachedInputTokens + usage.cacheReadTokens
      + usage.cacheWriteTokens + usage.outputTokens
    if (data.usage === undefined || billed <= 0 || typeof event.time !== 'number') {
      skipped += 1
      continue
    }
    samples += 1
    const source: MessageSource = data.message?.source ?? {}
    const provider = typeof source.provider === 'string' && source.provider.length > 0 ? source.provider : 'unknown'
    const model = typeof source.model === 'string' && source.model.length > 0 ? source.model : 'unknown'
    const tier = classifyTier(event.time, timeZone)
    const key = `${provider}\u0000${model}\u0000${tier}`
    const row = routes.get(key) ?? {
      provider,
      model,
      tier,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }
    row.uncachedInputTokens += usage.uncachedInputTokens
    row.cacheReadTokens += usage.cacheReadTokens
    row.cacheWriteTokens += usage.cacheWriteTokens
    row.outputTokens += usage.outputTokens
    routes.set(key, row)
  }
  const rows = [...routes.values()]
  const totals: UsageBuckets = {
    uncachedInputTokens: sum(rows.map(row => row.uncachedInputTokens)),
    cacheReadTokens: sum(rows.map(row => row.cacheReadTokens)),
    cacheWriteTokens: sum(rows.map(row => row.cacheWriteTokens)),
    outputTokens: sum(rows.map(row => row.outputTokens)),
  }
  return { rows, totals, samples, skipped }
}
