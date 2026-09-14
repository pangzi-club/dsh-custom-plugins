import { summarizeUsage, DEFAULT_TIME_ZONE } from './host/fold.js'
import { DEFAULT_CURRENCY, normalizePricing, priceRows } from './host/pricing.js'
import type { ModelRates, PricedRoute, UnpricedRoute } from './host/pricing.js'
import type { DshContext, NodeIncomingMessage, NodeServerResponse } from './host/context.js'

/**
 * dsh-stats - session usage statistics for the Web GUI (Host half).
 *
 * Claims GET /dsh-stats/ping (heartbeat) and the authenticated
 * GET /api/dsh-stats/summary?session=<id>, which folds the session's durable
 * log into per-route, per-tier token rows and prices them with the effective
 * table (built-in DeepSeek peak/idle CNY rates, overridable from this row's
 * `pricing` config). Also registers the `session_stats` tool.
 */

const PING_PATH = '/dsh-stats/ping'

/** The plugin row's `config` mapping; values are validated at load. */
interface PluginRowConfig {
  label?: unknown
  timestamp?: unknown
  timeZone?: unknown
  pricing?: unknown
}

/** Config after validation: defaulted and typed. */
interface EffectiveConfig {
  label: string
  timestamp: boolean
  timeZone: string
  pricing: Map<string, ModelRates>
}

const DEFAULT_CONFIG: Pick<EffectiveConfig, 'label' | 'timestamp' | 'timeZone'> = {
  label: 'dsh-stats',
  timestamp: true,
  timeZone: DEFAULT_TIME_ZONE,
}

/** The summary document served to the pill and the `session_stats` tool. */
interface SummaryBody {
  sessionId: string
  label: string
  currency: string
  total: number
  priced: boolean
  routes: PricedRoute[]
  unpriced: UnpricedRoute[]
  samples: number
  skipped: number
}

/** Either a readable summary or the failure reason, told apart by `notFound`. */
type ReadOutcome =
  | { notFound: string; body?: undefined }
  | { notFound?: undefined; body: SummaryBody }

/**
 * Validate the plugin-row config and merge it over the defaults. Invalid
 * values fail loudly at load time, in the launcher's terminal log.
 * @param config - the plugin row's config value (may be undefined).
 * @returns the effective config.
 */
function resolveConfig(config: unknown): EffectiveConfig {
  const source = (config ?? {}) as PluginRowConfig
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`dsh-stats: config must be a mapping, got ${JSON.stringify(source)}`)
  }
  if (source.label !== undefined
      && (typeof source.label !== 'string' || source.label.trim().length === 0)) {
    throw new Error(`dsh-stats: config.label must be a non-empty string, got ${JSON.stringify(source.label)}`)
  }
  if (source.timestamp !== undefined && typeof source.timestamp !== 'boolean') {
    throw new Error(`dsh-stats: config.timestamp must be a boolean, got ${JSON.stringify(source.timestamp)}`)
  }
  const timeZone = typeof source.timeZone === 'string' && source.timeZone.trim().length > 0
    ? source.timeZone.trim()
    : DEFAULT_CONFIG.timeZone
  if (source.timeZone !== undefined && typeof source.timeZone !== 'string') {
    throw new Error(`dsh-stats: config.timeZone must be a string, got ${JSON.stringify(source.timeZone)}`)
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    throw new Error(`dsh-stats: config.timeZone is not a valid IANA time zone: ${JSON.stringify(source.timeZone)}`)
  }
  return {
    label: typeof source.label === 'string' ? source.label.trim() : DEFAULT_CONFIG.label,
    timestamp: typeof source.timestamp === 'boolean' ? source.timestamp : DEFAULT_CONFIG.timestamp,
    timeZone,
    pricing: normalizePricing(source.pricing),
  }
}

