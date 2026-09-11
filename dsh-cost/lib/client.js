window.__ModuleLoader__.load({
	id: "dsh-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
/**
 * dsh-cost — browser half: the conversation-cost pill for the composer dock.
 *
 * It registers one additive entry on `conversation.composer.dock`, so it gets
 * the framework's session props (`sessionId`, `useProjection`, `t`) without
 * importing another feature plugin. The pill re-reads the Host's priced session
 * reading whenever the durable token usage moves, and reads the provider
 * balance when its dialog opens. Placement and dismissal reuse the same
 * `ui-primitives` seats the neighbouring stats pills use, so the interaction
 * matches them; only the row (a sibling entry below the stats row) differs,
 * because the composer dock is a column.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.name = void 0;
exports.apply = apply;
const React = __importStar(require("react"));
const react_dom_1 = require("react-dom");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const NS = 'dsh-cost';
const SESSION_ROUTE = '/api/dsh-cost/session';
const BALANCE_ROUTE = '/api/dsh-cost/balance';
const COST_DEBOUNCE_MS = 400;
const PANEL_GAP = 8;
const PANEL_MARGIN = 12;
const STYLE_ID = 'dsh-cost/styles';
/** Hidden-but-laid-out portaled panel for the placement clamp's measure pass. */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };
const zh = {
    'pill.aria': '本次费用 {amount}',
    'dialog.title': '对话费用',
    'dialog.model': '模型',
    'dialog.input': '未缓存输入',
    'dialog.cacheRead': '缓存命中',
    'dialog.cacheWrite': '缓存写入',
    'dialog.output': '输出',
    'dialog.peak': '高峰',
    'dialog.idle': '空闲',
    'dialog.unpriced': '未配置价格',
    'dialog.balance': '账户余额',
    'dialog.balanceLoading': '读取中…',
    'dialog.balanceEmpty': '暂无可显示的余额',
    'dialog.balanceReason.MISSING_CREDENTIAL': '未找到 API Key',
    'dialog.balanceReason.PROVIDER_UNSUPPORTED': '该 provider 不支持余额查询',
    'dialog.balanceReason.UNAUTHORIZED': 'API Key 被拒绝',
    'dialog.balanceReason.MALFORMED_RESPONSE': '余额响应无法识别',
    'dialog.balanceReason.NETWORK': '网络请求失败',
    'dialog.balanceTotal': '总额',
    'dialog.balanceGranted': '赠金',
    'dialog.balanceToppedUp': '充值',
    'dialog.unavailable': '不可用：{reason}',
    'dialog.error': '读取失败：{message}',
    'dialog.retry': '重试',
    'dialog.basis': '按官方高峰/空闲单价逐样本估算 · {samples} 个计费样本',
    'dialog.excluded': '不含 fork 继承的 {count} 条事件',
    'dialog.empty': '本次会话还没有计费记录',
};
const en = {
    'pill.aria': 'Session cost {amount}',
    'dialog.title': 'Conversation cost',
    'dialog.model': 'Model',
    'dialog.input': 'Uncached input',
    'dialog.cacheRead': 'Cache hit',
    'dialog.cacheWrite': 'Cache write',
    'dialog.output': 'Output',
    'dialog.peak': 'Peak',
    'dialog.idle': 'Idle',
    'dialog.unpriced': 'No configured price',
    'dialog.balance': 'Account balance',
    'dialog.balanceLoading': 'Loading…',
    'dialog.balanceEmpty': 'No balance available',
    'dialog.balanceReason.MISSING_CREDENTIAL': 'no API key found',
    'dialog.balanceReason.PROVIDER_UNSUPPORTED': 'this provider exposes no balance API',
    'dialog.balanceReason.UNAUTHORIZED': 'the API key was rejected',
    'dialog.balanceReason.MALFORMED_RESPONSE': 'the balance response was not recognized',
    'dialog.balanceReason.NETWORK': 'the request failed',
    'dialog.balanceTotal': 'Total',
    'dialog.balanceGranted': 'Granted',
    'dialog.balanceToppedUp': 'Topped up',
    'dialog.unavailable': 'Unavailable: {reason}',
    'dialog.error': 'Read failed: {message}',
    'dialog.retry': 'Retry',
    'dialog.basis': 'Estimated per sample at the published peak/idle rates · {samples} billed samples',
    'dialog.excluded': 'Excludes {count} fork-inherited events',
    'dialog.empty': 'This session has no billed usage yet',
};
/** Styles injected once per page, token-only so both themes follow the shell. */
const CSS = `
.dsh-cost-root {
  display: flex;
  justify-content: center;
  gap: 12px;
  width: 100%;
  max-width: var(--dsh-chat-content-width);
  margin: 0 auto;
  box-sizing: border-box;
  padding: 0 calc(var(--dsh-composer-side-clearance) + 16px) 2px;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsh-cost-anchor { display: inline-flex; min-width: 0; }
.dsh-cost-pill {
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
.dsh-cost-pill:hover,
.dsh-cost-pill[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsh-cost-pill svg { width: 14px; height: 14px; flex: none; }
.dsh-cost-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: max-content;
  min-width: min(300px, calc(100vw - 24px));
  max-width: min(440px, calc(100vw - 24px));
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
.dsh-cost-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsh-cost-titleLabel { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-cost-titleLabel svg { width: 14px; height: 14px; flex: none; }
.dsh-cost-titleValue { font-variant-numeric: tabular-nums; }
.dsh-cost-rule { margin-bottom: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-cost-details {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cost-details dt,
.dsh-cost-details dd { min-width: 0; margin: 0; }
.dsh-cost-details dd {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.dsh-cost-details .dsh-cost-route { overflow-wrap: anywhere; }
.dsh-cost-section { margin-top: 14px; }
.dsh-cost-note { margin-top: 10px; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-balance { display: flex; justify-content: space-between; gap: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-balance b { color: var(--dsw-alias-label-secondary); font-weight: 500; font-variant-numeric: tabular-nums; }
.dsh-cost-retry {
  margin-left: 6px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
`;
/** Inject the plugin stylesheet once. */
function ensureStyle() {
    if (typeof document === 'undefined')
        return;
    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null)
        return;
    const tag = document.createElement('style');
    tag.dataset.plugin = NS;
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
}
/** A coin glyph carrying the currency mark. */
function CostIcon() {
    return (React.createElement("svg", { viewBox: "0 0 16 16", "aria-hidden": true, focusable: "false" },
        React.createElement("circle", { cx: "8", cy: "8", r: "6.2", fill: "none", stroke: "currentColor", strokeWidth: "1.2" }),
        React.createElement("path", { d: "M5.5 5.4h5M5.5 7.4h5M8 5.4v5.4M6.1 8.8 8 10.9l1.9-2.1", fill: "none", stroke: "currentColor", strokeWidth: "1.1", strokeLinecap: "round", strokeLinejoin: "round" })));
}
/**
 * Money text: two decimals at or above one cent, four below, currency-symbol
 * first when the currency is known.
 * @param amount - amount in the currency.
 * @param currency - ISO currency code.
 * @returns the display string.
 */
