# 05 · live 数据通道：`ctx.resources` 与 `useResource`

[上一章：LLM 调用观测](04-llm-stream.md) · [下一章：组件化 UI 与座位系统](06-ui-primitives.md)

四轮下来，哨塔已经装满传感器，但数据全困在宿主进程的环形缓冲里。v5 修通最后一公里：
宿主暴露一个已鉴权的活动快照 API；浏览器侧注册一个**资源提供者**（provider），把
`dsh-resource://dsh-tool-watchtower/<会话>` 变成一条 live 数据流；组件端用框架标准钩子
`useResource` 读四态快照。第一辑第 5 章的手写 `useEndpoint` 轮询从此退役——取数逻辑
收进 provider 一处，组件只管读。

> **本章状态声明**：资源模型契约核对自上游 `packages/client/resources`（`Resources`
> 接口与 `ResourceRegistry` 实现）与 `docs/subsystems/client-resources.md`；代码未经
> 本工作区实测。

## 1. 资源模型：地址、提供者、四态

第一辑的取数姿势是组件级的：每个组件自己 `useEndpoint`（防抖 fetch + 手动重试）。
资源模型把它拆成三段，各自归位：

```
地址（address）    dsh-resource://<协议>/<路径>   —— 一切的钥匙
提供者（provider） 浏览器侧注册：协议 → 帧流（AsyncIterable）
消费者（consumer） 任意座位组件：useResource(地址) → 四态快照
```

- **地址**是 `dsh-resource://` URL，host（域名位）命名协议，路径带作用域参数——本插件的
  会话 id 就编码在路径里（上游的文件协议同理：`dsh-resource://file/session/<id>/<路径>`）；
- **提供者**实现一个 `open(address, { signal })`，返回帧流：**第一帧是当前值，此后每帧
  是一次变更**。帧是 `RemoteResult`：`{ ok: true, value }` 或 `{ ok: false, error }`。
  失败也走帧——`open` 里 throw 是编程错误，不被捕获；
- **消费者**拿到的快照有四态：`none`（无此协议的 provider）/ `loading`（开着还没帧）/
  `live`（最新 ok 帧）/ `failed`（最近一帧失败，但保留上次的值）。

引用计数是模型送的第二份礼：最后一个订阅者离开（或 pin 释放）时，注册表 **abort 掉
provider 的流**并丢弃状态；组件重新挂载则重开。轮询、防抖、abort 清理、重复订阅去重
——全在注册表和 provider 里发生一次，组件无感。

**但要说破一层**：出仓插件的 provider 跑在**浏览器**里，而数据在**宿主**进程。框架
没有替你架好宿主 → 浏览器的推送专线（那是壳内部的 RPC 通道），所以 provider 的「帧流」
得自己供血。本章的供血方式是带修订号的**跟随式轮询**（上游文件 provider 的 stat +
follow 同款思路）：宿主每次落账就 `revision + 1`，provider 每秒比对一次修订号，**变了
才产出新帧**——`useResource` 的消费者看到的就是准实时的 live，而不是无脑刷。

> 帧流的另一条供血路线是 `ctx.connection.rpc` 逻辑通道（真推送）。它的接线面更大，
> 本章不展开；延伸阅读指路。轮询在这里不是妥协——对秒级活动面板，它足够了。

## 2. 宿主半边：修订号 + 活动 API

### 2.1 `activity.ts`：修订号

环形缓冲已经有「每次变更」的语义，缺的只是一个可比较的数。两处增量：

```ts
export class ActivityLog {
  private readonly records: ActivityRecord[] = []
  private readonly attempts = new Map<string, ModelRecord>()
  private revision = 0
  private route: RouteSnapshot | undefined

  // …既有方法不变…

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
```

### 2.2 `index.ts`：快照 API

`inject` 扩成 `['webServer', 'connection', 'tools']`（`tools` 是第 3 章加的），`apply`
里加路由（`json` 助手与第一辑
`dsh-stats` 的同名函数一致；未知会话返回空快照而不是 404——面板先亮起来，比报错友好）：

```ts
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: '/api/dsh-tool-watchtower/activity',
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
```

文件顶部（常量区）加：

```ts
function emptySnapshot(): { revision: number; records: ActivityRecord[]; totals: ActivityTotals; route: undefined } {
  return { revision: 0, records: [], totals: foldTotals([]), route: undefined }
}
```

（`foldTotals` 与 `ActivityRecord`/`ActivityTotals`/`RouteSnapshot` 类型从
`./host/activity.js` 一并 import。）

