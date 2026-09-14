# 06 · 组件化 UI 与座位系统：Menu、Modal、Toast 与 keyed 卡片

[上一章：live 数据通道](05-live-ui.md) · [下一章：事件管线的测试](07-testing.md)

v5 的胶囊「能看」，v6 让它「好用」：点开是**菜单**（类型过滤 + 详情入口），详情是
**Modal**（活动记录列表），门禁出手时顶上滑过一条 **Toast**；会话头部加一个入口按钮；
`watchtower_report` 在对话流里换上**自定义卡片**（keyed 座位）。全部弹层用
`@deepseek-ai/dsh-client-ui-primitives` 的现成组件——第一辑第 5 章手搓 popover 的三件套
（定位钩子 + 外点关闭 + Esc），本章起能不写就不写。

> **本章状态声明**：组件 props 与座位契约核对自上游 `packages/client/ui-primitives`
> 源码与 `slot-catalog.ts` 生成目录；代码未经本工作区实测。

## 1. 座位系统：四种 cardinality

第一辑只住过一个 `list` 座位。座位按「一格能住几个条目」分四种（全量目录见上游
`slot-catalog.ts`，运行时可用 `cordis_inspect` 的 client 视图查活体）：

| cardinality | 语义 | 本插件用例 |
| --- | --- | --- |
| `list` | 同座多条，按 `order` 排列 | `conversation.composer.dock`（胶囊）、`conversation.session.header.utilities`（入口按钮） |
| `single` | 一格一占；不传 priority 时你的条目**胜出**出厂 UI | 本辑不用（动了就是换掉出厂件） |
| `keyed` | 按 `key` 分格；key 的名字空间开放 | `tool.call.toolview`，`key: 'watchtower_report'` |
| `chain` | 管道式包装整个座位 | 本辑不用 |

三条注册规矩，先立后用：

1. **外层包裹不可省**：永远是
   `ctx.slots.inject(座位, () => ctx.slots.register(options, 组件))`——`inject` 负责回收
   与按需挂载，直接调 `register` 是错的；
2. **不要传 priority**：浏览器侧会自动把你的条目排在所有出厂条目之后；`list` 内的先后
   用 `order` 表达；
3. **keyed 命中即替换**：`tool.call.toolview` 的 key 域开放，但出厂已经占了 `bash`、
   `read`、`write` 等一组——注册这些 key 是**接管**（`replaceRisk: shadows-shipped-ui`），
   注册自家工具名是纯增量。本插件 key 自己的 `watchtower_report`，无碰撞。

本辑还消费一组框架**标准 props**——不管住哪个座位，组件都会收到 `sessionId`、
`useResource`、`useProjection`、`t` 等一整套（第 5 章的胶囊已经用过前两个）。keyed 座位
额外收到**所有者 props**：`callId`、`toolName`、`block`（运行中或已结算的工具调用块）。

## 2. 本章用到的 primitives

| 组件/钩子 | 一句话 | 本章用法 |
| --- | --- | --- |
| `Menu` | 锚定下拉菜单：分组标签、分隔线、多选标记、键盘导航、portal 模式 | 胶囊点击弹出的过滤菜单 |
| `Modal` | 居中对话框：毛玻璃遮罩、Escape/点遮罩关闭、`closeLabel` 必填 | 活动记录详情 |
| `Toast` | 顶部居中的瞬态横幅：滑入-停留-淡出，`onDone` 后由持有者卸载 | 门禁拦截/待审批通知 |
| `StateDot` | 五态状态点（done/warning/ongoing/error/idle） | 记录卡片的结算状态 |
| `useAnchoredMaxHeight` | 底部锚定浮层的最大高度钳制 | 本辑未用到（Menu 的 portal 模式自带钳制），列此备查 |

不碰的也值得点名：`Tooltip`/`HoverCard`（悬停预览）、`Button`/`Switch`/`Input`（表单）、
`JsonTree`/`CodeBlock`（结构化展示）、`MarkdownText`（不可信富文本）。要给面板加料时
先查这份清单——出仓客户端没有第三方组件库，primitives 就是标准库。

## 3. 动手 v6

### 3.1 类型垫片增量：`shims.d.ts`

primitives 声明扩成六个导出（原有的两条保留）：

```ts
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
  export function useAnchoredMaxHeight(ref: any, cap: number, signal: unknown): number
  export const Menu: any
  export const Modal: any
  export const Toast: any
  export const StateDot: any
}
```

