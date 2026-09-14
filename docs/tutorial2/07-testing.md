# 07 · 事件管线的测试：委托、短路与决策组合

[上一章：组件化 UI 与座位系统](06-ui-primitives.md) · [下一章：附录速查](08-reference.md)

哨塔的全部行为都发生在事件管线里——而管线最难测的地方在于：**监听者不是孤立函数，是
链上的一环**。`return next()` 是不是真的交棒了？一个监听者的 deny 有没有吃掉下游？
变换型监听者尊不尊重下游的 block？本章把第一辑第 7 章的三层金字塔搬进瀑布世界：纯函数
照旧单测，**fakeCtx 升级成能组合瀑布的 harness**，vm 信封测试扩到三个座位。

> **本章状态声明**：测试代码依据前六章的教程代码撰写，与全部代码一样未经本工作区
> 实测；断言的语义以 `node:test` 与前文的代码为准。

## 1. 三层各测什么

| 层 | 对象 | 断言什么 | 前例 |
| --- | --- | --- | --- |
| 纯函数 | `rules` / `transform` / `activity` | 输入 → 输出，逐分支 | 第一辑 fold.test |
| 编排 | `apply()` 挂上的监听者 | **注册了什么** + **瀑布行为**：委托/短路/决策/折叠 | 第一辑 index.test（升级） |
| 信封 | `lib/client.js` | envelope、导出、三个座位、词表对齐、provider | 第一辑 bundle.test（扩展） |

编排层的新问题是瀑布的组合语义：`ctx.on` 注册的一串监听者，在真实管线里是**链式**
调用的——第一个监听者拿到的 `next()` 会调第二个，以此类推，最后落到框架的默认行为。
fakeCtx 要如实模拟这一点，测试才有意义。

测试跑在**构建产物**上（`import '../lib/index.js'`）——先 `node build.mjs` 再
`npm test`，测的永远是用户会加载的那份代码（第一辑的老规矩，TS 化之后尤其重要）。

## 2. 瀑布 harness：把链组合出来

第一辑 index.test 的 fakeCtx 只**收集**监听者；这里再加一个组合器，按 cordis 的顺序
把监听者串成链，末端接一个可断言的 terminal：

```js
/**
 * Compose registered listeners into one waterfall chain, cordis-style: the
 * first-registered listener runs first, its next() reaches the second, …, and
 * the terminal runs when the chain runs out.
 */
function composeWaterfall(listeners, terminal) {
  return async (...payload) => {
    const call = index => {
      if (index >= listeners.length) return terminal(...payload)
      return listeners[index](...payload, () => call(index + 1))
    }
    return call(0)
  }
}
```

两个惯用断言道具：

- **`released` 计数器**：terminal 里自增——「下游被到达了几次」的直接证据；
- **监听者数组过滤**：`state.events.filter(e => e.eventName === 'tools/pre-execute')`
  拿到同一事件的所有监听者，交给组合器。

## 3. 编排层：门禁与变换的行为契约

**`dsh-tool-watchtower/test/waterfall.test.mjs`**（完整清单；fakeCtx 骨架与第一辑
index.test 相同，`harness()` 收集 routes/fetchRoutes/tools/events/disposers，此处从略）：

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'
import { SECRET_MARK } from '../lib/host/transform.js'

// …harness() 与第一辑相同：捕获 effect/webServer/connection.fetch/tools/events，
//   另加 resources 容器（第 5 章起客户端有 provider，宿主 ctx 不涉及）…

const gateListeners = state => state.events.filter(e => e.eventName === 'tools/pre-execute').map(e => e.listener)
const transformListeners = state => state.events.filter(e => e.eventName === 'tools/post-execute').map(e => e.listener)

const EXEC = { name: 'watchtower_echo', callId: 'c1', agent: { session: { id: 's1' } } }
const RESULT = { isError: false, value: { echoed: 'x' }, content: [{ type: 'text', text: 'x' }] }

