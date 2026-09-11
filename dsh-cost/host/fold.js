/**
 * Session-log fold behind the cost pill: attribute every provider-reported
 * usage sample to the model route that produced it and to the provider's
 * peak/idle billing tier of that sample's timestamp, replacing a sample the
 * same turn/step restates (retries) exactly the way the durable token
 * accounting does.
 *
 * The fold is pure: events in, token rows out. Pricing stays in `pricing.js`,
 * so a rate change never requires re-reading a log.
 */

/** Peak billing windows in local time: inclusive hour, exclusive end hour. */
export const PEAK_WINDOWS = Object.freeze([[9, 12], [14, 18]])

/** Time zone the provider's billing tiers are defined in. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

const WEEKEND = new Set(['Sat', 'Sun'])

/**
 * Which billing tier one timestamp falls in.
 * @param timeMs - event timestamp in Unix epoch milliseconds.
 * @param timeZone - IANA zone the windows are expressed in.
 * @returns `'peak'` inside a weekday window, otherwise `'idle'`.
 */
export function classifyTier(timeMs, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timeMs))
  const field = type => parts.find(part => part.type === type)?.value
  const weekday = field('weekday')
  if (weekday === undefined || WEEKEND.has(weekday)) return 'idle'
  const minutes = Number(field('hour') ?? '0') * 60 + Number(field('minute') ?? '0')
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from * 60 && minutes < to * 60) ? 'peak' : 'idle'
}

/** Whether one value is a safe non-negative token count. */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Last reported usage chunk of one compacted Assistant stream. */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage !== undefined) {
      return record.chunk.usage
    }
  }
  return undefined
}

/**
 * Normalize one provider usage sample into disjoint buckets. Absent cache
 * buckets count as zero; an unusable sample is skipped rather than guessed.
 * @param usage - provider usage object.
 * @returns the four billing buckets, or undefined when the sample is unusable.
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  return {
    uncachedInputTokens: inputTokens,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    outputTokens,
  }
}

/** One model route as recorded by the provider or the effective request header. */
function routeOf(source) {
  if (source === null || typeof source !== 'object') return undefined
  const { provider, model } = source
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Fold one session log into per-route, per-tier token rows.
 *
 * Only events the session owns are counted: a fork's inherited prefix was
 * billed in the ancestor session, so billing it here would double count.
 * @param events - raw session events in seq order.
 * @param options - inherited prefix length and the billing time zone.
 * @returns token rows keyed by route and tier, plus sample counters.
 */
export function foldUsage(events, options = {}) {
  const inherited = Number.isSafeInteger(options.inheritedEventCount) ? options.inheritedEventCount : 0
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
  const owned = events.slice(Math.max(0, inherited))
  const rows = new Map()
  let samples = 0
  let skipped = 0
  let currentRoute
  let last = null

  const bump = (key, route, tier, buckets, sign) => {
    const existing = rows.get(key) ?? {
      provider: route.provider,
      model: route.model,
      tier,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }
    existing.uncachedInputTokens += sign * buckets.uncachedInputTokens
    existing.cacheReadTokens += sign * buckets.cacheReadTokens
    existing.cacheWriteTokens += sign * buckets.cacheWriteTokens
    existing.outputTokens += sign * buckets.outputTokens
    rows.set(key, existing)
  }

  const sample = (turn, step, route, time, usage) => {
    const buckets = normalizeUsage(usage)
    if (buckets === undefined || route === undefined || typeof time !== 'number') {
      skipped += 1
      return
    }
    const tier = classifyTier(time, timeZone)
    const key = `${route.provider}\u0000${route.model}\u0000${tier}`
    if (last !== null && last.turn === turn && last.step === step) {
      bump(last.key, last.route, last.tier, last.buckets, -1)
    }
    bump(key, route, tier, buckets, 1)
    last = { turn, step, key, route, tier, buckets }
    samples += 1
  }

  for (const event of owned) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (event.type === 'request/header') {
      const route = routeOf(data?.header?.config)
      if (route !== undefined) currentRoute = route
      continue
    }
    if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === data?.turn && last.step === data?.step) last = null
      continue
    }
    if (event.type === 'assistant/message') {
      const usage = data?.usage ?? streamUsage(data?.stream)
      if (usage !== undefined) sample(data?.turn, data?.step, routeOf(data?.message?.source) ?? currentRoute, event.time, usage)
      continue
    }
    if (event.type === 'assistant/attempt') {
      const usage = streamUsage(data?.stream)
      if (usage !== undefined) sample(data?.turn, data?.step, currentRoute, event.time, usage)
    }
  }

  const list = [...rows.values()].filter(row => (
    row.uncachedInputTokens !== 0 || row.cacheReadTokens !== 0 || row.cacheWriteTokens !== 0 || row.outputTokens !== 0
  ))
  return { samples, skipped, rows: list }
}
