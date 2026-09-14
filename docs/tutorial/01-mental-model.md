# 01 · 心智模型：DSH 如何加载你的插件

[上一章（导读）](README.md) · [下一章：第一个插件](02-first-plugin.md)

本章不写代码。先建立四个心智模型，后面每一章都建立在它们之上：

1. DSH 是微内核，**一切能力都是插件注册出来的**；
2. 插件契约只有四个词：`name`、`inject`、`apply`、`ctx.effect`；
3. 「出仓开发」与上游文档默认的「仓内开发」差在哪里，为什么差；
4. 一个插件行从写进 `cordis.patch.yml` 到跑起来，中间发生了什么。

## 1. 一切皆插件

DeepSeek Harness（DSH）的宿主只提供一个小内核：插件加载器（Cordis loader）、事件总线、服务注册表。
Web GUI、工具系统、会话存储、凭据管理……全部是以插件形式挂上来的服务，插件之间通过
`ctx.*` 上的服务与事件协作。上游有一张「feature → mechanism」对照表，主张是：

> 每个产品特性都映射到某个已文档化扩展点上的一个监听者。

（见上游 checkout 内 `docs/cookbook/extension-cookbook.md`；哪根 `ctx.*` 是可替换 seam、
哪根是核心脊柱，见 `docs/capability-seams.md`。）

对你的直接意义：**给 DSH 加能力 = 写一个插件，在某个扩展点上注册点什么**。
本教程会覆盖其中最常用的几根：

| 想做什么 | 扩展点 |
| --- | --- |
| 占一个 HTTP 路径（favicon、自有页面） | `ctx.webServer.register()` |
| 提供浏览器可调用的已鉴权 API | `ctx.connection.fetch.register()` |
| 读会话事件日志 | `ctx.sessionQuery`、`ctx.on('session/event', …)` |
| 读凭据（API Key 等） | `ctx.credentials.resolve(ref)` |
| 往 Web UI 加一块界面 | 客户端 `ctx.slots.inject()` + `ctx.locale.register()` |
| 加工具 / 拦截工具调用 | `ctx.tools.register()`、`ctx.on('tools/pre-execute', …)` |

## 2. 插件契约：四个词

一个插件就是一个 ESM 模块，导出一个 `apply` 函数。框架加载插件时调用 `apply`，把上下文
`ctx` 传进来，你在 `ctx` 上注册一切：

```js
/** 插件名：日志、错误信息、plugin 行 id 里都会出现，保持稳定。 */
export const name = 'my-plugin'

/** 声明消费的服务：框架会等这些服务全部就绪后才加载本插件。 */
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  // 一切注册都走 ctx.*；拿到的返回值是「注销函数」。
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/x', handler }),
    'my-plugin: GET /x',   // effect 标签，卸载日志里可读
  )
}
```

四个词各自的含义：

- **`name`**：插件的稳定标识。命名习惯带 `dsh-` 前缀（如 `dsh-cost`）。
- **`inject`**：声明式依赖。框架会等 `inject` 里列的服务全部就绪后才调用 `apply`，
  所以 `apply` 里可以直接用 `ctx.webServer`，**不要**在 `apply` 里轮询或判空绕开。
- **`apply(ctx, config)`**：注册逻辑写在这里。第二个参数 `config` 来自插件行（[第 3 章](03-config-reload.md)）。
- **`ctx.effect(fn, label)`**：显式生命周期。`fn` 的返回值是清理函数，插件卸载时被调用。
  通过 `ctx.*` 注册的事件监听、工具、定时器会**自动回收**；只有需要显式释放的资源
  （路由、连接、句柄）才必须写 `ctx.effect`。判断标准很简单：注册函数**返回了注销函数**，
  就把它包进 `ctx.effect`。

除了函数形态，Cordis 还接受对象形态与 `Service` 子类形态（见上游
`docs/user/develop/basic/index.md`）。出仓插件用函数形态就够了——`Service` 子类用于
「向别的插件提供服务」，那是进阶场景（上游 `docs/user/develop/framework/service.md`）。

## 3. 「出仓」意味着什么

上游的入门教程（`docs/user/develop/basic/`）默认你在**仓库 checkout 内**开发：在仓库根建
`scratch-plugin/`，用 `pnpm dsh web --patch ./scratch-plugin/cordis.yml` 启动。这很好，但它把
两条路混在了一起：你的代码和 DSH 源码住在同一个目录树里，随手就可能改到上游文件。

本教程走**出仓**路线：插件住在独立工作区（就像本仓库 `dsh-custom`），通过 profile 挂进
DSH，上游 checkout 对你只读。两条路线的差异：

