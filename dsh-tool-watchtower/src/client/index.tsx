/**
 * dsh-tool-watchtower — browser half: the live-activity pill and panel (v6).
 *
 * One provider turns `dsh-resource://dsh-tool-watchtower/<sessionId>` into a
 * frame stream (revision-checked follow poll over the authenticated activity
 * API); the composer-dock pill and the session-header button read it through
 * the standard `useResource` hook. The pill opens a Menu (type filter +
 * details entry), the details live in a Modal, gate verdicts surface as
 * Toasts, and `watchtower_report` gets an in-conversation card via the keyed
 * `tool.call.toolview` seat. All overlays are ui-primitives components.
 */

import * as React from 'react'
import { Menu, Modal, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'

const NS = 'dsh-tool-watchtower'
const ACTIVITY_ROUTE = '/api/dsh-tool-watchtower/activity'
const RESOURCE_PROTOCOL = 'dsh-tool-watchtower'
const POLL_MS = 1000
const STYLE_ID = 'dsh-tool-watchtower/styles'

const zh: Record<string, string> = {
  'pill.aria': '会话活动监视：{summary}',
  'pill.failed': '监视离线',
  'pill.empty': '尚无活动',
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
}

const en: Record<string, string> = {
  'pill.aria': 'Session activity watch: {summary}',
  'pill.failed': 'Watch offline',
  'pill.empty': 'No activity yet',
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
  // -1, not 0: an empty session's revision 0 must still count as the first frame.
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

/** The totals line: `tools N(!E)(⊘D) · tokens-in/up tokens-out` or a status word. */
function totalsText(totals: any): string {
  if (totals === undefined || totals === null) return '…'
  const errors = Number(totals.toolErrors) > 0 ? `!${totals.toolErrors}` : ''
  const denied = Number(totals.denied) > 0 ? ` ⊘${totals.denied}` : ''
  return `${totals.tools}${errors}${denied} · ↑${formatTokens(Number(totals.inputTokens))} ↓${formatTokens(Number(totals.outputTokens))}`
}

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

interface PillProps {
  sessionId?: unknown
  useResource?: (address: string) => { status: string; value?: any; failure?: { message?: string } | undefined }
  t: (key: string, params?: Record<string, unknown>) => string
}

interface MenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filter: string
  onFilter: (filter: string) => void
  onOpenDetails: () => void
  text: string
  t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * The pill's filter menu. The anchor is the trigger rendered in place (not a
 * ref); `side: 'top'` opens upward (the dock sits at the page bottom) and
 * `portal` escapes overflow clipping.
 */
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

interface ModalProps {
  open: boolean
  onClose: () => void
  snapshot: any
  filter: string
  t: (key: string, params?: Record<string, unknown>) => string
}

/** The activity details Modal; the primitive brings mask/Escape/close chrome. */
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

/**
 * The in-conversation card for `watchtower_report` (keyed toolview seat).
 * Deliberately not localized: whether the keyed seat hands seats components a
 * working `t()` is unverified, so neutral glyphs + numbers are the honest
 * fallback.
 */
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

/** The composer-dock activity pill, fed by useResource. */
function WatchtowerPill(props: PillProps): unknown {
  const { sessionId, useResource, t } = props
  // Hooks run before any early return — seat components are React components
  // too, and conditional hooks break React's ordering contract.
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('all')
  const [toasts, setToasts] = React.useState<{ id: number; text: string }[]>([])
  const seenGate = React.useRef<{ denied: number; asked: number } | undefined>(undefined)
  const toastSeq = React.useRef(0)

  const address = sessionId === undefined ? undefined : activityAddress(String(sessionId))
  const snapshot = address !== undefined && useResource !== undefined ? useResource(address) : undefined

  // Gate-watch: toast when deny/ask counters move. The first read is history,
  // not news — no toast for it. The effect keys on the revision so it reruns
  // once per delivered frame.
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

/**
 * Header entry: a second consumer of the same address (the registry opens one
 * stream per address regardless of consumer count — reference counting at
 * work), with its own Modal state and the filter pinned to `all`.
 */
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

export const name = NS

/** Slots for the seats, locale for the words, resources for the provider. */
export const inject = ['slots', 'locale', 'resources']

/**
 * Mount the provider and the three seats.
 * @param ctx - the browser plugin context.
 */
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
