# dsh-favicon-triangle

把 DSH Web GUI 的标签页图标（favicon）换成三角形，**不改动 DSH 仓库里的任何前端构建产物**。

## 原理

Web 外壳的 `index.html` 声明了 `<link rel="icon" href="/favicon.svg">`，安装清单
`manifest.webmanifest` 的图标也指向同一个路径；而实际的文件由
`@deepseek-ai/dsh-host-frontend-static` 通过 webserver 的 **fallback seat** 从
`apps/web/dist` 提供。

webserver 的路由匹配顺序是：**exact 路由 → 最长 prefix → fallback**。
本插件用 `ctx.webServer.register()` 注册一条 exact 路由 `GET/HEAD /favicon.svg`，
因此它稳定地优先于 fallback 里的静态文件，同时覆盖标签页图标与「安装为应用」后的图标。

插件不注入任何页面脚本，也不需要重新构建前端；`dsh` 升级后依然生效。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件入口：`inject: ['webServer']`，注册 `/favicon.svg` 路由并返回可回收的 effect |
| `cordis.patch.yml` | bundle 层：供 `dsh plugin add` 安装时插入插件行 |
| `test/index.test.js` | 单元测试：路由声明、卸载回收、GET/HEAD/405 行为与 SVG 形状 |

图标本身是自适应的：浅色配色方案下为黑色，`prefers-color-scheme: dark` 下变为白色，
所以在浅色和深色标签栏上都可见。

## 启用

已经写进本机 profile 的 patch 层（`$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: favicon-triangle
      name: '/path/to/dsh-custom/dsh-favicon-triangle/index.js'
```

`web` profile 的 `patchReload` 是 `live`，所以保存后**无需重启**即生效（页面刷新即可看到）。
如果 profile 是 `startup`，或者行引用了新文件，重启 `dsh web` 后生效。

也可以按包名安装为可分发插件：

```sh
dsh plugin --profile web add /path/to/dsh-custom/dsh-favicon-triangle
```

## 关闭

删除 `cordis.patch.yml` 里的 `favicon-triangle` 条目（live 重载后立刻恢复原图标）；
用 `dsh plugin add` 安装的话，执行 `dsh plugin --profile web remove dsh-favicon-triangle`。

## 测试

```sh
cd dsh-favicon-triangle && npm test   # node --test test/*.test.js
```

## 已知限制

- 浏览器可能缓存了旧图标：路由带 `cache-control: no-cache, must-revalidate`，但首次替换
  仍可能需要强制刷新（macOS 上 Chrome 可 `Cmd+Shift+R`）。
- 只改浏览器 chrome 里的图标；应用内标题栏/侧边栏的品牌图形属于
  `@deepseek-ai/dsh-client-ui-brand-official`，不在本插件范围内。
- 只注册 `/favicon.svg`；若浏览器另外请求 `/favicon.ico`，仍走 fallback（当前外壳并未引用它）。