/** One heartbeat reading. */
function pingBody(config: EffectiveConfig): { ok: boolean; plugin: string; now?: string } {
  const body: { ok: boolean; plugin: string; now?: string } = { ok: true, plugin: config.label }
  if (config.timestamp) body.now = new Date().toISOString()
  return body
}

function servePing(req: NodeIncomingMessage, res: NodeServerResponse, config: EffectiveConfig): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(pingBody(config)), 'utf8')
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One JSON response with the headers a live reading needs. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export const name = 'dsh-stats'

export const inject = ['webServer', 'connection', 'sessionQuery', 'tools']

/** Cap on cached summaries; the oldest entry is dropped past it. */
const MEMO_LIMIT = 64

export function apply(ctx: DshContext, config: unknown = {}): void {
  const effective = resolveConfig(config)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PING_PATH, handler: (req, res) => servePing(req, res, effective) }),
    'dsh-stats: GET /dsh-stats/ping',
  )

  const memo = new Map<string, { body: SummaryBody; dirty: boolean }>()
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const entry = memo.get(String(session?.id ?? ''))
    if (entry !== undefined) entry.dirty = true
  })

  /** Read one session and fold + price it; `notFound` marks an unreadable session. */
  const readSummary = async (sessionId: string): Promise<ReadOutcome> => {
    let snapshot: { events?: unknown }
    try {
      snapshot = await ctx.sessionQuery.readSession(sessionId)
    } catch (error) {
      return { notFound: `dsh-stats: ${messageOf(error)}` }
    }
    const fold = summarizeUsage(snapshot.events, { timeZone: effective.timeZone })
    const priced = priceRows(fold.rows, effective.pricing)
    return {
      body: {
        sessionId,
        label: effective.label,
        currency: DEFAULT_CURRENCY,
        total: priced.total,
        priced: priced.routes.length > 0,
        routes: priced.routes,
        unpriced: priced.unpriced,
        samples: fold.samples,
        skipped: fold.skipped,
      },
    }
  }

  const serveSummary = async (request: Request): Promise<Response> => {
    const requested = new URL(request.url).searchParams.get('session')?.trim() ?? ''
    if (requested.length === 0) {
      return json({ error: 'dsh-stats: session id is required' }, 400)
    }
    const cached = memo.get(requested)
    if (cached !== undefined && cached.dirty !== true) return json(cached.body)
    const outcome = await readSummary(requested)
    if (outcome.notFound !== undefined) return json({ error: outcome.notFound }, 404)
    if (memo.size >= MEMO_LIMIT) {
      const oldest = memo.keys().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    memo.set(requested, { body: outcome.body, dirty: false })
    return json(outcome.body)
  }

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: '/api/dsh-stats/summary',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: serveSummary,
    }),
    'dsh-stats: GET /api/dsh-stats/summary',
  )

  ctx.effect(
    () => ctx.tools.register({
      name: 'session_stats',
      description: 'Read token usage statistics of one DSH session (per model and token bucket).',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session id to summarize.' },
        },
        required: ['session'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        // Raw JSON-Schema tools own their input validation.
        const session = args?.session
        if (typeof session !== 'string' || session.trim().length === 0) {
          throw new Error('session_stats: arguments.session must be a non-empty string')
        }
        const outcome = await readSummary(session.trim())
        if (outcome.notFound !== undefined) {
          throw new Error(`session_stats: cannot read session: ${outcome.notFound}`)
        }
        return outcome.body
      },
    }),
    'dsh-stats: tool session_stats',
  )

  // 观察：记录每次调用后放行（emit 场景也可以用 tools/result，更合适）
  ctx.on('tools/pre-execute', async (exec, next) => {
    console.log(`[dsh-stats] tool call: ${exec.name}`)
    return next()
  })

  // 策略：对特定条件给出终局裁决，否则放行
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'session_stats' && String(exec.arguments?.session ?? '').length > 200) {
      return { kind: 'deny', reason: 'session id looks malformed' }
    }
    return next()
  })
}