### 3.2 词表与样式增量

`zh`/`en` 各补十一条（键集合保持一致——第 7 章的 bundle 测试会断言这一点）：

```ts
// zh 增量
'menu.filter': '按类型过滤',
'menu.filter.all': '全部',
'menu.filter.tools': '工具与门禁',
'menu.filter.model': '模型与提示词',
'menu.details': '查看详情…',
'modal.title': '瞭望塔活动',
'modal.close': '关闭',
'modal.empty': '暂无记录',
'toast.denied': '瞭望塔拦下了 {count} 次工具调用',
'toast.asked': '{count} 次调用等待审批',
'header.aria': '打开瞭望塔活动面板',

// en 增量
'menu.filter': 'Filter by type',
'menu.filter.all': 'All',
'menu.filter.tools': 'Tools & gate',
'menu.filter.model': 'Model & prompts',
'menu.details': 'Open details…',
'modal.title': 'Watchtower activity',
'modal.close': 'Close',
'modal.empty': 'No records yet',
'toast.denied': 'Watchtower blocked {count} tool call(s)',
'toast.asked': '{count} call(s) awaiting approval',
'header.aria': 'Open the watchtower panel',
```

CSS 追加（记录列表与会话内卡片；依旧只用语义层 token）：

```css
.dsh-tower-records {
  margin: 0;
  padding: 0;
  list-style: none;
  font-variant-numeric: tabular-nums;
}
.dsh-tower-records li {
  padding: 4px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tower-records li:first-child { border-top: none; }
.dsh-tower-empty { color: var(--dsw-alias-label-tertiary); }
.dsh-tower-report {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.dsh-tower-report svg { width: 12px; height: 12px; flex: none; }
.dsh-tower-reportSummary { font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; }
```

### 3.3 新组件：菜单、详情、Toast、会话内卡片

**过滤菜单**——`Menu` 的 anchor 是渲染在原位的触发元素（不是 ref），所以胶囊按钮直接
作为 `anchor` 传入；`side: 'top'` 让菜单向上开（dock 在页面底部），`portal` 逃出
overflow 裁剪：

```tsx
interface MenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filter: string
  onFilter: (filter: string) => void
  onOpenDetails: () => void
  text: string
  t: (key: string, params?: Record<string, unknown>) => string
}

function FilterMenu(props: MenuProps): unknown {
  const { open, onOpenChange, filter, onFilter, onOpenDetails, text, t } = props
  return (
    <Menu
      open={open}
      anchor={(
        <button
          type="button"
          className="dsh-tower-pill"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('pill.aria', { summary: text })}
          onClick={() => onOpenChange(!open)}
        >
          <TowerIcon />
          <span>{text}</span>
        </button>
      )}
      items={[
        { type: 'label', id: 'filter-label', text: t('menu.filter') },
        { id: 'filter-all', label: t('menu.filter.all') },
        { id: 'filter-tools', label: t('menu.filter.tools') },
        { id: 'filter-model', label: t('menu.filter.model') },
        { type: 'separator', id: 'sep' },
        { id: 'details', label: t('menu.details') },
      ]}
      selectedIds={[`filter-${filter}`]}
      onSelect={(id: string) => {
        if (id === 'details') {
          onOpenDetails()
          onOpenChange(false)
          return
        }
        onFilter(id.slice('filter-'.length))
        onOpenChange(false)
      }}
      onClose={() => onOpenChange(false)}
      side="top"
      portal
      dense
    />
  )
}
```

**活动详情**——`Modal` 自带遮罩/Escape/关闭钮，我们只喂标题、描述与内容；记录行的
格式化是纯函数（第 7 章直接测它）：

