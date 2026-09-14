# 01 · 事件模式与观察者：把哨塔架上

[上一章（导读）](README.md) · [下一章：权限门](02-pre-execute.md)

第一辑里你已经让插件「说话」（路由、API、界面）和「干活」（工具）。本辑的第一个动作
是让它「旁听」：v1 给贯穿示例 `dsh-tool-watchtower` 架起两个观察位——旁听每次工具调用
的终局（`tools/result`）和每次模型输出的实时流（`agent/assistant-stream`），把看到的
东西折进内存环形缓冲，再暴露一个心跳路由确认自己活着。后面六章的全部能力（门禁、变换、
面板）都长在这层观察之上。

> **本章状态声明**：本辑代码依据上游文档与源码签名撰写（出处见各章延伸阅读），未经
> 本工作区运行实测。第一次照抄请留出验证时间；遇到出入，以上游文档为准。

## 1. 事件的四种模式

第一辑你已经用过两类「事件」：Cordis 事件（进程内总线分派，`ctx.on('tools/pre-execute', …)`）
和会话事件广播（耐久日志落盘后的 `ctx.on('session/event', …)`）。本辑只碰前者，但要用
全它的模式谱系。上游把 Cordis 事件分成四种模式（辨析见上游
`docs/user/develop/framework/events.md` 的 Event modes 一节）：

| 模式 | 语义 | 监听者签名 | 本辑用到的例子 |
| --- | --- | --- | --- |
| `emit` | 通知，不等待、不改变事件本身 | 普通回调 | `tools/result`、`agent/assistant-stream`、`agent/inbox/inserted` |
| `waterfall` | 监听者链依次过手，可裁决/可变换 | `(payload, next) => Promise<decision>` | `tools/pre-execute`（第 2 章）、`tools/post-execute`（第 3 章）、`llm/stream`（第 4 章） |
| `serial` | 逐个 await，能延迟边界但不改数据 | 普通回调（可异步） | `agent/turn-stopping`（本辑不展开） |
| `bail` | 有监听者表态即停 | 返回非空值即接管 | 本辑不涉及 |

两种模式的**纪律差异**是本辑的地基：

- **emit 是安全的**：监听者抛错被框架收纳（contained），事件照常分派给下一个听者——
  所以观察位优先选 emit，写坏了也拖不垮宿主；
- **waterfall 是有责任感的**：监听者**必须** `return next()` 把链交下去，除非你刻意
  短路。忘掉 `next()` 不是抛错，而是**静默吃掉整条管线**——工具不再执行、流不再往下走，
  且没有任何报错指向你的监听者。第 2、3 章全是 waterfall，先把这条纪律刻进肌肉。

## 2. v1 的两个观察位

### 2.1 `tools/result`：工具调用的终局

```ts
// mode: emit — listener failures are contained
'tools/result'(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```

它在管线**最末端**触发：工具体跑完（或在更早的站被拒绝）、结果已归一化并深冻结之后。
`exec` 携带这次调用的身份（`callId`、`name`、冻结的 `arguments`、发起的 `agent`），
`result` 是终态——`{ isError: false, value, content }` 或
`{ isError: true, error: { name, code }, content }`。

第一辑第 6 章留过一句「emit 场景也可以用 `tools/result`，更合适」——v1 就把它落成代码。
选它做审计位有三个理由：**只读**（想改也改不了，对象是冻结的）、**终局**（一次调用恰好
一条记录，不像 pre-execute 还有被门禁拦下的一半）、**容错**（你的监听者抛错只伤自己）。

注意作用域：`tools/*` 事件按 agent 作用域过滤（agent 级监听者只听到自己 agent 的调用）；
出仓插件用 `ctx.on` 注册的是**全局**监听者，所有 agent 的调用都听得到——正是哨塔要的。

### 2.2 `agent/assistant-stream`：模型输出的实时流

```ts
// mode: emit
'agent/assistant-stream'(payload: { agent: Agent; frame: AssistantStreamFrame }): void
```

每次模型尝试（attempt）在进程内直播一条帧流，`frame` 是三拍子：

