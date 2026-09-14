# 05 · Web 客户端半边：把界面装进 Web GUI

[上一章](04-host-api.md) · [下一章：工具与事件](06-tools-events.md)

宿主半边的数据已经就位，本章给 `dsh-stats` 装上**客户端半边**：在输入框统计行下方挂一个
「会话用量」胶囊，点击展开明细面板。这是全教程最陡的一章——不是因为逻辑复杂，而是因为
它运行在另一个进程（浏览器）、另一套模块系统（loader 模块表）、另一条构建链（上游 `tsc`
+ ModuleLoader 信封）里。成品参照：[`dsh-cost`](../../dsh-cost/README.md) 的客户端半边。

## 1. 浏览器是怎么加载你的插件的

宿主进程加载 `index.js`；浏览器加载的是**另一个入口** `lib/client.js`。链路是：

1. 宿主的 `clientModules` 服务扫描所有声明了客户端半边的插件包，拼出一张 **boot graph**
   （`window.__DSH_BOOT__`），随 `index.html` 下发；
2. 页面壳（shell）启动时先安装一个极小的 `window.__ModuleLoader__` 队列信箱，再按 graph
   请求合并脚本 `/plugins/??dsh-stats/client.js,…&rev=<hash>`；
3. 你的 bundle 是一行 `window.__ModuleLoader__.load({ id, factory })`：`factory(require)` 是
   CommonJS 风格的模块工厂，`require` 由壳的**冻结模块表**回答；
4. 壳按依赖顺序执行各 factory，`factory` 返回的 `module.exports` 就是一个标准的 Cordis
   插件（`name`/`inject`/`apply`）——浏览器侧同样有一套 `ctx`，`ctx.slots`、`ctx.locale`
   都是服务。

两条硬约束由此而来：

- **单文件、无相对 import**。`/plugins` 只服务你的 `lib/client.js` 一个资源，`require`
  只认模块表里的裸包名；
- **裸包名只有基线模块可用**。壳的冻结模块表共 9 项（上游
  `packages/client/web/src/platform.ts` 是唯一权威）：

```
react · react/jsx-runtime · react-dom · react-dom/client ·
@deepseek-ai/cordis · @deepseek-ai/dsh-client-store ·
@deepseek-ai/dsh-client-ui-slots · @deepseek-ai/dsh-client-ui-primitives ·
@deepseek-ai/dsh-client-ui-dockkit
```

