# 04 · 已鉴权 API 与会话数据

[上一章](03-config-reload.md) · [下一章：Web 客户端半边](05-web-client.md)

`dsh-stats` 到目前为止只会报心跳。本章让它干真活：读会话的持久事件日志，折叠成 token
用量统计，通过一条**已鉴权**的 API 喂给浏览器。这一章的成品参照是
[`dsh-cost`](../../dsh-cost/README.md) 的宿主半边——它是本仓库最重的真实实现。

## 1. 为什么不继续用 webServer

第 2 章的 `webServer.register` 对外**没有任何鉴权**：凡是能连到 3080 端口的请求都能调。
页面资产、favicon 这类公开资源无所谓；但会话数据、凭据相关的东西必须走另一条 seam——
**`ctx.connection.fetch`**：宿主与浏览器之间那条已鉴权的 API 通道。凡是「给 Web GUI 前端
用的数据接口」都应该注册在这里。

| | `ctx.webServer.register` | `ctx.connection.fetch.register` |
| --- | --- | --- |
| 定位 | 原始 HTTP 路由表 | 前端 API 通道 |
| 鉴权 | 无，自己负责 | 框架完成（Host/Origin 校验 + 浏览器 token）， handler 执行前已通过 |
| 路径 | 任意绝对路径 | 必须位于 `/api` 之下 |
| handler 形状 | Node `(req, res)` | Fetch 风格 `(request) => Promise<Response>` |
| 方法 | 自己判断 | 声明 `methods: ['GET', …]`，框架挡掉其余 |
| 请求体 | 自己读流 | 声明 `requestBody: 'buffered' \| 'streaming'`，buffered 时 `await request.json()` 即可 |

注册形状：

```js
ctx.connection.fetch.register({
  path: '/api/dsh-stats/summary',   // 绝对路径，位于 /api 之下；重复认领会抛错
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: serveSummary,              // async (request: Request) => Response
})
```

返回的也是注销函数，照旧包进 `ctx.effect`。

## 2. 数据从哪来：会话事件日志

DSH 的每个会话都是一份**只追加**的持久事件日志：模型每轮请求、每条助手消息、每次工具
调用都落成带 `seq` 与 `time` 的事件。读取走 `ctx.sessionQuery`（`inject` 声明依赖）：

```js
const snapshot = await ctx.sessionQuery.readSession(sessionId)
// snapshot.events                 事件数组（旧→新）
// snapshot.inheritedEventCount    fork 会话继承自父会话的事件条数
```

与本教程相关的两种事件形状（真实样例可看 `dsh-cost/test/routes.test.mjs` 的 `snapshot()`）：

```js
// 一次模型请求的路由信息
{ type: 'request/header', seq: 1, time: 1726017600000,
  data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } } }

// 一条助手消息，携带本样本的 token 用量
{ type: 'assistant/message', seq: 2, time: 1726017600000,
  data: { turn: 1, step: 1,
    message: { source: { provider: 'deepseek', model: 'deepseek-flash' } },
    usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500, cacheWriteTokens: 0 } } }
```

统计口径本教程取最简：**逐个 `assistant/message` 样本，按 `message.source` 的模型路由累加
四个 token 桶**。（`dsh-cost` 的口径严格得多：高峰/空闲分档、重试补计、fork 继承剔除……
这些进阶口径都写在它的 README 里，实现全在 `dsh-cost/host/fold.js`。）

## 3. 先写纯函数：`host/fold.js`

出仓插件的可测逻辑抽成 `host/` 下的纯函数：不碰 `ctx`、不碰时钟、不碰网络，测试就是
普通函数调用。**`dsh-stats/host/fold.js`**：

