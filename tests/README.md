# tests/ —— 怎么跑、为什么这么跑

本仓库是**零 npm 依赖**的：没有 `npm install`，没有测试框架，全部用 Node 内置的
`node:test` + `node:assert/strict`。仓库要求的 Node 版本是 `^22.19.0 || >=24.0.0`
（见 `plugin/package.json` 的 `engines`）。

---

## 一条命令跑全部

```bash
node tests/run-web-tests.mjs            # 四关全跑
node tests/run-web-tests.mjs --fast     # 跳过第 1 关（不起 HTTP 服务，省时间）
node tests/run-web-tests.mjs --only=4   # 只跑第 N 关
```

四关的顺序是「从外到内」，前一道失败就没必要跑后一道：

| 关 | 命令 | 抓什么 |
|---|---|---|
| 1 | `node tools/selfcheck-http.mjs` | 真起静态服务，把 `index.html` 引到的每个资源都拉一遍；目录穿越必须被挡 |
| 2 | `node tools/selfcheck-modules.mjs` | 真 `import()` 每个模块，核对导出契约与 PetUI 的 12 个动作 id |
| 3 | `node tools/selfcheck-api.mjs` | 真 `import()` 核对 app.js 用到的成员；含 `busy.js` 再导出守卫 |
| 4 | `node --test tests/*.test.mjs` | 单元语义 + 契约哨兵 |

只跑单测：

```bash
node --test tests/*.test.mjs
node --test tests/persona.test.mjs          # 单文件
```

---

## ⚠️ 两条必须记住的命令行约束

### (a) 不要写 `node --test tests/`

在 Node 22.23.2 下它直接报错：

```
Error: Cannot find module 'D:\...\aemeath-desktop-pet\tests'
  code: 'MODULE_NOT_FOUND'
# fail 1
```

Node 把 `tests` 当**入口模块**去 require，不认目录（加尾斜杠也一样）。
必须显式给 glob：`tests/*.test.mjs`，或让 Node 自己展开 `'tests/**/*.test.mjs'`。

### (b) 不要只看退出码

`node:test` 的退出码和 `# fail` 都不足以判定「真的全绿」：

- **全 skip 时退出码仍然是 0**；
- **`# fail` 只统计顶层 subtest**，子测试的 `not ok` 会被漏计。

所以 `run-web-tests.mjs` 与 CI 都额外复核 TAP：

```
# fail 必须为 0
# pass 不得低于 60（用例被跳过 / 文件没被加载时这个数会塌）
not ok 行数 - TODO 行数 - SKIP 行数 必须为 0
```

注意 **`not ok` 行是缩进的**（两个空格），用 `^not ok` 匹配会全部漏掉子测试。
正确的正则是 `^[[:space:]]*not ok [0-9]+`（POSIX）或 `/^\s*not ok \d+/m`（JS）。

### (c) 涉及「模拟时间」的测试必须写完就重复跑

单跑一次绿，不代表它稳定。本仓库的瓶颈测试是 `tests/pet.test.mjs` 的 12 个动作那条，
它第一次写完时**每 3~6 次全量运行就红 1~2 次**，根因全部是「测试对时序的假设」而不是实现缺陷：

- `web/js/pet/index.js:358-368` 有**随机待机调度器**：`idleTimer += dt*1000` 累计到
  `TIMING.idleActionMinMs`（`web/js/pet/constants.js:201`，9000ms）就会自动
  `trigger('idle-random')`。于是「一个会话里连播 12 个动作」到第 4 轮就会撞上它。
- `trigger()` 的拒绝原因**不止「动作在播」**：`web/js/pet/index.js:259-272` 的
  `rig.trigger()` 还做 `ACTION_COOLDOWN` 去抖（`web/js/pet/constants.js:174-187`，
  `greet:2600`、`idle-random:5200`、`long-press:1400`…）。排空**动画**不等于排空**冷却**：
  greet 的 `dur:1900` 但冷却 2600ms，只推 1.65s 仍会被拒。
- `getDebugState().playing` 是**数组**（如 `['greet']`），不是布尔；`if (playing)` 会把空数组当「在播」。