React、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`（定位/关闭等交互 hook）是日常
最常用的三项。想 import 别的？没有——那是「进上游提需求」的信号，不是绕过的信号。

## 2. 声明客户端半边

`clientModules` 认的是 **package.json 声明**：`dsh.client` 说明「有客户端半边」，
`exports["./client"]` 指出产物在哪。**两者同时存在**，模块表才会收录你。更新
**`dsh-stats/package.json`**：

```json
{
  "name": "dsh-stats",
  "version": "0.1.0",
  "description": "DSH Web GUI plugin: session usage stats",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": { "client": { "platform": "web" } },
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test test/*.test.mjs"
  },
  "private": true
}
```

## 3. 客户端组件：`src/client/index.tsx`

结构完全镜像 `dsh-cost`：词表 → 样式 → 小工具 → 取数 hook → 组件 → 插件契约。为控制
篇幅，面板比 `dsh-cost` 精简（无余额区），但骨架一件不少：

```tsx
/**
 * dsh-stats — browser half: the session-usage pill for the composer dock.
 *
 * It registers one additive entry on `conversation.composer.dock`, so it gets
 * the framework's session props (sessionId, useProjection, t) without
 * importing another feature plugin. Placement and dismissal reuse the same
 * ui-primitives seats the neighbouring stats pills use.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'

const NS = 'dsh-stats'
const SUMMARY_ROUTE = '/api/dsh-stats/summary'
const STATS_DEBOUNCE_MS = 400
const PANEL_GAP = 8
const PANEL_MARGIN = 12
const STYLE_ID = 'dsh-stats/styles'

/** Hidden-but-laid-out portaled panel for the placement clamp's measure pass. */
const MEASURE_STYLE: Record<string, string | number> = { visibility: 'hidden', left: 0, top: 0 }

const zh: Record<string, string> = {
  'pill.aria': '本次会话用量 {tokens}',
  'dialog.title': '会话用量',
  'dialog.route': '模型',
  'dialog.input': '未缓存输入',
  'dialog.cacheRead': '缓存命中',
  'dialog.cacheWrite': '缓存写入',
  'dialog.output': '输出',
  'dialog.samples': '{samples} 个计费样本 · 跳过 {skipped} 个',
  'dialog.empty': '本次会话还没有用量记录',
  'dialog.error': '读取失败：{message}',
  'dialog.retry': '重试',
}

const en: Record<string, string> = {
  'pill.aria': 'Session usage {tokens}',
  'dialog.title': 'Session usage',
  'dialog.route': 'Model',
  'dialog.input': 'Uncached input',
  'dialog.cacheRead': 'Cache hit',
  'dialog.cacheWrite': 'Cache write',
  'dialog.output': 'Output',
  'dialog.samples': '{samples} billed samples · {skipped} skipped',
  'dialog.empty': 'This session has no usage yet',
  'dialog.error': 'Read failed: {message}',
  'dialog.retry': 'Retry',
}

/** Styles injected once per page, token-only so both themes follow the shell. */
const CSS = `
.dsh-stats-root {
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
.dsh-stats-anchor { display: inline-flex; min-width: 0; }
.dsh-stats-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 24px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-stats-pill:hover,
.dsh-stats-pill[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsh-stats-pill svg { width: 14px; height: 14px; flex: none; }
.dsh-stats-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: max-content;
  min-width: min(280px, calc(100vw - 24px));
  max-width: min(400px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
.dsh-stats-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsh-stats-titleLabel { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-stats-titleLabel svg { width: 14px; height: 14px; flex: none; }
.dsh-stats-titleValue { font-variant-numeric: tabular-nums; }
.dsh-stats-rule { margin-bottom: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-stats-details {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-stats-details dt,
.dsh-stats-details dd { min-width: 0; margin: 0; }
.dsh-stats-details dd {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.dsh-stats-details .dsh-stats-route { overflow-wrap: anywhere; }
.dsh-stats-note { margin-top: 10px; color: var(--dsw-alias-label-tertiary); }
.dsh-stats-retry {
  margin-left: 6px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
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

/** A bar-chart glyph. */
function StatsIcon(): unknown {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M3 10.5v2M6.5 7v5.5M10 3.5v9M13 8.5v3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Compact token count: 950, 12.3K, 2.1M. */
function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
}

/** Exact token count with grouping. */
function formatExact(value: number): string {
  return value.toLocaleString('en-US')
}

interface Reading {
  status: 'idle' | 'loading' | 'ready' | 'error'
  body?: any
  error?: string
}

/**
 * Read one JSON endpoint, debounced, keeping the last good body across
 * refreshes and exposing a manual retry.
 */
function useEndpoint(url: string | undefined, signalKey: unknown, debounceMs: number): Reading & { reload: () => void } {
  const [state, setState] = React.useState<Reading>({ status: 'idle' })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    if (url === undefined) {
      setState({ status: 'idle' })
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(() => {
      fetch(url, { headers: { accept: 'application/json' } })
        .then(async (response) => {
          const body = await response.json().catch(() => undefined)
          if (response.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          return body
        })
        .then((body) => {
          if (!cancelled) setState({ status: 'ready', body })
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
          }
        })
    }, debounceMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [url, signalKey, attempt, debounceMs])
  return { ...state, reload: () => { setAttempt(value => value + 1) } }
}

interface StatsPillProps {
  sessionId?: unknown
  useProjection?: (key: string) => any
  t: (key: string, params?: Record<string, unknown>) => string
}

/** The composer-dock usage pill and its dialog. */
function StatsPill(props: StatsPillProps): unknown {
  const { sessionId, useProjection, t } = props
  const usage = useProjection === undefined ? undefined : useProjection('tokenUsage')
  const billedTokens = usage === undefined || usage === null
    ? 0
    : (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
  const hasTokens = billedTokens > 0
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLSpanElement | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)

  const sessionUrl = hasTokens && sessionId !== undefined
    ? `${SUMMARY_ROUTE}?session=${encodeURIComponent(String(sessionId))}`
    : undefined
  const stats = useEndpoint(sessionUrl, billedTokens, STATS_DEBOUNCE_MS)
  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  React.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  if (!hasTokens) return null
  const body = stats.body
  const totals = body?.totals ?? {}
  const grand = (body?.routes ?? []).reduce(
    (sum: number, route: any) => sum + route.uncachedInputTokens + route.cacheReadTokens
      + route.cacheWriteTokens + route.outputTokens,
    0,
  )
  const amountText = body !== undefined ? formatTokens(grand) : '…'

  return (
    <div className="dsh-stats-root" data-dsh-stats>
      <span ref={rootRef} className="dsh-stats-anchor">
        <button
          type="button"
          className="dsh-stats-pill"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('pill.aria', { tokens: amountText })}
          onClick={() => { setOpen(!open) }}
        >
          <StatsIcon />
          <span>{amountText}</span>
        </button>
        {open && createPortal(
          <div
            ref={panelRef}
            className="dsh-stats-panel"
            role="dialog"
            aria-label={t('dialog.title')}
            style={pos ?? MEASURE_STYLE}
          >
            <div className="dsh-stats-title">
              <span className="dsh-stats-titleLabel"><StatsIcon />{t('dialog.title')}</span>
              <span className="dsh-stats-titleValue">{stats.status === 'error' ? '—' : amountText}</span>
            </div>
            <div className="dsh-stats-rule" aria-hidden />
            {stats.status === 'error' && (
              <div className="dsh-stats-note">
                {t('dialog.error', { message: stats.error ?? '' })}
                <button type="button" className="dsh-stats-retry" onClick={stats.reload}>{t('dialog.retry')}</button>
              </div>
            )}
            {stats.status !== 'error' && grand === 0 && (
              <div className="dsh-stats-note">{t('dialog.empty')}</div>
            )}
            {stats.status !== 'error' && grand > 0 && (
              <dl className="dsh-stats-details">
                <dt>{t('dialog.route')}</dt>
                <dd />
                {(body?.routes ?? []).map((route: any) => (
                  <React.Fragment key={`${route.provider}/${route.model}`}>
                    <dt className="dsh-stats-route">{`${route.provider}/${route.model}`}</dt>
                    <dd>{formatTokens(route.uncachedInputTokens + route.cacheReadTokens + route.cacheWriteTokens + route.outputTokens)}</dd>
                  </React.Fragment>
                ))}
                <dt>{t('dialog.input')}</dt>
                <dd>{formatExact(totals.uncachedInputTokens ?? 0)}</dd>
                <dt>{t('dialog.cacheRead')}</dt>
                <dd>{formatExact(totals.cacheReadTokens ?? 0)}</dd>
                <dt>{t('dialog.cacheWrite')}</dt>
                <dd>{formatExact(totals.cacheWriteTokens ?? 0)}</dd>
                <dt>{t('dialog.output')}</dt>
                <dd>{formatExact(totals.outputTokens ?? 0)}</dd>
              </dl>
            )}
            {body !== undefined && (
              <div className="dsh-stats-note">
                {t('dialog.samples', { samples: body.samples ?? 0, skipped: body.skipped ?? 0 })}
              </div>
            )}
          </div>,
          document.body,
        )}
      </span>
    </div>
  )
}

export const name = NS

/** Slot and locale are the only client services this plugin consumes. */
export const inject = ['slots', 'locale']

/**
 * Mount the usage pill next to the other composer-dock entries.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: any): void {
  ensureStyle()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-stats: locale')
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'dsh-stats',
    order: 1,
    locale: NS,
  }, StatsPill))
}
```

末尾的插件契约值得逐行读：

- **`inject: ['slots', 'locale']`**——客户端半边消费的两个服务；
- **`ctx.locale.register(NS, { zh, en })`**——注册词表。此后框架会把本地化的
  `t(key, params)` 作为 prop 注入你的组件，`{tokens}` 这类占位符由它填充；
- **`ctx.slots.inject(seat, contribute)`**——向一个**插槽席位**贡献内容。
  `conversation.composer.dock` 是输入框统计行所在的列表席位（更多席位见附录速查表）。
  `contribute` 在席位挂载时执行（并会在重挂载时重跑），里面用 `ctx.slots.register`
  注册 `{ name, id, order, locale }` 与组件；它**自带回收**，所以不包 `ctx.effect`
  （对照：`locale.register` 返回注销函数，要包）。**`id` 是席位内的唯一键**：内建统计行
  在这条席位上已经占用了 `stats`，插件条目直接用插件名（`dsh-stats`）最稳——撞车时后
  加载的一方会报 `already has an entry with id …` 并整个包加载失败。

组件侧三个值得注意的设计（都是 `dsh-cost` 验证过的做法）：

- **用 `useProjection('tokenUsage')` 做门控**：框架把会话投影喂给你，没有计费用量就整颗
  胶囊不渲染（`return null`），不占位、不闪;
- **取数用防抖 hook**：`billedTokens` 移动才重新 fetch，保持上次的成功体，错误可手动
  重试——面板开开关关不会打爆 API；
- **定位/关闭复用 primitives**：`useAnchoredPosition` + `useDismissOnOutsidePointer` 与
  内建统计胶囊同款交互（弹出方向、边缘钳制、点外关闭、Esc 关闭），面板用 `createPortal`
  挂到 `document.body` 以逃出 composer 的裁剪上下文。

**样式纪律**：只用 DSH 的 CSS 变量（`--dsw-alias-*`、`--dsh-chat-content-width` 等），
不写死颜色——这样浅色/深色主题自动跟随壳。`ensureStyle` 保证样式只注入一次。

## 4. 构建链：从 TSX 到 `lib/client.js`

浏览器模块表需要的是**一个 CommonJS 风格的 JS 文件**，所以 TSX 要编译并包进信封。出仓
插件用不了仓库的 `clientBundle` tsdown 预设（它按 `packages/<group>/<package>` 解析清单），
但实际上也不需要 bundler：单文件、无相对 import，`tsc` 就够。要加三个文件。

**`dsh-stats/tsconfig.build.json`**：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "CommonJS",
    "moduleResolution": "Node",
    "ignoreDeprecations": "6.0",
    "jsx": "react",
    "strict": false,
    "skipLibCheck": true,
    "noEmitOnError": true,
    "rootDir": "src",
    "outDir": ".build",
    "types": []
  },
  "include": ["src/client/index.tsx", "src/shims.d.ts"]
}
```

**`dsh-stats/tsconfig.json`**——给编辑器的入口。IDE 的 TS 语言服务只会自动拾取名为
`tsconfig.json` 的配置，`tsconfig.build.json` 对它**不可见**；没有这份文件时，打开
`index.tsx` 会被当成无配置的孤立项目——垫片不加载（`TS2307` 找不到模块）、JSX 命名空间
缺失（`TS7026` 满屏红）。让前者 extends 后者即可，`build.mjs` 仍使用构建配置：

```json
{
  "extends": "./tsconfig.build.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/client/index.tsx", "src/shims.d.ts"]
}
```

**`dsh-stats/src/shims.d.ts`**——出仓解析不到真的 React 类型包，tsc 会对三个裸 import 报
`TS2307: Cannot find module`；这个文件用最小环境声明兜底（只覆盖用到的面；仅构建期使用，
不进产物）：

```ts
/**
 * Minimal ambient types for the browser half's platform imports.
 *
 * The plugin is built outside the repository workspace, so the real React and
 * primitives type packages are not resolvable from here; these declarations
 * cover exactly the surface `src/client/index.tsx` uses. They are build-time
 * only and never shipped in the bundle.
 */

