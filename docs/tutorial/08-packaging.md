# 08 · 打包与分发：从本机挂载到可安装 bundle

[上一章](07-testing.md) · [下一章（附录）：速查表](09-reference.md)

到目前为止 `dsh-stats` 一直用**方式 A**（profile patch 里写绝对路径）挂载——这对「只在这台
机器上用」完全够用。本章把它变成**方式 B**：一个可 `dsh plugin add` 安装的 bundle，能装到
任何一台有 DSH 的机器上。成品参照：[`dsh-favicon-triangle`](../../dsh-favicon-triangle/README.md)
（本仓库唯一已 bundle 化的插件）。

## 1. 两种接入方式的本质区别

| | 方式 A：profile patch 挂载 | 方式 B：bundle 安装 |
| --- | --- | --- |
| 插件行 `name` | 绝对路径（`/Users/you/…/index.js`） | **包名**（`dsh-stats`） |
| 模块解析 | 按绝对路径直接 import | 在 profile 自己的 `node_modules` 里解析 |
| 适合 | 本机开发、随时改 | 分发给别人 / 多机复用 |
| 增删方式 | 编辑 `cordis.patch.yml` | `dsh plugin add` / `remove` |

关键差异在**插件行 `name` 的含义变了**：bundle 行写包名，解析发生在 profile 目录的
`node_modules` 里——`dsh plugin add` 本质上是用 pnpm 把你的包装进 profile，再让层叠组合
读到你包里的 patch 层。

## 2. dsh-stats v6：补上 bundle 三件套

**其一，`dsh-stats/cordis.patch.yml`**——包自带的 bundle 层，行里 `name` 用**包名**：

```yaml
# Bundle layer for dsh-stats: inserts the plugin row by package name.
# Install with `dsh plugin add <path-or-tarball>`; the row then resolves through
# Node resolution inside the profile's own node_modules.
- insert:
    - id: stats
      name: dsh-stats
```

**其二，`package.json` 声明 bundle 与发布内容**：

```json
{
  "name": "dsh-stats",
  "version": "0.1.0",
  "description": "DSH Web GUI plugin: session usage stats",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": { "platform": "web" },
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "files": ["index.js", "host", "lib/client.js", "cordis.patch.yml"],
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test test/*.test.mjs"
  },
  "license": "MIT",
  "private": true
}
```

- `dsh.bundle.patch` 指向包内 patch 层——**这是「可安装」的开关**：安装器只把声明了它的
  依赖认作 DSH bundle；
- `files` 列出发布内容：宿主入口、`host/`、已构建的客户端 bundle、patch 层。源码与测试
  不必发布；
- `dsh.client` 与 `exports["./client"]` 原样保留——bundle 化不影响客户端半边的声明。

**其三，README**。一个要分发的插件必须有像样的 README（这也是本工作区的硬约定，见
[`AGENTS.md`](../../AGENTS.md)），六个段落一个不能少：

```markdown
# dsh-stats

## 作用          一句话 + 一张截图能说清的事
## 原理          占了哪些扩展点（路由、API、席位、工具），数据从哪来
## 配置          插件行 config 的全部键：类型、默认值、示例
## 启用          方式 A 的 YAML 样例 + 方式 B 的安装命令
## 测试          npm test
## 已知限制      口径差异、布局约束、provider 限制……如实列出
```

「已知限制」最容易被略过也最不能略过：**口径差异必须写明**。参照 `dsh-cost` 的写法——
它的费用是逐样本估算而非平台账单、余额只支持 DeepSeek 官方接口，两条都醒目地写在
README 里。用户拿着你的数字对账之前，应该已经读过这两行。

## 3. 安装、验证、卸载

```sh
cd /path/to/deepseek-harness

# 安装（本地目录；tarball、npm 包名同样可以）
pnpm dsh plugin --profile web add /path/to/dsh-custom/dsh-stats

# 验证组合结果：输出里应出现 "# == dsh-stats" 的 bundle 层
pnpm dsh --profile web --dump-config

# 卸载
pnpm dsh plugin --profile web remove dsh-stats
```

