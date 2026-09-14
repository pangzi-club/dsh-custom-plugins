/**
 * Fold a session's durable event log into per-model token totals.
 * Pure: no clock, no I/O, no ctx — trivially unit-testable.
 */

/** One usage sample with every bucket present; missing buckets read as zero. */
function normalizeUsage(usage) {
  const value = bucket => (Number.isFinite(bucket) ? bucket : 0)
  const source = usage ?? {}
  return {
    uncachedInputTokens: value(source.inputTokens),
    cacheReadTokens: value(source.cacheReadTokens),
    cacheWriteTokens: value(source.cacheWriteTokens),
    outputTokens: value(source.outputTokens),
  }
}

const sum = (values) => values.reduce((total, value) => total + value, 0)

/**
 * Fold assistant messages into per-route token rows.
 * @param events - the session's durable event log (`readSession().events`).
 * @returns per-route rows sorted by first appearance, grand totals, sample counts.
 */
export function summarizeUsage(events) {
  const routes = new Map()
  let samples = 0
  let skipped = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'assistant/message') continue
    const data = event.data ?? {}
    const usage = normalizeUsage(data.usage)
    const billed = usage.uncachedInputTokens + usage.cacheReadTokens
      + usage.cacheWriteTokens + usage.outputTokens
    if (data.usage === undefined || billed <= 0) {
      skipped += 1
      continue
    }
    samples += 1
    const source = data.message?.source ?? {}
    const provider = typeof source.provider === 'string' ? source.provider : 'unknown'
    const model = typeof source.model === 'string' ? source.model : 'unknown'
    const key = `${provider}/${model}`
    const row = routes.get(key) ?? {
      provider,
      model,
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
  const totals = {
    uncachedInputTokens: sum(rows.map(row => row.uncachedInputTokens)),
    cacheReadTokens: sum(rows.map(row => row.cacheReadTokens)),
    cacheWriteTokens: sum(rows.map(row => row.cacheWriteTokens)),
    outputTokens: sum(rows.map(row => row.outputTokens)),
  }
  return { rows, totals, samples, skipped }
}
