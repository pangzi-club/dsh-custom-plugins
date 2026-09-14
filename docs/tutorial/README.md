# DSH 出仓插件教程

一套**由浅入深**的 DeepSeek Harness（DSH）插件开发教程，教你在一个**独立于 DSH 源码仓**
的工作区里开发、挂载、测试并分发插件——也就是本仓库（`dsh-custom`）自己的开发方式。

## 这套教程是什么、不是什么

上游自带一条入门轨道（DSH checkout 内 `docs/user/develop/basic/`），但它默认**仓内开发**：
在仓库根建 scratch 目录、用 `--patch` 覆盖启动、随手可用仓库的类型与 DSL。本教程补的是
另一半世界——**出仓开发**：

- 插件住在独立目录（就像本仓库的 `dsh-cost/`、`dsh-favicon-triangle/`），上游 checkout
  对你**只读**；
- 宿主半边是零依赖的纯 ESM JavaScript（工作区没有 `node_modules`）；
- 客户端半边有自己的构建链（上游 `tsc` + ModuleLoader 信封）；
- 挂载走 profile 的 `cordis.patch.yml`（绝对路径）或 `dsh plugin add`（bundle）。

两条路线不冲突：上游轨道讲框架概念更系统，本教程讲出仓工程更落地。建议先过本教程第 1
章，需要深挖框架时再回上游轨道。

## 前置条件

- 一个可运行的 DSH 源码 checkout（教程用 `/path/to/deepseek-harness` 指代），已完成
  `pnpm install`；
- Node `^22.19 || >=24`；
- `$DSH_HOME`（默认 `~/.dsh`）下有 `web` profile（首次 `pnpm dsh web` 后自动生成）；
- 会用 `curl` 和浏览器 DevTools。

## 贯穿示例：`dsh-stats`

教程不搞碎片例子，而是带你从零手写**一个**插件 `dsh-stats`（会话用量统计），逐章生长：
第 2 章它是 30 行的心跳路由，到第 8 章收官时已是一个带已鉴权 API、Web 界面、模型工具、
测试与安装包的双半边插件——**结构上就是本仓库 `dsh-cost` 的精简版**。每章的代码清单都
可直接照抄，两个真实插件随时可对照成品。

```
01 心智模型 ─→ 02 心跳路由 ─→ 03 配置 ─→ 04 会话 API ─→ 05 客户端界面
                                                        ─→ 06 工具与事件
                                                        ─→ 07 测试 ─→ 08 打包分发
```

## 章节导航

| 章节 | 内容 | 涉及扩展点 | 难度 |
| --- | --- | --- | --- |
| [01 · 心智模型](01-mental-model.md) | 微内核与 Cordis 契约；出仓 vs 仓内；加载链路与生效语义 | — | ★ |
| [02 · 第一个插件](02-first-plugin.md) | `dsh-stats` v1：exact 路由、挂载、验证、最小测试 | `webServer` | ★ |
| [03 · 配置与生效](03-config-reload.md) | 插件行 config、fail-loudly 校验、live 重载的边界 | — | ★ |
| [04 · 已鉴权 API 与会话数据](04-host-api.md) | v2：`connection.fetch` 路由、`sessionQuery` 折叠、缓存失效、凭据 | `connection.fetch`、`sessionQuery`、`session/event`、`credentials` | ★★ |
| [05 · Web 客户端半边](05-web-client.md) | v3：slots/locale、单文件 TSX、构建链与 ModuleLoader 信封 | 客户端 `slots`、`locale` | ★★★ |
| [06 · 工具与事件](06-tools-events.md) | v4：裸 ToolDefinition、`tools/pre-execute` 瀑布 | `tools`、`tools/*` | ★★ |
| [07 · 测试](07-testing.md) | 零依赖三层金字塔：纯函数 / fakeCtx 编排 / vm bundle | — | ★★ |
| [08 · 打包与分发](08-packaging.md) | v5：bundle 三件套、`dsh plugin add`、发布到 npm | `dsh.bundle` | ★★ |
| [09 · 附录：速查表](09-reference.md) | seam / 席位 / 生效语义 / 坑 / 上游文档地图 | 全部 | 查阅 |

扩展点的**验证状态**贯穿全教程：`webServer`、`connection.fetch`、`sessionQuery`、
`credentials`、`slots`、`locale` 已被本仓库两个真实插件验证；`tools` 一章依据上游文档
（章内有醒目声明）。

## 约定

- 每章结构固定：概念 → 动手（完整代码）→ 挂载与验证 → 坑 → 小结与延伸阅读；
- 「验证」指在 <http://127.0.0.1:3080> 的真实 GUI 上确认，不用别的端口冒充；
- 工作区纪律以 [`AGENTS.md`](../../AGENTS.md) 为准：上游 checkout 只读、零第三方依赖、
  新插件登记进根 [README](../../README.md)。

## 反馈

发现教程与实际行为不符（DSH 的公开 API 还是 pre-stable，升级后扩展点可能变化），按
`AGENTS.md` 的精神处理：在本仓库修教程或示例，不改上游。
