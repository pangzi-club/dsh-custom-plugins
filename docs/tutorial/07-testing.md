# 07 · 测试：零依赖地测一个没有 node_modules 的插件

[上一章](06-tools-events.md) · [下一章：打包与分发](08-packaging.md)

出仓插件的测试有三条铁律：**零依赖**（工作区没有 `node_modules`，也别引入）、**不打真实
网络**、**不依赖 GUI 或已启动的 DSH**。全部用 `node --test`（Node 内置测试器）达成。

先做一个整理动作：把[第 2 章](02-first-plugin.md)的 `test/index.test.js` 统一改名为
`index.test.mjs`（`.mjs` 后缀对 ESM 无歧义），并把 `package.json` 的测试脚本改为：

```json
"scripts": { "test": "node --test test/*.test.mjs" }
```

测试分三层，自下而上越来越「像真的」，也越来越少：

```
第三层  bundle 结构测试   lib/client.js 的信封、导出、注册行为     1 个文件
第二层  编排测试          apply 注册了什么、handler 如何应答        1~2 个文件
第一层  纯函数测试        host/ 下的折叠、校验、格式化             每模块 1 个文件
```

## 1. 第一层：纯函数

[第 4 章](04-host-api.md)把折叠逻辑抽进 `host/fold.js` 就是为了这一刻——不需要任何 mock，
调用函数、断言结果。**`dsh-stats/test/fold.test.mjs`**：

```js
/**
 * Tests for the usage fold: per-route accumulation, bucket normalization,
 * and the skipping of unusable samples.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeUsage } from '../host/fold.js'

const TIME = Date.UTC(2026, 8, 11, 2, 0, 0)

/** One assistant message sample. */
function message(seq, route, usage) {
  return {
    type: 'assistant/message',
    seq,
    time: TIME,
    data: { turn: 1, step: seq, message: { source: route }, usage },
  }
}

test('folds usage samples per model route', () => {
  const events = [
    message(1, { provider: 'deepseek', model: 'flash' }, { inputTokens: 100, outputTokens: 200 }),
    message(2, { provider: 'deepseek', model: 'flash' }, { inputTokens: 1, cacheReadTokens: 10 }),
    message(3, { provider: 'deepseek', model: 'pro' }, { outputTokens: 5 }),
  ]
  const fold = summarizeUsage(events)
  assert.equal(fold.samples, 3)
  assert.equal(fold.skipped, 0)
  assert.equal(fold.rows.length, 2)
  const flash = fold.rows.find(row => row.model === 'flash')
  assert.equal(flash.uncachedInputTokens, 101)
  assert.equal(flash.cacheReadTokens, 10)
  assert.equal(flash.outputTokens, 200)
  assert.deepEqual(fold.totals, {
    uncachedInputTokens: 101,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 205,
  })
})

test('skips assistant messages without usable usage', () => {
  const events = [
    {
      type: 'request/header', seq: 1, time: TIME,
      data: { header: { config: { provider: 'deepseek', model: 'flash' } } },
    },
    message(2, { provider: 'deepseek', model: 'flash' }, {}),
    message(3, { provider: 'deepseek', model: 'flash' }, undefined),
  ]
  const fold = summarizeUsage(events)
  assert.equal(fold.samples, 0)
  assert.equal(fold.skipped, 2)
  assert.deepEqual(fold.rows, [])
})

test('tolerates non-array event logs', () => {
  assert.deepEqual(summarizeUsage(undefined).rows, [])
  assert.deepEqual(summarizeUsage(null).totals, {
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  })
})
```

配置校验（`resolveConfig`）同属这一层：合法值合并出有效配置、非法值当场抛错、省略取
默认——三种用例各来一条即可。

## 2. 第二层：编排（`fakeCtx` + 假服务）

这一层回答「`apply` 在 `ctx` 上注册了什么、注册的东西行为对不对」。手法是手写一个最小
的 cordis 形状 `ctx`，把每个服务换成记录用的假实现。**`dsh-stats/test/routes.test.mjs`**：