结论（写这类测试时照做）：
1. **不要在一个会话里靠累计推帧来「排空」** —— 累计时间会跨过调度器的阈值。每个动作前
   `unmount()` + `mount()` 重置，既是干净状态也是确定状态。
2. 排空要**同时覆盖动画与冷却**（推够 max(dur, COOLDOWN)）；且排空总时长要**留在
   `idleActionMinMs` 以下**，否则调度器会插进来。
3. 「播放中重复触发应被拒」这类断言，**两次 trigger 之间一帧都不要推**，靠 `loop:true`
   的动作（如 `long-press`）保证它确实还在播。
4. 涉及时间/随机的测试，**至少连跑 5~10 次全量**再宣布稳定。

### (d) 怀疑某个文件坏了之前，先确认它没在被别人写

四个模块是并行人写的。我遇到过：`web/js/pet/constants.js` 连续多次 `import()` 报
`SyntaxError: Unexpected token 'export'`，而同一份字节复制到外部目录后 `node --check` 却能
exit 0 —— 当时该文件的 mtime 正在变化（队友在修另一个问题），我读到的是**写了一半的快照**。

判据与纪律：
- `node --check` 通过**不能**作为「这个文件可被 import」的证据 —— 以 `import()` 实测为准；
- 怀疑并发写时，**重读文件并核对 mtime 是否变化**，再做结论，别直接报 blocker；
- 用 Node 脚本或 `read`/`write`/`edit` 工具读写含中文的文本文件。
  **Windows 上不要用 PowerShell `Get-Content -Raw` / `Set-Content`**：它按 ANSI(GBK) 解码
  UTF-8，会把中文注释变成 U+FFFD 并吞掉行结构（本项目已经因此毁过一次
  `web/js/pet/constants.js`）。

**最终验收前必须先「冻结写者」**：本项目已经出现过三次「测试跑到一半别人正在改代码」
的假红（`tests/pet.test.mjs` 的动作用例、以及 training 哨兵），每次都白查十几分钟。
发布前的最后一遍验证应当是：确认所有协作者已停手 → `Get-ChildItem web/js/**/*.js` 的
mtime 已稳定 → 连跑 5~10 次全量 → 再取结果。

---

## 测试文件一览

| 文件 | 覆盖 |
|---|---|
| `events.test.mjs` | `core/events.js`：on/once/off/emit、disposer、订阅者抛错隔离、AppEvents 23 个键与契约逐一比对 |
| `settings.test.mjs` | `core/settings.js`：DEFAULTS、get 回落语义、类型强制、敏感键（`getSecret`/`setSecret`/不进 `all()`）、onChange、reset |
| `lead-settings.test.mjs` | settings 的「任何已登记键都不得把调用方哨兵当结果返回」遍历式回归 |
| `deepseek.test.mjs` | `chat/deepseek.js`：请求体构造（注入 `fetchImpl` mock）、SSE 分片解析、错误分级、abort 语义；零真实网络 |
| `persona.test.mjs` | `persona/index.js`：buildSystemPrompt 按小节断言、polish 的元叙述清理、splitBubbles 合并阈值、预设注册 |
| `training.test.mjs` | `training/index.js`：manifest 校验的错误码/警告码矩阵、路径安全、时长区间、导出配方、submit/poll |
| `pet.test.mjs` | `pet/index.js`：真实运行时对象、12 个动作、hitTest、lookAt、setMouth、getDebugState 快照。**时序敏感**，见 (c) |
| `plugin.test.mjs` | `plugin/index.js` + `plugin/static-server.mjs`：路径安全、信任校验 fail-closed、两条注入通道、disposer 释放 |
| `serve-cli.test.mjs` | `plugin/serve-cli.mjs`：参数解析（值不被吃掉）、真起服务托管 index.html、越界 4xx |
| `app-modules.test.mjs` | **白屏级防回归**：`core/busy.js` 必须再导出 dom.js 的 `$`/`$$`/`el`/`toast`/`formatTime`、app.js 模块图可加载、静态 import 表逐个可解析、三个 tools 脚本退出码为 0 |
| `toolchain.test.mjs` | `voice-training/scripts/`：真跑 `make-manifest` / `validate-dataset` 两个 CLI。合成 WAV → 清单幂等（手填字段不被冲掉）→ 删文件后清单收敛 → `--check` 一致/不一致 → 各退出码（0/1/2/3）→ 时长越界默认只警告、`--strict-durations` 才报错 → **工具链自己生成的骨架 license 必须被红线拦住** → `isPlaceholder()` 的 Node/浏览器双份实现结论一致。全部在 `mkdtempSync` 临时目录里跑，不碰仓库 |

