# 08 · 附录：速查表

[上一章：事件管线的测试](07-testing.md) · [返回导读](README.md)

本辑出现的全部 seam、决策与坑，压成四张表。表里每一行的**权威出处**见 §5——签名以
上游为准，本表只帮你定位。

## 1. 本辑事件矩阵

| 事件 / 类型 | 模式 | 载荷要点 | 用途 | 章 |
| --- | --- | --- | --- | --- |
| `tools/pre-execute` | waterfall | `exec`（callId/name/冻结 args/agent）→ allow·deny·ask | 工具门禁 | 02 |
| `tools/execute` | waterfall | `ToolDispatchExecution`（只许换 signal）→ 结果 | 计时/超时/指标包裹 | 03 |
| `tools/post-execute` | waterfall | `exec` + `result` → accept（换投影/换值/捎上下文）· block | 结果变换 | 03 |
| `tools/result` | emit | 冻结终局（身份 + 结果），监听者抛错被收纳 | 审计落账（最终真相） | 01 |
| `llm/stream` | waterfall | `GenerateOptions`（深冻结）→ `AsyncIterable<StreamChunk>` | 每次模型调用的只读旁听（无会话身份） | 04 |
| `agent/assistant-stream` | emit | `{ agent, frame }`，start/chunk/end 三拍子，usage 挂 chunk | 实时 token 流（进程内） | 01 |
| `agent/inbox/inserted` | emit | `{ agent, message }` | 提示词入队时刻 | 04 |
| `session/event` = `request/header` | 日志广播 | `data.header.config`（provider/model/…） | 当前模型路由（耐久权威） | 04 |
| `tools/change` | emit | 无载荷 | 工具集变化通知（本辑未用，备查） | — |

事件名三防（拼错静默无效）：`tools/result`（Cordis）≠ `tool/result`（会话事件类型）；
`agent/assistant-stream` 没有 `agent/stream` 简写；`request/header` 是会话事件类型，
`ctx.on('request/header')` 不存在。

## 2. 需求 → seam 决策表

| 想做什么 | 用什么 | 不用什么 | 章 |
| --- | --- | --- | --- |
| 审计每次工具调用的终局 | `tools/result`（emit） | pre-execute 顺手记（那是策略位） | 01 |
| 拦下某些工具调用 | `tools/pre-execute` → deny（reason 给模型指路） | throw（那是 bug） | 02 |
| 让人审批危险调用 | `tools/pre-execute` → ask（`ctx.approval`，fail-closed） | 自己弹 UI（审批面是壳的） | 02 |
| 改工具参数 | **做不到（设计如此）**——deny + reason 引导重调 | — | 02 |
| 替换工具的模型可见结果 | `tools/post-execute` → accept + content（换投影）或 value（换值，重校验） | — | 03 |
| 作废一份已跑完的结果 | `tools/post-execute` → block + feedback（结果级否决） | — | 03 |
| 给下一次模型请求捎话 | post-execute 的 `additionalContexts`（或 `exec.agent.inject`） | — | 03 |
| 给调用计时/加超时 | `tools/execute` 包裹（只许换 signal）；声明 `timeoutMs` 交给仓内 policy | 在工具体里自己掐表 | 03 |
| 看每次模型调用的 provider/model | `llm/stream`（读 options、原样 `next()`） | 消费流（改时序契约） | 04 |
| 换模型/改调用配置 | `agent/request`（本辑未教，指路） | `llm/stream` 里动手（禁区） | 04 |
| 看当前会话的模型路由 | `session/event` 的 `request/header` | — | 04 |
| 实时 token 用量 | `agent/assistant-stream` 的 usage chunk | 解析 `llm/stream` 的流 | 01/04 |
| 统计提示词入口 | `agent/inbox/inserted`（chars ≠ tokens） | — | 04 |
| 给模型加能力 | `ctx.tools.register`（裸 JSON Schema + 自校验） | 仓内 `defineTool`（解析不到） | 03 |
| 定制自己工具的模型侧投影 | `output.render`；UI 卡意图用 `presentCall`/`presentResult`（纯函数） | 在 render 里做 I/O | 03 |
| 定制工具在会话流里的卡片 | keyed 座位 `tool.call.toolview`，`key: 工具名` | 抢出厂 key（那是接管） | 06 |
| 把宿主数据推给 UI | `ctx.resources` provider + `useResource`（失败走帧、abort 到 fetch） | 组件里各自轮询（第一辑旧法） | 05 |
| 往界面加一块东西 | 对应座位 + `ctx.slots.inject(seat, () => ctx.slots.register(…))` | 传 priority、改核心 | 06 |

## 3. 客户端速查

**座位**（本辑用过的；全目录在上游 `slot-catalog.ts`）：

| 座位 | cardinality | 用例 |
| --- | --- | --- |
| `conversation.composer.dock` | list | composer 下的活动胶囊 |
| `conversation.session.header.utilities` | list | 会话头右侧入口按钮 |
| `tool.call.toolview` | keyed（key=工具名） | `watchtower_report` 的会话内卡片 |

