/**
 * dsh-cost — conversation cost for the Web GUI (Host half).
 *
 * The browser pill asks two authenticated exact Fetch routes for everything it
 * renders: `/api/dsh-cost/session` folds the session's durable log into
 * per-route, per-billing-tier token rows and prices them with the effective
 * table (built-in DeepSeek CNY rates, overridable from this plugin row's
 * `pricing` config), and `/api/dsh-cost/balance` reads the provider account
 * balance with the resolved credential. No repository code is involved: the
 * seams are the connection's Fetch-route registry and the session-query
 * service.
 */

import { DEFAULT_CURRENCY, normalizePricing, priceRows } from './host/pricing.js'
import { DEFAULT_TIME_ZONE, PEAK_WINDOWS, foldUsage } from './host/fold.js'
import { fetchBalance } from './host/balance.js'

export const name = 'dsh-cost'

/** The connection owns the authenticated route registry; session-query owns log reads. */
export const inject = ['connection', 'sessionQuery']

const SESSION_ROUTE = '/api/dsh-cost/session'
const BALANCE_ROUTE = '/api/dsh-cost/balance'

const DEFAULT_PROVIDER = 'deepseek'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Cap on cached session folds; the oldest entry is dropped past it. */
const MEMO_LIMIT = 64

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** One JSON response with the headers a live reading needs. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Non-empty trimmed string, or the fallback. */
function textOr(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** Resolve the configured credential through the managed store, then the launching environment. */
async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
  }
  const ambient = process.env[ref]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}

/**
 * Register the two cost routes for as long as this plugin stays loaded.
 * @param ctx - Host context carrying the connection and session-query services.
 * @param config - this plugin row's config (provider, endpoint, credential ref, prices).
 */
export function apply(ctx, config = {}) {
  const provider = textOr(config?.provider, DEFAULT_PROVIDER)
  const state = {
    provider,
    baseURL: textOr(config?.baseURL, DEFAULT_BASE_URL),
    apiKeyEnv: textOr(config?.apiKeyEnv, DEFAULT_API_KEY_ENV),
    timeZone: textOr(config?.timeZone, DEFAULT_TIME_ZONE),
    currency: textOr(config?.currency, DEFAULT_CURRENCY),
    pricing: normalizePricing(config?.pricing),
  }
  /** @type {Map<string, { body: unknown, dirty: boolean }>} */
  const memo = new Map()
  // A cached fold stays servable until a billable settlement lands, so opening
  // the dialog repeatedly never re-reads the log; the next request after a
  // settled usage sample does.
  const BILLABLE_EVENTS = new Set(['assistant/message', 'assistant/attempt', 'llm/retry', 'llm/retry-started'])
  ctx.on('session/event', (session, event) => {
    if (!BILLABLE_EVENTS.has(event?.type)) return
    const entry = memo.get(String(session?.id ?? ''))
    if (entry !== undefined) entry.dirty = true
  })

  const serveSession = async (request) => {
    const requested = new URL(request.url).searchParams.get('session')?.trim() ?? ''
    if (requested.length === 0) return json({ error: 'dsh-cost: session id is required' }, 400)
    const cached = memo.get(requested)
    if (cached !== undefined && cached.dirty !== true) return json(cached.body)
    let snapshot
    try {
      snapshot = await ctx.sessionQuery.readSession(requested)
    } catch (error) {
      return json({ error: `dsh-cost: ${messageOf(error)}` }, 404)
    }
    const events = Array.isArray(snapshot.events) ? snapshot.events : []
    const inheritedEvents = Number(snapshot.inheritedEventCount) || 0
    const fold = foldUsage(events, { inheritedEventCount: inheritedEvents, timeZone: state.timeZone })
    const priced = priceRows(fold.rows, state.pricing)
    const body = {
      sessionId: requested,
      provider: state.provider,
      currency: state.currency,
      total: priced.total,
      priced: priced.routes.length > 0,
      routes: priced.routes,
      unpriced: priced.unpriced,
      samples: fold.samples,
      skipped: fold.skipped,
      basis: { timeZone: state.timeZone, peakWindows: PEAK_WINDOWS, weekdaysOnly: true },
      excluded: { inheritedEvents },
    }
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value)
    memo.set(requested, { body, dirty: false })
    return json(body)
  }

  const serveBalance = async () => {
    if (state.provider !== 'deepseek') {
      return json({
        provider: state.provider,
        available: false,
        reason: 'PROVIDER_UNSUPPORTED',
        message: `dsh-cost: no balance API is configured for provider "${state.provider}"`,
      })
    }
    const apiKey = await resolveApiKey(ctx, state.apiKeyEnv)
    if (apiKey === undefined) {
      return json({
        provider: state.provider,
        available: false,
        reason: 'MISSING_CREDENTIAL',
        message: `dsh-cost: no credential "${state.apiKeyEnv}" is available`,
      })
    }
    const result = await fetchBalance({ baseURL: state.baseURL, apiKey })
    if (result.kind === 'ok') {
      return json({ provider: state.provider, available: result.isAvailable, rows: result.rows })
    }
    if (result.kind === 'http-error') {
      const unauthorized = result.status === 401 || result.status === 403
      return json({
        provider: state.provider,
        available: false,
        reason: unauthorized ? 'UNAUTHORIZED' : `HTTP_${result.status}`,
        message: `dsh-cost: balance request answered HTTP ${result.status}`,
      })
    }
    if (result.kind === 'malformed') {
      return json({
        provider: state.provider,
        available: false,
        reason: 'MALFORMED_RESPONSE',
        message: 'dsh-cost: balance response shape was not recognized',
      })
    }
    return json({
      provider: state.provider,
      available: false,
      reason: 'NETWORK',
      message: `dsh-cost: balance request failed: ${result.message}`,
    })
  }

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: SESSION_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: serveSession,
    }),
    'dsh-cost: session cost route',
  )
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: BALANCE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: serveBalance,
    }),
    'dsh-cost: balance route',
  )
}
