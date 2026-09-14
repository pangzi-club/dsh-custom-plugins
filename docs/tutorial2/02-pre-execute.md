# 02 · 权限门：`tools/pre-execute` 的 allow、deny 与 ask

[上一章：事件模式与观察者](01-waterfall.md) · [下一章：结果变换与工具呈现](03-transform.md)

v1 的哨塔只看不说。v2 让它开口：给 `dsh-tool-watchtower` 加一张**规则表**（插件行 config），
在 `tools/pre-execute` 瀑布里对每次工具调用做裁决——放行、拒绝，或上抛给审批服务让
人点头。这是第一辑第 6 章「策略监听者」的完全体，也是 waterfall 纪律第一次真正上考场。

> **本章状态声明**：决策类型与审批语义核对自上游 `docs/subsystems/tools.md` 与
> `docs/subsystems/approval.md`；代码未经本工作区实测（本辑通例，下不再重复）。

## 1. 瀑布上的门：位置与决策

第一辑第 6 章给过管线全图，`tools/pre-execute` 站在最前面：

```
tools/pre-execute   ← 本章：allow / deny / ask
  → 单调 guard（ctx.tools.guard，终局否决，本辑不展开）
    → tools/execute   包裹调度（第 3 章）
      → execute 体
        → tools/post-execute   （第 3 章）
          → tools/result   （第 1 章已挂观察者）
```

决策类型是三个字面量的判别联合（上游 `PreToolDecision`）：

```ts
type PreToolDecision =
  | { kind: 'allow' }                 // 放行（交给下游与工具体）
  | { kind: 'deny'; reason: string }  // 拒绝；reason 成为这次调用的错误文本
  | { kind: 'ask'; reason?: string }  // 上抛审批服务
```

三条上游写明的语义，决定了本章的写法：

- **参数不可改写**。决策类型里根本没有「改参数」这个分支——不是框架没来得及做，而是
  刻意焊死：调用此刻已经落了 `tool/call` 日志、已经呈现到 UI，事后改写会让日志、界面与
  实际执行三者对不上。想限制参数，只能在 deny 的 `reason` 里说清楚；
- **`ask` 走审批 seam，fail-closed**。返回 `{ kind: 'ask' }` 后，注册表把这次调用交给
  `ctx.approval` 审批服务：审批面给出 `allowed-once` 才放行，`rejected`/`cancelled`/
  `unavailable` 一律拒绝——**没有审批面的组合里，ask 等同于 deny**（上游
  `docs/subsystems/approval.md`：缺失的、抛错的、不合规的 answerer 都算 `unavailable`，
  绝不因此开门）。Web GUI 自带人审通道（上游 `packages/client/ui-approval`）；
- **你的返回值取代整条下游**。waterfall 的组合规则：调 `next()` 把链交下去；**不调而
  直接返回决策，等于替所有下游监听者做了主**。所以裁决型监听者的正确姿势是——

  - 不裁决：`return next()`（哪怕你心里觉得该放行，也要让下游说了算）；
  - 裁决：`return { kind: 'deny', reason }` 或 `{ kind: 'ask' }`。

  反面教材是 `return { kind: 'allow' }`：它看起来人畜无害，实际上会**短路所有排在后面
  的否决型监听者**——你以为在放行，其实在越权。本章代码里 allow 永远是 `next()`。

另外两点边界：`exec.arguments` 已冻结（v1 坑里提过），规则匹配只能基于工具名与参数的
**读**；waterfall 监听者的产出是**返回值**不是异常——别用 throw 表达「拒绝」，那是
bug 不是策略。

## 2. 规则表：`src/host/rules.ts`

规则语义刻意做小：**首条命中生效**（数组顺序即优先级），`tool` 匹配工具名的精确字符串
或 `'*'` 通配，未命中任何规则默认放行。配置校验延续第一辑的 fail-loudly 风格——加载时
报错，不给静默吞错的配置留活路。

