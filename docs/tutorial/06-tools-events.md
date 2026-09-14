# 06 · 工具与事件：让模型调用你的能力

[上一章](05-web-client.md) · [下一章：测试](07-testing.md)

到目前为止 `dsh-stats` 的能力都服务于**人**（页面、胶囊）。本章补上最后一类扩展点：
**工具**——注册给模型调用的能力；以及**工具事件**——在工具调用管线里做策略。v5 给
`dsh-stats` 注册一个 `session_stats` 工具，让对话里的模型能自己查会话用量。

> **本章状态声明**：`ctx.tools` 及其事件管线有完整的上游文档与仓内实现背书
> （`docs/subsystems/tools.md`、`docs/cookbook/adding-a-tool.md`），但本仓库的两个真实插件
> 尚未使用过这条 seam——也就是说，下面是教程里唯一未经本工作区实测的代码。第一次照抄
> 时请留出验证时间，遇到出入以上游文档为准。

## 1. 工具是什么

`ctx.tools` 是宿主进程里的工具注册表（`inject: ['tools']` 声明依赖）。注册的工具会自动
进入系统提示的工具表，**模型可见、可调用**；调用走一条守卫管线（详见 §3），最终落到你的
`execute`。工具名 `run_code` 是保留名，不要用。

上游教程（`docs/user/develop/basic/tool.md`）用 `defineTool` DSL 写工具：参数用简写 schema，
`execute` 里的 `args` 已按 schema 校验并推导类型。**出仓插件用不了这套**——`defineTool`
来自 `@deepseek-ai/dsh-tools`，你的工作区解析不到（[第 1 章 §3](01-mental-model.md)）。
好在注册表**同样接受裸定义**（MCP 工具就是这么接入的），代价是一条硬规矩：

> 裸 JSON-Schema 工具**自己负责输入校验**——注册表不会替你校验模型生成的参数。

所以出仓工具 = 裸 JSON Schema + `execute` 里手动校验 + 自己 normalize。

## 2. dsh-stats v5：注册 `session_stats` 工具

`inject` 再加一个服务：

```js
export const inject = ['webServer', 'connection', 'sessionQuery', 'tools']
```

`apply` 里（其余保持不变，接在 summary 路由之后）：

```js
ctx.effect(
  () => ctx.tools.register({
    name: 'session_stats',
    description: 'Read token usage statistics of one DSH session (per model and token bucket).',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id to summarize.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      // Raw JSON-Schema tools own their input validation.
      const session = args?.session
      if (typeof session !== 'string' || session.trim().length === 0) {
        throw new Error('session_stats: arguments.session must be a non-empty string')
      }
      let snapshot
      try {
        snapshot = await ctx.sessionQuery.readSession(session.trim())
      } catch (error) {
        throw new Error(`session_stats: cannot read session: ${messageOf(error)}`)
      }
      const fold = summarizeUsage(snapshot.events)
      return {
        session: session.trim(),
        routes: fold.rows,
        totals: fold.totals,
        samples: fold.samples,
        skipped: fold.skipped,
      }
    },
  }),
  'dsh-stats: tool session_stats',
)
```

字段逐个看：

- **`parameters`**：参数的 JSON Schema。`type/properties/required` 这类基础构件在注册表的
  支持子集内；保持简单，花哨的关键字可能被拒；
- **`output.schema`**：**规范值**（canonical value）的 JSON Schema——`execute` 的返回值会
  先对照它校验、冻结，再交给渲染。「声明一个规范 JSON 形状并只返回它」是工具契约的核心：
  调用方（模型、程序）解析结构化数据，而不是从散文里抠数字；
- **`output.render`**：规范值 → 模型可见内容（`ContentBlock[]`）的纯投影。调试期
  `JSON.stringify` 就够；
- **`execute(args, exec)`**：真正干活。开头手动校验参数（裸工具的本分）；`exec.signal` 是
  协作取消信号，做异步 I/O 时应当透传（如 `fetch(url, { signal: exec.signal })`）；抛错
  即失败（`isError`），成功的非理想结局（如非零退出码）也要表示成规范值而不是抛；
- 想给 Web GUI 的工具卡片定制外观，还有可选的 `presentCall`/`presentResult`——纯函数、
  可重放，规则见上游 `docs/cookbook/adding-a-tool.md`，本教程不展开。

## 3. 拦截工具调用：`tools/*` 事件

工具调用走一条瀑布管线，每一站都是可监听的 Cordis 事件：

