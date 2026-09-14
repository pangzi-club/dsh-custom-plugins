# 03 · 结果变换与工具呈现：`post-execute`、`execute` 包裹与自定义工具

[上一章：权限门](02-pre-execute.md) · [下一章：LLM 调用观测](04-llm-stream.md)

v3 把哨塔从「拦在前面」推进到「跟在后面」：`tools/post-execute` 里做**结果变换**（脱敏、
标注、阻断），`tools/execute` 包裹里给每次调用**计时**；同时注册两个自定义工具——
`watchtower_echo`（变换模式的练功靶）和 `watchtower_report`（顺带演示 `presentCall`/
`presentResult` 的呈现词汇）。上一章的原则在这里全部加倍：post-execute 的决策空间更大，
「取代下游」的杀伤力也更大。

> **本章状态声明**：决策类型、包裹约束与呈现词汇核对自上游 `docs/subsystems/tools.md`、
> `docs/cookbook/adding-a-tool.md` 与仓内 `repeat-tool-reminder`/`spill-policy` 监听者；
> 代码未经本工作区实测。

## 1. `tools/post-execute`：结果的三种命运

管线位置在工具体之后、`tools/result` 之前：

```ts
// mode: waterfall
'tools/post-execute'(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,   // 工具体刚跑完的归一化结果
  next: () => Promise<PostToolDecision>,
): Promise<PostToolDecision>
```

决策类型（上游 `PostToolDecision`）：

```ts
| { kind: 'accept'; content?: ContentBlock[] }            // 替换模型/UI 可见投影
| { kind: 'accept'; value: JsonValue }                    // 替换规范值（会重新校验、重渲染）
| { kind: 'accept'; additionalContexts?: UserMessage[] }  // 三者可组合
| { kind: 'block'; feedback: ContentBlock[] }             // 把结果变成错误，feedback 成为模型可见的纠正文本
```

（`content` 与 `value` 二选一：替换投影不动规范值；替换规范值则整个投影按新值重算。）

三个语义要点：

- **失败的调用也会到这里**：工具体抛错、乃至上一站被 deny 的调用，都以错误结果流经
  post-execute（第 2 章的坑）。变换前先看 `result.isError`，别把失败结果再加工一遍；
- **`block` 是「结果级否决」**：调用已经跑了，覆水难收——block 做的不是撤销，而是把
  成功结果替换成错误 + 纠正反馈，让模型知道为什么这份结果不能用。门禁（pre-execute）
  拦的是「能不能跑」，这里拦的是「这份结果能不能用」；
- **`additionalContexts` 骑在任何决策上**：给下一次模型请求捎一条耐久上下文（用户角色
  消息），仓内 `repeat-tool-reminder` 用它提醒模型「你已经连续调了 N 次同一个工具」。

仓内监听者示范了一个值得抄的组合姿势——**先自记、再委托、后叠加**：先做自己的观察
（状态无论如何推进），`await next()` 让下游先说，然后把自己的贡献**折**到下游决策上；
下游 block 就尊重 block，绝不用自己的 accept 把它翻掉。post-execute 的监听者之间是
这样和平共处的。

## 2. `tools/execute`：一次词法生命周期的包裹

```ts
// mode: waterfall
'tools/execute'(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
```

它**包住整个调度**（超时、重试、指标都写在这层；仓内的 timeout-policy 就是一个
`tools/execute` 包裹者）。对插件最实用的姿势是**计时**：

```ts
ctx.on('tools/execute', async (exec, next) => {
  const startedAt = Date.now()
  const result = await next()
  durations.set(String(exec.callId ?? ''), Date.now() - startedAt)
  return result
})
```

两条约束写进上游文档：

- 包裹者**只能替换 `exec.signal`**（自己的超时信号），调用身份不可动；而且注册表会把
  替换信号与真正的调用者信号**融合**——你换掉的信号中止时，调用者那边照样中止。本教程
  只读不换；
- 这里的 `next()` 返回的是 post-execute **之前**的结果——包裹者看到的和
  `tools/result` 看到的不是同一个东西。所以 v3 的计时器用一个小 Map 把毫秒数按 `callId`
  递给 `tools/result` 观察者落账（最终结果只认 `tools/result`，第 1 章的选择再次占优）。

