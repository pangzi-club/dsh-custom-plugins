# 09 · 附录：出仓插件速查表

[上一章](08-packaging.md) · [返回导读](README.md)

正文讲过的东西这里压成表格，供写插件时随手查。「验证状态」一列的含义：

- **已验证**：本工作区的真实插件（`dsh-cost`、`dsh-favicon-triangle`）正在使用；
- **文档背书**：上游文档与实现支持，本工作区尚未实测（照抄时以上游文档为准）。

## 1. 宿主半边 seam 速查

| 需求 | 扩展点 | 签名要点 | 验证状态 |
| --- | --- | --- | --- |
| 占一个 HTTP 路径 | `ctx.webServer.register` | `{ kind: 'exact'\|'prefix', path, handler(req, res) }`，返回注销函数；重复 `(kind, path)` 抛错；fallback 单席位勿碰 | 已验证 |
| 前端数据 API | `ctx.connection.fetch.register` | `{ path(/api 之下), methods, requestBody: 'buffered'\|'streaming', fetch(request) => Response }`；框架鉴权 | 已验证 |
| 读会话日志 | `ctx.sessionQuery.readSession` | `=> { events, inheritedEventCount, … }`；另有 trace/搜索/谱系 | 已验证 |
| 响应日志增量 | `ctx.on('session/event', …)` | `(session, event)` 落盘后广播；`event.type` 如 `assistant/message` | 已验证 |
| 读凭据 | `ctx.credentials.resolve(ref)` | 可选依赖用 `ctx.get('credentials')`；配置里只放引用 | 已验证 |
| 注册工具 | `ctx.tools.register` | 裸 `ToolDefinition`（见下）；`run_code` 保留名 | 文档背书 |
| 工具策略 | `ctx.on('tools/pre-execute', …)` | waterfall：`{kind:'allow'} \| {kind:'deny',reason} \| {kind:'ask',reason?}`；不裁决就 `next()` | 文档背书 |
| 结果处理 | `ctx.on('tools/post-execute', …)` | accept / 替换 / 追加上下文 / block | 文档背书 |
| 只读观察 | `ctx.on('tools/result', …)` | emit 模式，失败被包容 | 文档背书 |

裸 `ToolDefinition` 最小形状（出仓没有 `defineTool` DSL，**参数自己校验**）：

```js
{
  name: 'my_tool',
  description: '…模型可见…',
  parameters: { type: 'object', properties: { … }, required: […] },
  output: {
    schema: { type: 'object' },                       // 规范值的 JSON Schema
    render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) { /* 校验 args → 返回规范值；透传 exec.signal */ },
}
```

## 2. 客户端半边速查

**基线模块表**（裸 import 仅此 9 项，权威来源：上游 `packages/client/web/src/platform.ts`）：

```
react · react/jsx-runtime · react-dom · react-dom/client ·
@deepseek-ai/cordis · @deepseek-ai/dsh-client-store ·
@deepseek-ai/dsh-client-ui-slots · @deepseek-ai/dsh-client-ui-primitives ·
@deepseek-ai/dsh-client-ui-dockkit
```

**契约**：`inject: ['slots', 'locale']`；`ctx.locale.register(ns, { zh, en })`（键集合必须
一致）注册词表；`ctx.slots.inject(seat, () => ctx.slots.register({ name, id, order, locale },
Component))` 向席位贡献组件（自带回收，不包 `ctx.effect`；`locale.register` 返回注销函数，
要包）。

**常用席位**（完整目录与基数见上游 `docs/subsystems/slots.md` 的席位树）：

| 席位 | 基数/作用域 | 用途 |
| --- | --- | --- |
| `conversation.composer.dock` | list / session | 输入框统计行下方加条目（本教程与 `dsh-cost` 所用） |
| `conversation.chat.node` | keyed | 自定义聊天业务行的渲染器 |
| `tool.call.toolview` | keyed | 自定义工具卡片的渲染 |
| `sidebar.*` / `main` / `settings.*` | — | 侧栏、主区、设置页的挂点 |

**构建链**：单文件 TSX（无相对 import）→ 上游 `tsc`（`tsconfig.build.json` +
`src/shims.d.ts`）→ `build.mjs` 包进 `window.__ModuleLoader__.load({ id, factory })` 信封 →
提交 `lib/client.js`。`package.json` 需 `dsh.client: { platform: 'web' }` 与
`exports["./client"]` **双声明**。

