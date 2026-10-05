# aemeath-desktop-pet-dsh-plugin

把本仓库的 `web/` 目录（原创 Q 版 Canvas 桌宠 + 聊天 + 语音 + 训练工具链）作为**只读静态站点**
挂到 DSH 已监听的 HTTP 服务上，并在 DSH 页面里注入一个悬浮入口按钮。

- **零运行时依赖**：`dependencies` 与 `devDependencies` 都是空的，只用 Node 内置模块。
- **零构建**：不产出 bundle，直接以原生 ES Module 形式托管 `web/`。
- **不改 DSH 核心**：只用已查证的公开契约（Service `webServer` + Event `webserver/index-inject`）。

---

## 能力边界（请先读这一段，不要读成「已完美集成」）

| 事项 | 本插件 | 说明 |
|---|---|---|
| 托管静态页面 | ✅ | 通过 `ctx.webServer.register({kind:'prefix', path:'/aemeath', handler})` |
| 页面内入口按钮 | ✅ | 双通道注入：Web 形态走 `tapIndex()`，桌面壳走 `webserver/index-inject` 结构化行 |
| DSH **原生**前端面板 / Slot 组件 | ❌ | 有意不做，见下 |
| 修改 DSH 核心 | ❌ | 不需要，也没有 |
| 依赖构建产物 / `dsh.client` 通道 | ❌ | 与「零构建」冲突，有意不用 |

**关于 `dsh.client`**：DSH 官方的前端插件通道（`dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime', ...] }`）
需要基于 `@deepseek-ai/dsh-client-runtime` 等包**编译出客户端 bundle**。本仓库的硬约束是
「零构建、原生 ES Module、零 npm 依赖」，两者直接冲突。所以本插件给出的形态是
**一个独立页面**（点按钮在新标签页打开），而不是嵌进 DSH 侧边栏的原生面板。
这是有意的取舍，不是遗漏。

---

## 安装

```bash
# 从本地目录（开发时）
dsh plugin --profile web add link:/绝对/路径/to/aemeath-desktop-pet/plugin

# 或从 npm
dsh plugin --profile web add aemeath-desktop-pet-dsh-plugin
```

`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，DSH 启动时会按 bundle 层叠加，
把本插件插进目标 profile 的配置树。

卸载 / 禁用：

```bash
dsh plugin --profile web remove aemeath-desktop-pet-dsh-plugin
```

禁用是安全的：本插件注册的所有路由都通过 `ctx.effect()` 收集 disposer，卸载时逐个释放；
注入进页面的那段脚本是**内联脚本 + 自吞 onerror**，不会像 `kind:'script-src'` 那样
在路由消失后把整个 boot 拖崩（见下节）。

---

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `AEMEATH_PREFIX` | `/aemeath` | 静态站点挂载点前缀。`pet`、`/pet`、`/pet/` 都会被规范成 `/pet` |
| `AEMEATH_WEB_ROOT` | （自动） | `web/` 目录的绝对路径。默认从插件目录的上一级找 `web/` |
| `AEMEATH_TRUSTED_HOSTS` | （空） | 逗号分隔的额外可信 Host（默认只信回环地址，见下） |

排查「按钮在，但打开是 404」时先访问健康检查：

```
GET /aemeath/__aemeath_health
→ {"ok":true,"plugin":"aemeath-desktop-pet","prefix":"/aemeath","webRoot":"…\\web","node":"v22.23.2"}
```

`ok:false` 表示没找到 `web/`，此时 `/aemeath/` 返回的是 **503 降级说明页**（含怎么修），
不是静默 404。

---

## 为什么注入要写两条通道（本插件最容易踩坑的地方）

| DSH 形态 | index.html 从哪来 | 生效的通道 |
|---|---|---|
| Web（`dsh web`） | 宿主 `renderIndex()` 渲染 | `ctx.webServer.tapIndex(html => …)` |
| Electron 桌面壳 | 安装包内静态 dist 直接读盘（`dsh-app://app/`） | **只有** `webserver/index-inject` 结构化行 |

两处关键事实：

1. **桌面壳的注入表是宿主启动时一次性收集的**。所以 `root.on('webserver/index-inject', …)`
   必须是 `apply()` 里的**第一件事**，不能推迟到 `root.inject(['webServer'], cb)` 里
   —— 服务就绪晚于收集，行就永远进不了表。本插件按此顺序实现。
2. **不能用 `kind:'script-src'`**。页面侧对 `script-src` 的解释是「加载失败即 reject 整个 boot」，
   而注入表一旦被缓存就没有刷新路径：插件被关掉后路由已注销 ⇒ 404 ⇒ **DSH 起不来**。
   所以本插件推的是**内联 `kind:'script'`**（自行 `createElement('script')` 并吞掉 `onerror`）
   加上一条 `kind:'html'` 的纯 DOM 节点行，由宿主与桌面壳各取所需。

这两条结论不是猜的，是从 `webserver/index-inject` 的事件描述与
`webServer` 服务的精确契约（`cordis_inspect_query`，`platform=host`）以及同类插件的
实际实现里核对出来的。

---

## 安全

- **只读**：不创建、不写入、不修改 `web/` 下的任何文件。
- **路径安全**：`safeRelativePath()` 在解码后统一处理 `..`、`.`、空字节、非法百分号编码、
  盘符、以及 `//host` / `\\host\share` 这类 UNC / 协议相对形态，越界一律拒绝。
- **信任校验（fail-closed）**：`trustRejection()` 默认只放行**回环 Host**；
  带 `Sec-Fetch-Site: cross-site` 的请求、Host 不在信任列表的请求、以及校验器自身出错的情况
  **一律 403**。跨机访问请显式设置 `AEMEATH_TRUSTED_HOSTS`。
- 响应带 `X-Content-Type-Options: nosniff`。

---

## 本地预览（不需要 DSH）

`serve-cli.mjs` 与 DSH 路由**共用同一个** `createStaticHandler`，所以行为一致：

```bash
node plugin/serve-cli.mjs                    # 127.0.0.1:8787
node plugin/serve-cli.mjs --port 9000 --web-root ../web
node plugin/serve-cli.mjs --once             # 服务一个请求就退出（CI 冒烟用）
node plugin/serve-cli.mjs --help
```

它是排查工具，不是 DSH 的一部分：DSH 里由 `index.js` 通过 `ctx.webServer.register()` 挂载。

---

## 对外导出

```js
// plugin/index.js
export const name = 'aemeath-desktop-pet';
export function apply(root) { … }
export const DEFAULT_PREFIX = '/aemeath';
export const LAUNCHER_ELEMENT_ID = 'aemeath-launcher';
export function buildInjectText(prefix) { … }
export function buildInjectRow(prefix) { … }
export function buildInjectRowScript(prefix) { … }
export function buildUnavailablePage(webRoot, prefix) { … }
export default { name, apply };
```

```js
// plugin/static-server.mjs
export function mimeFor(filePath)
export function resolveWebRoot(candidate, opts?)
export function safeRelativePath(requestUrl, opts?)
export function resolveInside(webRoot, relativePath)
export function readStaticFile(webRoot, relativePath)
export function escapeHtml(s)
export function trustRejection(req, opts?)
export function createStaticHandler({ webRoot, prefix, indexFile, trustedHosts, logger })
export const MIME_TYPES
```

```js
// plugin/serve-cli.mjs
export function parseArgs(argv)
export function createServer({ webRoot, prefix, trustedHosts, quiet })
export const DEFAULT_HOST / DEFAULT_PORT / DEFAULT_PREFIX
```
