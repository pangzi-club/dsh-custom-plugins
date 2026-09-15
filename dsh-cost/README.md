# dsh-cost

在 DSH Web GUI 底部统计行下方加一个**对话费用**胶囊：点击展开面板，显示本次会话费用（按模型、按 token 桶、按高峰/空闲分档）与 DeepSeek 账户余额。

**不改动 deepseek-harness 仓库任何文件**：Host 半只用 `ctx.connection.fetch` 的已鉴权 exact 路由与 `ctx.sessionQuery` 的日志读取；浏览器半只注册一个 `conversation.composer.dock` 条目，并复用基线模块 `@deepseek-ai/dsh-client-ui-primitives` 的 `useAnchoredPosition` / `useDismissOnOutsidePointer`，所以弹窗的定位与关闭行为与左侧 pill 相同。

## 工作原理

```
pill ──GET /api/dsh-cost/session?session=<id>──▶ 读日志 → 逐样本折叠 → × 价目表 → 金额
     ──GET /api/dsh-cost/balance───────────────▶ ctx.credentials 取 key → GET {baseURL}/user/balance
```

- **逐样本、按时间分档**：每个 provider usage 样本按 `event.time` 归入高峰/空闲，再按该样本所属模型（`assistant/message.source`，缺省用最近的 `request/header`）计价，与官方分时计费口径一致。高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00，其余空闲。
- **重试语义与官方记账一致**：同一 turn/step 的重复样本互相替换；`llm/retry-started` 之后的新样本是叠加（重试是第二次计费请求）。
- **只算本次会话自有事件**：fork 继承的父会话前缀不计（`inheritedEventCount` 之后才算），子 agent 会话也不计。
- **缓存写按未命中输入价计**（DeepSeek 无独立缓存写单价）。
- 费用是**按下表逐样本估算**，不是平台账单；面板脚注会说明。

## 配置（插件行的 config）

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的插件行里写：

```yaml
    - id: cost
      name: '/path/to/dsh-custom/dsh-cost/index.js'
      config:
        timeZone: Asia/Shanghai        # 分档所用时区
        provider: deepseek             # 目前只有 deepseek 支持余额
        # baseURL: https://api.deepseek.com
        # apiKeyEnv: DEEPSEEK_API_KEY  # 走 credentials 存储，回退到启动环境变量
        # currency: CNY
        pricing:                       # 省略 = 使用内置官方价；给出则按模型覆盖
          deepseek-flash: { cacheRead: 0.04, input: 2, output: 8 }   # 高峰价，空闲默认减半
          deepseek-v4-pro:
            peak: { cacheRead: 0.3, input: 9, output: 13.5 }
            idle: { cacheRead: 0.15, input: 4.5, output: 6.75 }
          # some-model: null           # null = 移除内置价，该模型显示“未配置价格”
```

- 单价单位是「每百万 token」，`input` 同时覆盖未缓存输入与缓存写入。
- 键可以是模型 id，也可以是 `provider/model`（后者优先）。
- 内置默认（CNY、高峰档，空闲为一半）：`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` = 0.04 / 2 / 8；`deepseek-v4-pro` = 0.30 / 9 / 13.5。
- 配置写在 profile patch 里而不是 `settings.yaml`：出仓库插件无法 `import` 仓库内的 schemastery 去注册 settings namespace。patch 文件是 `patchReload: live`，改完会重新组合。

## 构建与测试

```sh
cd dsh-cost
pnpm install             # 一次性：装入 typescript devDependency（node_modules/.bin/tsc）
npm test                 # node --test test/*.test.mjs（40 项）
node build.mjs           # 用插件自带的 tsc 编译 src/client/index.tsx 并包成 lib/client.js
```

`build.mjs` 用本目录 `node_modules/.bin/tsc`（`typescript` 是 devDependency，版本精确锁定，与上游 checkout 一致），不再依赖 DSH checkout；tsc 缺失时会报错提示先 `pnpm install`。客户端 bundle 只有 `lib/client.js` 一个资源会被 `/plugins` 服务，因此 `src/client/index.tsx` 必须保持单文件、无相对 import。

## 生效与运维

- **首次接入**：往 profile patch 追加行后，`live` 重载会重新组合，但 boot graph 变了 → 需要**刷新页面**。
- **改了 `lib/client.js`**：模块注册表按 specifier 缓存 row/rev，本插件不在仓库 HMR 监视范围内 → 需要**重启 `dsh web`** 再刷新页面。
- **关闭**：删除该 patch 行即可（host 路由与 pill 一起消失）。

## 已知限制

- **位置**：`conversation.composer.dock` 的父容器是纵向 flex 列（`InputBar.module.css` 的 `.root`），插件条目只能成为统计行**下面的另一行**；要让它紧贴 token pill 右侧只能改核心 `StatsPills`，或用脆弱的 DOM 注入。
- 打开费用面板**不会**自动关闭左侧两个 pill（它们共用 ui-chat 内部的 `openPill` 状态，插件无法加入该互斥）。
- 余额仅支持 DeepSeek 官方 `/user/balance`；其他 provider 显示“该 provider 不支持余额查询”。缺 key、401、网络失败都有明确原因。
- 计费不覆盖子 agent 会话与 fork 继承事件；单价随官方调整需自行更新配置。
