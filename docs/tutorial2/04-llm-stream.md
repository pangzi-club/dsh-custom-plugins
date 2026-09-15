# 04 · LLM 调用观测：只看，不碰

[上一章：结果变换与工具呈现](03-transform.md) · [下一章：live 数据通道](05-live-ui.md)

工具层已经布满传感器。v4 把哨塔的镜头转向**模型调用本身**：每一次请求走哪个
provider/model（`llm/stream`），当前会话的模型配置是什么（`session/event` 的
`request/header`），用户的提示词何时入队（`agent/inbox/inserted`）。

先把本辑的硬边界钉死：**这一章全部是观测**。不换模型、不改请求、不重放流——
`agent/request`（换模型配置的正道）与 `llm/stream` 的短路/自产流（重放、网关模式）都
在延伸阅读里指路，正文不碰。观测位一旦越过这条线，就从「哨塔」变成「中间人」了。

> **本章状态声明**：事件载荷核对自上游 `docs/subsystems/llm-streaming.md`、
> `docs/subsystems/core.md` 与 `docs/subsystems/session.md`；代码已按工作区实测实现
> 核对（2026-09-15）。

## 1. 三个观测位，三种时间性

| 观测位 | 模式 | 载荷 | 时间性 | 有会话身份吗 |
| --- | --- | --- | --- | --- |
| `llm/stream` | waterfall | `GenerateOptions`（provider、model、messages…） | 进程内，每次调用 | **没有** |
| `session/event` 之 `request/header` | 日志广播 | `EpochHeader`（config 快照） | 耐久，落盘 | 有（`session.id`） |
| `agent/inbox/inserted` | emit | `{ agent, message }` | 进程内，入队时刻 | 有（`agent.session.id`） |

三个站位互补，缺一不可：

- **`llm/stream` 是唯一包住「每一次」模型调用的拦截点**——包括不走 agent 循环的手工
  调用。签名是本教程最特别的一个：waterfall 过的不是决策值，而是**异步可迭代**：

  ```ts
  'llm/stream'(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  ```

  上游给它写了三条规矩：**循环构建的请求到达时已深冻结（改写直接抛 TypeError）**——
  它的内容是会话日志的纯函数，改了就无法重建；**调 `next()` 拿到真正的 adapter 流**；
  **不调 `next()` 而自产 chunk 就是短路/重放**——那是网关模式的能力，也是观测者的禁区。
  观测姿态因此只有一个：读 `options` 的稳定字段，**原样返回 `next()` 的返回值**；

- **`request/header` 是耐久世界的模型配置快照**：每次请求纪元（initial/resume/change/
  series）落盘一条，`data.header.config` 带着 provider/model/reasoningEffort 等。它是
  `session/event` 的**类型**而非 Cordis 事件——老规矩，`ctx.on('session/event', (s, e)
  => e.type === 'request/header')`。想让面板显示「当前模型」，这里是权威来源；

- **`agent/inbox/inserted` 标记提示词入口**：消息进入活跃收件箱的时刻（上游词汇：
  inserted → claimed → 进入 step，或 discarded）。按会话统计「用户发了多少条、多长」，
  这里是入口。`message.content` 是内容块数组，文本长度自己数——那是**字符数不是
  token 数**，别混用。

顺带一提：第 1 章挂的 `agent/assistant-stream` 观察者已经在按会话折叠 usage 块——
本新不新增东西，它就是本章故事的第三块拼图（请求 → 流 → 用量，三站贯穿一次调用）。

## 2. 动手 v4

### 2.1 `activity.ts` 增量

一种新记录（提示词入队）+ 一个与流水分开的**路由槽**。`llm/stream` 没有会话身份，它的
请求行只进终端日志、不进缓冲（§1 的表格）；路由不是事件流而是「当前值」，所以不放
records、单独存：

```ts
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
```

`ActivityTotals` 增加 `prompts: number`（初始化为 0），`foldTotals` 加一个分支：

```ts
    if (record.kind === 'prompt') {
      totals.prompts += 1
      continue
    }
```

类里加三个成员（`route` 与两个记录方法）：

```ts
  private route: RouteSnapshot | undefined

  /** The durable route snapshot replaces — never appends — on each header. */
  setRoute(time: number, provider: string, model: string): void {
    this.route = { time, provider, model }
  }

  recordPrompt(time: number, chars: number): void {
    this.push({ kind: 'prompt', time, chars })
  }
```

`snapshot()` 返回值带上 `route`：

```ts
  snapshot(): { records: readonly ActivityRecord[]; totals: ActivityTotals; route: RouteSnapshot | undefined } {
    return { records: [...this.records], totals: foldTotals(this.records), route: this.route }
  }
```

加一个纯助手（提示词的字符计数）：

```ts
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
```

### 2.2 类型垫片增量：`context.d.ts`

```ts
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
```

`DshContext` 增加三条重载（`llm/stream` 的可迭代签名原样照抄上游形状）：

```ts
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
```

### 2.3 接线：`index.ts` 三个监听者

