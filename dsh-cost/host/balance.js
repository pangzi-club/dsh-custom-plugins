/**
 * DeepSeek account balance read: `GET /user/balance` with the resolved API key,
 * normalized into the shape the pill's dialog renders. Every expected failure
 * (HTTP status, unrecognized payload, network) is an outcome value, never a
 * throw, so the route can always answer a stable JSON body.
 */

/** Balance endpoint path on the provider's API base. */
export const BALANCE_PATH = '/user/balance'

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Normalize one `/user/balance` payload.
 * @param payload - parsed JSON body.
 * @returns availability plus one row per currency, or undefined when malformed.
 */
export function normalizeBalance(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const infos = payload.balance_infos
  const isAvailable = payload.is_available === true
  if (infos === undefined) return { isAvailable, rows: [] }
  if (!Array.isArray(infos)) return undefined
  const rows = []
  for (const info of infos) {
    if (info === null || typeof info !== 'object') return undefined
    const { currency, total_balance: total, granted_balance: granted, topped_up_balance: toppedUp } = info
    if (typeof currency !== 'string' || currency.length === 0) return undefined
    if (typeof total !== 'string' || typeof granted !== 'string' || typeof toppedUp !== 'string') return undefined
    rows.push({ currency, total, granted, toppedUp })
  }
  return { isAvailable, rows }
}

/**
 * Read the provider balance once.
 * @param options - endpoint base, API key, and optional transport overrides.
 * @returns an outcome discriminated by `kind`.
 */
export async function fetchBalance({ baseURL, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = new URL(BALANCE_PATH, baseURL).toString()
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (response.ok !== true) return { kind: 'http-error', status: response.status }
    const payload = await response.json().catch(() => undefined)
    const normalized = normalizeBalance(payload)
    if (normalized === undefined) return { kind: 'malformed' }
    return { kind: 'ok', ...normalized }
  } catch (error) {
    return { kind: 'network', message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
