import { summarizeUsage } from './host/fold.js'

/**
 * dsh-stats - session usage statistics fro the Web GUI (Host half, v1).
 * 
 * v1 claims one exact route: GET /dsh-stats/ping answers a JSON heartbeat, to
 * confirm the plugin is mounted and its route is alive.
 */

const PING_PATH = '/dsh-stats/ping'

const DEFAULT_CONFIG = { label: 'dsh-stats', timestamp: true }

/**
 * Validate the plugin-row config and merge it over the defaults. Invalid
 * values fail loudly at load time, in the launcher's terminal log.
 * @param config - the plugin row's config value (may be undefined).
 * @returns the effective config.
 */
function resolveConfig(config) {
  const source = config ?? {}
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
  return {
    label: typeof source.label === 'string' ? source.label.trim() : DEFAULT_CONFIG.label,
    timestamp: typeof source.timestamp === 'boolean' ? source.timestamp : DEFAULT_CONFIG.timestamp,
  }
}

/** One heartbeat reading. */
function pingBody(config) {
  const body = { ok: true, plugin: config.label }
  if (config.timestamp) body.now = new Date().toISOString()
  return body
}

function servePing(req, res, config) {
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

export const name = 'dsh-stats'

export const inject = ['webServer', 'connection', 'sessionQuery', 'tools']

/** Cap on cached summaries; the oldest entry is dropped past it. */
const MEMO_LIMIT = 64

export function apply(ctx, config = {}) {
  const effective = resolveConfig(config)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PING_PATH, handler: (req, res) => servePing(req, res, effective) }),
    'dsh-stats: GET /dsh-stats/ping',
  )

  const memo = new Map()
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const entry = memo.get(String(session?.id ?? ''))
    if (entry !== undefined) entry.dirty = true
  })

  const serveSummary = async (request) => {
    const requested = new URL(request.url).searchParams.get('session')?.trim() ?? ''
    if (requested.length === 0) {
      return json({ error: 'dsh-stats: session id is required' }, 400)
    }
    const cached = memo.get(requested)
    if (cached !== undefined && cached.dirty !== true) return json(cached.body)
    let snapshot
    try {
      snapshot = await ctx.sessionQuery.readSession(requested)
    } catch (error) {
      return json({ error: `dsh-stats: ${messageOf(error)}` }, 404)
    }
    const fold = summarizeUsage(snapshot.events)
    const body = {
      sessionId: requested,
      label: effective.label,
      routes: fold.rows,
      totals: fold.totals,
      samples: fold.samples,
      skipped: fold.skipped,
    }
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value)
    memo.set(requested, { body, dirty: false })
    return json(body)
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
        let snapshot
        try {
          snapshot = await ctx.sessionQuery.readSession(session.trim())
        } catch (error) {
          throw new Error(`session_stats: cannot read session: ${messageOf(error)}`)
        }
        const fold = summarizeUsage(snapshot.events)
        return {
          session: session.trim(),
          routes: fold.rows,
          totals: fold.totals,
          samples: fold.samples,
          skipped: fold.skipped,
        }
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
