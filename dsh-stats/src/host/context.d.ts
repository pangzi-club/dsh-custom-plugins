/**
 * Minimal structural types for the DSH/Cordis host surface this plugin uses.
 *
 * The plugin lives outside the repository workspace, so the real `@deepseek-ai/*`
 * types are not resolvable from here (and the host half must not import them);
 * these declarations cover exactly the surface `src/index.ts` touches, the same
 * trick `src/shims.d.ts` plays for the browser half. They are compile-time only
 * and never shipped. `Request`/`Response` come from the DOM lib.
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

/** One `connection.fetch.register` API entry. */
export interface FetchApiEntry {
  path: string
  methods: string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

/** One `tools.register` definition (bare JSON-Schema parameters). */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown> | undefined, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args?: Record<string, unknown>) => Promise<unknown>
}

/** The session side of a `session/event` signal. */
export interface SessionEventSignal {
  id?: unknown
}

/** The event side of a `session/event` signal. */
export interface SessionEventPayload {
  type?: unknown
}

/** One in-flight tool execution handed to `tools/pre-execute` listeners. */
export interface ToolExecution {
  name?: unknown
  arguments?: Record<string, unknown> | undefined
}

/** The Cordis context, restricted to the seams this plugin consumes. */
export interface DshContext {
  effect(register: () => unknown, label: string): unknown
  on(event: 'session/event', listener: (session: SessionEventSignal, event: SessionEventPayload) => void): unknown
  on(
    event: 'tools/pre-execute',
    listener: (exec: ToolExecution, next: () => Promise<unknown>) => unknown,
  ): unknown
  webServer: { register(entry: WebRouteEntry): unknown }
  connection: { fetch: { register(entry: FetchApiEntry): unknown } }
  sessionQuery: { readSession(sessionId: string): Promise<{ events?: unknown }> }
  tools: { register(tool: ToolDefinition): unknown }
}

declare global {
  /** Node's Buffer global, typed as the Uint8Array slice the ping handler uses. */
  var Buffer: { from(input: string, encoding?: string): Uint8Array }
}