test('the gate delegates when no rule matches and vetoes when one does', async () => {
  const state = harness({
    rules: [{ tool: 'write', decision: 'deny', reason: 'read-only session' }],
  })
  const chain = composeWaterfall(gateListeners(state), () => {
    throw new Error('downstream must not be reached on a veto')
  })

  // No match → next() runs, the default decision comes back.
  const allowed = await chain({ ...EXEC, name: 'read' }, () => ({ kind: 'allow' }))
  assert.deepEqual(allowed, { kind: 'allow' })

  // Match → the veto wins, and the thrown terminal above proves the chain stopped.
  const veto = await chain({ ...EXEC, name: 'write' }, () => {
    throw new Error('unreachable')
  })
  assert.deepEqual(veto, { kind: 'deny', reason: 'read-only session' })
})

test('an allow is a delegation, not an assertion: a downstream veto still wins', async () => {
  // '*' says allow; a listener registered AFTER the gate (the terminal here)
  // denies. The gate must not have short-circuited it.
  const state = harness({ rules: [{ tool: '*', decision: 'allow' }] })
  const chain = composeWaterfall(gateListeners(state), () => ({ kind: 'deny', reason: 'guard says no' }))
  const verdict = await chain(EXEC, () => { throw new Error('unreachable') })
  assert.deepEqual(verdict, { kind: 'deny', reason: 'guard says no' })
})

test('first match wins: order beats specificity', async () => {
  const state = harness({
    rules: [
      { tool: '*', decision: 'allow' },
      { tool: 'write', decision: 'deny', reason: 'never reached' },
    ],
  })
  const chain = composeWaterfall(gateListeners(state), () => ({ kind: 'allow' }))
  const verdict = await chain({ ...EXEC, name: 'write' }, () => ({ kind: 'allow' }))
  assert.deepEqual(verdict, { kind: 'allow' })
})

test('redact replaces the projection and consults downstream first', async () => {
  const state = harness({
    transform: { tools: ['watchtower_echo'], mode: 'redact' },
  })
  let downstreamReached = false
  const chain = composeWaterfall(transformListeners(state), () => {
    downstreamReached = true
    return { kind: 'accept' }
  })
  const secret = { ...RESULT, content: [{ type: 'text', text: `pw=${SECRET_MARK}123` }] }
  const decision = await chain(EXEC, secret, () => { throw new Error('unreachable') })
  assert.equal(downstreamReached, true, 'the transform delegates before overlaying')
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content[0].text, 'pw=[redacted]123')
})

test('block ends the chain on purpose', async () => {
  const state = harness({
    transform: { tools: ['watchtower_echo'], mode: 'block-secret' },
  })
  const chain = composeWaterfall(transformListeners(state), () => {
    throw new Error('unreachable')
  })
  const secret = { ...RESULT, content: [{ type: 'text', text: SECRET_MARK }] }
  const decision = await chain(EXEC, secret, () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'block')
  assert.match(decision.feedback[0].text, /Re-run without embedding secrets/)
})

test('annotate folds onto the downstream decision and respects a block', async () => {
  const state = harness({
    transform: { tools: ['watchtower_echo'], mode: 'annotate' },
  })

  // Downstream accepts → the notice rides on top.
  const chainAccept = composeWaterfall(transformListeners(state), () => ({ kind: 'accept' }))
  const folded = await chainAccept(EXEC, RESULT, () => { throw new Error('unreachable') })
  assert.equal(folded.kind, 'accept')
  assert.equal(folded.additionalContexts.length, 1)
  assert.equal(folded.additionalContexts[0].source.plugin, 'dsh-tool-watchtower')

  // Downstream blocks → the transform must NOT un-block it.
  const chainBlock = composeWaterfall(transformListeners(state), () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }))
  const respected = await chainBlock(EXEC, RESULT, () => { throw new Error('unreachable') })
  assert.equal(respected.kind, 'block')
})

