/**
 * Activity fold for the watchtower: a per-session ring buffer fed by the
 * `tools/result`, `tools/pre-execute`, `agent/assistant-stream` and
 * `agent/inbox/inserted` observers, plus the pure totals fold the ping body
 * and the live panel serve.
 *
 * Pure data + pure functions: no I/O, no clock. Where an event carries no
 * timestamp of its own (start/end frames, tool outcomes), the caller hands in
 * `Date.now()`.
 */

import type { AssistantStreamFrame } from './context.js'

/** The four token buckets the watchtower tracks (subset of upstream TokenUsage). */
export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One settled tool call, as `tools/result` reported it. */
export interface ToolRecord {
  kind: 'tool'
  time: number
  callId: string
  name: string
  isError: boolean
  /** Upstream error code when the call failed (e.g. ABORTED), when reported. */
  code?: string
  /** Wall-clock milliseconds from the tools/execute wrapper, when measured. */
  durationMs?: number
}

/** One model attempt, folded from its start/chunk/end frames. */
export interface ModelRecord {
  kind: 'model'
  /** Clock time of the start frame (chunk frames carry finer wire times upstream). */
  time: number
  attemptId: string
  turn: number
  step: number
  /** Set when the attempt's usage chunk arrives; absent when it never does. */
  usage?: TokenUsageLike
  /** Set by the end frame: committed to the log, or abandoned mid-flight. */
  outcome?: 'committed' | 'abandoned'
  endedAt?: number
}

/** One gate verdict the watchtower itself handed down (deny/ask only; plain allows are not audited). */
export interface DecisionRecord {
  kind: 'decision'
  time: number
  name: string
  decision: 'deny' | 'ask'
  reason?: string
}

/** One prompt entering the live inbox, as `agent/inbox/inserted` reported it. */
export interface PromptRecord {
  kind: 'prompt'
  time: number
  /** Characters across the message's text blocks — a size hint, NOT a token count. */
  chars: number
}

export type ActivityRecord = ToolRecord | ModelRecord | DecisionRecord | PromptRecord

/** The session's current model route, from the durable `request/header` event. */
export interface RouteSnapshot {
  time: number
  provider: string
  model: string
}

export interface ActivityTotals {
  tools: number
  toolErrors: number
  denied: number
  asked: number
  prompts: number
  modelAttempts: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Defensive number read: non-finite or missing counts as zero. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Pull the usage payload out of a chunk value, if it is one. */
function usageOf(chunk: unknown): TokenUsageLike | undefined {
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const usage = (chunk as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const raw = usage as Record<string, unknown>
  if (typeof raw.inputTokens !== 'number' || typeof raw.outputTokens !== 'number') return undefined
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    ...(typeof raw.cacheReadTokens === 'number' ? { cacheReadTokens: raw.cacheReadTokens } : {}),
    ...(typeof raw.cacheWriteTokens === 'number' ? { cacheWriteTokens: raw.cacheWriteTokens } : {}),
  }
}

/** Pure fold: totals over a record list, in list order. */
export function foldTotals(records: readonly ActivityRecord[]): ActivityTotals {
  const totals: ActivityTotals = {
    tools: 0,
    toolErrors: 0,
    denied: 0,
    asked: 0,
    prompts: 0,
    modelAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  for (const record of records) {
    if (record.kind === 'tool') {
      totals.tools += 1
      if (record.isError) totals.toolErrors += 1
      continue
    }
    if (record.kind === 'decision') {
      if (record.decision === 'deny') totals.denied += 1
      else totals.asked += 1
      continue
    }
    if (record.kind === 'prompt') {
      totals.prompts += 1
      continue
    }
    totals.modelAttempts += 1
    const usage = record.usage
    if (usage === undefined) continue
    totals.inputTokens += usage.inputTokens
    totals.outputTokens += usage.outputTokens
    totals.cacheReadTokens += usage.cacheReadTokens ?? 0
    totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  }
  return totals
}

/** Total characters across an inbox message's text blocks (0 when unreadable). */
export function promptChars(content: unknown): number {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      total += (block as { text: string }).text.length
    }
  }
  return total
}

/**
 * One session's ring buffer. New records land at the front; the oldest drop
 * past `limit`. In-flight attempts live in `attempts` until their end frame
 * arrives, so usage and outcome land on the record pushed at start.
 *
 * `revision` counts every mutation a poll consumer can observe (records *and*
 * the route slot) — the client provider compares it to decide whether a change
 * frame is due.
 */
export class ActivityLog {
  private readonly records: ActivityRecord[] = []
  private readonly attempts = new Map<string, ModelRecord>()
  private revision = 0
  private route: RouteSnapshot | undefined

  constructor(readonly limit: number) {}

  recordTool(time: number, callId: string, name: string, isError: boolean, code?: string, durationMs?: number): void {
    const record: ToolRecord = {
      kind: 'tool',
      time,
      callId,
      name,
      isError,
      ...(code === undefined ? {} : { code }),
      ...(durationMs === undefined ? {} : { durationMs }),
    }
    this.push(record)
  }

  recordDecision(time: number, name: string, decision: 'deny' | 'ask', reason?: string): void {
    const record: DecisionRecord = {
      kind: 'decision',
      time,
      name,
      decision,
      ...(reason === undefined ? {} : { reason }),
    }
    this.push(record)
  }

  recordPrompt(time: number, chars: number): void {
    this.push({ kind: 'prompt', time, chars })
  }

  /** Fold one assistant-stream frame; `fallbackTime` covers clock-free frames. */
  recordFrame(frame: AssistantStreamFrame, fallbackTime: number): void {
    const attemptId = String(frame.attemptId ?? '')
    if (frame.type === 'start') {
      const record: ModelRecord = {
        kind: 'model',
        time: fallbackTime,
        attemptId,
        turn: num(frame.turn),
        step: num(frame.step),
      }
      this.attempts.set(attemptId, record)
      this.push(record)
      return
    }
    const record = this.attempts.get(attemptId)
    if (record === undefined) return
    if (frame.type === 'chunk') {
      // Usage rides its own chunk type, always before finish when present.
      const usage = usageOf(frame.chunk)
      if (usage !== undefined) record.usage = usage
      return
    }
    if (frame.type === 'end') {
      record.endedAt = fallbackTime
      record.outcome = frame.outcome?.kind === 'committed' ? 'committed' : 'abandoned'
      // Done collecting: drop the in-flight entry so a reused id cannot alias.
      this.attempts.delete(attemptId)
    }
  }

  /**
   * The durable route snapshot replaces — never appends — on each header. It
   * lives outside the records (a "current value", not an event), but it is
   * part of the snapshot, so it bumps the revision and the live panel sees
   * route changes on the next poll.
   */
  setRoute(time: number, provider: string, model: string): void {
    this.revision += 1
    this.route = { time, provider, model }
  }

  snapshot(): {
    revision: number
    records: readonly ActivityRecord[]
    totals: ActivityTotals
    route: RouteSnapshot | undefined
  } {
    return { revision: this.revision, records: [...this.records], totals: foldTotals(this.records), route: this.route }
  }

  private push(record: ActivityRecord): void {
    this.revision += 1
    this.records.unshift(record)
    if (this.records.length > this.limit) this.records.length = this.limit
  }
}
