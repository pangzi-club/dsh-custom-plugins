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
