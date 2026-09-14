# 03 · 配置与生效语义

[上一章](02-first-plugin.md) · [下一章：已鉴权 API 与会话数据](04-host-api.md)

任何「两个部署可能想要不一样」的东西都该是配置。本章给 `dsh-stats` 加上配置，并借两个
实验把「改了什么、怎么生效」这张表从结论变成肌肉记忆。

## 1. 配置从哪来

出仓插件的配置只有一条通路：**插件行的 `config` 字段**，作为第二个参数进 `apply`：

```yaml
- insert:
    - id: stats
      name: '/Users/you/code/dsh-custom/dsh-stats/index.js'
      config:
        label: 'my-stats'
        timestamp: false
```

```js
export function apply(ctx, config = {}) {   // config 就是上面那块的值
  const label = requireLabel(config.label)  // 默认值 + 校验都是你自己的责任
  // ...
}
```

上游仓内插件有一套更讲究的做法（`docs/user/develop/basic/config.md`）：导出 Schemastery
的 `Schema.object` 声明，字段带默认值，还能注册进设置界面热替换。**出仓插件用不了**：
那套 DSL 要求 `import '@deepseek-ai/dsh-tools'`，而你的工作区解析不到任何 DSH 包
（[第 1 章 §3](01-mental-model.md)）。所以出仓的约定是：

- 配置一律走插件行 `config`，不注册 settings namespace；
- 默认值、类型校验在插件里**自己写**；
- 校验失败就在 `apply` 里**当场抛错**（fail loudly at load）——错误配置应该终止启动并
  出现在终端日志里，而不是变成一个静默的 `undefined` 在第 40 行炸开。

## 2. dsh-stats v2：接受配置

v2 给心跳加上两个配置项：`label`（显示名，默认 `dsh-stats`）与 `timestamp`（是否带时间戳，
默认 `true`）。**`dsh-stats/index.js`** 全量替换为：

```js
/**
 * dsh-stats — session usage statistics for the Web GUI (Host half, v2).
 *
 * v2 adds the plugin-row config: `label` (display name) and `timestamp`
 * (include the reading time in the heartbeat).
 */

/** The one path this plugin claims. */
const PING_PATH = '/dsh-stats/ping'

const DEFAULT_CONFIG = { label: 'dsh-stats', timestamp: true }

/**
 * Validate the plugin-row config and merge it over the defaults. Invalid
 * values fail loudly at load time, in the launcher's terminal log.
 * @param config - the plugin row's config value (may be undefined).
 * @returns the effective config.
 */
function resolveConfig(config) {
  const source = config ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`dsh-stats: config must be a mapping, got ${JSON.stringify(source)}`)
  }
  if (source.label !== undefined
      && (typeof source.label !== 'string' || source.label.trim().length === 0)) {
    throw new Error(`dsh-stats: config.label must be a non-empty string, got ${JSON.stringify(source.label)}`)
  }
  if (source.timestamp !== undefined && typeof source.timestamp !== 'boolean') {
    throw new Error(`dsh-stats: config.timestamp must be a boolean, got ${JSON.stringify(source.timestamp)}`)
  }
  return {
    label: typeof source.label === 'string' ? source.label.trim() : DEFAULT_CONFIG.label,
    timestamp: typeof source.timestamp === 'boolean' ? source.timestamp : DEFAULT_CONFIG.timestamp,
  }
}

/** One heartbeat reading under the effective config. */
function pingBody(config) {
  const body = { ok: true, plugin: config.label }
  if (config.timestamp) body.now = new Date().toISOString()
  return body
}

/**
 * Answer one ping request. The handler owns the complete response.
 * @param req - Node request.
 * @param res - Node response.
 * @param config - effective plugin config.
 */
function servePing(req, res, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(pingBody(config)), 'utf8')
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
 * Claim `/dsh-stats/ping` for as long as this plugin stays loaded.
 * @param ctx - Host context carrying the webserver service.
 * @param config - this plugin row's config (label, timestamp).
 */
export function apply(ctx, config = {}) {
  const effective = resolveConfig(config)
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: PING_PATH,
      handler: (req, res) => servePing(req, res, effective),
    }),
    'dsh-stats: GET /dsh-stats/ping',
  )
}
```

结构要点：`resolveConfig` 是纯函数（便于[第 7 章](07-testing.md)单测）；解析后的
`effective` 被 handler 闭包捕获——配置在 `apply` 时一次性定格，之后的行为完全确定。

## 3. 两个实验