**`dsh-tool-watchtower/src/host/rules.ts`**

```ts
/**
 * The watchtower's gate rules: a plugin-row `config.rules` list evaluated
 * first-match-wins against one tool name. Pure parsing + evaluation, no ctx,
 * so the tests can drive both directly.
 */

/** One configured rule: `tool` is an exact wire name or the `'*'` wildcard. */
export interface GateRule {
  tool: string
  decision: 'allow' | 'deny' | 'ask'
  reason?: string
}

/** The decisions the pre-execute waterfall understands (upstream shape). */
export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

const DECISIONS = new Set(['allow', 'deny', 'ask'])

/**
 * Validate `config.rules` (undefined → no rules) or fail loudly with the
 * offending path in the message.
 */
export function resolveRules(input: unknown): GateRule[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    throw new Error(`dsh-tool-watchtower: config.rules must be an array, got ${JSON.stringify(input)}`)
  }
  return input.map((entry, index) => {
    const at = `config.rules[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`dsh-tool-watchtower: ${at} must be a mapping, got ${JSON.stringify(entry)}`)
    }
    const rule = entry as Record<string, unknown>
    if (typeof rule.tool !== 'string' || rule.tool.trim().length === 0) {
      throw new Error(`dsh-tool-watchtower: ${at}.tool must be a non-empty string`)
    }
    if (typeof rule.decision !== 'string' || !DECISIONS.has(rule.decision)) {
      throw new Error(
        `dsh-tool-watchtower: ${at}.decision must be one of "allow" | "deny" | "ask", got ${JSON.stringify(rule.decision)}`,
      )
    }
    if (rule.reason !== undefined && (typeof rule.reason !== 'string' || rule.reason.trim().length === 0)) {
      throw new Error(`dsh-tool-watchtower: ${at}.reason must be a non-empty string when present`)
    }
    return {
      tool: rule.tool,
      decision: rule.decision as GateRule['decision'],
      ...(typeof rule.reason === 'string' ? { reason: rule.reason } : {}),
    }
  })
}

/** Evaluate the rules against one tool call: first match wins, default allow. */
export function decide(rules: readonly GateRule[], toolName: string): Verdict {
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== toolName) continue
    if (rule.decision === 'deny') {
      return { kind: 'deny', reason: rule.reason ?? `dsh-tool-watchtower: tool "${toolName}" is denied by rule` }
    }
    if (rule.decision === 'ask') {
      return { kind: 'ask', ...(rule.reason === undefined ? {} : { reason: rule.reason }) }
    }
    return { kind: 'allow' }
  }
  return { kind: 'allow' }
}
```

## 3. 接线：审计裁决 + 门禁监听者

两处增量。先给 `activity.ts` 加一种记录——**门的裁决**。被 deny 的调用不会产生正常的
工具结果记录（它根本没跑），门的审计得自己记：

在 `activity.ts` 的 `ModelRecord` 之后加入：

```ts
/** One gate verdict the watchtower itself handed down (deny/ask only; plain allows are not audited). */
export interface DecisionRecord {
  kind: 'decision'
  time: number
  name: string
  decision: 'deny' | 'ask'
  reason?: string
}
```

把联合类型与 totals 改成：

```ts
export type ActivityRecord = ToolRecord | ModelRecord | DecisionRecord

