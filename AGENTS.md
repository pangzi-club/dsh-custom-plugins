# AGENTS.md

本仓库（`dsh-custom`）是 DeepSeek Harness（DSH）的**出仓插件工作区**：在这里新建和修改
DSH 插件，让它们通过 DSH 已发布的扩展点接入，**而不是去改上游源码**。本文件是给在本
工作区工作的 agent 的约束与操作手册。

## 1. 红线：不改 `deepseek-harness` 源码

上游 DSH checkout（本文用 `/path/to/deepseek-harness` 指代）对插件开发而言是**只读的**：

- 禁止编辑其中任何文件——包括 `packages/`、`apps/`、`apps/web/dist/` 等构建产物、以及
  仓库内的 profile/bundle 模板。不要为了让插件跑起来去 patch 核心、改前端 dist、或加
  "临时" 导出。
- 不要在其中新增文件（草稿、测试 fixture、临时脚本都属于新增文件）。
- 可以**读**它：查扩展点、查类型、查文档、跑 `pnpm dsh` 来启动 GUI。
- 允许写的是：本工作区的任何文件，以及 `$DSH_HOME` 下的 profile 配置
  （`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）——那是用户本地配置，不是上游源码。

**缺少扩展点时的正确做法**：先在既有 seam 里找（见 §5），确认确实无法实现后，停下来向
用户说明缺口和可选方案，由用户决定是否去上游提改动。禁止的替代方案包括：改核心、注入
DOM、篡改 `apps/web/dist`、或者 fork 一份仓库进来。

## 2. 什么时候在这里新建插件

- 需求是「给 Web GUI 加一块 UI / 一条数据接口 / 一个路由 / 一个工具」→ 优先做插件。
- 需求只影响本机一个人的使用 → 插件 + profile patch 挂载即可，不必进上游。
- 只有确认某个能力**必须**在核心内部才能实现时，才谈上游改动（且要用户拍板，不在本工作区
  范围内）。

## 3. 目录与命名约定

每个插件一个顶层目录，目录名与 `package.json` 的 `name` 一致，用 `dsh-` 前缀、kebab-case：

```
dsh-<feature>/
├── package.json          # 见下
├── index.js              # Host 半边入口（ESM）
├── host/                 # 可选：Host 侧纯函数，便于脱离 ctx 单测
├── src/client/index.tsx  # 可选：Web Client 半边源码（单文件）
├── lib/client.js         # 可选：客户端构建产物，提交进仓库
├── build.mjs             # 可选：用上游 tsc 构建 lib/client.js
├── cordis.patch.yml      # 可选：bundle 层，供 dsh plugin add 安装
├── test/*.test.mjs       # node --test
└── README.md             # 作用 / 原理 / 配置 / 启用 / 测试 / 已知限制
```

`package.json` 约定（参考现有两个插件）：

```json
{
  "name": "dsh-<feature>",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "client": { "platform": "web" },
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "scripts": { "test": "node --test test/*.test.mjs" },
  "private": true
}
```

- `dsh.client`（`platform: "web"`）声明客户端半边；`exports["./client"]` 指向构建产物。
  两者同时存在时，客户端 bundle 才会进 `/plugins` 的模块表。
- `dsh.bundle.patch` 声明 bundle 层，`dsh plugin add` 才会插入插件行。
- **不引入第三方依赖**：本工作区没有 `node_modules`、没有 lockfile；Host 代码与测试只用
  Node 内置模块。

## 4. 插件契约（Cordis）

一个插件就是一个导出 `apply` 的 ESM 模块：

```js
export const name = 'dsh-<feature>'

/** 消费的服务必须在 apply 前就绪 */
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  // 一切注册都走 ctx.*；用 ctx.effect 显式表达需要回收的资源
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/x', handler }),
    'dsh-<feature>: GET /x',
  )
}
```

- `inject` 是声明式依赖：框架会等服务就绪后再加载插件，不要在 `apply` 里轮询/判空绕开。
- 事件监听、工具、定时器等通过 `ctx` 注册的东西，插件卸载时会自动回收；需要显式清理的
  资源（连接、句柄）用 `ctx.effect(() => disposer, label)`。
- 配置从插件行的 `config` 传入 `apply(ctx, config)` 的第二个参数。出仓插件**不要**注册
  settings namespace（无法 import 仓库内的 schemastery）；配置一律走插件行 `config`。
- 顺手加上 `README.md`，并在根 `README.md` 的「插件一览」里登记一行。

## 5. 首选扩展点（不要发明 API）

改动前先查上游文档：`docs/capability-seams.md`（能力与 seam 地图）、
`docs/cookbook/extension-cookbook.md`（feature → mechanism 对照表）、
`docs/user/develop/basic/*`（第一个插件 / 配置 / 打包）、`docs/cordis-api/*`、
`docs/subsystems/client-modules.md`。

现有两个插件已经验证可在出仓环境下工作的 seam：

| 需求 | 扩展点 | 例子 |
| --- | --- | --- |
| 占一个 HTTP 路径 | `ctx.webServer.register({ kind, path, handler })`（exact 优先于 fallback 静态文件） | `dsh-favicon-triangle/index.js` |
| 提供已鉴权的前端 API | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` | `dsh-cost/index.js` |
| 读会话日志/事件 | `ctx.sessionQuery`、`ctx.on('session/event', …)` | `dsh-cost/index.js` |
| 读凭据 | `ctx.credentials.resolve(ref)` | `dsh-cost/index.js` |
| 往 Web UI 加界面 | 客户端 `inject: ['slots','locale']` + `ctx.slots.inject(seat, …)` / `ctx.locale.register(ns, …)` | `dsh-cost/src/client/index.tsx` |
| 加工具 / 拦截工具调用 | `ctx.tools.register()`、`ctx.on('tools/pre-execute' \| 'tools/post-execute', …)` | `docs/cookbook/extension-cookbook.md` |

要点：

- 能用 exact 路由 / 增量插槽 / 事件监听解决的，就不要碰核心。
- 「扩展点不够就绕过」不是选项；见 §1。
- Host 半边**不能** `import '@deepseek-ai/dsh-*'`（本工作区没有 node_modules，Node 解析不到）。
  客户端半边的裸包名由浏览器模块表解析，因此只能用基线模块（React、react-dom、
  `@deepseek-ai/dsh-client-ui-primitives`）。

## 6. 两条接入路径与生效语义

**A. 本地挂载（开发默认）**：在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的顶层数组里
`insert` 一行，`name` 写插件入口的**绝对路径**（相对路径不生效——patch 不改变 loader 的
解析目录）：

```yaml
- insert:
    - id: my-feature
      name: '/path/to/dsh-custom/dsh-my-feature/index.js'
```

**B. 可分发 bundle**：声明 `dsh.bundle` + `cordis.patch.yml`（行里 `name` 写**包名**），
然后用 `pnpm dsh plugin --profile web add <插件目录>` 安装。

生效语义（`web` profile 是 `patchReload: live`，但 live 不等于万能）：

| 改了什么 | 生效方式 |
| --- | --- |
| 已有插件行的 `config` | 重新组合，刷新页面 |
| 新增插件行 / 插件引用了新文件 | 重启 `dsh web` + 刷新页面（boot graph 变了） |
| `lib/client.js`（客户端 bundle） | 重启 `dsh web` + 刷新页面（模块表按 specifier 缓存，出仓插件不在 HMR 监视范围内） |

启动 GUI：在上游 checkout 里 `pnpm dsh web`，打开 <http://127.0.0.1:3080>。**若 GUI 已在
运行，刷新它即可，不要另起服务器。**

## 7. 客户端半边（Web Client）构建

- `src/client/index.tsx` 必须**单文件、无相对 import**：只有 `lib/client.js` 一个资源会被
  `/plugins` 服务，`require` 由浏览器模块表回答。
- 构建用上游 checkout 的 `tsc`，把编译结果包进 `window.__ModuleLoader__.load({ id, factory })`
  信封：照抄 `dsh-cost/build.mjs` 与 `dsh-cost/tsconfig.build.json`。
- checkout 路径是**机器本地配置**：从环境变量 `DSH_REPO` 或 git-ignored 的
  `dsh-cost/.dsh-repo` 解析；代码、文档、注释里都不要写个人绝对路径，缺失时要给出可操作的
  报错（而不是晦涩的 `undefined` 崩溃）。
- `lib/client.js` **提交进仓库**，这样用户不需要构建即可使用；只在改了 `src/client/` 后才
  需要重新 `node build.mjs`。
- 定位/关闭等交互优先复用 `@deepseek-ai/dsh-client-ui-primitives` 的 hook
  （`useAnchoredPosition`、`useDismissOnOutsidePointer`），保持一致体验。

## 8. 测试

- 用 `node --test`（`npm test`），零依赖、不打真实网络、不依赖 GUI 或已启动的 DSH。
- 把可测逻辑抽成 `host/` 下的纯函数；`ctx` 相关的编排用最小 mock（route handler 用
  mock `req`/`res`，见 `dsh-cost/test/routes.test.mjs`）。
- 客户端 bundle 的结构（信封、导出、无相对 import）也要有测试，见
  `dsh-cost/test/bundle.test.mjs`。
- 改动后两个插件目录的测试都要绿：`dsh-cost` 40 项、`dsh-favicon-triangle` 6 项。

## 9. 完成标准（Definition of Done）

1. `npm test` 在改动涉及的插件目录内全绿；未涉及的不回归。
2. 改了客户端源码 → 跑过 `node build.mjs`，`lib/client.js` 同步更新。
3. 在 <http://127.0.0.1:3080> 上**实际验证**（必要时重启 `dsh web` 并刷新）；不要用另一个
   端口的服务器冒充验证。
4. 确认**没有**对上游 checkout 引入任何改动（例如 `git -C /path/to/deepseek-harness status --short`，
   以及 `git -C <本工作区> status --short` 看自己改了什么）。
5. 新插件：补 `README.md` + 根 `README.md` 一览行；行为/配置/限制写清楚，不要只留代码。

## 10. 已知坑

- **出仓插件没有 HMR**：仓库内的 HMR 只监视仓库自身。改了 Host 代码通常要靠 live 重载，
  改了客户端 bundle 必须重启 `dsh web`。
- **新增行不是热插拔**：boot graph 变化需要重启进程，别反复刷新页面等它生效。
- **相对路径不解析**：profile patch 里的 `name` 必须绝对路径；bundle 行才用包名。
- **浏览器缓存**：favicon 之类被浏览器缓存的资源要给 `no-cache, must-revalidate`，验证时
  先强制刷新。
- **`conversation.composer.dock` 是纵向 flex 列**：新增条目只能成为统计行的另一行，无法
  紧贴已有的 token pill；想做到只能改核心（即不做）。
- **计费/余额口径**：`dsh-cost` 的费用是逐样本估算，不是平台账单；余额只支持 DeepSeek
  官方 `/user/balance`。这类口径差异必须写进插件 README 的「已知限制」。
- **DSH 公开 API 是 pre-stable**：升级后扩展点可能变；修法是在本工作区调整插件，不是改上游。