```js
/**
 * Orchestration tests: the Host half registers the authenticated summary
 * route and the session_stats tool, and maps every outcome (missing id,
 * unreadable session, folded body, memoized reads) to stable JSON.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../index.js'

const SUMMARY_ROUTE = '/api/dsh-stats/summary'

/** Minimal ctx capturing effects, routes, tools, and event listeners. */
function harness({ readSession, config } = {}) {
  const routes = new Map()
  const tools = new Map()
  const listeners = new Map()
  const disposers = []
  const ctx = {
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    on(eventName, listener) {
      listeners.set(eventName, listener)
      return () => {}
    },
    get() {
      return undefined
    },
    webServer: {
      register() { return () => {} },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
    sessionQuery: {
      readSession: readSession ?? (async () => ({ events: [], inheritedEventCount: 0 })),
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
  }
  apply(ctx, config)
  return { routes, tools, listeners, disposers }
}

/** One session snapshot with a header plus one billed sample. */
function snapshot() {
  return {
    inheritedEventCount: 0,
    events: [
      {
        type: 'request/header', seq: 1, time: Date.UTC(2026, 8, 11, 2, 0, 0),
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } },
      },
      {
        type: 'assistant/message', seq: 2, time: Date.UTC(2026, 8, 11, 2, 0, 0),
        data: {
          turn: 1, step: 1,
          message: { source: { provider: 'deepseek', model: 'deepseek-flash' } },
          usage: { inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 500 },
        },
      },
    ],
  }
}

const bodyOf = async response => response.json()

test('declares its service dependencies', () => {
  assert.equal(name, 'dsh-stats')
  assert.deepEqual(inject, ['webServer', 'connection', 'sessionQuery', 'tools'])
})

test('registers the summary route as a buffered GET handler', () => {
  const { routes } = harness()
  const route = routes.get(SUMMARY_ROUTE)
  assert.ok(route, 'the summary route is registered')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')
})

test('requires a session id', async () => {
  const { routes } = harness()
  const response = await routes.get(SUMMARY_ROUTE).fetch(new Request('http://x/api/dsh-stats/summary'))
  assert.equal(response.status, 400)
  assert.match((await bodyOf(response)).error, /session id is required/)
})

test('answers 404 when the session cannot be read', async () => {
  const { routes } = harness({ readSession: async () => { throw new Error('not found') } })
  const response = await routes.get(SUMMARY_ROUTE)
    .fetch(new Request('http://x/api/dsh-stats/summary?session=missing'))
  assert.equal(response.status, 404)
  assert.match((await bodyOf(response)).error, /not found/)
})

test('answers the folded summary under the configured label', async () => {
  const { routes } = harness({ readSession: async () => snapshot(), config: { label: 'my-stats' } })
  const response = await routes.get(SUMMARY_ROUTE)
    .fetch(new Request('http://x/api/dsh-stats/summary?session=s1'))
  assert.equal(response.status, 200)
  const body = await bodyOf(response)
  assert.equal(body.label, 'my-stats')
  assert.equal(body.samples, 1)
  assert.deepEqual(body.routes, [{
    provider: 'deepseek',
    model: 'deepseek-flash',
    uncachedInputTokens: 1_000,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    outputTokens: 2_000,
  }])
})

test('memoizes a fold until a usage sample lands', async () => {
  let reads = 0
  const { routes, listeners } = harness({
    readSession: async () => {
      reads += 1
      return snapshot()
    },
  })
  const route = routes.get(SUMMARY_ROUTE)
  await route.fetch(new Request('http://x/api/dsh-stats/summary?session=s1'))
  await route.fetch(new Request('http://x/api/dsh-stats/summary?session=s1'))
  assert.equal(reads, 1)
  listeners.get('session/event')({ id: 's1' }, { type: 'assistant/message' })
  await route.fetch(new Request('http://x/api/dsh-stats/summary?session=s1'))
  assert.equal(reads, 2)
})

test('registers a session_stats tool that validates its own arguments', async () => {
  const { tools } = harness({ readSession: async () => snapshot() })
  const tool = tools.get('session_stats')
  assert.ok(tool, 'the tool is registered')
  assert.equal(tool.parameters.required[0], 'session')
  assert.equal(tool.output.schema.type, 'object')
  await assert.rejects(tool.execute({}), /arguments\.session/)
  const value = await tool.execute({ session: 's1' })
  assert.equal(value.samples, 1)
  assert.equal(value.routes[0].model, 'deepseek-flash')
})
```

设计要点：

- **`fakeCtx` 只实现被用到的面**：`effect`/`on`/`get` 加四个服务。每个假服务记录注册
  内容并返回能撤销的注销函数——这让「卸载后不留残留」可以直接断言（遍历 `disposers`）；
- **connection.fetch 用真的 `Request`/`Response`**：Node 22+ 内置 Fetch 实现，零成本拿到
  真实语义（`searchParams`、`response.json()`、status）；
- **事件驱动行为靠 `listeners` 直接驱动**：`session/event` 的失效逻辑不需要等真会话，
  手动调用监听器即可覆盖「标脏→重算」全链路。

第 2 章的 webServer handler 测试（`fakeRes` 直接打 `routes[0].handler`）同属这一层，不再
重复。

## 3. 第三层：bundle 结构测试

客户端半边没有「运行浏览器」的测试，但它的**结构契约**可以用 `node:vm` 逼真地验证：在
一个最小浏览器环境里执行 `lib/client.js`，断言信封、导出与注册行为。这是
`dsh-cost/test/bundle.test.mjs` 的模式，**`dsh-stats/test/bundle.test.mjs`**：