export interface ActivityTotals {
  tools: number
  toolErrors: number
  denied: number
  asked: number
  modelAttempts: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
```

`foldTotals` 的工具分支后面补一个分支，并把四个 token 桶的初始化留在原处（新增两个
计数器初始化为 0）：

```ts
    if (record.kind === 'decision') {
      if (record.decision === 'deny') totals.denied += 1
      else totals.asked += 1
      continue
    }
```

类里加方法（放在 `recordTool` 之后）：

```ts
  recordDecision(time: number, name: string, decision: 'deny' | 'ask', reason?: string): void {
    const record: DecisionRecord = {
      kind: 'decision',
      time,
      name,
      decision,
      ...(reason === undefined ? {} : { reason }),
    }
    this.push(record)
  }
```

然后是 `index.ts`：`inject` 不变（事件监听不需要声明依赖），`apply` 换成下面这版——
新增 config 解析与门禁监听者，v1 的两个观察者原样保留（下面省略号处）：

```ts
import { ActivityLog } from './host/activity.js'
import { decide, resolveRules } from './host/rules.js'
import type { GateRule } from './host/rules.js'
import type { DshContext, NodeIncomingMessage, NodeServerResponse } from './host/context.js'

// …常量区不变（PING_PATH / RING_LIMIT / SESSION_LIMIT）…

export const name = 'dsh-tool-watchtower'

export const inject = ['webServer']

/** The plugin row's config, validated at load. */
interface EffectiveConfig {
  rules: GateRule[]
}

export function apply(ctx: DshContext, config: unknown = {}): void {
  // Fail loudly on a malformed row, before anything registers.
  const source = (config ?? {}) as { rules?: unknown }
  if (source !== null && typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`dsh-tool-watchtower: config must be a mapping, got ${JSON.stringify(config)}`)
  }
  const effective: EffectiveConfig = { rules: resolveRules(source.rules) }

  const sessions = new Map<string, ActivityLog>()

  // …logOf、ping 路由、tools/result 观察者、agent/assistant-stream 观察者
  //   全部与 v1 相同，此处省略…

  // The gate: first-match-wins rules over every pending tool call. A veto is
  // audited and returned; an allow is always delegated, never asserted.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = String(exec.name ?? '')
    const verdict = decide(effective.rules, toolName)
    if (verdict.kind === 'allow') return next()
    const sessionId = String(exec.agent?.session?.id ?? '')
    if (sessionId.length > 0) {
      logOf(sessionId).recordDecision(Date.now(), toolName, verdict.kind, verdict.reason)
    }
    // Scaffold-era visibility, as in v1.
    console.log(`[dsh-tool-watchtower] gate ${verdict.kind}: ${toolName}`)
    return verdict
  })
}
```

这个监听者值得逐行读：

- **「先判后裁」**：`decide()` 返回 allow 时 `return next()`——把放行的最终发言权留给
  下游；只有 deny/ask 才亲自返回。这就是 §1 说的「返回值取代下游」的正确用法；
- **审计自己的裁决**：`tools/result` 只会告诉你「这次调用失败了」，不会告诉你「是门拒
  的、为什么拒」——门必须自己记账。ask 也记：即使随后被人批了，记录里留有「门曾经拦下」
  这件事；
- **没有 `ctx.effect`**：事件监听者随插件卸载自动回收（第一辑第 6 章的规矩）。

规则表长在插件行的 `config` 里（生效语义见第一辑第 3 章：改 config 只需重新组合 +
刷新页面，不用重启）：

```yaml
- insert:
    - id: watchtower
      name: '/path/to/dsh-custom/dsh-tool-watchtower/lib/index.js'
      config:
        rules:
          - tool: web_fetch
            decision: ask
            reason: outbound fetches need a human nod
          - tool: write
            decision: deny
            reason: this session is read-only
          - tool: '*'
            decision: allow