```
tools/pre-execute   允许/拒绝/上抛审批（allow/deny/ask 瀑布）
  → 单调 guard（ctx.tools.guard，最终否决不可翻案）
    → tools/execute   包裹调度（超时、重试、指标）
      → execute 体
        → tools/post-execute   接受/替换/追加上下文/阻断
          → tools/result   只读观察（emit 模式）
```

`pre-execute` 的决策形状：

```ts
{ kind: 'allow' }                     // 放行
{ kind: 'deny', reason: string }      // 拒绝，reason 会成为错误结果
{ kind: 'ask', reason?: string }      // 上抛给审批服务；无审批支持时等同于拒绝
```

**waterfall 语义的纪律**：不打算裁决的监听者**必须 `return next()`** 把链交下去；忘掉
`next()` 会吃掉整条管线。两个惯用法：

```js
// 观察：记录每次调用后放行（emit 场景也可以用 tools/result，更合适）
ctx.on('tools/pre-execute', async (exec, next) => {
  console.log(`[dsh-stats] tool call: ${exec.name}`)
  return next()
})

// 策略：对特定条件给出终局裁决，否则放行
ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.name === 'session_stats' && String(exec.arguments?.session ?? '').length > 200) {
    return { kind: 'deny', reason: 'session id looks malformed' }
  }
  return next()
})
```

`exec.arguments` 是模型生成的解析后参数（已冻结，只读）；`exec.agent` 是发起调用的代理
（用 `exec.agent.inject({ content, source: { kind: 'plugin', plugin: 'dsh-stats' } })` 可以
在下一次模型请求前注入耐久上下文）。事件监听自动回收，不需要 `ctx.effect`。

## 4. 两种「事件」不要混淆

到这里 `dsh-stats` 已经用了两种事件，它们属于不同世界：

| | Cordis 事件（`ctx.on('tools/pre-execute', …)`） | 会话事件广播（`ctx.on('session/event', …)`） |
| --- | --- | --- |
| 本质 | 进程内事件总线的分派 | 持久事件日志落盘后的广播 |
| 数据 | 活对象（`exec`、服务句柄） | 耐久记录（`session`、`event`，可重放） |
| 典型用途 | 策略、拦截、横切关注 | 对日志变化做出反应（缓存失效、投影更新） |
| 例子 | `tools/*`、`credentials/reference-updated` | `assistant/message`、`tool/result` 等日志类型 |

一个易踩的坑：上游文档里见的 `turn/*`、`step/*` 这类名字**是 `session/event` 的类型**，
不是 Cordis 事件——`ctx.on('turn/end')` 不会工作，要监听 `ctx.on('session/event', (s, e)
=> e.type === 'turn/end' && …)`。（辨析见上游 `docs/user/develop/framework/events.md`。）

## 5. 挂载与验证

改了 `inject` 与 `apply`（宿主代码）——**重启 `dsh web`**，然后：

1. 在 GUI 里对一个有过对话的会话发消息：「调用 session_stats 工具，查一下当前会话的
   token 用量」；
2. 模型发起 `session_stats` 调用 → 工具卡片显示 pending → 完成后渲染规范值的 JSON；
3. 宿主终端日志同步出现 `[dsh-stats] tool call: session_stats`（观察型监听者在工作）；
4. 故意让模型传一个不存在的会话 id：应看到工具以错误收场，错误信息来自 `execute` 的
   `throw`——失败也应该是可读的。

没有 GUI 也能冒烟测试：`dsh --profile web --dump-config` 确认插件行仍在组合结果里；工具
是否进入注册表则由[下一章](07-testing.md)的 `fakeCtx` 测试兜底。

## 小结

- 工具 = 声明规范值的 JSON Schema + 干活的 `execute` + 纯渲染投影；
- 出仓差异：没有 `defineTool` DSL → 裸定义 + **自己校验参数**；
- `tools/pre-execute` 是策略位（allow/deny/ask），不裁决就 `next()`；
- Cordis 事件（进程内分派）≠ 会话事件（日志广播），`turn/*` 属于后者；
- 本章 seam 未经本工作区实测，照抄时以上游文档为准。

## 延伸阅读

- 上游 `docs/cookbook/adding-a-tool.md` —— 工具契约的权威参考（execute 规则、长任务、
  UI 卡片词汇表）；
- 上游 `docs/subsystems/tools.md` —— 管线全图、schema 支持子集、`ctx.tools` 完整 API；
- 上游 `docs/cookbook/extension-cookbook.md` —— 权限门示例与 feature → mechanism 对照表；
- 上游 `docs/user/develop/basic/tool.md` —— 仓内 `defineTool` 教程，对照理解 DSL 的便利。