```ts
  // Read-only wrap of every model call. Loop-built requests arrive deep-frozen
  // (mutation throws), and short-circuiting — returning anything but next()'s
  // stream — is gateway territory this tower never enters. Note what this
  // station LACKS: no session identity, so requests stay console-only here;
  // per-session numbers come from request/header + assistant-stream instead.
  ctx.on('llm/stream', (options, next) => {
    console.log(`[dsh-tool-watchtower] llm request ${String(options.provider ?? 'unknown')}/${String(options.model ?? 'unknown')}`)
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
    // Scaffold-era visibility; the live panel replaces this later.
    console.log(`[dsh-tool-watchtower] route ${provider}/${model}`)
  })

  // Prompt entry point: one record per inbox insertion, per session.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const sessionId = String(agent?.session?.id ?? '')
    if (sessionId.length === 0) return
    const chars = promptChars(message?.content)
    logOf(sessionId).recordPrompt(Date.now(), chars)
    console.log(`[dsh-tool-watchtower] prompt queued (${chars} chars)`)
  })
```

（`promptChars` 从 `./host/activity.js` 一并 import。）

## 3. 上机验证清单

宿主代码改动 → **重启** `dsh web`、刷新，然后正常对话一轮：

1. **请求行**：宿主终端每次模型调用出现
   `[dsh-tool-watchtower] llm request <provider>/<model>`——注意工具循环里模型每走一步
   都会再来一行（一次用户回合 ≠ 一次模型调用）；
2. **路由行**：同一轮里出现 `route <provider>/<model>`——它来自落盘的 header 事件，
   会话恢复（resume）后新纪元的 header 也会再触发一次；
3. **提示词行**：你按下发送后立刻出现 `prompt queued (N chars)`——早于一切模型输出，
   因为入队在循环开始之前；
4. **三站对齐**：一条消息的完整生命周期应在终端留下
   `prompt queued → llm request → route → attempt <id> committed` 的顺序（工具回合里
   中间还会插 tool 行）；
5. **用量回流**：`attempt committed` 之后，第 1 章折好的 usage 已经在缓冲里——面板
   上线前没有可视化出口，用下一章的 live 通道（或临时 `console.log(JSON.stringify(logOf(id).snapshot().totals))`）确认四个 token 桶非零。

排查：请求行有了、路由行没有 → 检查会话事件过滤条件（`type !== 'request/header'` 的
拼写）与 `session.id` 读取；都没有 → 回到第 1 章排查顺序（组合、重启、事件名）。

## 4. 本章坑

- **`llm/stream` 没有会话身份**：`GenerateOptions` 是请求视图不是调用者视图，想按会话
  归桶请用 `request/header`（耐久）与 `assistant-stream`（进程内）；本章代码因此对
  请求行只打终端日志，不做按会话记账——这是设计，不是偷懒；
- **别消费流**：`for await (const chunk of await next())` 之类「数一数 chunk」的念头
  会改变下游的时序契约；流级观测已经有 `assistant-stream` 这条正路。观测者在
  `llm/stream` 只许读 `options`、原样返回 `next()`；
- **冻结是真的**：对循环构建的 `options`（含 `options.messages`）任何写操作直接抛
  TypeError。这不是给你留的钩子，是可重建性的保证；
- **`request/header` 是会话事件类型**：`ctx.on('request/header', …)` 静默无效（第 1 章
  的对照表再+1）；
- **header 的 config 形状仍在演化**：上游源码留有 `TODO(call-config-shape)`——哪些字段
  算纪元缓存键还可能调整。只读 provider/model 这类稳定字段，别深挖；
- **chars ≠ tokens**：提示词记录是字符数，token 化是 provider 的事；拿它做费用估算
  前先想清楚（要做就用 `assistant/message` 落盘的 usage，第一辑第 4 章的老路）。

## 5. 小结

- 三个观测位按时间性分工：`llm/stream`（进程内、每次调用、无会话身份）、
  `request/header`（耐久、带会话、当前模型的权威）、`agent/inbox/inserted`（入口时刻）；
- `llm/stream` 的观测姿态三句话：读稳定字段、原样返回 `next()`、永不自产流；
- 「当前值」与「流水」分开存：路由进独立槽（新值替换旧值），事件进环形缓冲；
- 本辑硬边界重申：观测不改行为——换模型走 `agent/request`，重放是网关的事，都不在
  本教程。

## 6. 延伸阅读

- 上游 `docs/subsystems/llm-streaming.md` —— `llm/stream` waterfall 节（深冻结与短路
  语义的原文）、`GenerateOptions`、`StreamChunk`、`TokenUsage`；
- 上游 `docs/subsystems/core.md` —— `agent/inbox/*` 事件与 `agent/request`（换模型的
  正道，本辑只指路）；
- 上游 `docs/subsystems/session.md` —— `SessionEventMap` 中 `request/header` 与
  「请求纪元」一节；
- 上游 `docs/subsystems/llm-streaming.md` 的 call-config 说明 + 源码
  `packages/llm/llm/src/call-config.ts` 的 `TODO(call-config-shape)` —— 形状仍会变的
  官方自述；
- [第一辑第 4 章](../tutorial/04-host-api.md) —— `session/event` 广播与 `sessionQuery`
  历史读取（本章只听实时广播，翻历史请回那里）。
