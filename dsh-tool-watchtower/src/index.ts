import { Buffer } from 'node:buffer'
import { ActivityLog } from './host/activity.js'
import type { DshContext, NodeIncomingMessage, NodeServerResponse } from './host/context.js'

/**
 * dsh-tool-watchtower — tool & model activity watchtower (Host half, v1).
 *
 * Two emit observers feed per-session ring buffers:
 *   - `tools/result`: the durable terminal outcome of every tool call;
 *   - `agent/assistant-stream`: the process-local live stream of every model
 *     attempt (usage chunks settle the token counters).
 * A ping route proves the plugin is alive and how many sessions it tracks.
 * Emit listeners are recycled by the framework on unload — no ctx.effect.
 */

const PING_PATH = '/dsh-tool-watchtower/ping'
/** Ring-buffer cap per session (records; oldest dropped past it). */
const RING_LIMIT = 256
/** Cap on tracked sessions; the oldest session is dropped past it. */
const SESSION_LIMIT = 32

export const name = 'dsh-tool-watchtower'

export const inject = ['webServer']

export function apply(ctx: DshContext, _config: unknown = {}): void {
  const sessions = new Map<string, ActivityLog>()

  const logOf = (sessionId: string): ActivityLog => {
    let log = sessions.get(sessionId)
    if (log === undefined) {
      log = new ActivityLog(RING_LIMIT)
      sessions.set(sessionId, log)
      if (sessions.size > SESSION_LIMIT) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
    }
    return log
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: PING_PATH,
      handler: (req: NodeIncomingMessage, res: NodeServerResponse) => servePing(req, res, sessions),
    }),
    'dsh-tool-watchtower: GET /dsh-tool-watchtower/ping',
  )

  // Observer: every tool call's terminal outcome. Emit mode — no next(), and
  // a throwing listener is contained by the framework.
  ctx.on('tools/result', (exec, result) => {
    const sessionId = String(exec.agent?.session?.id ?? '')
    if (sessionId.length === 0) return
    const isError = result.isError === true
    const code = isError && typeof result.error?.code === 'string' ? result.error.code : undefined
    logOf(sessionId).recordTool(Date.now(), String(exec.callId ?? ''), String(exec.name ?? ''), isError, code)
    // Scaffold-era visibility; the live panel replaces this in a later chapter.
    console.log(`[dsh-tool-watchtower] tool ${isError ? 'error' : 'ok'}: ${String(exec.name ?? '')}${code === undefined ? '' : ` (${code})`}`)
  })

  // Observer: every model attempt's live frames. Chunk-level logging would be
  // noise, so only settlements reach the console.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = String(agent?.session?.id ?? '')
    if (sessionId.length === 0) return
    logOf(sessionId).recordFrame(frame, Date.now())
    if (frame.type === 'end') {
      const attemptId = String(frame.attemptId ?? '')
      const committed = frame.outcome?.kind === 'committed'
      console.log(`[dsh-tool-watchtower] attempt ${attemptId} ${committed ? 'committed' : 'abandoned'}`)
    }
  })
}

/** One heartbeat reading, plus how many sessions the tower is tracking. */
function pingBody(sessions: Map<string, ActivityLog>): { ok: boolean; plugin: string; sessions: number; now: string } {
  return { ok: true, plugin: 'dsh-tool-watchtower', sessions: sessions.size, now: new Date().toISOString() }
}

function servePing(req: NodeIncomingMessage, res: NodeServerResponse, sessions: Map<string, ActivityLog>): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(pingBody(sessions)), 'utf8')
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}