function formatMoney(amount, currency) {
    const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
    const abs = Math.abs(amount);
    return `${symbol}${amount.toFixed(abs !== 0 && abs < 0.01 ? 4 : 2)}`;
}
/** Compact token count: 950, 12.3K, 2.1M. */
function formatTokens(value) {
    if (value < 1_000)
        return String(value);
    if (value < 1_000_000)
        return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
    return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}
/** Exact token count with grouping. */
function formatExact(value) {
    return value.toLocaleString('en-US');
}
/**
 * Read one JSON endpoint, debounced, keeping the last good body across
 * refreshes and exposing a manual retry.
 * @param url - endpoint URL, or undefined to stay idle.
 * @param signalKey - value whose change triggers a re-read.
 * @param debounceMs - settle delay before the request.
 * @returns the reading plus its retry action.
 */
function useEndpoint(url, signalKey, debounceMs) {
    const [state, setState] = React.useState({ status: 'idle' });
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        if (url === undefined) {
            setState({ status: 'idle' });
            return undefined;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            fetch(url, { headers: { accept: 'application/json' } })
                .then(async (response) => {
                const body = await response.json().catch(() => undefined);
                if (response.ok !== true)
                    throw new Error(body?.error ?? `HTTP ${response.status}`);
                return body;
            })
                .then((body) => {
                if (!cancelled)
                    setState({ status: 'ready', body });
            })
                .catch((error) => {
                if (!cancelled) {
                    setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
                }
            });
        }, debounceMs);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [url, signalKey, attempt, debounceMs]);
    return { ...state, reload: () => { setAttempt(value => value + 1); } };
}
/** The composer-dock cost pill and its dialog. */
function CostPill(props) {
    const { sessionId, useProjection, t } = props;
    const usage = useProjection === undefined ? undefined : useProjection('tokenUsage');
    const billedTokens = usage === undefined || usage === null
        ? 0
        : (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
            + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
    const hasTokens = billedTokens > 0;
    const [open, setOpen] = React.useState(false);
    const rootRef = React.useRef(null);
    const panelRef = React.useRef(null);
    const sessionUrl = hasTokens && sessionId !== undefined
        ? `${SESSION_ROUTE}?session=${encodeURIComponent(String(sessionId))}`
        : undefined;
    const cost = useEndpoint(sessionUrl, billedTokens, COST_DEBOUNCE_MS);
    const balance = useEndpoint(open ? BALANCE_ROUTE : undefined, open, 0);
    const pos = (0, dsh_client_ui_primitives_1.useAnchoredPosition)({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN });
    (0, dsh_client_ui_primitives_1.useDismissOnOutsidePointer)(rootRef, open, setOpen, panelRef);
    React.useEffect(() => {
        if (!open)
            return undefined;
        const onKeyDown = (event) => {
            if (event.key === 'Escape')
                setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('keydown', onKeyDown); };
    }, [open]);
    if (!hasTokens)
        return null;
    const body = cost.body;
    const priced = body?.priced === true;
    const amountText = priced ? formatMoney(body.total, body.currency) : '—';
    const totalOf = key => (body?.routes ?? []).reduce((sum, route) => sum + (route[key] ?? 0), 0);
    return (React.createElement("div", { className: "dsh-cost-root", "data-dsh-cost": true },
        React.createElement("span", { ref: rootRef, className: "dsh-cost-anchor" },
            React.createElement("button", { type: "button", className: "dsh-cost-pill", "aria-haspopup": "dialog", "aria-expanded": open, "aria-label": t('pill.aria', { amount: amountText }), onClick: () => { setOpen(!open); } },
                React.createElement(CostIcon, null),
                React.createElement("span", null, amountText)),
            open && (0, react_dom_1.createPortal)(React.createElement("div", { ref: panelRef, className: "dsh-cost-panel", role: "dialog", "aria-label": t('dialog.title'), style: pos ?? MEASURE_STYLE },
                React.createElement("div", { className: "dsh-cost-title" },
                    React.createElement("span", { className: "dsh-cost-titleLabel" },
                        React.createElement(CostIcon, null),
                        t('dialog.title')),
                    React.createElement("span", { className: "dsh-cost-titleValue" }, cost.status === 'error' ? '—' : amountText)),
                React.createElement("div", { className: "dsh-cost-rule", "aria-hidden": true }),
                cost.status === 'error' && (React.createElement("div", { className: "dsh-cost-note" },
                    t('dialog.error', { message: cost.error ?? '' }),
                    React.createElement("button", { type: "button", className: "dsh-cost-retry", onClick: cost.reload }, t('dialog.retry')))),
                cost.status !== 'error' && !priced && (React.createElement("div", { className: "dsh-cost-note" }, t('dialog.empty'))),
                priced && (React.createElement("dl", { className: "dsh-cost-details" },
                    React.createElement("dt", null, t('dialog.model')),
                    React.createElement("dd", null),
                    body.routes.map((route) => (React.createElement(React.Fragment, { key: `${route.provider}/${route.model}` },
                        React.createElement("dt", { className: "dsh-cost-route" }, `${route.provider}/${route.model}`),
                        React.createElement("dd", null, `${formatTokens(route.uncachedInputTokens + route.cacheReadTokens + route.cacheWriteTokens + route.outputTokens)} tok · ${formatMoney(route.amount, body.currency)}`)))),
                    React.createElement("dt", null, t('dialog.input')),
                    React.createElement("dd", null, formatExact(totalOf('uncachedInputTokens'))),
                    React.createElement("dt", null, t('dialog.cacheRead')),
                    React.createElement("dd", null, formatExact(totalOf('cacheReadTokens'))),
                    React.createElement("dt", null, t('dialog.cacheWrite')),
                    React.createElement("dd", null, formatExact(totalOf('cacheWriteTokens'))),
                    React.createElement("dt", null, t('dialog.output')),
                    React.createElement("dd", null, formatExact(totalOf('outputTokens'))),
                    React.createElement("dt", null, t('dialog.peak')),
                    React.createElement("dd", null, `${formatTokens(totalOf('peakTokens'))} · ${formatMoney(totalOf('peakAmount'), body.currency)}`),
                    React.createElement("dt", null, t('dialog.idle')),
                    React.createElement("dd", null, `${formatTokens(totalOf('idleTokens'))} · ${formatMoney(totalOf('idleAmount'), body.currency)}`),
                    (body.unpriced ?? []).map((route) => (React.createElement(React.Fragment, { key: `unpriced/${route.provider}/${route.model}` },
                        React.createElement("dt", { className: "dsh-cost-route" }, `${route.provider}/${route.model}`),
                        React.createElement("dd", null, `${formatTokens(route.tokens)} tok · ${t('dialog.unpriced')}`)))))),
                React.createElement("div", { className: "dsh-cost-section" },
                    React.createElement("div", { className: "dsh-cost-title" },
                        React.createElement("span", { className: "dsh-cost-titleLabel" }, t('dialog.balance'))),
                    React.createElement("div", { className: "dsh-cost-rule", "aria-hidden": true }),
                    balance.status !== 'ready' && (React.createElement("div", { className: "dsh-cost-note" }, t('dialog.balanceLoading'))),
                    balance.status === 'ready' && balance.body?.available !== true && (React.createElement("div", { className: "dsh-cost-note" }, t('dialog.unavailable', {
                        reason: t(`dialog.balanceReason.${balance.body?.reason ?? 'NETWORK'}`),
                    }))),
                    balance.status === 'ready' && balance.body?.available === true
                        && (balance.body.rows ?? []).length === 0 && (React.createElement("div", { className: "dsh-cost-note" }, t('dialog.balanceEmpty'))),
                    balance.status === 'ready' && (balance.body?.rows ?? []).map((row) => (React.createElement("div", { key: row.currency, className: "dsh-cost-balance" },
                        React.createElement("span", null, row.currency),
                        React.createElement("span", null,
                            `${t('dialog.balanceTotal')} `,
                            React.createElement("b", null, row.total),
                            ` · ${t('dialog.balanceGranted')} `,
                            React.createElement("b", null, row.granted),
                            ` · ${t('dialog.balanceToppedUp')} `,
                            React.createElement("b", null, row.toppedUp)))))),
                React.createElement("div", { className: "dsh-cost-note" },
                    t('dialog.basis', { samples: body?.samples ?? 0 }),
                    (body?.excluded?.inheritedEvents ?? 0) > 0
                        && ` · ${t('dialog.excluded', { count: body.excluded.inheritedEvents })}`)), document.body))));
}
exports.name = NS;
/** Slot and locale are the only client services this plugin consumes. */
exports.inject = ['slots', 'locale'];
/**
 * Mount the cost pill next to the other composer-dock entries.
 * @param ctx - the browser plugin context.
 */
function apply(ctx) {
    ensureStyle();
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cost: locale');
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'cost',
        order: 1,
        locale: NS,
    }, CostPill));
}

		return module.exports;
	}
});
