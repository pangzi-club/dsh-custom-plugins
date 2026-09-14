# dsh-custom

DeepSeek Harness（DSH）的**出仓插件工作区**：这里以独立目录开发和维护 DSH 插件，
**不修改上游 `deepseek-harness` 仓库的任何文件**。每个插件只通过 DSH 已发布的扩展点
（`webServer` 路由、`connection.fetch` 已鉴权路由、Web Client 插槽等）接入，因此可以
单独启用、单独关闭，升级 DSH 时不需要给仓库打补丁。开发约定见 [`AGENTS.md`](AGENTS.md)。想动手写插件，从
[`docs/tutorial/`](docs/tutorial/README.md) 的由浅入深教程开始。

## 插件一览

| 目录 | 插件名 | 作用 | 插件形态 |
| --- | --- | --- | --- |
| [`dsh-favicon-triangle/`](dsh-favicon-triangle/README.md) | `favicon-triangle` | 把 Web GUI 的浏览器标签页图标（以及「安装为应用」后的图标）换成三角形，随浅色/深色配色自动反色 | Host 单半边（`webServer` exact 路由） |
| [`dsh-cost/`](dsh-cost/README.md) | `dsh-cost` | 在 Web GUI 输入框统计行下方加一个「对话费用」胶囊：点击展开面板，显示本次会话费用（按模型、按 token 桶、按高峰/空闲分档）与 DeepSeek 账户余额 | Host 半边（两条 `connection.fetch` 路由）+ Web Client 半边（`conversation.composer.dock` 插槽） |

各插件的实现原理、全部配置项、构建方式与已知限制，见各自目录下的 README。

## 目录结构

```
dsh-custom/
├── README.md                    # 本文件：插件清单与使用方式
├── AGENTS.md                    # 在本工作区新建/修改插件的约定（含「不改上游源码」红线）
├── docs/tutorial/               # 由浅入深的出仓插件开发教程
├── dsh-favicon-triangle/        # 插件：三角形 favicon
│   ├── index.js                 # Host 入口：注册 GET/HEAD /favicon.svg
│   ├── cordis.patch.yml         # bundle 层：供 dsh plugin add 安装
│   └── test/index.test.js
└── dsh-cost/                    # 插件：对话费用胶囊
    ├── index.js                 # Host 入口：/api/dsh-cost/session 与 /api/dsh-cost/balance
    ├── host/                    # Host 侧纯函数（计价、折叠用量、余额请求）
    ├── src/client/index.tsx     # Web Client 入口（TypeScript + React）
    ├── lib/client.js            # 构建产物：被 /plugins 服务的客户端 bundle（已提交）
    ├── build.mjs                # 用上游 checkout 的 tsc 重新构建 lib/client.js
    └── test/*.test.mjs
```

## 环境前提

- 一个可运行的 DSH 源码 checkout（本文用 `/path/to/deepseek-harness` 指代）。
  `dsh-cost/build.mjs` 用该 checkout 的 `tsc`，路径从环境变量 `DSH_REPO` 或 git-ignored 的
  `dsh-cost/.dsh-repo` 解析。
- Node `^22.19 || >=24`；在上游 checkout 里执行 `pnpm install`。
- `$DSH_HOME`（默认 `~/.dsh`）下存在 `web` profile；profile 的 `package.json` 声明
  `patchReload: live`，并在 `cordis.patch.yml` 里挂上插件。

## 如何使用

### 1. 启动 Web GUI

若 `dsh` 未加入 PATH，可在 DSH checkout 目录内以源码方式运行：

```sh
cd /path/to/deepseek-harness
pnpm dsh web            # 已全局安装 dsh 时可直接用 `dsh web`
```

打开 <http://127.0.0.1:3080>。若 GUI 已在运行，直接刷新页面即可，**不要另起一个服务器**。

### 2. 启用插件

插件有两种接入方式，任选其一（两种方式可以混用）。

**方式 A：把本地目录挂进 profile patch（开发用，本机当前采用）**

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，在顶层数组里插入插件行，`name` 用
插件入口的**绝对路径**：

```yaml
- insert:
    - id: favicon-triangle
      name: '/path/to/dsh-custom/dsh-favicon-triangle/index.js'
    - id: cost
      name: '/path/to/dsh-custom/dsh-cost/index.js'
      config:
        timeZone: Asia/Shanghai
        provider: deepseek
```

`web` profile 是 `patchReload: live`，但 patch 改动是否立即生效取决于改了什么：

- **只改已有插件的 config**：重新组合即可，刷新页面生效。
- **新增插件行、或插件引用了新文件**：boot graph 变了，需要**重启 `dsh web`** 并刷新页面。
- **改了 `dsh-cost` 的 `lib/client.js`**：模块注册表按 specifier 缓存，需要**重启
  `dsh web`** 再刷新页面（本插件不在仓库 HMR 监视范围内）。

**方式 B：作为可分发 bundle 安装**

`dsh-favicon-triangle` 声明了 `dsh.bundle`，可以直接安装：

```sh
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-custom/dsh-favicon-triangle
pnpm dsh --profile web --dump-config     # 可见 "# == dsh-favicon-triangle" 层
```

`dsh-cost` 目前只声明了 `dsh.client`（客户端半边），没有 `dsh.bundle`，因此用方式 A
按绝对路径加载；若要长期分发它，需要补一个 `cordis.patch.yml` bundle 层（见 `AGENTS.md`）。

### 3. 验证

- **favicon**：刷新页面后标签页图标应为三角形；强制刷新（macOS Chrome `Cmd+Shift+R`）
  可排除旧图标缓存。
- **费用胶囊**：输入框统计行下方出现费用胶囊；点击展开，应能看到按模型分组的 token 与
  金额，以及 DeepSeek 账户余额。失败原因会显示在面板里（缺 key、401、网络失败等）。

### 4. 关闭

- 方式 A：从 `$DSH_HOME/profiles/web/cordis.patch.yml` 删除对应插件行，重启/刷新后
  该插件的路由与 UI 一起消失。
- 方式 B：`pnpm dsh plugin --profile web remove dsh-favicon-triangle`。

## 开发与测试

每个插件目录都可独立测试：

```sh
cd dsh-favicon-triangle && npm test    # node --test，6 项
cd dsh-cost && npm test                # node --test，40 项
```

修改 `dsh-cost/src/client/index.tsx` 后需要重建客户端 bundle（`lib/client.js` 已提交，
仅改 Host 半边时不必重建）：

```sh
cd dsh-cost
echo /path/to/deepseek-harness > .dsh-repo          # 一次性：写入本地 checkout 路径（git-ignored）
node build.mjs                                      # 用 DSH_REPO / .dsh-repo 解析 checkout
DSH_REPO=/path/to/deepseek-harness node build.mjs   # 也可以按次覆盖
```

客户端 bundle 只有 `lib/client.js` 一个资源会被 `/plugins` 服务，因此
`src/client/index.tsx` 必须保持单文件、无相对 import（裸包名由 loader 的模块表解析，
React、react-dom、`@deepseek-ai/dsh-client-ui-primitives` 都是基线模块）。

## 与上游仓库的关系

- 本工作区不改动 `deepseek-harness` 里的任何文件（包括前端构建产物），插件所需的接入点
  都来自已发布的服务与扩展点。
- DSH 的公开 API 目前仍是 pre-stable：升级 DSH 后若某个扩展点发生变化，应在本工作区内
  调整插件，而不是去改上游源码。
- 新增插件、命名、接入方式、测试与验证要求，见 [`AGENTS.md`](AGENTS.md)。
