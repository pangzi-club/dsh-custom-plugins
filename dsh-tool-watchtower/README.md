# dsh-tool-watchtower

DSH（DeepSeek Harness）出仓插件：一座架在**工具调用管线**与**模型调用通道**上的「瞭望塔」。
每次工具调用被记录、可按规则门禁（deny / ask）、被计时、可对结果做脱敏/标注/阻断；
每次模型调用被只读观测（provider/model 路由、实时 token 用量、提示词入队）。全部状态经
资源通道推给 Web GUI 的 live 面板（composer 胶囊 + 会话头入口 + 活动详情），并为自己的
报告工具提供会话内自定义卡片。

**只观测、不改行为**是模型通道的硬边界：不换模型、不改请求、不重放流。

> 本插件是 [`docs/tutorial2/`](../docs/tutorial2/README.md)（进阶教程）的贯穿示例的实现。
> 教程正文逐章讲解每个扩展点的语义与坑；本 README 只记录成品形态。

## 原理

- **宿主半边**（`src/index.ts` + `src/host/`，TypeScript 源码；`node build.mjs` 编译为
  `lib/index.js` + `lib/host/*.js`，`lib/` 不入库），
  `inject: ['webServer', 'connection', 'tools']`：
  - `tools/result`（emit）：每次工具调用的只读终局，落进按会话分桶的环形缓冲
    （`src/host/activity.ts`，每会话 256 条、最多 32 个会话，最旧淘汰）；
  - `tools/pre-execute`（waterfall）：按插件行 `config.rules` 做门禁，首条命中生效，
    默认放行。deny / ask 会作为 `decision` 记录自行审计（被拒的调用也会以错误结果流完
    管线，靠这条记录与工具自身的失败区分）；allow 永远是 `next()`，绝不亲自断言；
  - `tools/execute`（waterfall 包裹）：给每次调度记墙钟毫秒，按 `callId` 递给
    `tools/result` 观察者落账（包裹者的 `next()` 在 post-execute 之前返回，最终真相仍以
    `tools/result` 为准）；
  - `tools/post-execute`（waterfall）：对 `config.transform.tools` 点名的工具做结果变换
    ——`redact`（替换模型/UI 可见投影，规范值不动）、`annotate`（给下一次模型请求捎一条
    notice 上下文）、`block-secret`（结果级否决 + 纠正反馈）。结构是「先委托、尊重下游
    block、再叠加」；
  - `llm/stream`（waterfall）：只读旁听每次模型调用（`options` 深冻结、原样返回
    `next()` 的流）。该事件没有会话身份，按会话的数字来自下面两站；
  - `session/event`（`request/header` 类型）：耐久的模型路由快照（provider/model），
    新值替换旧值；
  - `agent/assistant-stream`（emit）：模型尝试的实时帧流（start/chunk/end），usage 块
    折进四个 token 桶（input / output / cacheRead / cacheWrite）；
  - `agent/inbox/inserted`（emit）：提示词入队时刻（记字符数，不是 token 数）；
  - `webServer` exact 路由 `GET /dsh-tool-watchtower/ping`：JSON 心跳（含跟踪的会话数）；
  - `connection.fetch` 已鉴权路由 `GET /api/dsh-tool-watchtower/activity?session=<id>`：
    活动快照（`revision` 单调递增；未知会话返回空快照而不是 404）；
  - `tools`：注册 `watchtower_echo`（变换模式的练功靶）与 `watchtower_report`（读哨塔
    快照，带 `presentCall`/`presentResult` 的 generic 卡呈现）。
- **客户端半边**（`src/client/index.tsx` → 构建为 `lib/client.js`，单文件无相对 import），
  `inject: ['slots', 'locale', 'resources']`：
  - `resources` provider：把 `dsh-resource://dsh-tool-watchtower/<会话>` 变成帧流——
    每秒带修订号的跟随轮询（修订号没变不产帧），失败走 `{ ok: false }` 帧、abort 贯穿
    到 fetch；
  - `conversation.composer.dock` 座位：活动胶囊（tools/错误/拦截计数 + token 流量），
    点击弹出 `Menu`（类型过滤 + 详情入口）；
  - `conversation.session.header.utilities` 座位：会话头入口按钮，打开同一个活动面板
    （同地址第二个消费者，注册表按引用计数只开一条轮询流）；
  - `tool.call.toolview` keyed 座位（`key: 'watchtower_report'`）：报告工具的会话内
    自定义卡片（运行中 ongoing 点 / 完成后一行摘要 + done 点）；
  - 门禁 deny / ask 计数变化时顶部滑 `Toast`（首次读数算历史不算新闻）；
  - 弹层全部用 `@deepseek-ai/dsh-client-ui-primitives`（Menu/Modal/Toast/StateDot），
    样式只用 `--dsw-alias-*` 语义 token，深浅色自动跟随。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `rules` | array | `[]` | 门禁规则表，**首条命中生效**；`tool` 为工具名精确匹配或 `'*'` 通配（通配条目应垫底）；`decision` ∈ `allow`/`deny`/`ask`；`reason` 可选（deny 时成为模型可见的错误文案，建议给模型指路） |