```tsx
/** One human line per activity record, newest first (records are pre-sorted). */
function recordLine(record: any): string {
  const time = typeof record?.time === 'number' ? new Date(record.time).toLocaleTimeString() : '?'
  switch (record?.kind) {
    case 'tool':
      return `${time} ⚒ ${record.name ?? '?'}${record.durationMs !== undefined ? ` · ${record.durationMs}ms` : ''}${record.isError ? ' ✗' : ''}`
    case 'decision':
      return `${time} ${record.decision === 'deny' ? '⊘' : '?'} ${record.name ?? '?'} · gate ${record.decision ?? '?'}`
    case 'model':
      return `${time} ◆ attempt ${record.turn ?? '?'}/${record.step ?? '?'}${record.outcome === 'abandoned' ? ' · abandoned' : ''}`
    case 'prompt':
      return `${time} ✎ ${record.chars ?? 0} chars`
    default:
      return `${time} · ${String(record?.kind ?? 'unknown')}`
  }
}

function matchesFilter(filter: string, record: any): boolean {
  if (filter === 'tools') return record?.kind === 'tool' || record?.kind === 'decision'
  if (filter === 'model') {
    return record?.kind === 'model' || record?.kind === 'prompt'
  }
  return true
}

interface ModalProps {
  open: boolean
  onClose: () => void
  snapshot: any
  filter: string
  t: (key: string, params?: Record<string, unknown>) => string
}

function ActivityModal(props: ModalProps): unknown {
  const { open, onClose, snapshot, filter, t } = props
  const route = snapshot?.route
  const records = (Array.isArray(snapshot?.records) ? snapshot.records : [])
    .filter((record: any) => matchesFilter(filter, record))
    .slice(0, 50)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('modal.title')}
      closeLabel={t('modal.close')}
      description={route === undefined || route === null
        ? undefined
        : `${route.provider}/${route.model}`}
    >
      {records.length === 0
        ? <p className="dsh-tower-empty">{t('modal.empty')}</p>
        : <ul className="dsh-tower-records">{records.map((record: any, index: number) => (
            <li key={index}>{recordLine(record)}</li>
          ))}</ul>}
    </Modal>
  )
}
```

**会话内卡片**（keyed 座位组件）——`block` 是运行中调用（`argsRaw` 在手）或已结算结果
（`content` 里是 `output.render` 产出的文本块）；运行中给 `ongoing` 态点，结算后解析
JSON 给一行摘要。卡片刻意不用 `t()`：keyed 座位的 locale 注入本辑未验证，用中性图形
与数字是诚实的降级（见 §5 的坑）：

```tsx
/** The in-conversation card for `watchtower_report` (keyed toolview seat). */
function ReportCard(props: any): unknown {
  const block = props?.block
  const settled = block?.kind === 'tool-result'
  if (!settled) {
    return (
      <span className="dsh-tower-report">
        <TowerIcon />
        <span className="dsh-tower-reportTitle">watchtower_report</span>
        <StateDot state="ongoing" />
      </span>
    )
  }
  const text = Array.isArray(block?.content)
    ? block.content.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
    : ''
  let summary = '—'
  try {
    const totals = JSON.parse(text)?.totals ?? {}
    summary = `${totals.tools ?? 0} tools · ${totals.modelAttempts ?? 0} attempts · ↑${formatTokens(Number(totals.inputTokens ?? 0))}`
  } catch {
    // Keep the dash; the model-facing JSON is not always parseable by design.
  }
  return (
    <span className="dsh-tower-report">
      <TowerIcon />
      <span className="dsh-tower-reportTitle">watchtower_report</span>
      <span className="dsh-tower-reportSummary">{summary}</span>
      <StateDot state={block?.isError ? 'error' : 'done'} />
    </span>
  )
}
```

### 3.4 胶囊重构 + `apply` 终版

胶囊现在持有四个状态与一条 Toast 观察逻辑。注意**钩子全部上移到提前返回之前**——
`useResource`、`useState`、`useEffect` 都是钩子，条件调用会打乱 React 的顺序契约
（v5 版靠「sessionId 挂载后不变」侥幸合规，v6 直接写对，见 §5）：