上游 cookbook 的一句话总结两个站的分工：**「最终结果的指标/审计/捕获用 `tools/result`；
只有必须变换结果或捎带上下文时才用 `tools/post-execute`」**。

## 3. 动手 v3

三个增量：`transform.ts`（纯函数）、`activity.ts` 的计时字段、`index.ts` 的三段接线。

### 3.1 变换内核：`src/host/transform.ts`

判定逻辑全部抽成纯函数：给模式、结果状态和文本，回答「这个结果该走哪条路」。第 7 章
不用 mock 任何框架就能测它。

**`dsh-tool-watchtower/src/host/transform.ts`**

```ts
/**
 * The transform kernel: pure planning for the post-execute listener. Given a
 * mode and the result's text, decide which path the result takes. No ctx, no
 * framework types — the listener only executes the plan.
 */

export type TransformMode = 'off' | 'redact' | 'annotate' | 'block-secret'

export interface TransformConfig {
  /** Tool names the demo transform may touch (own demo tools; keep user tools out). */
  tools: string[]
  mode: TransformMode
}

/** The marker the demo treats as a secret leak. */
export const SECRET_MARK = 'DSH_SECRET'

const MODES = new Set(['off', 'redact', 'annotate', 'block-secret'])

/** Validate `config.transform` (undefined → off) or fail loudly. */
export function resolveTransform(input: unknown): TransformConfig {
  if (input === undefined) return { tools: [], mode: 'off' }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`dsh-tool-watchtower: config.transform must be a mapping, got ${JSON.stringify(input)}`)
  }
  const raw = input as { tools?: unknown; mode?: unknown }
  if (!Array.isArray(raw.tools) || raw.tools.some(tool => typeof tool !== 'string' || tool.length === 0)) {
    throw new Error('dsh-tool-watchtower: config.transform.tools must be an array of non-empty strings')
  }
  if (typeof raw.mode !== 'string' || !MODES.has(raw.mode)) {
    throw new Error('dsh-tool-watchtower: config.transform.mode must be one of "off" | "redact" | "annotate" | "block-secret"')
  }
  return { tools: [...raw.tools], mode: raw.mode as TransformMode }
}

/** Join the text blocks of one result's content into a single string. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .join('\n')
}

/** Replace every secret marker in the projected text. */
export function redactText(text: string): string {
  return text.split(SECRET_MARK).join('[redacted]')
}

export type TransformPlan = 'passthrough' | 'redact' | 'block' | 'annotate'

/** The pure decision: what should happen to one settled result. */
export function planTransform(mode: TransformMode, isError: boolean, text: string): TransformPlan {
  if (mode === 'off' || isError) return 'passthrough'
  if (mode === 'redact') return text.includes(SECRET_MARK) ? 'redact' : 'passthrough'
  if (mode === 'block-secret') return text.includes(SECRET_MARK) ? 'block' : 'passthrough'
  return 'annotate'
}
```

### 3.2 计时落账：`activity.ts` 的增量

`ToolRecord` 增加一个字段（放在 `code` 之后）：

```ts
  /** Wall-clock milliseconds from the tools/execute wrapper, when measured. */
  durationMs?: number
```

`recordTool` 换成带时长的新签名（调用点同步更新）：

```ts
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
```

### 3.3 类型垫片增量：`context.d.ts`

本章首次消费 `tools` 服务，`inject` 相应扩成 `['webServer', 'tools']`（第 5 章再加
`connection`）。`DshContext` 增加成员与定义：

```ts
export interface DshContext {
  // …v1/v2 的成员不变…

  /** The v3 additions: content blocks, the run context, the two waterfalls. */
  tools: { register(tool: ToolDefinition): unknown }
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
}
```

内容块、运行上下文与工具定义（含可选的呈现投影——`presentCall`/`presentResult` 是
上游 `ToolDefinition` 的可选字段，出仓侧同样可选）：

```ts
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
```

工具定义本身（`tools.register` 的参数；`presentCall`/`presentResult` 在上游就是可选
字段，出仓侧同样可选）：

```ts
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
```

`DshContext` 增加两条瀑布与 `inject` 不变（事件不进 inject）。新增重载：

```ts
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
```

### 3.4 接线：`index.ts` 的三段