```

注意顺序的分量：`web_fetch` 的 ask 排在 `'*'` 之前才有意义——首条命中生效，通配条目
永远该垫底。

## 4. 上机验证清单

改了宿主代码（新监听者）→ **重启** `dsh web`，刷新页面：

1. **deny**：先用上面的规则表（去掉 `web_fetch` 行也行），让模型「帮我写一个
   hello.txt」。工具卡片应以错误收场，文案是 `reason` 里那句话；宿主终端出现
   `[dsh-tool-watchtower] gate deny: write`。`tools/result` 观察者**可能**也为它打出
   一条 `tool error` 日志——拒绝结果同样要流完管线收尾（见 §5 的坑）；分辨的依据是
   `gate deny` 行，且 `reason` 与卡片错误文案一致；
2. **ask**：让模型「抓取 https://example.com 的标题」。若 GUI 弹出审批确认（Web 自带
   人审通道），点允许 → 调用继续、终端出现 `gate ask: web_fetch` 后跟正常的结果日志；
   点拒绝 → 调用以错误收场；
3. **fail-closed 验证**：如果第 2 步没有弹审批而是直接错误——你的组合里没有可用的审批
   answerer，ask 按约定退化为拒绝。这不是 bug（见 §1 的 fail-closed 语义），换一个
   上游自带审批面的发行方式即可确认 ask 全流程；
4. **顺序敏感性**：把 `'*'` 挪到规则表第一行再刷新（改 config 不用重启），所有工具都
   放行、deny 规则失聪——亲眼看一次首条命中；
5. **配置报错路径**：把 `decision` 改成 `"maybe"` 再重新组合 → 启动日志里应有
   `config.rules[0].decision must be one of …` 的 fail-loudly 报错，插件不加载。

## 5. 本章坑

- **`return { kind: 'allow' }` 是越权**：它终结瀑布、剥夺下游监听者的否决权。放行只有
  一种正确写法：`return next()`；
- **首条命中，通配垫底**：规则表是顺序数组不是映射，`'*'` 放前面会吞掉一切特化规则；
- **deny 的 reason 是模型唯一能读到的解释**：写「被规则拒绝」等于没写。reason 要给模型
  指路（"read-only session, use read instead"），它下一次调用才会绕开；
- **ask ≠ 弹窗**：ask 只是把问题交给审批 seam；没有人审/机审 answerer 时它 fail-closed
  成拒绝。教程示例里它「看起来像弹窗」是因为 Web 组合带人审通道；
- **被拒 ≠ 没有结果**：`pre-execute` 的 deny 会把调用物化成**错误结果**继续走完管线——
  仓内策略 `repeat-tool-reminder` 正是因此在 post-execute 里统计被拒调用。别假设「拒了
  就什么都没有」；想区分「门拒的」与「工具自己失败的」，用门的审计记录对账；
- **waterfall 监听者别抛错**：决策靠返回值表达；把「拒绝」写成 throw 是把策略当 bug。
  （emit 的容错不适用于瀑布——瀑布监听者的责任更重，这也是观察位不该和策略位
  混在同一个监听者里的原因。）
- **改 config 与改代码的生效方式不同**：前者重新组合 + 刷新即可，后者必须重启（第一辑
  第 3 章的表）。反复改 rules.ts 却只刷页面，会一直跑旧代码。

## 6. 小结

- `tools/pre-execute` 是管线第一站，三值决策 allow/deny/ask；参数不可改写是设计而非
  限制；
- allow 永远 `next()`，裁决才亲自返回——返回值取代下游是 waterfall 的双刃剑；
- ask 走 `ctx.approval`，fail-closed：没有审批面就是拒绝（`allowed-once` 是唯一通行证）；
- 规则表做小（首条命中 + 通配 + 默认放行），校验做严（fail-loudly）；
- 门要自己记账：被拒的调用不会出现在 `tools/result` 里。

## 7. 延伸阅读

- 上游 `docs/subsystems/tools.md` —— `tools/pre-execute` 节、`PreToolDecision` 与
  「参数不可改写」的设计说明、guard 与瀑布的关系；
- 上游 `docs/subsystems/approval.md` —— 审批 seam 全文：`ApprovalOutcome` 闭集、
  fail-closed、人审/机审 answerer；
- 上游 `docs/cookbook/extension-cookbook.md` —— permission-gate 示例插件（本章的仓内
  原型）；
- 上游 `docs/cordis-primer.md` —— waterfall 组合语义；
- [第一辑第 6 章](../tutorial/06-tools-events.md) —— pre-execute 的入门讲法与两个
  惯用法。
