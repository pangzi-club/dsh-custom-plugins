import { Buffer } from 'node:buffer'
import { ActivityLog, foldTotals, promptChars } from './host/activity.js'
import type { ActivityRecord, ActivityTotals, RouteSnapshot } from './host/activity.js'
import { decide, resolveRules } from './host/rules.js'
import type { GateRule } from './host/rules.js'
import { SECRET_MARK, contentText, planTransform, redactText, resolveTransform } from './host/transform.js'
import type { TransformConfig } from './host/transform.js'
import type { DshContext, NodeIncomingMessage, NodeServerResponse } from './host/context.js'

/**
 * dsh-tool-watchtower — tool & model activity watchtower (Host half).
 *
 * Tool pipeline:
 *   - `tools/execute` wrapper: wall-clock per call, banked into `durations`
 *     and handed to the result observer by callId (the wrapper's next()
 *     resolves BEFORE post-execute, so tools/result stays the final truth);
 *   - `tools/pre-execute` gate: first-match-wins rules → deny/ask; an allow is
 *     always `next()`, never an asserted `{ kind: 'allow' }` (that would
 *     short-circuit every downstream vetoer);
 *   - `tools/post-execute` transform: redact/annotate/block on the configured
 *     demo tools — delegate first, respect a downstream block, overlay after;
 *   - `tools/result` observer: the read-only terminal outcome of every call;
 * Model lane (observation only — this tower never changes behaviour):
 *   - `llm/stream`: read options, return next()'s stream untouched (no session
 *     identity here, so per-session numbers come from the two stations below);
 *   - `session/event` (`request/header`): the durable per-session model route;
 *   - `agent/assistant-stream`: live attempt frames folded into usage totals;
 *   - `agent/inbox/inserted`: prompt entries (chars ≠ tokens).
 * Surfaces:
 *   - `webServer` exact ping route (heartbeat);
 *   - `connection.fetch` authenticated activity API for the browser provider;
 *   - `tools`: watchtower_echo (transform target) + watchtower_report.
 */

const PING_PATH = '/dsh-tool-watchtower/ping'
const ACTIVITY_PATH = '/api/dsh-tool-watchtower/activity'
/** Ring-buffer cap per session (records; oldest dropped past it). */
const RING_LIMIT = 256
/** Cap on tracked sessions; the oldest session is dropped past it. */
const SESSION_LIMIT = 32

export const name = 'dsh-tool-watchtower'

export const inject = ['webServer', 'connection', 'tools']

/** The plugin row's config, validated at load. */
interface EffectiveConfig {
  rules: GateRule[]
  transform: TransformConfig
}

function emptySnapshot(): { revision: number; records: ActivityRecord[]; totals: ActivityTotals; route: RouteSnapshot | undefined } {
  return { revision: 0, records: [], totals: foldTotals([]), route: undefined }
}