同时做一次**清扫**：第 1、4 章留的脚手架 `console.log`（tool/gate/llm request/route/
prompt 各行）现在全部删掉——面板就是它们的出口，别让宿主终端继续刷屏。

## 3. 浏览器半边：provider + 最小胶囊

客户端半边在本章出生：补齐构建链三件，写出单文件 TSX。

### 3.1 构建链补齐

**`dsh-tool-watchtower/package.json`**（增量）：`exports` 增加 client 条目，顶层加
`dsh.client` 声明——两者缺一不可（第一辑第 5 章的老规矩）：

```json
{
  "name": "dsh-tool-watchtower",
  "version": "0.1.0",
  "description": "DSH Web GUI plugin: tool & model activity watchtower",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": { "platform": "web" }
  },
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test test/*.test.mjs"
  },
  "private": true
}
```

**`dsh-tool-watchtower/build.mjs`** 换成双半边版：在 v1 版的基础上，宿主编译之后追加
客户端编译与 ModuleLoader 信封包装——宿主产物落 `lib/` 的逻辑不变，客户端部分（读
`.build/client/index.js`、包 `window.__ModuleLoader__.load({ id, factory })` 信封、
`lib/` 整体替换）与第一辑第 5 章 `dsh-stats/build.mjs` 逐行相同，只需把

```js
const packageName = 'dsh-tool-watchtower'
```

此外 `tsconfig.build.json`、`tsconfig.json`（编辑器入口）与 `src/shims.d.ts` 照抄第一辑
第 5 章；`shims.d.ts` 的 primitives 声明本辑先保持 `dsh-stats` 的两条（第 6 章会扩）。
`useResource` 不需要模块声明——它和 `useProjection` 一样是**座位组件的 props**，类型
写在 props 接口里。

### 3.2 单文件 TSX

**`dsh-tool-watchtower/src/client/index.tsx`**（v5 完整版；类名前缀 `dsh-tower`，沿用
`dsh-session-stats → dsh-stats` 的缩短惯例，样式 id 用全名）：

```tsx
/**
 * dsh-tool-watchtower — browser half: the live-activity pill (v5).
 *
 * One provider turns `dsh-resource://dsh-tool-watchtower/<sessionId>` into a
 * frame stream (revision-checked follow poll over the authenticated activity
 * API); the composer-dock pill reads it through the standard `useResource`
 * hook and shows the totals line. richer UI lands in the next chapter.
 */

import * as React from 'react'

const NS = 'dsh-tool-watchtower'
const ACTIVITY_ROUTE = '/api/dsh-tool-watchtower/activity'
const RESOURCE_PROTOCOL = 'dsh-tool-watchtower'
const POLL_MS = 1000
const STYLE_ID = 'dsh-tool-watchtower/styles'

const zh: Record<string, string> = {
  'pill.aria': '会话活动监视：{summary}',
  'pill.failed': '监视离线',
  'pill.empty': '尚无活动',
}

const en: Record<string, string> = {
  'pill.aria': 'Session activity watch: {summary}',
  'pill.failed': 'Watch offline',
  'pill.empty': 'No activity yet',
}

/** Styles injected once per page, token-only so both themes follow the shell. */
const CSS = `
.dsh-tower-root {
  display: flex;
  justify-content: center;
  width: 100%;
  max-width: var(--dsh-chat-content-width);
  margin: 0 auto;
  box-sizing: border-box;
  padding: 0 calc(var(--dsh-composer-side-clearance) + 16px) 2px;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsh-tower-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border: none;
  border-radius: 24px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
}
.dsh-tower-pill svg { width: 14px; height: 14px; flex: none; }
`

/** Inject the plugin stylesheet once. */
function ensureStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = NS
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** A watch-tower glyph. */
function TowerIcon(): unknown {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M5 14V6.5L4 4h8l-1 2.5V14M3.5 14h9M6.5 8h3M6.5 11h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Compact token count: 950, 12.3K, 2.1M (same rule as the stats pill). */
function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
}

/** The resource address for one session's activity stream. */
function activityAddress(sessionId: string): string {
  return `dsh-resource://${RESOURCE_PROTOCOL}/${encodeURIComponent(sessionId)}`
}