| | 仓内开发（上游教程） | 出仓开发（本教程） |
| --- | --- | --- |
| 插件住哪 | 仓库内 `scratch-plugin/` | 独立目录，如 `~/code/dsh-custom/dsh-my-plugin/` |
| 语言 | TypeScript，可用仓库类型 | 宿主半边用纯 ESM JavaScript |
| 可 import 什么 | `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 等仓库包 | **只用 Node 内置模块**（`node:fs` 等） |
| 启动方式 | `pnpm dsh web --patch <patch>` | 正常 `pnpm dsh web`，插件在 profile patch 里 |
| 升级 DSH | 你的 scratch 目录混在仓库里 | 插件目录不动，只对接已发布扩展点 |

「宿主半边只能用 Node 内置模块」不是风格偏好，是机制约束：插件以**绝对路径**被 loader
加载，Node 解析裸包名（如 `@deepseek-ai/dsh-tools`）时从插件文件所在目录逐级向上找
`node_modules`——你的工作区没有（也不该有）装着 DSH 依赖的 `node_modules`，所以解析必然
失败。消费 DSH 能力的唯一途径是 `inject` + `ctx.*`；宿主代码里需要的工具函数自己写进
`host/` 目录。这条约束的好处：你的插件对 DSH 版本的要求面最小，也不会意外依赖进内部实现。

> 客户端半边（[第 5 章](05-web-client.md)）是另一套规则：浏览器里的裸包名由 loader 的
> 模块表解析，可以用 React 等基线模块。

## 4. 一个插件行是怎么跑起来的

启动 `dsh web` 时，DSH 从 **profile** 读组装指令。profile 是 `$DSH_HOME/profiles/<名字>`
下的一个目录（`$DSH_HOME` 默认 `~/.dsh`；Web GUI 用 `web` profile），里面有三个关键文件：

```
$DSH_HOME/profiles/web/
├── package.json         # dsh.profile.bundles：bundle 层列表（dsh-base、dsh-web-app…）
│                        # dsh.profile.patchReload: live —— patch 文件改动是否热重载
├── cordis.patch.yml     # 你的 patch 层：本教程所有插件行都写在这里
└── pnpm-workspace.yaml  # bundle 安装（第 8 章）用的 pnpm 工作区
```

启动时的**层叠顺序**（后者覆盖前者）：

```
各 bundle 自带的 cordis.patch.yml（按 bundles 列表顺序）
  → profile 的 cordis.patch.yml        ← 出仓插件挂在这里
    → $DSH_HOME/cordis.patch.yml       （home 层，可选）
      → 命令行 --patch 覆盖             （上游教程用的入口）
```

每层都是同一套 **patch 语法**。你最常用的是 `insert`：

```yaml
- insert:
    - id: my-feature
      name: '/Users/you/code/dsh-custom/dsh-my-plugin/index.js'
      config:
        someOption: value
```

- `insert` 不带 `id` 时，把行追加到插件列表**顶层**——新增一个插件；
- 同一个 YAML 列表里，后面的 patch 可以用 `id` 定位前面插入的行并覆写字段
  （`config` 是**整体替换**，不做深合并）；
- `id` 对不上已有行时只会告警并跳过，不会报错。

**`name` 必须写绝对路径**：patch 文件只贡献配置，**不改变 loader 的模块解析目录**。写相对
路径时 loader 仍会相对 profile 目录解析，你的插件就找不到——这是新手最常见的「插上了没
反应」的原因。

loader 把所有层组合成最终的插件行列表，逐个加载（`inject` 依赖就绪才 `apply`），任何一个
插件 import 失败或 `apply` 抛错都会**响亮地**终止启动并带出原始堆栈——这是特性不是缺陷，
配置错了就要在启动日志里看见。

## 5. 「生效」的语义：先记结论

`web` profile 声明了 `patchReload: live`：DSH 会监视你的 patch 文件，改动后自动重新组合。
但「live」不等于万能，先记住这张表（原理与实验在[第 3 章](03-config-reload.md)）：

| 改了什么 | 生效方式 |
| --- | --- |
| 已有插件行的 `config` | 自动重新组合，**刷新页面**即可 |
| 新增/删除插件行，或插件引用了新文件 | **重启 `dsh web`** + 刷新页面（boot graph 变了） |
| 客户端 bundle `lib/client.js` | **重启 `dsh web`** + 刷新页面（模块表按 specifier 缓存） |
| 宿主半边代码（`index.js`、`host/*.js`） | **重启 `dsh web`** 最可靠（出仓插件不在仓库 HMR 监视范围内） |

## 6. 上手看一眼

在写任何插件之前，先确认三件事。以下命令在上游 checkout 里执行（本文用
`/path/to/deepseek-harness` 指代你的 checkout 路径）：

```sh
# 1. 看看你的 profile 长什么样（首次启动 dsh web 后会自动生成）
cat ~/.dsh/profiles/web/package.json
cat ~/.dsh/profiles/web/cordis.patch.yml

# 2. 启动 Web GUI（若已在运行，刷新页面即可，不要另起服务器）
cd /path/to/deepseek-harness
pnpm dsh web
# 打开 http://127.0.0.1:3080

# 3. 验证你手上的 profile 是哪个：终端启动日志会打印 profile 名与插件加载记录
```

如果 `cordis.patch.yml` 里已经有人挂过插件（比如本工作区的两个），对照 §4 的语法读一遍，
确认每行的 `id`、`name`（绝对路径）、`config` 三个字段你都能说出含义。

## 小结

- DSH 是微内核，加能力 = 在扩展点上注册；
- 契约四词：`name` / `inject` / `apply` / `ctx.effect`，注册返回注销函数就包 effect；
- 出仓开发：宿主半边零第三方依赖，一切经 `ctx.*`；
- 插件行写进 profile 的 `cordis.patch.yml`，`name` 必须绝对路径；
- 生效语义四行表，先背下来。

下一章写第一个插件：一个占住 `/dsh-stats/ping` 路由的 30 行宿主半边。

## 延伸阅读

- 上游 `docs/cordis-primer.md` —— Cordis 五个核心观念（事件分派模式、waterfall 语义）；
- 上游 `docs/cordis-api/fiber.md` —— `ctx.effect` 与插件生命周期的精确语义；
- 上游 `docs/user/develop/framework/index.md` —— 插件状态机（加载/卸载/HMR 循环）；
- 本仓库 [`AGENTS.md`](../../AGENTS.md) —— 出仓工作区的完整约定（红线、目录结构、DoD）。
