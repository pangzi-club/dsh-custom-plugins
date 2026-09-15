/**
 * Minimal structural types for the DSH/Cordis host surface this plugin uses
 * (v1: webServer ping + the two emit observers). Compile-time only, never
 * shipped; widened chapter by chapter as later features consume more surface.
 */

/** Node's IncomingMessage, as far as the ping handler reads it. */
export interface NodeIncomingMessage {
  method?: string | undefined
}

/** Node's Server response, as far as the ping handler writes it. */
export interface NodeServerResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: Uint8Array | string): void
}

/** One `webServer.register` route entry. */
export interface WebRouteEntry {
  kind: 'exact' | 'prefix' | 'fallback'
  path: string
  handler: (req: NodeIncomingMessage, res: NodeServerResponse) => void
}

/** The agent side of an event payload, as far as the watchtower reads it. */
export interface AgentLike {
  session?: { id?: unknown } | undefined
}

/** One settled tool execution handed to `tools/result` (deep-frozen upstream). */
export interface ToolExecution {
  callId?: unknown
  name?: unknown
  arguments?: unknown
  agent?: AgentLike | undefined
}

/** The frozen terminal outcome of one tool call. */
export interface ToolExecutionResult {
  isError?: unknown
  error?: { name?: unknown; code?: unknown } | undefined
  value?: unknown
}

/**
 * One `agent/assistant-stream` frame, flattened to the fields the fold reads;
 * the code switches on `type` ('start' | 'chunk' | 'end').
 */
export interface AssistantStreamFrame {
  type?: unknown
  attemptId?: unknown
  revision?: unknown
  index?: unknown
  /** Epoch ms on chunk frames only. */
  time?: unknown
  turn?: unknown
  step?: unknown
  /** The StreamChunk on chunk frames; read only for its `usage` payload. */
  chunk?: unknown
  outcome?: { kind?: unknown; eventType?: unknown } | undefined
}

/** The Cordis context, restricted to the seams this plugin consumes (v1). */
export interface DshContext {
  effect(register: () => unknown, label: string): unknown
  on(
    event: 'tools/result',
    listener: (exec: ToolExecution, result: ToolExecutionResult) => void,
  ): unknown
  on(
    event: 'agent/assistant-stream',
    listener: (payload: { agent?: AgentLike | undefined; frame: AssistantStreamFrame }) => void,
  ): unknown
  webServer: { register(entry: WebRouteEntry): unknown }
}