`dsh plugin add` 实际做了三件事：

1. 把你给的路径**锚定到调用时的工作目录**再交给 pnpm（避免 pnpm 在 profile 目录里执行时
   把相对路径解析到别处）；
2. 在 profile 目录里跑 `pnpm add`（首次使用会初始化 profile 工作区并装上 `dsh-base`）；
3. **对账** `dsh.profile.bundles`：扫 profile 的新依赖，凡是声明了 `dsh.bundle.patch` 的
   （也就是 DSH bundle）追加进 bundle 列表，让它成为一层组合输入；不再是 bundle 的依赖
   则移除。模板自带的 bundle 永远不动。

两个容易误解的点：

- **它不改你的 `cordis.patch.yml`**——profile 的 patch 层始终是你手写的；bundle 的插件行
  来自包内 patch，经 `dsh.profile.bundles` 这条独立通道进入组合；
- **装完要重启**：bundle 列表进了 `package.json`，属于启动时读取的组装输入。

## 4. 分发渠道与安全注意

| 渠道 | 命令 | 注意 |
| --- | --- | --- |
| 本地目录 | `dsh plugin add /path/to/dsh-stats` | 开发期最顺手；升级靠 `pnpm update` 或重装 |
| tarball | `dsh plugin add ./dsh-stats-0.1.0.tgz`（先 `npm pack`） | 不需要发布基础设施 |
| npm | 发布后 `dsh plugin add dsh-stats` | `files` 字段决定包内容；`lib/client.js` 必须随包发布 |
| git | `dsh plugin add github:you/dsh-stats` | 见下 |

git 渠道有个**安全闸**：如果包用 `prepare` 脚本在安装时自建（出仓插件常见——装完跑
`node build.mjs` 生成 `lib/client.js`），pnpm 默认不执行第三方仓库的 install 期脚本，用户
必须在自己的 profile `pnpm-workspace.yaml` 里把它加进 `allowBuilds` 白名单。这是特性不是
麻烦——install 期脚本就是任意代码执行，用户应当有意识地放行。绕开它的正路：发布前把
`lib/client.js` 构建好随包分发（`dsh-cost` 与本教程的做法），让消费者完全不需要构建。

## 5. 发布前清单（Definition of Done）

从[`AGENTS.md`](../../AGENTS.md)的完成标准改写成教程版，`dsh-stats` 收尾时逐项打勾：

1. `npm test` 全绿（含 bundle 结构测试；改过 `src/client/` 就先 `node build.mjs`）；
2. 在 <http://127.0.0.1:3080> 上**实际验证**过（胶囊、面板、工具调用；必要时重启
   `dsh web` 并强刷页面）——不要拿另一个端口的服务器冒充；
3. `git -C /path/to/deepseek-harness status --short` 为空：**上游 checkout 零改动**；
4. 自己工作区 `git status` 里只有预期的文件；
5. README 六段齐备，已知限制与口径差异写明；
6. 根 `README.md` 的「插件一览」登记一行（住在工作区里的插件）。

至此 `dsh-stats` 走完了从 30 行心跳路由到可分发双半边插件的全程——它就是一个精简版的
`dsh-cost`。回头看第 1 章的心智模型，四条应该都已经变成手感了。

## 延伸阅读

- [`dsh-favicon-triangle/cordis.patch.yml`](../../dsh-favicon-triangle/cordis.patch.yml) ——
  最小 bundle 层实例；
- 上游 `docs/user/develop/basic/publish.md` —— 打包与安装的权威文档（bundle 与 profile
  的关系、加载顺序、git 安装的安全细节）；
- 上游 `apps/cli/src/plugin.ts` —— `dsh plugin` 命令的实现（路径锚定与 bundle 对账）。
