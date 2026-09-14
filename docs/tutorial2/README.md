# DSH 出仓插件教程 · 第二辑（进阶）

第一辑（[`docs/tutorial/`](../tutorial/README.md)）教你把一个出仓插件的基本形态做出来：
路由、已鉴权 API、客户端界面、工具、测试、打包。这一辑往**深处**走——事件管线与更深的
客户端：

- **工具与事件实战**：权限门（allow/deny/ask）、结果变换（替换/阻断）、调用包裹与计时、
  自定义工具的呈现；
- **LLM 调用观测**：包住每一次模型调用的 `llm/stream`、实时 token 流、模型配置快照——
  **只观测、不改行为**；
- **客户端 UI 进阶**：`useResource` live 数据通道替代手写轮询、`Menu`/`Toast`/`Modal`
  组件化弹层、keyed 座位给自定义工具做会话内卡片、三层主题 token。

## 前置条件

- **完成第一辑**（或等价能力）：你已经能独立做出一个带已鉴权 API 与客户端半边的双半边
  出仓插件，理解 `inject`/`ctx.effect`、profile 挂载、生效语义与零依赖测试金字塔；
- 第一辑的全部环境前提仍然有效（DSH checkout、Node、`$DSH_HOME` 的 `web` profile）；
- 构建链不再重讲：本辑客户端直接复用[第一辑第 5 章](../tutorial/05-web-client.md)的
  `build.mjs` / tsconfig 三件套 / ModuleLoader 信封，只换包名。

## 贯穿示例：`dsh-tool-watchtower`

本辑的贯穿示例是**工具瞭望塔** `dsh-tool-watchtower`：一座架在工具调用管线与模型调用
通道上的哨塔——

- 每次**工具调用**都被记录（`tools/result`），可按规则**门禁**（`tools/pre-execute`：
  allow/deny/ask），可观察**耗时**（`tools/execute` 包裹），自己的报告工具还能演示
  **结果变换**（`tools/post-execute`）与会话内**自定义卡片**（keyed 座位）；
- 每次**模型调用**的流量被只读观测（`llm/stream` + `agent/assistant-stream` +
  `request/header`），聚成实时 token 计数与当前模型快照；
- 全部状态经**资源通道**（`ctx.resources` + `useResource`）推给 Web GUI 的 live 面板，
  界面用 ui-primitives 组件搭成。

```
01 观察者(v1) ─→ 02 权限门(v2) ─→ 03 结果变换与工具(v3) ─→ 04 LLM 观测(v4)
                                                            ─→ 05 live 面板(v5)
                                                            ─→ 06 组件化 UI(v6)
                                                            ─→ 07 测试 ─→ 08 速查
```

## 章节导航

| 章节 | 内容 | 涉及扩展点 | 难度 |
| --- | --- | --- | --- |
| [01 · 事件模式与 waterfall](01-waterfall.md) | v1：emit/waterfall 契约、`tools/result` 与 `agent/assistant-stream` 观察者、活动快照 | `tools/result`、`agent/assistant-stream` | ★★ |
| [02 · 权限门](02-pre-execute.md) | v2：`tools/pre-execute` 的 allow/deny/ask、规则表、审批流 | `tools/pre-execute` | ★★ |
| [03 · 结果变换与工具呈现](03-transform.md) | v3：`tools/post-execute`、`tools/execute` 包裹、`presentCall` 与自定义工具 | `tools/post-execute`、`tools/execute`、`tools.register` | ★★★ |
| [04 · LLM 调用观测](04-llm-stream.md) | v4：`llm/stream` 只读转发、`request/header`、token 折叠 | `llm/stream`、`session/event`、`agent/inbox/inserted` | ★★★ |
| [05 · live 数据通道](05-live-ui.md) | v5：`ctx.resources` provider、`useResource` 四态、composer 胶囊 | 客户端 `resources`、`slots` | ★★★ |
| [06 · 组件化 UI 与座位系统](06-ui-primitives.md) | v6：`Menu`/`Toast`/`Modal`、keyed 座位卡片、header 入口、主题 token | 客户端 `slots`、ui-primitives | ★★★ |
| [07 · 事件管线的测试](07-testing.md) | fakeCtx 瀑布 harness：委托/短路/决策组合的断言 | — | ★★ |
| [08 · 附录：速查表](08-reference.md) | 事件矩阵、需求 → seam 决策表、UI 速查、坑清单 | 全部 | 查阅 |

## 验证状态声明（务必先读）

第一辑的代码蒸馏自本仓库**已验证的真实插件**；本辑不是。本辑的贯穿示例
`dsh-tool-watchtower` **没有对应的真实实现**，全部代码依据**上游文档与源码签名**撰写——
写作时逐条核对过事件载荷、决策类型与组件 props 的原始声明（各章「延伸阅读」标明出处），
但**未经本工作区运行实测**。这延续了第一辑第 6 章的先例（那一章同为文档背书），只是
范围扩大到整辑。因此：

- 每章的「上机验证」是**留给读者的清单**（预期效果 + 排查顺序），不是作者已跑通的记录；
- 第一次照抄时请留出验证时间；遇到行为与教程不符，**以上游文档为准**，并欢迎按
  `AGENTS.md` 的精神回修本教程；
- 事件签名的最终权威永远是源码 JSDoc 生成的 cordis-catalog 区（见第 8 章的文档地图）。

## 约定

- 每章结构固定：概念 → 动手（完整代码或明确标注的增量）→ 上机验证清单 → 坑 → 小结与
  延伸阅读；
- 代码为 TypeScript（对齐 `dsh-stats` 的最新形态：宿主与客户端都从 `src/` 编译进
  `lib/`，`lib/` 不入库）；构建链沿用第一辑第 5 章，本辑只给差异；
- 「观测不改行为」是第 4 章的硬边界：本辑不教拦截/改写模型请求（`agent/request` 换模型、
  `llm/stream` 短路重放只在延伸阅读里指路）；
- 工作区纪律以 [`AGENTS.md`](../../AGENTS.md) 为准：上游 checkout 只读、零第三方依赖。

## 反馈

DSH 的公开 API 是 pre-stable，事件载荷与组件 props 都可能随升级变化。发现教程与实际
行为不符时：修本教程，不改上游。