| `transform.tools` | string[] | `[]` | 允许变换的工具名单（只应点自己的演示工具） |
| `transform.mode` | string | `off` | `off` / `redact` / `annotate` / `block-secret` |

非法配置在插件加载时抛错终止（fail loudly），终端日志可见。示例：

```yaml
- insert:
    - id: watchtower
      name: '/absolute/path/to/dsh-custom/dsh-tool-watchtower/lib/index.js'
      config:
        rules:
          - tool: web_fetch
            decision: ask
            reason: outbound fetches need a human nod
          - tool: write
            decision: deny
            reason: this session is read-only, use read instead
          - tool: '*'
            decision: allow
        transform:
          tools: [watchtower_echo]
          mode: redact
```

只改 config：重新组合 + 刷新页面即可；新增插件行或改代码：重启 `dsh web` + 刷新
（改 `lib/client.js` 也必须重启）。

## 启用

方式 A（本机挂载）：编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，`name` 用绝对路径
（见上例；不带 config 时至少给出 id 与 name 两行）。构建并重启：

```sh
cd dsh-tool-watchtower
pnpm install     # 一次性：装入 typescript devDependency（node_modules/.bin/tsc）
node build.mjs   # 两个半边的产物统一重建到 lib/
```

方式 B（bundle）：本插件未声明 `dsh.bundle`；要分发请按 `AGENTS.md` 补
`cordis.patch.yml` 后 `pnpm dsh plugin --profile web add <插件目录>`。

## 验证

```sh
curl http://127.0.0.1:3080/dsh-tool-watchtower/ping
# {"ok":true,"plugin":"dsh-tool-watchtower","sessions":0,"now":"…"}
```

GUI 内：composer 下方出现瞭望塔胶囊；让模型跑一个工具，胶囊计数约 1 秒内 +1；菜单选
「查看详情…」看记录列表；配置 deny 规则后让模型撞门，顶部应滑过拦截 Toast。

## 测试

```sh
npm test    # node --test，42 项，零依赖、不打网络、不依赖 GUI
```

测试跑在构建产物上：改了 `src/` 先 `node build.mjs` 再 `npm test`。分层：纯函数
（rules / transform / activity）、编排（waterfall harness 组合瀑布链，断言委托/短路/
先委托后叠加/尊重下游 block 四条纪律）、信封（bundle 三座位 + provider + 词表对齐）。

## 已知限制

- **未经真实运行实测的行为**：事件载荷与组件 props 依据上游文档与源码签名撰写（教程
  各章「延伸阅读」标明出处），本插件的 GUI 侧行为尚未在真实会话中逐项验证；遇到与
  教程不符处以 `docs/tutorial2/` 各章排查顺序 + 上游文档为准，并欢迎回修。
- **`annotate` 的 notice 是手写字面量**：上游造 `UserMessage` 的正路
  `createUserMessage`（`@deepseek-ai/dsh-llm`）出仓解析不到；若未来版本对消息 `id`
  形态加运行时校验，这里是第一个会碎的地方。
- **live 通道是轮询**：provider 在浏览器、数据在宿主，帧流靠每秒一次的带修订号轮询
  供血（不是真推送）；每个开着面板的会话每秒一个请求，引用计数保证无订阅即无请求。
  要细粒度需改走 `ctx.connection.rpc` 推送通道。
- **`ask` 的可用性取决于审批面**：ask 把裁决交给 `ctx.approval`，fail-closed——没有
  可用审批 answerer 的组合里 ask 等同于拒绝，不是 bug。
- **内存有界但进程内**：环形缓冲（256 条/会话 × 32 会话）只活在宿主进程里，重启即失；
  历史统计请用 `dsh-stats`（读耐久日志）。
- **chars ≠ tokens**：提示词记录是字符数，token 化是 provider 的事；token 口径来自
  `assistant-stream` 的 usage 块，是估算观测，不是平台账单。