**其一：config 与计时器。** `EffectiveConfig` 增加 `transform: TransformConfig`，解析处
加一行（校验失败照样 fail-loudly）：

```ts
  const effective: EffectiveConfig = {
    rules: resolveRules(source.rules),
    transform: resolveTransform(source.transform),
  }
```

`apply` 体内、两个 v1 观察者之前，加计时器与它的交接处：

```ts
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
```

v1 的 `tools/result` 观察者更新为取出时长（其余不变）：

```ts
  ctx.on('tools/result', (exec, result) => {
    const sessionId = String(exec.agent?.session?.id ?? '')
    if (sessionId.length === 0) return
    const callId = String(exec.callId ?? '')
    const isError = result.isError === true
    const code = isError && typeof result.error?.code === 'string' ? result.error.code : undefined
    const durationMs = durations.get(callId)
    durations.delete(callId)
    logOf(sessionId).recordTool(Date.now(), callId, String(exec.name ?? ''), isError, code, durationMs)
    console.log(`[dsh-tool-watchtower] tool ${isError ? 'error' : 'ok'}: ${String(exec.name ?? '')}${durationMs === undefined ? '' : ` (${durationMs}ms)`}`)
  })
```

**其二：变换监听者。** 放在门禁监听者之后——它的结构就是 §1 说的「先自记、再委托、
后叠加」：

```ts
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
    const downstream = await next() as PostDecisionLike
    if (downstream.kind === 'block') return downstream

    if (plan === 'redact') {
      // Replace the model/UI-facing projection; the canonical value is intact.
      return { kind: 'accept', content: [{ type: 'text', text: redactText(contentText(result.content)) }] }
    }

    // annotate: ride a durable notice onto the next model request.
    const notice = {
      id: `dsh-tool-watchtower-notice-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: `watchtower recorded "${toolName}"; the session activity log includes this call.` }],
      source: { kind: 'plugin', plugin: 'dsh-tool-watchtower', form: 'notice', summary: `${toolName} recorded` },
    }
    const carried = Array.isArray(downstream.additionalContexts) ? downstream.additionalContexts : []
    return { kind: 'accept', additionalContexts: [notice, ...carried] }
  })
```

`notice` 上有一处出仓约束要诚实标注：上游造 `UserMessage` 的正路是
`createUserMessage`（来自 `@deepseek-ai/dsh-llm`），出仓解析不到，所以这里用**手写字面
量**（`id` 给了唯一字符串）。运行时它就是一条普通消息；但若未来版本对 id 的形态加了
运行时校验，这里是第一个会碎的地方——已列入插件 README 的已知限制。只想要「下一次请求
前注入上下文」而不动结果的话，还有第一辑第 6 章提过的
`exec.agent.inject({ content, source: { kind: 'plugin', plugin: '…' } })` 通道。

**其三：两个演示工具。** `watchtower_echo` 是变换模式的练功靶（让它回显带
`DSH_SECRET` 的文本即可触发 redact/block）；`watchtower_report` 读哨塔自己的快照：

```ts
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
          : { records: [], totals: foldTotals([]) }
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
```

（`foldTotals` 从 `./host/activity.js` 一并 import。）

呈现词汇只用最保守的 `generic` 卡：`presentCall` 在**等待期**给标题与类别（`kind:
'read'` 让 UI 挑一个读类图标），`presentResult` 在**完成后**给一行摘要。上游词汇表里
还有 `terminal`/`diff`/`search` 等卡形（见延伸阅读），规则一致：**纯函数、只描述意图、
不碰 UI**——真正的会话内卡片渲染是第 6 章 keyed 座位的事，那是另一条独立通道。

配置示例（`watchtower_report` 默认放行，`watchtower_echo` 进变换靶区）：

```yaml
- insert:
    - id: watchtower
      name: '/path/to/dsh-custom/dsh-tool-watchtower/lib/index.js'
      config:
        rules:
          - tool: '*'
            decision: allow
        transform:
          tools: [watchtower_echo]
          mode: redact          # 'off' | 'redact' | 'annotate' | 'block-secret'