```js
/**
 * Fold a session's durable event log into per-model token totals.
 * Pure: no clock, no I/O, no ctx — trivially unit-testable.
 */

/** One usage sample with every bucket present; missing buckets read as zero. */
function normalizeUsage(usage) {
  const value = bucket => (Number.isFinite(bucket) ? bucket : 0)
  const source = usage ?? {}
  return {
    uncachedInputTokens: value(source.inputTokens),
    cacheReadTokens: value(source.cacheReadTokens),
    cacheWriteTokens: value(source.cacheWriteTokens),
    outputTokens: value(source.outputTokens),
  }
}

const sum = (values) => values.reduce((total, value) => total + value, 0)

/**
 * Fold assistant messages into per-route token rows.
 * @param events - the session's durable event log (`readSession().events`).
 * @returns per-route rows sorted by first appearance, grand totals, sample counts.
 */
export function summarizeUsage(events) {
  const routes = new Map()
  let samples = 0
  let skipped = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'assistant/message') continue
    const data = event.data ?? {}
    const usage = normalizeUsage(data.usage)
    const billed = usage.uncachedInputTokens + usage.cacheReadTokens
      + usage.cacheWriteTokens + usage.outputTokens
    if (data.usage === undefined || billed <= 0) {
      skipped += 1
      continue
    }
    samples += 1
    const source = data.message?.source ?? {}
    const provider = typeof source.provider === 'string' ? source.provider : 'unknown'
    const model = typeof source.model === 'string' ? source.model : 'unknown'
    const key = `${provider}/${model}`
    const row = routes.get(key) ?? {
      provider,
      model,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }
    row.uncachedInputTokens += usage.uncachedInputTokens
    row.cacheReadTokens += usage.cacheReadTokens
    row.cacheWriteTokens += usage.cacheWriteTokens
    row.outputTokens += usage.outputTokens
    routes.set(key, row)
  }
  const rows = [...routes.values()]
  const totals = {
    uncachedInputTokens: sum(rows.map(row => row.uncachedInputTokens)),
    cacheReadTokens: sum(rows.map(row => row.cacheReadTokens)),
    cacheWriteTokens: sum(rows.map(row => row.cacheWriteTokens)),
    outputTokens: sum(rows.map(row => row.outputTokens)),
  }
  return { rows, totals, samples, skipped }
}
```

## 4. 注册已鉴权路由：`index.js` v3

保留 ping，新增 `GET /api/dsh-stats/summary?session=<id>`。**`dsh-stats/index.js`** 顶部
import 区加一行，`apply` 里加路由与缓存：

```js
import { summarizeUsage } from './host/fold.js'
```

ESM 的相对 import **必须带 `.js` 扩展名**：漏掉会在插件加载时得到
`ERR_MODULE_NOT_FOUND`（编辑器的自动导入经常帮你抹掉它，留意）。

`inject` 扩为三个服务：

```js
/** The webserver owns raw routes; the connection owns the authenticated API; session-query owns log reads. */
export const inject = ['webServer', 'connection', 'sessionQuery']
```

`apply` 里（ping 的 effect 保持不变，接在其后）：

```js
/** Cap on cached summaries; the oldest entry is dropped past it. */
const MEMO_LIMIT = 64

// inside apply(ctx, config):
  const effective = resolveConfig(config)

  /** @type {Map<string, { body: unknown, dirty: boolean }>} */
  const memo = new Map()
  // A cached fold stays servable until a new usage sample lands in the log.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const entry = memo.get(String(session?.id ?? ''))
    if (entry !== undefined) entry.dirty = true
  })

  const serveSummary = async (request) => {
    const requested = new URL(request.url).searchParams.get('session')?.trim() ?? ''
    if (requested.length === 0) {
      return json({ error: 'dsh-stats: session id is required' }, 400)
    }
    const cached = memo.get(requested)
    if (cached !== undefined && cached.dirty !== true) return json(cached.body)
    let snapshot
    try {
      snapshot = await ctx.sessionQuery.readSession(requested)
    } catch (error) {
      return json({ error: `dsh-stats: ${messageOf(error)}` }, 404)
    }
    const fold = summarizeUsage(snapshot.events)
    const body = {
      sessionId: requested,
      label: effective.label,
      routes: fold.rows,
      totals: fold.totals,
      samples: fold.samples,
      skipped: fold.skipped,
    }
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value)
    memo.set(requested, { body, dirty: false })
    return json(body)
  }

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: '/api/dsh-stats/summary',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: serveSummary,
    }),
    'dsh-stats: GET /api/dsh-stats/summary',
  )
```