**实验 A：改 `config`，不重启。** 确认 GUI 正在运行，编辑
`$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: stats
      name: '/Users/you/code/dsh-custom/dsh-stats/index.js'
      config:
        label: 'my-stats'
        timestamp: false
```

保存。终端日志里会出现一次重新组合的记录，然后：

```sh
curl -s http://127.0.0.1:3080/dsh-stats/ping
# {"ok":true,"plugin":"my-stats"}     ← label 变了，now 没了，全程无需重启
```

这就是 `patchReload: live` 真正覆盖的场景：**已有插件行的 config 改动**，重新组合后插件
带着新 `config` 重新 `apply`。

**实验 B：写坏 `config`。** 把 `label` 改成数字 `123` 保存。终端日志立刻打出带
`dsh-stats: config.label must be a non-empty string` 的错误，插件加载失败——这正是
fail-loudly 想要的效果。改回合法值保存，插件恢复。注意此时 Web 页面本身通常还在（内核
还在），坏的只是这一个插件；所以**终端日志是你的第一现场**，别只盯着浏览器。

## 4. 生效语义：机制与边界

把[第 1 章](01-mental-model.md)的表展开讲透。`web` profile 的 `patchReload: live` 意味着：
DSH 启动时挂了一个只监视**用户 patch 文件**的 watcher（`cordis.patch.yml` 等）。文件一变，
它把所有层重新组合一遍，对根组装入口做一次 `update`——已有插件行被卸载并按新 `config`
重新加载。这条链路覆盖的就是实验 A。

表格其余的行，边界都来自同一个事实：**启动时定形的东西，运行时不会自己变**。

| 改了什么 | 生效方式 | 为什么 |
| --- | --- | --- |
| 已有插件行的 `config` | 重新组合，刷新页面 | live watcher 重新组合插件行，插件重跑 `apply` |
| 新增/删除插件行、插件引用了新文件 | 重启 `dsh web` | 插件列表构成 boot graph；loader 的加载图在启动时定形，运行中新增的行不会被拾取 |
| 客户端 bundle `lib/client.js` | 重启 `dsh web` | 浏览器模块表按 specifier 缓存；出仓插件不在仓库 HMR（stat-poll + SSE）的监视范围内 |
| 宿主半边代码（`index.js`、`host/*.js`） | 重启 `dsh web` 最可靠 | Node 的 ESM 模块缓存与 loader 状态都指向旧代码；出仓目录没有 HMR |

两条由此推出的纪律：

- **反复刷新页面等不到新插件行**。新增了行就去重启，别在浏览器里赌运气；
- **改了客户端 bundle 就直接重启**。`lib/client.js` 换了内容但进程没重启时，页面拿到的
  可能还是旧模块表——你会在「代码明明改了却没变化」里浪费一下午。

另一个配置语义的坑：patch 层里用 `id` 覆写已有行的 `config` 时，`config` 是**整体替换**，
不做深合并。想改 `pricing` 里的一个键，就得把整个 `pricing` 写全（真实案例见
[`dsh-cost`](../../dsh-cost/README.md) 的配置说明）。

## 5. 什么时候该进配置

经验法则：**环境差异**（路径、时区、凭据引用、价格表）和**调参**（阈值、间隔、开关）进
`config`；业务逻辑不进。`dsh-cost` 是个好样本：`timeZone`、`provider`、`baseURL`、
`apiKeyEnv`、`currency`、`pricing` 全在插件行 `config` 里，宿主代码里没有一个环境判断。

凭据是特例：`config` 里只放**引用**（如 `apiKeyEnv: DEEPSEEK_API_KEY`），值通过
`ctx.credentials.resolve(ref)` 在运行时解析（[第 4 章 §5](04-host-api.md)）。永远不要把
密钥本体写进 `cordis.patch.yml`。

## 小结

- 出仓配置唯一通路：插件行 `config` → `apply(ctx, config)`，自己合默认值、当场校验抛错；
- live 的覆盖面 = 已有行的 config 改动；其余（新行、新文件、bundle、宿主代码）一律重启；
- `config` 覆写是整体替换；凭据只放引用。

下一章让 `dsh-stats` 干真活：读会话日志，通过已鉴权 API 把用量统计喂给浏览器。

## 延伸阅读

- 上游 `docs/user/develop/basic/config.md` —— 仓内的 Schemastery 配置玩法与热替换，
  了解两端差异后再看出仓取舍会更有感觉；
- 上游 `packages/boot/app-boot/src/profile.ts` 顶部注释 —— profile 与层叠组合的设计说明；
- [`dsh-cost/README.md`](../../dsh-cost/README.md) —— 一个真实插件的全量 `config` 参考。
