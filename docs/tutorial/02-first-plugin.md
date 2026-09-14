# 02 · 第一个插件：占一条路由

[上一章](01-mental-model.md) · [下一章：配置与生效](03-config-reload.md)

本章从零写出第一个插件 **`dsh-stats`**（会话用量统计，后续章节会一路把它养成双半边插件）。
v1 只做一件事：在 `GET /dsh-stats/ping` 上回答一个 JSON 心跳。它会覆盖你以后每个宿主半边
都要用到的全部骨架：路由模型、插件契约、挂载、验证、测试。

成品参照：[`dsh-favicon-triangle`](../../dsh-favicon-triangle/README.md)——本仓库最简单的
真实插件，同样只占一条 exact 路由。

## 1. webServer 的路由模型

`ctx.webServer` 是宿主进程里的 HTTP 服务（`inject: ['webServer']` 声明依赖它）。它维护一张
路由表，插件用 `register` 认领条目：

```js
ctx.webServer.register({
  kind: 'exact',            // 'exact' | 'prefix'
  path: '/dsh-stats/ping',  // 绝对路径，结尾不带斜杠
  handler: servePing,       // (req, res) => void | Promise<void>，Node 原生 http 风格
})
// 返回注销函数；重复认领同一个 (kind, path) 会抛错
```

请求到达时的匹配顺序：

1. **exact**：路径完全相等命中；
2. **最长前缀**：`prefix` 路由按长度取胜，前缀 `p` 匹配 `p` 本身和 `p/<任意>`；
3. **fallback**：唯一一个兜底席位，属于 SPA 静态文件服务——Web GUI 的页面资源从这里出。

对插件的意义：**exact 路由稳定优先于前端静态文件**。哪怕 SPA 的 dist 里真有一个
`/dsh-stats/ping` 文件，你的 exact 注册也会赢。反过来说，别去碰 `registerFallback`——那个
席位已有主人，第二个注册直接抛错。

handler 是 Node 原生 `(req, res)` 风格，**整个响应归你负责**：状态码、头、体，一样都不能少。

## 2. 建目录，写两个文件

在你的工作区（本教程沿用 `dsh-custom` 的布局；独立建仓也一样）：

```sh
mkdir -p dsh-stats/test
```

**`dsh-stats/package.json`**——v1 是最小集，`dsh.bundle` 等分发字段到[第 8 章](08-packaging.md)再补：

```json
{
  "name": "dsh-stats",
  "version": "0.1.0",
  "description": "DSH Web GUI plugin: session usage stats",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js" },
  "scripts": { "test": "node --test test/*.test.js" },
  "private": true
}
```

两个要点：`"type": "module"` 让 Node 按 ESM 解析（Cordis 插件契约要求）；没有任何
`dependencies`——出仓宿主半边零第三方依赖（[第 1 章 §3](01-mental-model.md)）。

**`dsh-stats/index.js`**：

```js
/**
 * dsh-stats — session usage statistics for the Web GUI (Host half, v1).
 *
 * v1 claims one exact route: GET /dsh-stats/ping answers a JSON heartbeat, to
 * confirm the plugin is mounted and its route is alive.
 */

/** The one path this plugin claims. */
const PING_PATH = '/dsh-stats/ping'

/** One heartbeat reading. */
function pingBody() {
  return { ok: true, plugin: 'dsh-stats', now: new Date().toISOString() }
}

/**
 * Answer one ping request. The handler owns the complete response: reject
 * methods with no representation, and never let anything cache a live reading.
 * @param req - Node request.
 * @param res - Node response.
 */
function servePing(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(pingBody()), 'utf8')
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

export const name = 'dsh-stats'

/** The webserver service owns the route table this plugin claims a path in. */
export const inject = ['webServer']

/**
 * Claim `/dsh-stats/ping` for as long as this plugin stays loaded; the
 * registered effect removes the route when the plugin unloads.
 * @param ctx - Host context carrying the webserver service.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PING_PATH, handler: servePing }),
    'dsh-stats: GET /dsh-stats/ping',
  )
}
```

逐段对照[第 1 章](01-mental-model.md)的契约四词：`name`、`inject: ['webServer']`、
`apply(ctx)`、`ctx.effect(() => register(...), label)`。`register` 返回注销函数，所以必须包
进 `ctx.effect`——插件卸载时路由随之释放，不留尸体。

handler 的三个习惯值得现在养成：

- **方法检查**：不支持的 方法回 `405` 并给出 `allow` 头，而不是让它们掉进 200；
- **精确的 `content-length`**：`Buffer.byteLength` 而不是字符串长度；
- **明确的 `cache-control`**：动态读数用 `no-store`（会被浏览器缓存的资源则给
  `no-cache, must-revalidate`，favicon 类插件的教训，见附录坑清单）。

## 3. 挂载并验证

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，在顶层数组里插入一行，`name` 用**绝对路径**：

```yaml
- insert:
    - id: stats
      name: '/Users/you/code/dsh-custom/dsh-stats/index.js'
```