### 不在 `node --test` 里、但值得知道的两个几何工具

| 命令 | 用途 |
|---|---|
| `node tools/smoke-pet-frame.mjs` | 画面几何自检：解析绘制指令算包围盒，判定是否溢出画布；`--top` 打印最靠上的 8 条绘制 + 变换矩阵 |
| `node tools/probe-pet-pixels.mjs` | **像素级**复核：解码渲染出的 PNG，量「真正被画出来的墨迹包围盒」与四边留白。与 `smoke-pet-frame` 是两套独立口径，互为交叉验证 |

---

## 关于 `{ todo: '…' }` 哨兵

对于「已确认是实现方缺陷、但当前无人修」的问题，我们不删断言、也不放宽期望值，
而是把它写成 **TODO 哨兵**：

```js
test('占位值出现在后缀位置也必须被拒（DEFECT 回归哨兵）', { todo: 'DEFECT: isPlaceholder 只匹配前缀形态' }, () => {
  assert.equal(validateManifest(m).ok, false);   // 期望值保持严格
});
```

失败时输出 `not ok … # TODO <原因>`，计入 `# todo` 而**不计入 `# fail`**，
于是「绿灯」仍然可信，而缺陷一旦被修好，这条会自动转绿 —— 那时把 `{ todo }` 摘掉即可。

**当前没有哨兵**（`{ todo }` 数量为 0，全量 `# todo 0`）。历史上出现过两条，都已修好并转成硬断言：

1. `tests/training.test.mjs` 的 `isPlaceholder` **后缀**形态（`'来源：待填'` 漏判）—— 授权红线可被一句话绕过。
2. `tests/toolchain.test.mjs` 的 `isPlaceholder` **占位标签**形态（`'示例占位：请改写为…'` 漏判）——
   这条更难看：**工具链自己生成的骨架清单能通过它自己的红线校验**（`make-manifest` 生成 → `validate-dataset` 放行）。
   修法是两边同步追加「占位标签 + 冒号 + 正文」判定：只查冒号左边的标签是否以占位词开头且足够短。

> 这两条都属于同一类：**边界正则在「占位词右侧紧接汉字」时会漏判**。
> 改 `isPlaceholder` 时必须同时改 `voice-training/scripts/validate-dataset.mjs` 与
> `web/js/training/index.js`（有意双份实现），`tests/toolchain.test.mjs` 会对两边同时下断言。

---

## 负面验证（自检脚本必须做这件事）

一个自检脚本「退出码 0」可能是**因为它什么都没检查**。所以每次新增/修改自检脚本，
都要做一次注入式负面验证：**故意改坏一个导出，确认脚本退出码变成 1**。

已做过的验证（2026-02，Node 22.23.2）：把 `web/js/core/busy.js` 末行从
`export { $, $$, el, on, formatTime, toast } from './dom.js';` 改回 `export { on };`

| 命令 | 结果 |
|---|---|
| `node tools/selfcheck-api.mjs` | exit 1，`✗ Busy 缺: $, $$, el, formatTime, toast` |
| `node tools/smoke-app-import.mjs` | exit 1，`SyntaxError: The requested module './core/busy.js' does not provide an export named '$'` |
| `node --test tests/app-modules.test.mjs` | `# fail 5` |
| `node tests/run-web-tests.mjs --fast` | `❌ 2 关失败`，exit 1 |

改回后全部恢复绿色。

---

## CI

`.github/workflows/ci.yml` 在 Node 22 与 24 上跑上述全部关卡（Ubuntu，无 `npm install`），
并在最后跑一条 `node voice-training/scripts/validate-dataset.mjs --help` 冒烟。