declare module 'react' {
  export type ReactNode = any
  export type CSSProperties = Record<string, string | number | undefined>
  export type MutableRefObject<T> = { current: T }
  export function createElement(type: any, props?: any, ...children: any[]): any
  export function useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void]
  export function useEffect(effect: () => void | (() => void) | undefined, deps?: readonly unknown[]): void
  export function useRef<T>(initial: T | null): MutableRefObject<T | null>
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T>(callback: T, deps: readonly unknown[]): T
  export const Fragment: any
}

declare module 'react-dom' {
  export function createPortal(children: any, container: any, key?: string | null): any
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export function useAnchoredPosition(options: {
    open: boolean
    anchorRef: any
    panelRef: any
    side: 'top' | 'bottom'
    gap: number
    margin: number
  }): any
  export function useDismissOnOutsidePointer(
    rootRef: any,
    open: boolean,
    setOpen: (open: boolean) => void,
    panelRef?: any,
  ): void
}

declare namespace JSX {
  type Element = any
  interface IntrinsicElements { [name: string]: any }
}
```

组件以后用到新的基线 API（比如 `React.useReducer`）时，记得回来给对应的 `declare module`
补一条声明——垫片只覆盖「用到的面」。

**`dsh-stats/build.mjs`**——解析上游 checkout、跑 `tsc`、把产物包进信封：

```js
/**
 * Build the browser half into the loader's bundle envelope.
 *
 * The plugin lives outside the repository workspace, so it cannot use the
 * repository's `clientBundle` tsdown preset. It needs no bundler: the client
 * source is one file with no relative imports, `tsc` compiles it to CommonJS,
 * and this script wraps the emitted module in the documented
 * `window.__ModuleLoader__.load({ id, factory })` handoff. Bare specifiers stay
 * `require(...)` calls, answered by the loader's module table.
 *
 * Usage: node build.mjs
 *   The DSH checkout that owns `tsc` is machine-local: set DSH_REPO, or write
 *   the path into the git-ignored `.dsh-repo` file next to this script.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const packageName = 'dsh-stats'

/**
 * Resolve the checkout that provides `tsc`: env first, then the local pointer
 * file, then an actionable failure.
 * @returns the configured checkout path.
 */
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