test('the wrapper times the dispatch and the result observer banks it', async () => {
  const state = harness({})
  const execute = composeWaterfall(
    state.events.filter(e => e.eventName === 'tools/execute').map(e => e.listener),
    () => ({ isError: false, value: {} }),
  )
  await execute(EXEC, () => { throw new Error('unreachable') })

  const resultListener = state.events.find(e => e.eventName === 'tools/result').listener
  const log = state.activityOf('s1')   // harness 里暴露 sessions Map 的读取口
  resultListener(EXEC, { isError: false, value: {} })
  const { records } = log.snapshot()
  const tool = records.find(record => record.kind === 'tool')
  assert.equal(tool.name, 'watchtower_echo')
  assert.equal(typeof tool.durationMs, 'number')
})
```

四个行为契约各就各位：**委托**（no-match 与 allow 都到达下游）、**短路**（veto 与
block 不到达）、**先委托后叠加**（redact 先触下游）、**尊重下游 block**（annotate 不
翻案）。这四条正是第 2、3 章反复强调的瀑布纪律——现在它们是会红的产品断言，不是散文。

## 4. 纯函数层：决策内核与折叠

纯函数测试没有新技法（第一辑 fold.test 的老路），列两组代表断言示意：

```js
// rules.test.mjs 的骨架
test('resolveRules fails loudly with the offending path', () => {
  assert.throws(() => resolveRules('nope'), /config\.rules must be an array/)
  assert.throws(() => resolveRules([{ tool: 'x', decision: 'maybe' }]), /config\.rules\[0\]\.decision/)
})

