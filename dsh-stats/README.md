# dsh-session-stats

DSH（DeepSeek Harness）出仓插件：在 Web GUI 输入框统计行下方挂一枚「会话用量」胶囊，
点击展开面板，查看本次会话按模型分组的 token 用量（未缓存输入 / 缓存命中 / 缓存写入 /
输出）与计费样本数。

> 插件内部标识（插件名、席位 id、路由路径、样式前缀）沿用 `dsh-stats`，与包名
> `dsh-session-stats` 不冲突；npm 包名与客户端模块表 id 以 `package.json` 的 `name` 为准。

## 原理

- **宿主半边**（`src/index.ts` + `src/host/`，TypeScript 源码；`node build.mjs` 编译为
  `lib/index.js` + `lib/host/*.js`——构建产物统一住在 `lib/`，已加入 `.gitignore` 不入库，
  本机构建本地用；profile patch 与测试都指向产物路径），
  `inject: ['webServer', 'connection', 'sessionQuery', 'tools']`：
  - `webServer` exact 路由 `GET /dsh-stats/ping`：JSON 心跳，验证插件挂载与路由存活；
  - `connection.fetch` 已鉴权路由 `GET /api/dsh-stats/summary?session=<id>`：
    `sessionQuery.readSession` 读会话事件日志，`summarizeUsage` 把逐条 `assistant/message`
    样本按 `message.source` 的模型路由折叠成四个 token 桶、并按样本时间戳划分
    高峰/空闲档，`src/host/pricing.ts` 再按有效价格表逐档计价（缓存写入按未缓存输入计费）；
    结果按会话缓存，`session/event`（`assistant/message`）落盘后标脏、下次请求重算；
  - `tools`：注册 `session_stats` 工具（裸 JSON Schema 定义、参数自校验），另有两个
    `tools/pre-execute` 监听（调用日志、超长 session id 拒绝）；
  - DSH 宿主的 `ctx`/Node 请求响应类型无法从出仓位置 import，由
    `src/host/context.d.ts` 提供最小结构化声明（与客户端 `src/shims.d.ts` 同一手法）。
- **客户端半边**（`src/client/index.tsx` → 构建为 `lib/client.js`）：向
  `conversation.composer.dock` 席位注入条目（id `dsh-stats`）；`tokenUsage` 投影非零才渲染；
  取数防抖、面板定位与点外关闭复用 `@deepseek-ai/dsh-client-ui-primitives`；词表 zh/en。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `label` | string | `dsh-stats` | 心跳与 summary 响应中的显示名（非空字符串） |
| `timestamp` | boolean | `true` | 心跳响应是否携带时间戳 |
| `timeZone` | string | `Asia/Shanghai` | 高峰/空闲分档所用 IANA 时区 |
| `pricing` | object | 内置官方快照 | 按模型覆盖价格表（CNY/百万 token）；裸对象视为 `peak`，省略 `idle` 时取半价；`null` 移除该模型（报告为未计价）；键可用裸模型 id 或 `provider/model` |

内置价格快照（与 `dsh-cost` 一致）：`deepseek-flash` / `deepseek-v4-flash` /
`deepseek-v4-flash-vision-exp` 高峰 `cacheRead 0.04 / input 2 / output 8`，
`deepseek-v4-pro` 高峰 `0.3 / 9 / 13.5`；空闲档为高峰半价。官方调价后用 `pricing` 覆盖即可，
不必改代码。示例：

```yaml
- insert:
    - id: stats
      name: '/absolute/path/to/dsh-custom/dsh-stats/lib/index.js'
      config:
        label: my-stats
        timeZone: Asia/Shanghai
        pricing:
          deepseek-v4-pro: { cacheRead: 0.3, input: 9, output: 13.5, idle: { cacheRead: 0.15, input: 4.5, output: 6.75 } }
          deepseek-flash: null
```

非法配置在插件加载时抛错终止（fail loudly），终端日志可见。

## 启用

方式 A：本机挂载（编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，`name` 用绝对路径）：

```yaml
- insert:
    - id: stats
      name: '/absolute/path/to/dsh-custom/dsh-stats/lib/index.js'
      config:
        label: my-stats
```

方式 B：npm 安装（发布后）：

```sh
pnpm dsh plugin --profile web add dsh-session-stats
```

方式 C：git 子目录安装（本仓库根是插件集合、不是单包，需用 pnpm 的 `#path:` 写法指向
插件目录）。注意 `lib/` 不入库：git 渠道装到的包没有构建产物，而构建又依赖本机的上游
checkout（`.dsh-repo`/`DSH_REPO`），因此 git 渠道只适合本仓库协作者；对外分发用方式 B
（npm 包在发布前已 `node build.mjs`，产物随 tarball 走）：

```sh
pnpm dsh plugin --profile web add 'github:pangzi-club/dsh-custom-plugins#path:dsh-stats'
```

三种方式安装或变更后都需要重启 `dsh web` 并刷新页面。关闭：方式 A 删除插件行；方式 B/C
执行 `pnpm dsh plugin --profile web remove dsh-session-stats`。

## 测试

```sh
npm test    # node --test，24 项，零依赖、不打网络
```

修改 `src/` 下任意源码后先 `node build.mjs` 再跑测试：两个半边的产物统一重建到 `lib/`
（宿主 `lib/index.js` + `lib/host/`、客户端 `lib/client.js`），测试执行的是产物
（bundle 测试会执行 `lib/client.js`）。`lib/` 在 `.gitignore` 里，改源码不产生 git 噪音；
换机器或新 clone 后需要先配置 `.dsh-repo`（或 `DSH_REPO`）并跑一次 `node build.mjs`，
插件才有产物可加载。

## 已知限制

- **计价口径**：价格为逐样本估算，非平台账单。高峰/空闲按官方窗口划分（工作日本地时间
  9–12 点、14–18 点，`timeZone` 可配），空闲按半价；缓存写入按未缓存输入计费。不补计
  重试样本、不剔除 fork 继承事件（`inheritedEventCount` 未参与折叠），与平台账单可能
  不一致；更严格的口径参见 dsh-cost。价格表是内置官方快照，调价后请用 `pricing` 覆盖。
- **布局**：胶囊只能出现在统计行下方的新一行（composer dock 是纵向 flex 列）；打开面板
  不会自动收起内建统计胶囊（互斥状态归壳所有）。