```js
/**
 * Bundle-contract tests: the built lib/client.js must present the loader
 * envelope, expose the plugin exports, and register the dock entry with a
 * locale namespace that has zh/en parity.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** Stub of the baseline platform modules the bundle requires. */
function platformModules() {
  return {
    'react': {
      createElement: () => null,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useRef: (initial) => ({ current: initial ?? null }),
      useMemo: (factory) => factory(),
      useCallback: (callback) => callback,
      Fragment: Symbol('Fragment'),
    },
    'react-dom': { createPortal: () => null },
    '@deepseek-ai/dsh-client-ui-primitives': {
      useAnchoredPosition: () => null,
      useDismissOnOutsidePointer: () => {},
    },
  }
}

/** Execute the built bundle and return the factory it registers. */
function loadBundle() {
  let row
  const created = []
  const document = {
    querySelector: () => null,
    createElement: () => {
      const element = { dataset: {}, textContent: '' }
      created.push(element)
      return element
    },
    head: { appendChild: () => {} },
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: value => { row = value } } },
    document,
    console,
  })
  vm.runInContext(readFileSync(BUNDLE, 'utf8'), context)
  assert.ok(row, 'the bundle registers a module-loader row')
  const registry = platformModules()
  const exports = row.factory(specifier => {
    if (specifier in registry) return registry[specifier]
    throw new Error(`the bundle requested an unknown module ${specifier}`)
  })
  return { row, exports, created }
}

/** Stub browser plugin context capturing what the plugin registers. */
function context() {
  const registered = {}
  return {
    registered,
    ctx: {
      effect(fn) {
        return fn()
      },
      locale: {
        register(ns, dictionaries) {
          registered.locale = { ns, dictionaries }
          return () => {}
        },
      },
      slots: {
        inject(key, contribute) {
          registered.seat = key
          registered.dispose = contribute()
          return () => {}
        },
        register(options, Component) {
          registered.options = options
          registered.Component = Component
          return () => {}
        },
      },
    },
  }
}

/** Copy a value out of the vm realm so structural assertions compare plainly. */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('presents the loader envelope with the package identity', () => {
  const { row, exports } = loadBundle()
  assert.equal(row.id, 'dsh-stats')
  assert.equal(typeof row.factory, 'function')
  assert.equal(exports.name, 'dsh-stats')
  assert.deepEqual(plain(exports.inject), ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
})

test('injects its stylesheet once and registers the dock entry', () => {
  const { exports, created } = loadBundle()
  const { ctx, registered } = context()
  exports.apply(ctx)
  const style = created.find(element => element.dataset.plugin === 'dsh-stats')
  assert.ok(style, 'a plugin-scoped style element is created')
  assert.match(style.textContent, /dsh-stats-pill/)
  assert.equal(registered.locale.ns, 'dsh-stats')
  assert.equal(registered.seat, 'conversation.composer.dock')
  assert.deepEqual(plain(registered.options), {
    name: 'conversation.composer.dock',
    id: 'dsh-stats',
    order: 1,
    locale: 'dsh-stats',
  })
  assert.equal(typeof registered.Component, 'function')
})

test('ships zh/en dictionaries with identical key sets', () => {
  const { exports } = loadBundle()
  const { ctx, registered } = context()
  exports.apply(ctx)
  const { zh, en } = registered.locale.dictionaries
  assert.deepEqual(Object.keys(plain(zh)).sort(), Object.keys(plain(en)).sort())
})
```

注意 `require` stub 的失败模式是**抛错**：bundle 一旦请求了模块表之外的裸包名（也就是
违反了[第 5 章](05-web-client.md)的基线约束），这条测试立刻红。

## 4. 运行与节奏

```sh
cd dsh-stats && npm test
```

节奏上的约定（与[`AGENTS.md`](../../AGENTS.md)的完成标准一致）：

- 改动涉及的插件目录测试全绿才算完；未涉及的目录不回归；
- 改了 `src/client/` → 先 `node build.mjs` 再跑测试（bundle 测试读的是 `lib/client.js`）；
- 测试不依赖 GUI；GUI 上的实际验证（胶囊出现、面板可用、工具可调）是发布前的**额外**
  一步，代替不了也代替不被测试覆盖。

## 小结

- 三层金字塔：纯函数（多）→ 编排（中）→ bundle 结构（少）；
- `fakeCtx` 只实现被用到的面，每个假服务记录注册并返回注销函数；
- connection.fetch 用内置 `Request`/`Response` 打真语义；
- bundle 用 `vm` + 模块表 stub 验证信封与导出，`require` 一越界就红。

## 延伸阅读

- [`dsh-cost/test/`](../../dsh-cost/README.md) —— 生产级的三层测试全集（40 项）；
- [`dsh-favicon-triangle/test/index.test.js`](../../dsh-favicon-triangle/test/index.test.js)
  —— 单路由插件的完整小测试；
- 上游 `docs/testing.md` —— 仓库自身的测试策略（了解 DSH 怎么测自己）。