test('decide is first-match-wins with a default allow', () => {
  const rules = resolveRules([
    { tool: 'web_fetch', decision: 'ask' },
    { tool: '*', decision: 'deny', reason: 'closed' },
  ])
  assert.deepEqual(decide(rules, 'web_fetch'), { kind: 'ask' })
  assert.deepEqual(decide(rules, 'read'), { kind: 'deny', reason: 'closed' })
  assert.deepEqual(decide(rules, 'unknown'), { kind: 'deny', reason: 'closed' })
  assert.deepEqual(decide([], 'read'), { kind: 'allow' })
})
```

```js
// activity.test.mjs 的骨架：帧序列折成一条记录
test('a model attempt folds start → usage chunk → end', () => {
  const log = new ActivityLog(8)
  log.recordFrame({ type: 'start', attemptId: 'a1', turn: 2, step: 1 }, 1000)
  log.recordFrame({ type: 'chunk', attemptId: 'a1', time: 1050, chunk: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } } }, 1060)
  log.recordFrame({ type: 'end', attemptId: 'a1', outcome: { kind: 'committed' } }, 1100)
  const { records, totals } = log.snapshot()
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 })
  assert.equal(records[0].outcome, 'committed')
  assert.equal(totals.modelAttempts, 1)
  assert.equal(totals.inputTokens, 10)

  // Chunks for an unknown attempt are ignored, end never double-counts.
  log.recordFrame({ type: 'end', attemptId: 'a1', outcome: { kind: 'abandoned' } }, 1200)
  assert.equal(log.snapshot().records[0].outcome, 'committed')
})
```

环形截断、`planTransform` 的四模式真值表、`redactText`/`contentText` 的防御分支——
同一风格铺开即可，这里不占篇幅。

## 5. 信封层：三个座位与 provider

bundle 测试在 vm 里跑 `lib/client.js`，比第一辑多断言三件事：**三个座位都注册了**、
**provider 进了 ctx.effect**、**词表仍 zh/en 对齐**（Menu/Modal/Toast/StateDot 在
apply 期只被 import 不被调用，stub 给空壳即可）：

```js
test('registers two list seats, one keyed seat, and the provider', () => {
  const { exports } = loadBundle()   // 与第一辑相同的 vm 装载器，primitives stub 增加 Menu/Modal/Toast/StateDot
  const effects = []
  const seats = []
  const ctx = {
    effect(fn, label) { effects.push({ dispose: fn(), label }) },
    locale: { register: () => () => {} },
    resources: { register: (provider) => { effects.push({ provider, label: 'provider' }); return () => {} } },
    slots: {
      inject(key, contribute) {
        const captured = { seat: key }
        contribute((options, Component) => { captured.options = options; captured.Component = Component; return () => {} })
        seats.push(captured)
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.deepEqual(seats.map(s => s.seat), [
    'conversation.composer.dock',
    'conversation.session.header.utilities',
    'tool.call.toolview',
  ])
  assert.deepEqual(seats[2].options, { name: 'tool.call.toolview', key: 'watchtower_report' })
  const provider = effects.find(e => e.provider)?.provider
  assert.equal(provider.protocol, 'dsh-tool-watchtower')
  assert.equal(typeof provider.open, 'function')
})

test('ships zh/en dictionaries with identical key sets', () => {
  // …与第一辑相同：注册进假 ctx，取 dictionaries，比较键集合…
})
```

`slots.inject` 的 stub 里那句 `contribute(...)` 是关键——第一辑的 stub 直接调用了
`ctx.slots.register`，这里的客户端代码把 register 推迟到 `inject` 的回调里（框架的
按需挂载契约），stub 必须同样先回调再捕获，否则三个座位全是 undefined。

## 6. 跑起来

```sh
cd /path/to/dsh-custom/dsh-tool-watchtower
node build.mjs
npm test          # node --test test/*.test.mjs
```

测试顺序纪律：纯函数文件不依赖构建以外的任何东西；编排与信封文件依赖 `lib/` 存在且
新鲜——把 `build` 挂在 `pretest` 亦可（`"pretest": "node build.mjs"`），代价是每次
测试都编译。仓库里的 `dsh-stats` 选择手动先 build，本教程沿用。

## 7. 本章坑

- **组合顺序即注册顺序**：harness 的 `composeWaterfall` 按注册顺序链式调用（第一个注册
  的先拿到控制权）——与 cordis 的瀑布方向一致。谁先注册在 `apply` 里是写死的，测试
  别打乱它去凑断言；
- **测行为不测实现**：断言「下游到达了几次」「决策长什么样」，别断言监听者内部调用了
  哪个私有函数——重构 `logOf`/`sessions` 时测试不该跟着碎；
- **时间敏感的断言用类型不断言数值**：`durationMs` 断 `typeof number`，别断 `=== 0`
  之类——时钟是环境，不是被测物；
- **vm stub 的形状要跟契约走**：`slots.inject` 的回调式注册（本章）与第一辑的直接
  注册不同——stub 从真实契约抄，不从记忆抄；
- **客户端组件不在 vm 里渲染**：bundle 测试只跑到 `apply` 为止；组件树的行为（钩子
  顺序、Menu 交互）属 GUI 验证清单，vm 里硬造 renderer 是入坑的开始。

## 8. 小结

- 三层金字塔平移到瀑布世界：纯函数照旧、编排层升级出 `composeWaterfall`、信封层扩到
  三座位 + provider；
- 四条瀑布纪律（委托/短路/先委托后叠加/尊重下游 block）在本章全部变成可红可绿的断言
  ——文档里的纪律，测试里兑现；
- harness 与第一辑同源：收集注册 + 可断言 terminal，区别只在多了一层链式组合器；
- 测产物不测源码、stub 从契约抄、时钟不断言数值——三条老规矩依旧。

## 9. 延伸阅读

- [第一辑第 7 章](../tutorial/07-testing.md) —— 三层金字塔与 fakeCtx 的入门讲法
  （本章只讲增量）；
- 上游 `docs/cordis-primer.md` —— waterfall 的组合语义（harness 的组合顺序依据）；
- `node:test` 文档 —— `test`/`assert/strict` 的本事就够本教程用，零依赖不破功；
- 本仓库 `dsh-stats/test/` —— 四个测试文件的真实样例（harness 骨架的出处）。