/** One JSON response with the headers a live reading needs. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
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

export function apply(ctx: DshContext, config: unknown = {}): void {
  // Fail loudly on a malformed row, before anything registers.
  const source = (config ?? {}) as { rules?: unknown; transform?: unknown }
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`dsh-tool-watchtower: config must be a mapping, got ${JSON.stringify(config)}`)
  }
  const effective: EffectiveConfig = {
    rules: resolveRules(source.rules),
    transform: resolveTransform(source.transform),
  }

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

  // The live panel's feed. Unknown sessions get an empty snapshot instead of a
  // 404: the panel mounts before a session's first record, and a 404 would pin
  // it to the `failed` state forever.
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: ACTIVITY_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const requested = new URL(request.url).searchParams.get('session')?.trim() ?? ''
        if (requested.length === 0) {
          return json({ error: 'dsh-tool-watchtower: session id is required' }, 400)
        }
        const log = sessions.get(requested)
        return json(log !== undefined ? log.snapshot() : emptySnapshot())
      },
    }),
    'dsh-tool-watchtower: GET /api/dsh-tool-watchtower/activity',
  )

  // Wall-clock per settled call, handed from the wrapper to the result observer.
  const durations = new Map<string, number>()

  // Around-dispatch wrapper: metrics only. A wrapper may replace exec.signal
  // (the registry fuses it with the caller's); this tower deliberately reads
  // the clock and delegates.
  ctx.on('tools/execute', async (exec, next) => {
    const startedAt = Date.now()
    const result = await next()
    durations.set(String(exec.callId ?? ''), Date.now() - startedAt)
    return result
  })

  // Observer: every tool call's terminal outcome. Emit mode — no next(), and
  // a throwing listener is contained by the framework.
  ctx.on('tools/result', (exec, result) => {
    const sessionId = String(exec.agent?.session?.id ?? '')
    if (sessionId.length === 0) return
    const callId = String(exec.callId ?? '')
    const isError = result.isError === true
    const code = isError && typeof result.error?.code === 'string' ? result.error.code : undefined
    const durationMs = durations.get(callId)
    durations.delete(callId)
    logOf(sessionId).recordTool(Date.now(), callId, String(exec.name ?? ''), isError, code, durationMs)
  })

  // Observer: every model attempt's live frames (start/chunk/end; usage rides
  // the chunk and settles the token counters).
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = String(agent?.session?.id ?? '')
    if (sessionId.length === 0) return
    logOf(sessionId).recordFrame(frame, Date.now())
  })

  // The gate: first-match-wins rules over every pending tool call. A veto is
  // audited and returned; an allow is always delegated, never asserted.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = String(exec.name ?? '')
    const verdict = decide(effective.rules, toolName)
    if (verdict.kind === 'allow') return next()
    const sessionId = String(exec.agent?.session?.id ?? '')
    if (sessionId.length > 0) {
      logOf(sessionId).recordDecision(Date.now(), toolName, verdict.kind, verdict.reason)
    }
    return verdict
  })

  // The transform demo: only the tools named in config, only in the configured
  // mode. Everything else delegates untouched.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const toolName = String(exec.name ?? '')
    if (!effective.transform.tools.includes(toolName)) return next()
    const plan = planTransform(effective.transform.mode, result.isError === true, contentText(result.content))
    if (plan === 'passthrough') return next()

    if (plan === 'block') {
      // A veto ends the chain on purpose: feedback becomes the error text the
      // model reads instead of the blocked result.
      return {
        kind: 'block',
        feedback: [{
          type: 'text',
          text: `watchtower: result blocked — it carried a ${SECRET_MARK} marker. Re-run without embedding secrets.`,
        }],
      }
    }

    // Transforms never undo a downstream veto: delegate first, respect a block,
    // only then overlay our own decision.
    const downstream = await next()
    if (downstream.kind === 'block') return downstream

    if (plan === 'redact') {
      // Replace the model/UI-facing projection; the canonical value is intact.
      return { kind: 'accept', content: [{ type: 'text', text: redactText(contentText(result.content)) }] }
    }

    // annotate: ride a durable notice onto the next model request. The
    // upstream way to build a UserMessage is createUserMessage
    // (@deepseek-ai/dsh-llm), which is not resolvable from outside the
    // repository — hence the hand-written literal (known limitation; if a
    // future release validates the id's shape, this is where it breaks first).
    const notice = {
      id: `dsh-tool-watchtower-notice-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: `watchtower recorded "${toolName}"; the session activity log includes this call.` }],
      source: { kind: 'plugin', plugin: 'dsh-tool-watchtower', form: 'notice', summary: `${toolName} recorded` },
    }
    const carried = Array.isArray(downstream.additionalContexts) ? downstream.additionalContexts : []
    return { kind: 'accept', additionalContexts: [notice, ...carried] }
  })

  // Read-only wrap of every model call. Loop-built requests arrive deep-frozen
  // (mutation throws), and short-circuiting — returning anything but next()'s
  // stream — is gateway territory this tower never enters. Note what this
  // station LACKS: no session identity, so requests stay unrecorded here;
  // per-session numbers come from request/header + assistant-stream instead.
  ctx.on('llm/stream', (_options, next) => {
    return next()
  })

  // Durable route snapshot: the latest request/header wins, per session.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'request/header') return
    const sessionId = String(session?.id ?? '')
    if (sessionId.length === 0) return
    const data = event.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined
    const provider = String(data?.header?.config?.provider ?? 'unknown')
    const model = String(data?.header?.config?.model ?? 'unknown')
    logOf(sessionId).setRoute(Date.now(), provider, model)
  })

  // Prompt entry point: one record per inbox insertion, per session.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const sessionId = String(agent?.session?.id ?? '')
    if (sessionId.length === 0) return
    const chars = promptChars(message?.content)
    logOf(sessionId).recordPrompt(Date.now(), chars)
  })

  ctx.effect(
    () => ctx.tools.register({
      name: 'watchtower_echo',
      description: 'Echo the given text back. Demo target for the watchtower transform modes.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo back.' } },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { echoed: { type: 'string' } },
          required: ['echoed'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: String((value as { echoed?: unknown })?.echoed ?? '') }],
      },
      async execute(args) {
        // Raw JSON-Schema tools own their input validation.
        const text = args?.text
        if (typeof text !== 'string') {
          throw new Error('watchtower_echo: arguments.text must be a string')
        }
        return { echoed: text }
      },
    }),
    'dsh-tool-watchtower: tool watchtower_echo',
  )

  ctx.effect(
    () => ctx.tools.register({
      name: 'watchtower_report',
      description: 'Read the watchtower activity snapshot for one session: recent tool calls, gate verdicts, model attempts, token totals.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session id. Defaults to the calling session.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      presentCall(args) {
        // Generic pending card: a title, a "read" category, the args as detail.
        return { card: 'generic', title: 'Watchtower report', kind: 'read', rawInput: args ?? {} }
      },
      presentResult(_args, value) {
        // Generic completed card: a one-line totals summary replaces the raw dump.
        const totals = (value as { totals?: Record<string, number> })?.totals ?? {}
        const at = (key: string): number => (typeof totals[key] === 'number' ? totals[key] : 0)
        return {
          card: 'generic',
          title: 'Watchtower report',
          content: [{
            type: 'text',
            text: `tools ${at('tools')} (errors ${at('toolErrors')}, denied ${at('denied')}, asked ${at('asked')}) · attempts ${at('modelAttempts')} · tokens in ${at('inputTokens')} / out ${at('outputTokens')}`,
          }],
        }
      },
      async execute(args, exec) {
        const requested = typeof args?.session === 'string' && args.session.trim().length > 0
          ? args.session.trim()
          : String(exec?.agent?.session?.id ?? '')
        if (requested.length === 0) {
          throw new Error('watchtower_report: no session id given and the caller has none')
        }
        const log = sessions.get(requested)
        const snapshot = log !== undefined
          ? log.snapshot()
          : emptySnapshot()
        return {
          session: requested,
          generatedAt: new Date().toISOString(),
          totals: snapshot.totals,
          // Keep the model-facing payload bounded; the panel sees everything.
          records: snapshot.records.slice(0, 32),
        }
      },
    }),
    'dsh-tool-watchtower: tool watchtower_report',
  )
}