/** One fetch attempt: the parsed body, or the failure text. */
async function fetchSnapshot(sessionId: string, signal: AbortSignal): Promise<{ ok: true; body: any } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${ACTIVITY_ROUTE}?session=${encodeURIComponent(sessionId)}`, {
      headers: { accept: 'application/json' },
      signal,
    })
    const body = await response.json().catch(() => undefined)
    if (response.ok !== true) {
      return { ok: false, message: String(body?.error ?? `HTTP ${response.status}`) }
    }
    return { ok: true, body }
  } catch (error) {
    // Aborts are the registry tearing us down, not failures to report.
    if (signal.aborted) return { ok: false, message: 'aborted' }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Sleep that wakes early when the stream is torn down. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * The provider: first frame is the current snapshot, later frames are changes
 * (revision moved). Poll failures surface as failure frames; the last good
 * value stays visible (the registry keeps it for `failed` snapshots).
 */
async function* openActivity(address: string, ctx: { signal: AbortSignal }): AsyncIterable<any> {
  const sessionId = decodeURIComponent(new URL(address).pathname.replace(/^\//, ''))
  let lastRevision = -1
  while (!ctx.signal.aborted) {
    const attempt = await fetchSnapshot(sessionId, ctx.signal)
    if (attempt.ok === true) {
      if (attempt.body?.revision !== lastRevision) {
        lastRevision = attempt.body?.revision
        yield { ok: true, value: attempt.body }
      }
    } else if (attempt.message !== 'aborted') {
      yield { ok: false, error: { code: 'FETCH', message: attempt.message, details: {} } }
    }
    await sleep(POLL_MS, ctx.signal)
  }
}

/** The totals line: `tools N(!E) tokens-in/up tokens-out` or a status word. */
function totalsText(totals: any): string {
  if (totals === undefined || totals === null) return '…'
  const errors = Number(totals.toolErrors) > 0 ? `!${totals.toolErrors}` : ''
  const denied = Number(totals.denied) > 0 ? ` ⊘${totals.denied}` : ''
  return `${totals.tools}${errors}${denied} · ↑${formatTokens(Number(totals.inputTokens))} ↓${formatTokens(Number(totals.outputTokens))}`
}

interface PillProps {
  sessionId?: unknown
  useResource?: (address: string) => { status: string; value?: any; failure?: { message?: string } | undefined }
  t: (key: string, params?: Record<string, unknown>) => string
}

/** The composer-dock activity pill, fed by useResource. */
function WatchtowerPill(props: PillProps): unknown {
  const { sessionId, useResource, t } = props
  if (sessionId === undefined || useResource === undefined) return null
  const snapshot = useResource(activityAddress(String(sessionId)))
  if (snapshot.status === 'none') return null

  let text: string
  let title: string
  if (snapshot.status === 'loading') {
    text = '…'
    title = t('pill.empty')
  } else if (snapshot.status === 'failed') {
    text = t('pill.failed')
    title = snapshot.failure?.message ?? t('pill.failed')
  } else {
    text = totalsText(snapshot.value?.totals)
    title = t('pill.aria', { summary: text })
  }

  return (
    <div className="dsh-tower-root" data-dsh-tool-watchtower>
      <span className="dsh-tower-pill" role="status" aria-label={title}>
        <TowerIcon />
        <span>{text}</span>
      </span>
    </div>
  )
}

export const name = NS

/** Slots for the seat, locale for the words, resources for the provider. */
export const inject = ['slots', 'locale', 'resources']

/**
 * Mount the provider and the dock pill.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: any): void {
  ensureStyle()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tool-watchtower: locale')
  ctx.effect(
    () => ctx.resources.register({ protocol: RESOURCE_PROTOCOL, open: openActivity }),
    'dsh-tool-watchtower: activity provider',
  )
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'dsh-tool-watchtower',
    order: 1,
    locale: NS,
  }, WatchtowerPill))
}
```

五个设计点：

- **`inject` 三服务**：`resources` 是本章新消费的服务，声明式注入（框架等它就绪才
  apply）——provider 注册在 `apply` 顶层经 `ctx.effect` 包裹（上游契约原文：disposer
  要持有在调用者自己的 effect 里）；
- **修订号比较在 provider，不在组件**：值没变就不产帧，组件也就不重渲。轮询间隔
  （1s）是面板粒度的取舍点：调小更实时、更费请求；这是轮询供血的天花板，真推送见
  延伸阅读；
- **失败也走帧**：`open` 内不 throw（那是编程错误）；网络失败产出 `{ ok: false }` 帧，
  注册表把它折成 `failed` 态并保留上次的值——胶囊会显示「监视离线」而不是白屏，恢复后
  下一帧自动翻回 `live`；