模块顶层补两个小工具（`dsh-cost` 同款）：

```js
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** One JSON response with the headers a live reading needs. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
```

三个设计决定值得咀嚼：

- **缓存 + 事件失效**：`session/event` 是事件日志每次落盘后的广播（fire-and-forget）。
  缓存的统计在新的 `assistant/message` 到来前一直可服役，到来后标脏、下次请求重算——
  反复打开面板不会反复重读整份日志。注意事件监听**不需要**包 `ctx.effect`，插件卸载时
  自动回收；
- **错误即响应**：缺参 400、读不到会话 404，都以稳定的 JSON 形状返回，让前端可渲染
  `body.error`，而不是让它面对一个裸的 HTML 错误页；
- **`skipped` 入响应**：口径里「跳过了多少不可用样本」是数据的一部分，如实上报。

## 5. 凭据：本例用不上，但你早晚会用

`dsh-stats` 只读本地日志，不需要 API Key。当你的插件要调外部服务时（像 `dsh-cost` 查
余额），遵循同一模式——**配置里放引用，运行时解析**：

```js
// dsh-cost 的 resolveApiKey：先托管凭据库，后启动环境
async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get('credentials')          // 可选服务：get 而不是 inject
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)        // ref 如 'DEEPSEEK_API_KEY'
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
  }
  const ambient = process.env[ref]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}
```

两个细节：`credentials` 用 `ctx.get`（**可选依赖**：没有凭据库时退回环境变量，而不是拒绝
加载）；每次使用时解析（热轮换的 key 下次请求自动生效）。密钥本体永远不进任何 YAML。

## 6. 挂载与验证

`apply` 引用了新文件 `host/fold.js`——boot graph 变了，**重启 `dsh web`**。然后分两步验证：

**鉴权确实在**。直接 curl API 路径，会被框架的 fence 挡下（未携带浏览器 token 的请求
根本到不了你的 handler）：

```sh
curl -i http://127.0.0.1:3080/api/dsh-stats/summary
# 4xx：被鉴权拒绝——这是对的，公开的只有你的 ping 路由
```

**管线确实通**。在 GUI 页面（<http://127.0.0.1:3080>）打开 DevTools Console，同源请求
自动带 token：

```js
await fetch('/api/dsh-stats/summary').then(r => r.json())
// { error: 'dsh-stats: session id is required' }        ← 400 分支

await fetch('/api/dsh-stats/summary?session=no-such-session').then(r => r.json())
// { error: 'dsh-stats: …' }                              ← 404 分支
```

真实会话的数字要等[下一章](05-web-client.md)的界面出来才能直观看到——这也正是下一章
存在的理由：**宿主半边提供数据，客户端半边提供界面**。

## 小结

- 前端数据接口一律走 `ctx.connection.fetch`：框架鉴权、Fetch 形状、`/api` 之下；
- 会话数据 = 事件日志：`sessionQuery.readSession` 读，`session/event` 广播增量；
- 折叠/计价逻辑抽成 `host/` 纯函数；口径元数据（samples/skipped）如实进响应；
- 缓存用事件标脏失效；凭据走「引用 + 运行时解析」；
- 新增被引用的文件 = boot graph 变化 = 重启。

## 延伸阅读

- [`dsh-cost/host/fold.js`](../../dsh-cost/README.md) —— 同款折叠的生产级实现（高峰/空闲
  分档、重试补计、fork 剔除）；
- 上游 `docs/subsystems/session-query.md` —— `ctx.sessionQuery` 完整能力（trace、搜索、
  谱系）；
- 上游 `docs/subsystems/credentials.md` —— 凭据引用、热轮换与 `describe` 的 UI 协作；
- 上游 `docs/subsystems/web-server.md` 与 `docs/api-gateway.md` —— 两种路由的宿主侧与
  传输侧细节。