```

## 4. 上机验证清单

宿主代码改动 → **重启** `dsh web`、刷新：

1. **计时**：让模型随便跑一个工具（如 read）。宿主终端的 tool 日志带上了毫秒
   （`tool ok: read (12ms)`）——这是包裹者与 `tools/result` 隔着 Map 握手成功；
2. **redact**：`mode: redact` 下让模型「用 watchtower_echo 回显 `密码是 DSH_SECRET_123`」。
   模型收到的工具结果里标记已替换为 `[redacted]`，但工具**成功**（不是错误）——投影
   被换、规范值无恙；
3. **block-secret**：换成 `mode: block-secret` 再来一次。这次工具以错误收场，错误文案
   是 feedback 那句「Re-run without embedding secrets」，模型通常会照做——观察它第二
   次调用的行为变化；
4. **annotate**：换成 `mode: annotate`，随便回显一条。结果原样到模型，但下一次模型
   请求里多了一条 watchtower 的 notice 上下文（GUI 里可能折叠显示为上下文行）；
5. **自定义工具**：让模型「调用 watchtower_report 看看当前会话的活动」。等待期卡片
   标题应为 Watchtower report（presentCall 生效），完成后卡片正文是一行 totals 摘要
   而不是 JSON 堆（presentResult 生效）；展开看模型侧收到的仍是完整 JSON；
6. **不打扰验证**：把 `transform.tools` 指向 `watchtower_echo` 时随便跑一个 `read`——
   它的路径应为 `passthrough`（下游原样），确认靶区限制在工作。

## 5. 本章坑

- **post-execute 的 accept 会掀翻下游**：你的返回值取代整条下游决策。变换型监听者必须
  先 `await next()` 并尊重下游的 block（本章代码的「先委托后叠加」姿势）；例外的只有
  你**刻意**要否决的 block；
- **`content` 与 `value` 二选一**：同时给两个是类型错误；替换 `value` 会触发重新校验——
  换出去的值必须仍然满足工具的 `output.schema`；
- **包裹者看到的不是最终结果**：`tools/execute` 的 `next()` 在 post-execute 之前返回。
  要「最终真相」，观察 `tools/result`；要「过程指标」，在包裹里记、按 `callId` 交接；
- **信号替换是双刃剑**：包裹者换 `exec.signal` 后必须让自己的工作在信号中止时安静下来
  （上游叫 reach quiescence）。教程只计时，不碰信号——需要超时语义时优先给工具声明
  `timeoutMs`，让仓内 timeout-policy 包裹；
- **additionalContexts 的 id**：出仓造不了 `createUserMessage`，手写字面量的 id 是已知
  的兼容性赌注（见 §3.4 的标注）；
- **presentCall/presentResult 必须纯**：同参数同返回、不抛错、不碰网络不碰 DOM——注册
  表会在任意时刻重放它们（上游原文：pure replayable）。

## 6. 小结

- post-execute 三种命运：accept（换投影/换值/捎上下文）、block（结果级否决 + 纠正
  反馈）、或老实 `next()`；
- 组合姿势「先自记、再委托、后叠加」是 post-execute 监听者和平共处的关键；
- `tools/execute` 是包裹层：计时、超时、指标的位子；只许换信号，且它看到的不是最终
  结果——最终真相在 `tools/result`；
- 自定义工具的呈现走 `presentCall`/`presentResult` 的 render-intent 词汇，纯函数描述
  意图，UI 由宿主侧桥接（第 6 章还有 keyed 座位的会话内通道）；
- 出仓约束落地一处：`UserMessage` 手工造，id 是已知限制。

## 7. 延伸阅读

- 上游 `docs/subsystems/tools.md` —— post-execute / execute 两节的决策类型全文与
  「content 与 value 二选一」的重校验语义；
- 上游 `docs/cookbook/extension-cookbook.md` —— feature → mechanism 表里两行金句：
  「最终指标用 tools/result；必须变换才用 post-execute」「deadline/retry/metrics 用
  tools/execute 包裹」；
- 上游 `docs/cookbook/adding-a-tool.md` —— 呈现词汇表（generic/terminal/diff/search/
  read/web 卡）与 presentCall/presentResult 的纯度规则；
- 仓内 `packages/guard/repeat-tool-reminder` —— 「先自记、再委托、后叠加」的原型
  （additionalContexts 折叠姿势的出处）；
- 仓内 `packages/guard/timeout-policy` —— timeoutMs 的官方包裹者，
  信号替换的示范。