```tsx
function WatchtowerPill(props: PillProps): unknown {
  const { sessionId, useResource, t } = props
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('all')
  const [toasts, setToasts] = React.useState<{ id: number; text: string }[]>([])
  const seenGate = React.useRef<{ denied: number; asked: number } | undefined>(undefined)
  const toastSeq = React.useRef(0)

  const address = sessionId === undefined ? undefined : activityAddress(String(sessionId))
  const snapshot = address !== undefined && useResource !== undefined ? useResource(address) : undefined

  // Gate-watch: toast when deny/ask counters move. The first read is history,
  // not news — no toast for it.
  const revision = snapshot?.value?.revision
  React.useEffect(() => {
    const totals = snapshot?.value?.totals
    if (totals === undefined) return
    const before = seenGate.current
    seenGate.current = { denied: Number(totals.denied), asked: Number(totals.asked) }
    if (before === undefined) return
    const push = (text: string) => {
      toastSeq.current += 1
      setToasts(list => [...list, { id: toastSeq.current, text }])
    }
    const denied = Number(totals.denied) - before.denied
    const asked = Number(totals.asked) - before.asked
    if (denied > 0) push(t('toast.denied', { count: denied }))
    if (asked > 0) push(t('toast.asked', { count: asked }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  if (snapshot === undefined || snapshot.status === 'none') return null

  let text: string
  if (snapshot.status === 'loading') text = '…'
  else if (snapshot.status === 'failed') text = t('pill.failed')
  else text = totalsText(snapshot.value?.totals)

  return (
    <div className="dsh-tower-root" data-dsh-tool-watchtower>
      <FilterMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        filter={filter}
        onFilter={setFilter}
        onOpenDetails={() => setDetailsOpen(true)}
        text={text}
        t={t}
      />
      <ActivityModal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        snapshot={snapshot.value}
        filter={filter}
        t={t}
      />
      {toasts.map(toast => (
        <Toast
          key={toast.id}
          text={toast.text}
          holdMs={4000}
          onDone={() => setToasts(list => list.filter(item => item.id !== toast.id))}
        />
      ))}
    </div>
  )
}
```

头部入口按钮是同一地址的第二个消费者（各自持有 Modal 开关；注册表对同一地址只开一条
流——引用计数的实惠）：

```tsx
function HeaderButton(props: { sessionId?: unknown; useResource?: any; t: (key: string, params?: Record<string, unknown>) => string }): unknown {
  const { sessionId, useResource, t } = props
  const [open, setOpen] = React.useState(false)
  const address = sessionId === undefined ? undefined : activityAddress(String(sessionId))
  const snapshot = address !== undefined && useResource !== undefined ? useResource(address) : undefined
  if (snapshot === undefined || snapshot.status === 'none') return null
  return (
    <span data-dsh-tool-watchtower>
      <button
        type="button"
        className="dsh-tower-pill"
        aria-haspopup="dialog"
        aria-label={t('header.aria')}
        onClick={() => setOpen(true)}
      >
        <TowerIcon />
      </button>
      <ActivityModal open={open} onClose={() => setOpen(false)} snapshot={snapshot.value} filter="all" t={t} />
    </span>
  )
}
```

`apply` 终版——四个座位/服务注册，三种回收语义各有归属：

```tsx
export function apply(ctx: any): void {
  ensureStyle()
  // Returned disposers → ctx.effect.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tool-watchtower: locale')
  ctx.effect(
    () => ctx.resources.register({ protocol: RESOURCE_PROTOCOL, open: openActivity }),
    'dsh-tool-watchtower: activity provider',
  )
  // slots.inject recycles itself — never wrap it in ctx.effect.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'dsh-tool-watchtower',
    order: 1,
    locale: NS,
  }, WatchtowerPill))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-tool-watchtower',
    order: 1,
    locale: NS,
  }, HeaderButton))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'watchtower_report',
  }, ReportCard))
}
```

### 3.5 主题 token 的三层规矩

本章 CSS 全部走 `--dsw-*` 变量不是审美偏好，是上游样式平台的分层契约
（`docs/web-styling.md`）：

- `--dsw-static-*`：原始色板，**feature 一律不许直接用**；
- `--dsw-alias-*`：语义别名（`label-primary/secondary/tertiary`、`border-l1..l4`、
  `interactive-bg-hover`…），插件的默认选择；
- `--dsw-specific-*`：具体表面（`menu`、`bubble`、`sidebar-fill`…），做「和某个出厂
  表面同款」时用。

暗色模式的机制随之免费：token 在 `body[data-ds-dark-theme]` 下整体重定义，插件一个
媒体查询都不用写。浮层另有一条硬规：`border: 0` + `box-shadow: var(--dsw-elevation-*)`
（hairline 由 `--dsw-elevation-stroke-color` 控制）——本章弹层全是 primitives 自带
chrome，我们只需要遵守自己的列表样式用 hairline `border-l2`。

## 4. 上机验证清单

`node build.mjs` → **重启** `dsh web` → 强刷页面：

1. **菜单**：点胶囊 → 菜单向上弹出，分组标签 + 三个可勾选项；↑↓ 键移动、Enter 选中；
   选「工具与门禁」后菜单关闭，再开时勾选状态保留；
2. **详情**：菜单选「查看详情…」→ Modal 弹出，描述行是当前 `provider/model` 路由，列表
   是过滤后的记录（时间 + 图标 + 摘要）；Esc 与点遮罩都能关闭；