```
start   { attemptId, revision, turn, step }            一次尝试开始
chunk   { attemptId, index, time, chunk: StreamChunk } N 次，逐块输出
end     { attemptId, outcome: committed | abandoned }  结算（或放弃）
```

`chunk.chunk` 是上游的 `StreamChunk` 词汇：`text-delta`/`reasoning-delta`（文本与思考
增量）、`tool-call-delta`（工具调用参数流）、`usage`（token 用量，**恒在 finish 之前**）、
`finish`（收尾）。v1 只关心 `usage`——它的载荷 `TokenUsage` 有四个桶：`inputTokens`
（未缓存输入）、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`。

这帧流和耐久日志的关系要分清：**chunk 帧是过程性的**，只活在进程里，页面刷新就拿不回来；
尝试结算时，完整副本才作为 `assistant/message`（或失败的 `assistant/attempt`）落进会话
日志并广播 `session/event`。想要历史数据走 `sessionQuery`（第一辑第 4 章）；想要「正在
发生」，只有这条流。

### 2.3 事件名别念错

一组高发混淆，先排掉：

| 你想要的 | 正确写法 | 常见错写 |
| --- | --- | --- |
| Cordis 事件：工具结果终局 | `ctx.on('tools/result', …)` | `tool/result`（这是**会话事件类型**，少个 s） |
| Cordis 事件：模型实时流 | `ctx.on('agent/assistant-stream', …)` | `agent/stream`、`assistant/stream` |
| 会话事件里的工具调用/结果 | `(session, event) => event.type === 'tool/call'` | `ctx.on('tool/call', …)`（不存在这条 Cordis 事件） |

## 3. 动手：脚手架 + 观察者

本章建出插件的完整骨架。构建链（`build.mjs`、tsconfig、`.dsh-repo` 指针）照抄第一辑
[第 5 章](../tutorial/05-web-client.md)的做法，下面只列**本插件的**文件全文与差异。

### 3.1 包与构建链

**`dsh-tool-watchtower/package.json`**（第 5 章会补客户端条目）：

```json
{
  "name": "dsh-tool-watchtower",
  "version": "0.1.0",
  "description": "DSH Web GUI plugin: tool & model activity watchtower",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test test/*.test.mjs"
  },
  "private": true
}
```

**`dsh-tool-watchtower/build.mjs`**：v1 只编译宿主半边（客户端半边第 5 章加入时再换成
双半边版本）。开头 `resolveRepo()` 原样照抄第一辑第 5 章 `build.mjs` 的同名函数（环境
变量 `DSH_REPO` 优先、`.dsh-repo` 指针兜底、缺失时给出可操作的报错）：

```js
/**
 * Build the host half into lib/ (v1: host only; the client half joins with
 * the live panel later). Output stages through .build/ so a failed compile
 * never leaves a half-updated lib/ behind.
 *
 * Usage: node build.mjs
 *   The DSH checkout that owns `tsc` is machine-local: set DSH_REPO, or write
 *   the path into the git-ignored `.dsh-repo` file next to this script.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/** Resolve the checkout that provides `tsc`; env first, then the pointer file. */
function resolveRepo() {
  const configured = process.env.DSH_REPO?.trim()
  if (configured) return configured
  const pointer = join(root, '.dsh-repo')
  if (existsSync(pointer)) {
    const fromFile = readFileSync(pointer, 'utf8').trim()
    if (fromFile) return fromFile
  }
  throw new Error(
    'build.mjs: no deepseek-harness checkout configured.\n'
      + `Set DSH_REPO=/path/to/deepseek-harness, or write that path into ${pointer} (git-ignored).`,
  )
}

const tsc = join(resolveRepo(), 'node_modules', '.bin', 'tsc')
if (!existsSync(tsc)) {
  throw new Error(
    `build.mjs: ${tsc} not found.\n`
      + 'Point DSH_REPO at a deepseek-harness checkout whose dependencies are installed (pnpm install).',
  )
}

rmSync(join(root, '.build'), { recursive: true, force: true })
execFileSync(tsc, ['-p', join(root, 'tsconfig.host.build.json')], { stdio: 'inherit' })
rmSync(join(root, 'lib'), { recursive: true, force: true })
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, '.build', 'index.js'), join(root, 'lib', 'index.js'))
cpSync(join(root, '.build', 'host'), join(root, 'lib', 'host'), { recursive: true })
rmSync(join(root, '.build'), { recursive: true, force: true })
console.log('built lib/index.js + lib/host/')
```

`tsconfig.host.build.json`、`tsconfig.json`（编辑器入口）与 `.gitignore` 从 `dsh-stats/`
原样抄过来，不用改（`include` 恰好都是 `src/index.ts` + `src/host`）。另外把上游 checkout
路径写进 git-ignored 的 `dsh-tool-watchtower/.dsh-repo`（一行绝对路径）。

### 3.2 类型垫片：`src/host/context.d.ts`

出仓插件解析不到上游类型，照第一辑的惯例自写最小结构化声明——只声明本章读到的面，
字段一律防御性 `unknown`，由使用方收窄：

**`dsh-tool-watchtower/src/host/context.d.ts`**

```ts
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
```

### 3.3 活动折叠：`src/host/activity.ts`

观察者的全部**逻辑**住在这个纯模块里：环形缓冲、帧折叠、总量统计。不碰 `ctx`、不碰
时钟（事件自带时间戳的地方用事件自带的；没有的地方由调用方传入 `Date.now()`），第 7 章
可以直接单测。

**`dsh-tool-watchtower/src/host/activity.ts`**

```ts
/**
 * Activity fold for the watchtower: a per-session ring buffer fed by the
 * `tools/result` and `agent/assistant-stream` observers, plus the pure totals
 * fold the ping body (and, later, the live panel) serve.
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

export type ActivityRecord = ToolRecord | ModelRecord

export interface ActivityTotals {
  tools: number
  toolErrors: number
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

/**
 * One session's ring buffer. New records land at the front; the oldest drop
 * past `limit`. In-flight attempts live in `attempts` until their end frame
 * arrives, so usage and outcome land on the record pushed at start.
 */