- **abort 贯穿到 fetch**：`sleep` 与 `fetch` 都接 `signal`，最后一个订阅者离开时流当场
  停——不会留下空转的定时器。`aborted` 的 fetch 失败不产帧（那不是数据失败）；
- **胶囊先求「在」**：v5 的 UI 只求一个活的读数（loading 的 `…`、live 的 totals、
  failed 的「离线」）。把它变好看是下一章的事。

## 4. 上机验证清单

构建、重启、刷新（客户端 bundle 变化必须重启，第一辑生效语义表的老规矩）：

```sh
cd /path/to/dsh-custom/dsh-tool-watchtower
node build.mjs
# 重启 dsh web，刷新页面
```

1. **API 直读**：`curl 'http://127.0.0.1:3080/api/dsh-tool-watchtower/activity?session=nope'
   → `{"revision":0,"records":[],"totals":{…全零…},"route":null}`（未知会话给空快照；
   注意 `/api` 前缀路由走已鉴权通道，浏览器里的请求自带凭据，curl 是匿名直读——若返回
   401，用浏览器 DevTools 的 Network 面板看同 URL 的响应代替）；
2. **胶囊出现**：GUI 任意会话里 composer 下方出现瞭望塔胶囊，初始 `…`，第一次轮询后
   变成 totals 行；
3. **live 更新**：让模型跑一个工具 → 胶囊的 tools 计数在 ~1 秒内 +1，无需刷新；token
   桶在回复结束后涨上去；
4. **离线态**：临时把宿主 API 路由的路径改错并重启 → 胶囊显示「监视离线」；改回来再
   重启 → 自动恢复（failed → live 的翻回）；
5. **卸载回收**：DevTools Network 面板确认 activity 请求约每秒一次；切到无会话的主页
   （胶囊卸载）→ 请求停止——引用计数在替你关流。

## 5. 本章坑

- **provider 在浏览器、数据在宿主**：`ctx.resources.register` 注册的是浏览器侧协议；
  别在宿主 ctx 上找它。数据过墙走已鉴权 API（或 RPC 通道），这是出仓插件的总格局；
- **`open` 里 throw 不会被救**：失败必须是**帧**。抛出的异常会穿透注册表的消费循环——
  上游原文「a throw inside the stream is a programming error and is not caught」；
- **修订号比较要防首帧陷阱**：`lastRevision` 初始化为 -1 而不是 0——否则「空会话的
  revision 0」与「还没取过」分不清，首帧逻辑会写出一堆特判；
- **未知会话给空快照，不给 404**：面板的生命周期先于会话的第一条记录（刚打开页面就
  挂载），404 会让它永远停在 failed；
- **轮询间隔与宿主负载**：每个开着面板的会话每秒一个请求；引用计数保证没订阅就没请求，
  但别把 POLL_MS 调到几百毫秒还抱怨请求多——要细粒度去研究 RPC 推送通道；
- **`useResource` 的地址要稳定**：地址由 sessionId 拼出，`encodeURIComponent` 必须
  有（会话 id 里的特殊字符会破坏 URL 结构，协议解析就错位了）。

## 6. 小结

- 资源模型三段式：地址（协议 + 作用域路径）→ provider（首帧当前值 + 变更帧）→
  `useResource` 四态；轮询/abort/引用计数一次写好，组件白嫖；
- 出仓的现实：provider 在浏览器、数据在宿主，帧流靠「带修订号的跟随轮询」供血；
  失败走帧不抛错，abort 贯穿到 fetch；
- 宿主侧配套：快照 API + `revision` 单调递增；未知会话空快照；
- 客户端半边出生：双半边构建链就位，dock 胶囊先求「在」，下一章求「好」。

## 7. 延伸阅读

- 上游 `packages/client/resources`（`src/client/contract.ts` + `resources.ts`）——
  `Resources`/`ResourceProvider`/`ResourceSnapshot` 的权威契约与注册表实现（本章的
  四态、引用计数、abort 行为全部读自这里）；
- 上游 `docs/subsystems/client-resources.md` —— 资源模型的使用视角文档；
- 上游 `packages/api/workspace-files` —— stat + follow 式 provider 的仓内原型
  （「第一帧当前值 + 变更帧」的实战写法）；
- 上游 `packages/client/connection` —— RPC 逻辑通道（真推送的供血路线，本辑未展开）；
- [第一辑第 5 章](../tutorial/05-web-client.md) —— 客户端构建链与 ModuleLoader 信封
  的完整讲解（本章照抄的部分都在那里）。
