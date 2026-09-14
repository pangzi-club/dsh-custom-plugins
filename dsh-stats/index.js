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

export const name = 'dsh-stats'

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const effective = resolveConfig(config)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PING_PATH, handler: (req, res) => servePing(req, res, effective) }),
    'dsh-stats: GET /dsh-stats/ping',
  )
}