export class ActivityLog {
  private readonly records: ActivityRecord[] = []
  private readonly attempts = new Map<string, ModelRecord>()

  constructor(readonly limit: number) {}

  recordTool(time: number, callId: string, name: string, isError: boolean, code?: string): void {
    const record: ToolRecord = {
      kind: 'tool',
      time,
      callId,
      name,
      isError,
      ...(code === undefined ? {} : { code }),
    }
    this.push(record)
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

  snapshot(): { records: readonly ActivityRecord[]; totals: ActivityTotals } {
    return { records: [...this.records], totals: foldTotals(this.records) }
  }

  private push(record: ActivityRecord): void {
    this.records.unshift(record)
    if (this.records.length > this.limit) this.records.length = this.limit
  }
}
```

### 3.4 宿主入口：`src/index.ts`

**`dsh-tool-watchtower/src/index.ts`**

```ts
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
```

三个设计点：

- **按会话分桶**：`exec.agent?.session?.id` 与 `agent.session.id` 把每条观测挂到会话上。
  第 5 章的 live 面板按会话地址取数，这个分桶从 v1 就定下来；`SESSION_LIMIT` 防止长驻
  进程里会话 Map 无界生长（最旧淘汰，同第一辑 memo 的做法）；
- **观测位不存活对象**：`exec`/`result` 是冻结快照，但里面的 `agent`、`signal` 是活引用
  ——监听者只抽取纯数据（字符串、布尔、数字）进缓冲，不持有整对象；
- **console.log 是脚手架**：两个观察位各留了一行终端输出，专为本章验证。第 5 章面板
  上线后应删掉（届时缓冲有了真正的出口）。

### 3.5 挂载

构建并在 profile 里登记（绝对路径，见第一辑第 6 节生效语义；改的是 boot graph，要**重启**
`dsh web`）：

```sh
cd /path/to/dsh-custom/dsh-tool-watchtower
node build.mjs
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 顶层数组里加一行（其余行保留）：

```yaml
- insert:
    - id: watchtower
      name: '/path/to/dsh-custom/dsh-tool-watchtower/lib/index.js'
```

## 4. 上机验证清单

重启 `pnpm dsh web` 并刷新 <http://127.0.0.1:3080>，按顺序确认：

1. **心跳**：`curl http://127.0.0.1:3080/dsh-tool-watchtower/ping` →
   `{"ok":true,"plugin":"dsh-tool-watchtower","sessions":0,"now":"…"}`
   （`sessions` 计数是活的：聊过天再 curl，应看到它变成 1+）；
2. **工具终局**：在 GUI 里发一条会触发工具的消息（如「用 read 工具看一下仓库的
   README.md」）。模型发起 `read` 调用、跑完后，宿主终端出现
   `[dsh-tool-watchtower] tool ok: read`——注意它在**结果落定后**出现，不是调用前；
3. **模型结算**：任意一次回复结束后，终端出现
   `[dsh-tool-watchtower] attempt <id> committed`；
4. **放弃路径**：模型长回答中途点停止按钮 → 应看到 `attempt <id> abandoned`（或一次
   失败尝试落成错误终局）——过程流没了，但 end 帧总是到达；
5. **无 GUI 冒烟**：`dsh --profile web --dump-config` 里能找到 watchtower 行。

排查顺序（没看到日志时）：插件行进了组合结果吗（第 5 步）→ 重启了吗（boot graph 变化
必须重启，光刷新没用）→ 事件名拼写（§2.3 的对照表）→ 监听者自己抛错了吗（emit 容错
不报给你，临时在监听者首行加 `console.log('seen')` 二分定位）。

## 5. 本章坑

- **emit 不是 waterfall**：这两个观察位**没有 `next()`**。把第一辑 pre-execute 的写法
  带过来（`async (exec, next) => …`）只会得到一个永远不被调用的参数和无辜的观察者；
- **`tools/result` 与 `tool/result` 差一个字母**：后者是 `session/event` 的**类型**——
  `ctx.on('tool/result')` 静默无效（Cordis 不认识的监听者不报错，只是永远不触发）；
- **usage 块按「可能没有」处理**：上游约定 adapter 在 finish 前发 usage，但不保证每个
  provider 每次都带；`foldTotals` 对缺 usage 的尝试照常计数，只是四个桶不加；
- **start 帧没有时间戳**：`chunk.time` 才有（epoch ms）。v1 用本地时钟兜底，亚秒精度
  场景请在 chunk 里取时间；
- **`arguments` 是冻结的**：读可以，改写没意义（改冻结对象直接抛 TypeError）——参数
  本来也不许改写，第 2 章会讲为什么管线把这个口子焊死了；
- **内存有界**：环形缓冲 + 会话数上限都是刻意的。哨塔常驻在宿主进程里，任何「只进不出」
  的记录结构都是泄漏。

## 6. 小结

- Cordis 事件四种模式：emit 安全（容错、无责任）、waterfall 有纪律（`next()` 必调，
  否则静默短路）；观察位优先 emit；
- `tools/result` = 工具调用的只读终局（身份 + 冻结结果），审计位首选；
- `agent/assistant-stream` = 模型尝试的进程内直播（start/chunk/end 三拍子，usage 桶
  挂在 chunk 上）；过程流≠耐久日志，历史走 `sessionQuery`；
- 事件名对照要背：`tools/result`（Cordis）vs `tool/result`（会话事件类型）；
- v1 建成：按会话分桶的环形缓冲 + 纯折叠 + 心跳路由，第 7 章的全部测试素材就位。

## 7. 延伸阅读

- 上游 `docs/user/develop/framework/events.md` —— 四种事件模式的权威定义；
- 上游 `docs/cordis-primer.md` —— waterfall 语义与「不调 next 即短路」的警告框；
- 上游 `docs/subsystems/tools.md` —— `tools/result` 节与 `ToolExecution`/`ToolExecutionResult`
  的完整字段（cordis-catalog 生成区，签名永远可对源码验证）；
- 上游 `docs/subsystems/llm-streaming.md` —— `StreamChunk`、`TokenUsage` 词汇表；
- 上游 `docs/subsystems/core.md` —— `agent/*` 事件一节（含 assistant-stream 的帧定义）；
- [第一辑第 6 章](../tutorial/06-tools-events.md) —— 工具注册与 pre-execute 入门（本章
  是它的实测补全与展开）。
