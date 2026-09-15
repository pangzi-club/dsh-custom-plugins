/**
 * Minimal structural types for the DSH/Cordis host surface this plugin uses.
 * Compile-time only, never shipped; widened chapter by chapter as later
 * features consume more surface (v1 observers → v2 gate → v3 tools/waterfalls
 * → v4 llm/session/inbox → v5 connection.fetch).
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

/** One `connection.fetch.register` route entry (the authenticated API lane). */
export interface ConnectionRoute {
  path: string
  methods: string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
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
  content?: unknown
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

/** Content block, as far as render/feedback builders create them. */
export interface ContentBlockLike {
  type: string
  text?: string | undefined
}

/** The execution context handed to a tool's execute (signal not consumed here). */
export interface ToolRunContextLike {
  agent?: AgentLike | undefined
}

/** The dispatch view a tools/execute wrapper receives. */
export interface ToolDispatchExecutionLike {
  callId?: unknown
  name?: unknown
  agent?: AgentLike | undefined
}

/** The pre-post-execute result a wrapper's next() resolves to. */
export interface DispatchResultLike {
  isError?: unknown
}

/** One post-execute decision a downstream listener may have produced. */
export interface PostDecisionLike {
  kind?: unknown
  content?: unknown
  value?: unknown
  additionalContexts?: unknown
}

/** The tool definition `tools.register` accepts (bare JSON Schema form). */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown> | undefined, value: unknown) => ContentBlockLike[]
  }
  execute: (args: Record<string, unknown> | undefined, exec?: ToolRunContextLike | undefined) => Promise<unknown>
  /** Render-intent view for the pending call card (upstream GenericCallView subset). */
  presentCall?: (args: Record<string, unknown> | undefined) => Record<string, unknown> | undefined
  /** Render-intent view for the completed card (upstream GenericResultView subset). */
  presentResult?: (args: Record<string, unknown> | undefined, value: unknown) => Record<string, unknown> | undefined
}

/** GenerateOptions, as far as the read-only llm/stream observer reads it. */
export interface GenerateOptionsLike {
  provider?: unknown
  model?: unknown
}

/** One session-event broadcast: a type tag plus its opaque payload. */
export interface SessionEventSignal {
  id?: unknown
}

export interface SessionEventLike {
  type?: unknown
  data?: unknown
}

/** An inbox message, as far as the prompt observer reads it. */
export interface InboxMessageLike {
  content?: unknown
}

/** The Cordis context, restricted to the seams this plugin consumes. */
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
  on(
    event: 'tools/pre-execute',
    listener: (exec: ToolExecution, next: () => Promise<unknown>) => Promise<unknown>,
  ): unknown
  on(
    event: 'tools/execute',
    listener: (exec: ToolDispatchExecutionLike, next: () => Promise<DispatchResultLike>) => Promise<unknown>,
  ): unknown
  on(
    event: 'tools/post-execute',
    listener: (
      exec: ToolExecution,
      result: ToolExecutionResult,
      next: () => Promise<PostDecisionLike>,
    ) => Promise<unknown>,
  ): unknown
  on(
    event: 'llm/stream',
    listener: (options: GenerateOptionsLike, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>,
  ): unknown
  on(
    event: 'session/event',
    listener: (session: SessionEventSignal, event: SessionEventLike) => void,
  ): unknown
  on(
    event: 'agent/inbox/inserted',
    listener: (payload: { agent?: AgentLike | undefined; message?: InboxMessageLike | undefined }) => void,
  ): unknown
  webServer: { register(entry: WebRouteEntry): unknown }
  connection: { fetch: { register(route: ConnectionRoute): unknown } }
  tools: { register(tool: ToolDefinition): unknown }
}