**新增插件行会改变 boot graph，必须重启**：在上游 checkout 里重启 `pnpm dsh web`（若 GUI
已在运行，先停掉它再启动；千万不要另起一个端口的服务器来「验证」），然后打开
<http://127.0.0.1:3080>。

验证三连：

```sh
curl -i http://127.0.0.1:3080/dsh-stats/ping
# HTTP/1.1 200 OK
# content-type: application/json; charset=utf-8
# cache-control: no-store
# {"ok":true,"plugin":"dsh-stats","now":"2026-09-14T08:00:00.000Z"}

curl -I http://127.0.0.1:3080/dsh-stats/ping    # HEAD：只有头，没有体
curl -i -X POST http://127.0.0.1:3080/dsh-stats/ping
# HTTP/1.1 405 Method Not Allowed · allow: GET, HEAD
```

终端启动日志里也能看到 effect 标签 `dsh-stats: GET /dsh-stats/ping` 注册成功。

### 没生效？按顺序查

1. **`name` 是不是绝对路径**——相对路径不解析（第 1 章 §4）；
2. **是不是忘了重启**——新增行不是热插拔，反复刷新页面没用；
3. **是不是连错了端口**——`web` profile 固定在 3080；你在别的端口起的服务不是 DSH；
4. **启动日志有没有报错**——插件 import 失败或 `apply` 抛错会带原始堆栈终止启动。

## 4. 给它写个测试

出仓插件的测试约定：`node --test`、零依赖、不碰网络、不要求 GUI 在跑。思路是用一个最小
的 `fakeCtx` 捕获插件注册了什么，再直接调用捕获到的 handler。

**`dsh-stats/test/index.test.js`**：

```js
/**
 * Tests for dsh-stats v1: the plugin claims one exact route, and that route
 * answers GET/HEAD with the heartbeat JSON and rejects other methods.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../index.js'

/** Minimal cordis-shaped ctx capturing the effect and route the plugin registers. */
function fakeCtx() {
  const state = { routes: [], disposers: [], effects: 0 }
  return {
    state,
    ctx: {
      effect(effect) {
        state.effects += 1
        state.disposers.push(effect())
      },
      webServer: {
        register(route) {
          state.routes.push(route)
          return () => {
            state.routes.splice(state.routes.indexOf(route), 1)
          }
        },
      },
    },
  }
}

/** Minimal Node response double recording status, headers, and body. */
function fakeRes() {
  const res = { status: 0, headers: undefined, body: undefined }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.body = body
  }
  return res
}

test('declares the webserver dependency and a stable plugin name', () => {
  assert.equal(name, 'dsh-stats')
  assert.deepEqual(inject, ['webServer'])
})

test('claims exactly the ping path with one exact route', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  assert.equal(state.routes.length, 1)
  assert.deepEqual(
    { kind: state.routes[0].kind, path: state.routes[0].path },
    { kind: 'exact', path: '/dsh-stats/ping' },
  )
})

test('unloading the plugin releases the route', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  for (const dispose of state.disposers) dispose()
  assert.equal(state.routes.length, 0)
})

test('GET answers the heartbeat JSON; other methods are refused', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  const ok = fakeRes()
  state.routes[0].handler({ method: 'GET' }, ok)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(String(ok.body))
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-stats')
  assert.equal(Number(ok.headers['content-length']), Buffer.byteLength(String(ok.body)))

  const bad = fakeRes()
  state.routes[0].handler({ method: 'POST' }, bad)
  assert.equal(bad.status, 405)
  assert.equal(bad.headers.allow, 'GET, HEAD')
})
```

```sh
cd dsh-stats && npm test    # 4 项全绿
```

第三个测试（卸载释放路由）值得留意：它在验证 `ctx.effect` 的生命周期语义，而不是某个实现
细节——**插件卸载后不留任何注册残留**，这是 Cordis 的硬约束，你的每个 effect 都该有这条
测试。

## 小结

- exact 路由稳定优先于 SPA 静态文件，是宿主半边最便宜的扩展点；
- handler 拥有整个响应：方法检查、精确 `content-length`、明确 `cache-control`；
- 注册函数返回注销函数 → 包 `ctx.effect`；
- 新增插件行 = boot graph 变化 = 重启 `dsh web`；
- 测试不依赖运行中的 DSH：`fakeCtx` 捕获注册，直接打 handler。

下一章给 `dsh-stats` 加配置，并把这章按下不表的「生效语义」彻底讲清。

## 延伸阅读

- [`dsh-favicon-triangle/`](../../dsh-favicon-triangle/README.md) —— 同款单路由插件的成品
  （SVG、深浅色适配、可 bundle 分发）；
- 上游 `docs/subsystems/web-server.md` —— `ctx.webServer` 完整参考（upgrade、index 注入等）；
- 上游 `docs/user/develop/basic/index.md` —— 仓内视角的「第一个插件」，可对照 §3 的差异表。
