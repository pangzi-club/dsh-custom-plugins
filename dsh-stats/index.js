/**
 * dsh-stats - session usage statistics fro the Web GUI (Host half, v1).
 * 
 * v1 claims one exact route: GET /dsh-stats/ping answers a JSON heartbeat, to
 * confirm the plugin is mounted and its route is alive.
 */

const PING_PATH = '/dsh-stats/ping'

/** One heartbeat reading. */
function pingBody() {
  return { ok: true, plugin: 'dsh-stats', now: new Date().toISOString() }
}

function servePing(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(pingBody()), 'utf8')
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

export const name = 'dsh-stats'

export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PING_PATH, handler: servePing }),
    'dsh-stats: GET /dsh-stats/ping',
  )
}
