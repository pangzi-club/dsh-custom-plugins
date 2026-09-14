# dsh-session-stats

DSH（DeepSeek Harness）出仓插件：在 Web GUI 输入框统计行下方挂一枚「会话用量」胶囊，
点击展开面板，查看本次会话按模型分组的 token 用量（未缓存输入 / 缓存命中 / 缓存写入 /
输出）与计费样本数。

> 插件内部标识（插件名、席位 id、路由路径、样式前缀）沿用 `dsh-stats`，与包名
> `dsh-session-stats` 不冲突；npm 包名与客户端模块表 id 以 `package.json` 的 `name` 为准。

## 原理

- **宿主半边**（`index.js` + `host/fold.js`），`inject: ['webServer', 'connection', 'sessionQuery', 'tools']`：
  - `webServer` exact 路由 `GET /dsh-stats/ping`：JSON 心跳，验证插件挂载与路由存活；
  - `connection.fetch` 已鉴权路由 `GET /api/dsh-stats/summary?session=<id>`：
    `sessionQuery.readSession` 读会话事件日志，`summarizeUsage` 把逐条 `assistant/message`
    样本按 `message.source` 的模型路由折叠成四个 token 桶合计；结果按会话缓存，
    `session/event`（`assistant/message`）落盘后标脏、下次请求重算；
  - `tools`：注册 `session_stats` 工具（裸 JSON Schema 定义、参数自校验），另有两个
    `tools/pre-execute` 监听（调用日志、超长 session id 拒绝）。
- **客户端半边**（`src/client/index.tsx` → 构建为 `lib/client.js`）：向
  `conversation.composer.dock` 席位注入条目（id `dsh-stats`）；`tokenUsage` 投影非零才渲染；
  取数防抖、面板定位与点外关闭复用 `@deepseek-ai/dsh-client-ui-primitives`；词表 zh/en。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `label` | string | `dsh-stats` | 心跳与 summary 响应中的显示名（非空字符串） |
| `timestamp` | boolean | `true` | 心跳响应是否携带时间戳 |

非法配置在插件加载时抛错终止（fail loudly），终端日志可见。

## 启用

方式 A：本机挂载（编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，`name` 用绝对路径）：

```yaml
- insert:
    - id: stats
      name: '/absolute/path/to/dsh-custom/dsh-stats/index.js'
      config:
        label: my-stats
```

方式 B：npm 安装（发布后）：

```sh
pnpm dsh plugin --profile web add dsh-session-stats
```

方式 C：git 子目录安装（本仓库根是插件集合、不是单包，需用 pnpm 的 `#path:` 写法指向
插件目录）：

```sh
pnpm dsh plugin --profile web add 'github:pangzi-club/dsh-custom-plugins#path:dsh-stats'
```

三种方式安装或变更后都需要重启 `dsh web` 并刷新页面。关闭：方式 A 删除插件行；方式 B/C
执行 `pnpm dsh plugin --profile web remove dsh-session-stats`。

## 测试

```sh
npm test    # node --test，22 项，零依赖、不打网络
```

修改 `src/client/` 后先 `node build.mjs` 再跑测试（bundle 测试会执行 `lib/client.js`）。

## 已知限制

- **用量口径**：逐 `assistant/message` 样本按模型路由累加；不区分高峰/空闲档位、不补计
  重试样本、不剔除 fork 继承事件（`inheritedEventCount` 未参与折叠）。与平台账单可能
  不一致，仅供粗略参考；更严格的口径参见 dsh-cost。
- **布局**：胶囊只能出现在统计行下方的新一行（composer dock 是纵向 flex 列）；打开面板
  不会自动收起内建统计胶囊（互斥状态归壳所有）。