3. **Toast**：用第 2 章的 deny 规则让模型撞一次门 → 顶部滑入「瞭望塔拦下了 1 次工具
   调用」，停留 4 秒后淡出消失（不残留）；ask 规则同理（审批面可用时）；
4. **头部入口**：会话标题旁出现瞭望塔图标，点击打开同一个面板（filter 固定 all）；
5. **keyed 卡片**：让模型调用 `watchtower_report` → 对话流里这张工具卡不再是一般
   JSON 行，而是瞭望塔小卡：运行中带 ongoing 状态点，完成后给 `tools · attempts · 输入`
   摘要 + done 点；**旁边的 read/bash 卡片不受影响**——keyed 隔离的证据；
6. **暗色**：系统切深色 → 胶囊、菜单、Modal、卡片全部跟随，无一处字面色残留；
7. **回收**：DevTools Network 确认两个消费者（胶囊 + 头部按钮）共存时 activity 轮询
   仍只有约每秒一次（同地址共享一条流）；退出会话 → 请求停止。

## 5. 本章坑

- **钩子顺序高于提前返回**：座位组件也是 React 组件——`useResource`/`useState`/
  `useEffect` 必须在任何 `return null` 之前调用。v5 的胶囊靠 props 稳定侥幸合规，v6
  的写法才是对的；新座位组件照 v6 抄；
- **key 拼错 = 永远不渲染**：keyed 座位的 key 域开放、无编译期检查，上游原话「a typo
  simply never renders」——卡片没出现时第一件事是逐字符对 key（工具名是注册名不是
  显示名）。活体排查用 `cordis_inspect` 的 client 视图看座位与住户；
- **keyed 命中出厂 key 是接管**：`key: 'bash'` 会顶掉官方终端卡。想定制出厂工具的卡片
  是合法的，但要意识到 `replaceRisk: shadows-shipped-ui`；
- **`Modal` 的 `closeLabel` 必填**（非 headless 形态）：忘了它，无障碍标签就缺了；
- **`Toast` 的卸载责任在持有者**：淡出结束只会调 `onDone`，不卸载就永远占位；同一文案
  连续触发要靠递增的 `key` 重启动画（本章的 `toastSeq`）；
- **keyed 座位的 locale 注入未验证**：`list` 座位的 `locale: NS` 给了 `t()`（第一辑已
  验证）；keyed 的 `registerOptions` 目录只写了 `key`。本辑的 ReportCard 因此用中性
  文案——想让卡片说话，先在自己环境里验证 `t` 是否到手；
- **字面色是暗色模式的裂缝**：CSS 里出现 `#fff`/`black` 的那一刻，两种主题必挂一种。
  回看 §3.5 的三层，只用 alias/specific。

## 6. 小结

- 四种 cardinality 对号入座：list 并排（dock、header）、keyed 分格（自家工具的会话内
  卡片）；外层 `slots.inject` 包裹与「不传 priority」是铁律；
- primitives 覆盖弹层全场景：Menu（含分组/多选/键盘）、Modal（chrome 全带）、Toast
  （卸载责任在持有者）、StateDot；第一辑的手搓 popover 退役；
- 同地址多消费者共享一条 provider 流——引用计数在注册表里，组件各管各的开关；
- 主题三层 token + 暗色自动跟随；出仓 UI 的「标准库」就是 primitives，加料前先查它；
- 状态提升一小步（filter 从菜单传给 Modal），换来一次真实的组件间协作示范。

## 7. 延伸阅读

- 上游 `packages/client/ui-primitives`（`README.md` + `src/`）——组件目录表与每个组件
  的 props JSDoc（Menu 的 portal/键盘语义、Toast 的 hold/fade 时序都在源码注释里）；
- 上游 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` —— 57 个
  座位的生成目录（cardinality/scope/ownerProps/replaceRisk/示例代码），运行时
  `cordis_inspect` 可查活体；
- 上游 `packages/client/ui-tool/src/client/contract/slots.ts` —— `tool.call.toolview`
  的所有者 props（`ToolCallOwnerProps`、`ToolCallBlock`）权威定义；
- 上游 `docs/web-styling.md` —— 三层 token、elevation、暗色机制；
- 上游 `docs/subsystems/client-modules.md` —— 座位组件的标准 props 全表；
- [第一辑第 5 章](../tutorial/05-web-client.md) —— 手搓 popover 三件套（对照理解
  primitives 帮你省掉了什么）。