const repo = resolveRepo()
const tsc = join(repo, 'node_modules', '.bin', 'tsc')
if (!existsSync(tsc)) {
  throw new Error(
    `build.mjs: ${tsc} not found.\n`
      + 'Point DSH_REPO at a deepseek-harness checkout whose dependencies are installed (pnpm install).',
  )
}

execFileSync(tsc, ['-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

const emitted = join(root, '.build', 'client', 'index.js')
const moduleSource = readFileSync(emitted, 'utf8')
const banner = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(packageName)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n`
const footer = '\n\t\treturn module.exports;\n\t}\n});\n'

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), banner + moduleSource + footer)
rmSync(join(root, '.build'), { recursive: true, force: true })
console.log(`built lib/client.js (${(banner + moduleSource + footer).length} bytes)`)
```

构建：

```sh
cd dsh-stats
echo /path/to/deepseek-harness > .dsh-repo    # 一次性写入（git-ignored）
node build.mjs                                # 或 DSH_REPO=/path/to/deepseek-harness node build.mjs
```

配套的 `.gitignore` 条目（`.dsh-repo` 是机器本地指针，`.build/` 是瞬态产物）：

```
.dsh-repo
.build/
```

**`lib/client.js` 提交进仓库**：用户拿到插件即可用，不需要自己构建；只有改了
`src/client/` 才需要重跑 `node build.mjs`。信封长这样（`tsc` 产物的 CommonJS 被原样嵌进
factory）：

```js
window.__ModuleLoader__.load({
  id: "dsh-stats",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // …tsc 编译产物；裸包名保持 require("react") 等调用，由模块表回答…
    return module.exports;
  }
});
```

## 5. 挂载与验证

客户端 bundle 是**新文件**、模块表也变了——**重启 `dsh web`**，然后打开（或强制刷新）
<http://127.0.0.1:3080>：

1. 随便打开一个有过对话的会话：输入框统计行下方出现用量胶囊，显示紧凑 token 数；
2. 点击胶囊：面板从锚点向上弹出，列出按模型分组的用量与四个桶的精确总数、样本数；
3. 点面板外或按 Esc：关闭；在面板外再点胶囊：重新打开；
4. 给模型发一条新消息：token 数在结算事件落地后自动前进。

排错提示：

- **胶囊不出现**：确认会话确有计费用量（门控 `return null`）；DevTools Network 里找
  `/plugins/…client.js` 是否 200，Network 里有没有 `/api/dsh-stats/summary` 请求；
- **改了 `lib/client.js` 却没变化**：重启了吗？模块表按 specifier 缓存（附录坑清单）；
- **面板里报错**：看错误文案——它直接来自宿主半边 JSON 的 `error` 字段，宿主与客户端
  的问题在这里汇合。

## 6. 本章专属坑清单

- **席位条目 `id` 撞车**：list 席位的 `id` 全席位唯一，`conversation.composer.dock` 上内建
  统计行已占用 `stats`；插件条目用插件名（`dsh-stats`）可避免撞上内建或其它插件，否则后
  加载的一方整个包加载失败（报 `already has an entry with id …`）；
- **`conversation.composer.dock` 是纵向 flex 列**：你的条目只能是统计行**下方的另一行**，
  无法紧贴某个已有胶囊。想改布局就是改核心——不做，README 的「已知限制」里写明即可；
- **zh/en 键集合必须一致**：`locale.register` 的两个词表键不齐会在加载时报错，
  [第 7 章](07-testing.md)的 bundle 测试也会盯住这一点；
- **打开面板不会让内建胶囊收起**：互斥状态归壳所有，插件间没有这个协调点；`dsh-cost`
  同样如此，属于已知限制。

## 小结

- 客户端半边 = 单文件 TSX → `tsc` → ModuleLoader 信封 → 提交 `lib/client.js`；
- `dsh.client` + `exports["./client"]` 双声明，缺一不进模块表；
- 裸 import 只有 9 个基线模块；交互 hook 优先复用 `ui-primitives`；
- 契约：`inject: ['slots', 'locale']`，词表 + 席位注入各司其职，自带回收的不包 effect；
- 样式只用 CSS 变量；改 bundle 重启进程。

## 延伸阅读

- [`dsh-cost/src/client/index.tsx`](../../dsh-cost/README.md) —— 生产级客户端半边（余额区、
  失败原因映射、更完整的面板）；
- 上游 `docs/subsystems/slots.md` —— 插槽系统全量参考：席位目录、基数（single/list/
  keyed/chain）、框架 hooks（`useSession`、`useConversation` 等）；
- 上游 `docs/subsystems/client-modules.md` 与 `packages/client/modules/README.md` ——
  boot graph、`/plugins` 组合脚本、模块表与 `dsh.client.external` 的宿主/浏览器两半；
- 上游 `docs/web-styling.md` —— Web UI 样式规范（CSS 变量的使用纪律）。