**样式**：只用 DSH CSS 变量（`--dsw-alias-*`、`--dsh-chat-content-width`、
`--dsw-elevation-prominent` 等），不写死颜色；`ensureStyle()` 一次性注入
`<style data-plugin-css="…">`。定位/关闭优先复用 `ui-primitives` 的
`useAnchoredPosition` / `useDismissOnOutsidePointer`。

## 3. 生效语义速查

`web` profile 为 `patchReload: live`。改完东西对号入座：

| 改了什么 | 生效方式 |
| --- | --- |
| 已有插件行 `config` | 保存 → 刷新页面 |
| 新增/删除插件行、插件引用新文件 | 重启 `dsh web` + 刷新 |
| `lib/client.js` | 重启 `dsh web` + 刷新（强刷排除缓存） |
| 宿主代码（`index.js`、`host/*.js`） | 重启 `dsh web` 最可靠 |
| bundle 列表（`dsh plugin add/remove`） | 重启 `dsh web` |

## 4. 坑清单

按「踩中后的症状」组织：

- **插件挂上没反应** → patch 行 `name` 写了相对路径（必须绝对路径）；或没重启（新行不是
  热插拔）；或连了别的端口（`web` profile 在 3080）。
- **改了客户端 bundle 却没变化** → 没重启 `dsh web`（模块表按 specifier 缓存）；或浏览器
  缓存（强刷，macOS Chrome `Cmd+Shift+R`）。
- **被缓存的旧资源骚扰** → 动态资源给 `no-store`；会被缓存的资源（favicon 类）给
  `no-cache, must-revalidate`，验证时先强刷。
- **配置改了没生效** → `config` 覆写是**整体替换**不深合并，想改一个键要写全整块。
- **`turn/*` 监听不工作** → 那是 `session/event` 的类型不是 Cordis 事件，监听
  `ctx.on('session/event', (s, e) => e.type === 'turn/end' && …)`。
- **API 返回没见过的空体 400** → webServer 对任何 handler 异常的最后兜底就是**空体 400**
  （不是 500）；真实的堆栈在 `dsh web` 终端日志里（warning 一条），先去看日志再改代码。
- **插件加载失败 `already has an entry with id …`** → list 席位的条目 `id` 是席位内唯一键，
  撞了内建条目或其它插件；换成唯一 id（直接用插件名最稳）。
- **胶囊挤不进统计行** → `conversation.composer.dock` 是纵向 flex 列，新条目只能是另一行；
  这是核心布局，出仓插件改不了，写进 README 已知限制。
- **面板开着但内建胶囊没收回** → 互斥状态归壳所有，插件间无协调点；已知限制。
- **上游升级后插件坏了** → DSH 公开 API 是 pre-stable；修法是在本工作区调整插件对接新
  扩展点，**永远不是**改上游源码、patch 核心、注入 DOM 或篡改前端 dist。

## 5. 上游文档地图

按「想做什么」索引（都在 DSH checkout 的 `docs/` 下；中文对照版为同名 `.zh.md`）：

| 想做什么 | 看哪篇 |
| --- | --- |
| 系统性学插件框架 | `cordis-tutorial/`（7 章无 key 实操）、`cordis-primer.md` |
| 第一个插件 / 工具 / 配置 / 打包（仓内视角） | `user/develop/basic/{index,tool,config,publish}.md` |
| 插件生命周期 / 事件 / 服务 | `user/develop/framework/{index,events,service}.md` |
| 哪根 `ctx.*` 是 seam、谁是实现方 | `capability-seams.md` |
| 特性 → 机制的对照与示例 | `cookbook/extension-cookbook.md` |
| 写一个工具（权威契约） | `cookbook/adding-a-tool.md` |
| `ctx.*` 核心 API（effect/fiber/registry/service） | `cordis-api/*.md` |
| webServer / 客户端模块 / 插槽 / 工具 / 凭据 / 会话查询 | `subsystems/{web-server,client-modules,slots,tools,credentials,session-query}.md` |
| Web UI 样式规范 | `web-styling.md` |
| 仓库测试策略 | `testing.md` |

## 6. 一句话提醒

出仓开发的全部纪律可以压成三句：**上游只读**；**扩展点不够时停下来问，而不是绕过去**；
**升级后坏了的修在你这边**。