**primitives**（本辑用过的；完整清单见包 README）：`Menu`（分组/多选/键盘/portal）、
`Modal`（`closeLabel` 必填）、`Toast`（`onDone` 后持有者卸载）、`StateDot`、
`useAnchoredPosition` / `useDismissOnOutsidePointer`（第一辑）、
`useAnchoredMaxHeight`（底部浮层钳制，备查）。

**样式三层**：`--dsw-static-*` 禁用 → `--dsw-alias-*` 默认 → `--dsw-specific-*`（对齐
出厂表面）；浮层 `border: 0` + `--dsw-elevation-*`；只用变量 = 暗色自动跟随。

**数据通道**：`dsh-resource://<协议>/<作用域路径>` → 浏览器 `ctx.resources.register`
（首帧当前值 + 变更帧，失败是帧不是 throw）→ 组件 `useResource` 四态
`none/loading/live/failed`；引用计数管开关，同地址多消费者共享一条流。

## 4. 坑清单汇总

**管线**（01–04）

- waterfall 监听者不调 `next()` = 静默短路整条链；`return { kind: 'allow' }` = 越权
  剥夺下游否决权；
- 被拒的调用也会物化成错误结果流完管线（post-execute、tools/result 都看得到）；
- post-execute 的变换要先 `await next()` 并尊重下游 block——你的返回值取代整条下游；
- `tools/execute` 的 `next()` 返回的是 post-execute 之前的结果，最终真相在 `tools/result`；
- `exec.arguments` 与循环构建的 `GenerateOptions` 都深冻结——改写直接抛 TypeError；
- emit 监听者抛错被收纳，waterfall 的责任重得多：决策是返回值，不是异常；
- 事件按 agent 作用域过滤；`ctx.on` 注册的全局监听者听全部 agent。

**LLM 观测**（04）

- `llm/stream` 无会话身份——按会话观测用 `request/header` + `assistant-stream`；
- 观测三不：不改冻结请求、不自产流、不消费 `next()` 的流；换模型走 `agent/request`；
- header 的 config 形状带上游 `TODO(call-config-shape)`，只读 provider/model 等稳定字段；
- prompt 的 chars 是字符数不是 token 数。

**客户端**（05–06）

- provider 在浏览器、数据在宿主——帧流自己供血（修订号轮询或 RPC 通道）；
- `open` 里 throw 不被救：失败必须是 `{ ok: false }` 帧；abort 要贯穿到 fetch；
- 修订号初值用 -1，别和「空会话的 0」撞首帧；未知会话给空快照别给 404；
- 钩子顺序高于提前返回；keyed 座位的 key 拼错=静默不渲染；命中出厂 key=接管；
- `Modal.closeLabel` 必填；`Toast` 的卸载责任在持有者、重弹靠 key 序列；
- CSS 只用 alias/specific token，一个字面色就是一条暗色裂缝；
- `slots.inject` 外层包裹不可省、不传 priority、list 内排序用 order。

**工程**（07 + 全辑）

- 改宿主代码重启、改客户端 bundle 重启、改插件行 config 只需重组合+刷新（第一辑 §6 的
  表继续有效）；
- 测产物不测源码：先 `node build.mjs` 再 `npm test`；stub 从真实契约抄，不从记忆抄；
- 时钟、随机、网络是环境不是被测物——断言类型与关系，不断言数值。

## 5. 上游文档地图（签名的最终权威）

| 想核对什么 | 去哪里 |
| --- | --- |
| 工具管线全图与 `tools/*` 事件签名 | 上游 `docs/subsystems/tools.md`（cordis-catalog 生成区，可对源码验证） |
| 工具契约（output/render/呈现词汇/timeoutMs） | 上游 `docs/cookbook/adding-a-tool.md` |
| 审批语义（fail-closed、`allowed-once`） | 上游 `docs/subsystems/approval.md` |
| `agent/*` 事件（assistant-stream/inbox/request） | 上游 `docs/subsystems/core.md` |
| `llm/stream`、`StreamChunk`、`TokenUsage` | 上游 `docs/subsystems/llm-streaming.md` |
| `SessionEventMap`（request/header 等） | 上游 `docs/subsystems/session.md` |
| waterfall 组合语义 | 上游 `docs/cordis-primer.md` |
| 事件四模式入门 | 上游 `docs/user/develop/framework/events.md` |
| feature → mechanism 对账表 | 上游 `docs/cookbook/extension-cookbook.md` |
| 资源模型契约 | 上游 `packages/client/resources`（`contract.ts` 是权威）+ `docs/subsystems/client-resources.md` |
| 座位全目录与 ownerProps | 上游 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（运行时 `cordis_inspect` 查活体） |
| primitives 组件目录 | 上游 `packages/client/ui-primitives/README.md` |
| 主题三层 token 与暗色 | 上游 `docs/web-styling.md` |

生成区提醒：`tools.md`/`core.md`/`capability-seams.md` 等的签名表由
`pnpm run gen-cordis-catalog` 从源码 JSDoc 生成——**文档与源码不会漂移太久**；发现
教程与两者都不一致时，改教程（`AGENTS.md` 的老规矩）。

## 返回

- [导读](README.md) —— 本辑定位、贯穿示例生长图与验证状态声明；
- [第一辑](../tutorial/README.md) —— 心智模型、构建链、打包分发等本辑未重讲的地基。
