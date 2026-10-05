# 内部接口契约 v1（所有并行开发者必须遵守）

> 这份文件是唯一的事实来源。任何一方要改这里的签名，必须先改本文件再改代码。
> 目标运行环境：**现代浏览器（Chromium/Edge/Firefox 最新版）**，原生 ES Module，**零构建、零 npm 依赖**。
> Node.js（`node:test`）只用于跑纯逻辑单测，不参与运行时。

## 0. 项目立足点（硬约束）

- 仓库**不包含**任何第三方游戏/动画/声优的素材、语音、模型、台词文本。形象为**原创 Q 版 Canvas 程序化绘制**。
- **不内置任何预训练声线/声音克隆权重**。TTS 默认走浏览器内置 `speechSynthesis`；用户可自行接入外部 HTTP 端点。
- 语音训练是**用户自备数据的工具链**，训练数据与产物全部落在 `voice-training/data/`，已被 `.gitignore` 排除。
- 零运行时依赖、零网络请求（除用户自己配置的 LLM/语音端点）。

## 1. 目录归属（写权限边界，不要越界）

| 归属 | 路径 | 负责人 |
|---|---|---|
| A | `web/js/pet/**`、`web/css/pet.css` | pet 渲染 + 互动 |
| B | `web/js/chat/**`、`web/js/persona/**` | 聊天 + DeepSeek + 人设 |
| C | `web/js/voice/**`、`web/js/training/**`、`voice-training/scripts/**`、`voice-training/manifests/**` | 语音 + 训练 |
| D | `plugin/**`、`tests/**`、`.github/**` | DSH 插件 + 测试 |
| Lead | `web/index.html`、`web/css/app.css`、`web/js/core/**`、`web/js/app.js`、`docs/**`（除本文件外可读可写）、`README.md`、`LICENSE`、`.gitignore` | 集成与外壳 |

**只读区**：`docs/CONTRACT.md`（本文件），以及不属于你的目录。需要别人的能力时，调用下面约定的 API，**不要直接改别人的文件**。

## 2. HTML 骨架（Lead 提供，A/B/C 只能按此查询，不得改动 index.html）

```html
<div id="app" class="app">
  <div id="pet-stage" class="pet-layer">            <!-- 桌宠画布所在层，可拖拽 -->
    <div id="pet-canvas-wrap" class="pet-canvas-wrap">
      <canvas id="aemeath-canvas" width="360" height="480"></canvas>
      <div id="pet-reminder" class="pet-reminder hidden"></div>   <!-- 桌宠头顶气泡 -->
    </div>
  </div>

  <!-- 左侧竖直工具栏：点击开/关面板。data-panel 值与 Panel id 一致 -->
  <nav id="panel-dock" class="panel-dock">
    <button class="dock-btn" data-panel="chat"    title="聊天">…</button>
    <button class="dock-btn" data-panel="voice"   title="语音">…</button>
    <button class="dock-btn" data-panel="train"   title="声音训练">…</button>
    <button class="dock-btn" data-panel="settings" title="设置">…</button>
  </nav>

  <aside id="panel-chat" class="panel" data-panel="chat">…</aside>
  <aside id="panel-voice" class="panel" data-panel="voice">…</aside>
  <aside id="panel-train" class="panel" data-panel="train">…</aside>
  <aside id="panel-settings" class="panel" data-panel="settings">…</aside>

  <div id="toast-root" class="toast-root"></div>
</div>
```

- `document.body` 上通过 `data-theme="light|dark"` 与 `data-mood="<mood>"` 暴露状态。
- 面板显隐：`hidden` class → CSS `display:none`。
- 所有可持久化控件统一用 `data-setting="<key>"`（见 `js/core/settings.js` 的 `DEFAULTS`）。

## 3. 事件契约（`web/js/core/events.js`，Lead 提供）

```js
// 订阅返回取消订阅函数
export function on(type, handler)      // handler(payload)
export function once(type, handler)
export function emit(type, payload)
export function off(type, handler)
export const AppEvents = {
  READY: 'app:ready',
  PET_CLICK: 'pet:click',            // { part, x, y, count }
  PET_DRAG_START: 'pet:drag:start',
  PET_DRAG_END: 'pet:drag:end',
  PET_POKE: 'pet:poke',              // { part }
  PET_MOOD: 'pet:mood',              // { mood, reason }
  PET_BUBBLE: 'pet:bubble',          // { text, ms }  —— A 侧订阅，用于头顶气泡
  PET_SPEAK_START: 'pet:speak:start',// { text }
  PET_SPEAK_END: 'pet:speak:end',
  PET_LISTEN_START: 'pet:listen:start',
  PET_LISTEN_END: 'pet:listen:end',
  PET_THINK: 'pet:think',            // { on: boolean }
  CHAT_SEND: 'chat:send',            // { text }
  CHAT_DELTA: 'chat:delta',          // { text }
  CHAT_DONE: 'chat:done',            // { text, usage, aborted }
  CHAT_ERROR: 'chat:error',          // { message, detail }
  VOICE_TTS_START: 'voice:tts:start',
  VOICE_TTS_END: 'voice:tts:end',
  VOICE_STT_RESULT: 'voice:stt:result', // { text, final }
  VOICE_STATE: 'voice:state',        // { speaking, listening }
  PANEL_TOGGLE: 'panel:toggle',      // { panel, open }
  SETTINGS_CHANGED: 'settings:changed', // { key, value, all }
  TOAST: 'ui:toast',                 // { text, kind: 'info'|'ok'|'warn'|'error', ms }
};
```

## 4. PetUI —— A 必须导出（`web/js/pet/index.js`）

```js
/** @typedef {'idle'|'happy'|'shy'|'surprised'|'sad'|'angry'|'sleepy'|'excited'|'think'|'listen'|'speak'} Mood */

export const PetUI = {
  version: '1.0.0',
  /** 挂载到 Lead 提供的 canvas 上；可重复调用，幂等。 */
  mount(canvas /* HTMLCanvasElement */, opts = { scale: 1 }),
  /**
   * 逐帧渲染，由 Lead 的 RAF 循环驱动。
   * **dt 单位是秒**（canonical），内部按 0~0.1s 截断以保护弹簧；
   * 为容错，>0.5 的数视为「调用方误传毫秒」并自动 /1000。
   */
  update(dt /* seconds */),
  unmount(),
  /** 触发一次性动作，返回 Promise<boolean>（true=有该动作） */
  trigger(action /* string */),
  /** 设置情绪（持久到下一次改变） */
  setMood(mood /* Mood */),
  getMood(),                       // -> Mood
  /** 点击区域命中测试（canvas 逻辑坐标，原点左上，范围 0..CANVAS_W / 0..CANVAS_H） */
  hitTest(x, y),                   // -> 'head'|'face'|'body'|'hand'|'hair'|'none'
  /**
   * 鼠标跟随。坐标口径与 hitTest 完全一致：**canvas 逻辑坐标**，
   * 由 Lead 用 `getBoundingClientRect()` 换算（CSS 像素 ≠ canvas 逻辑像素）。
   */
  lookAt(x, y),                    // -> void
  /** 说话口型同步；0..1 */
  setMouth(value),
  /** 头顶气泡由 PetUI 内部订阅 PET_BUBBLE 实现，无需外部调用 */
  /** 可选：外部 Live2D 模型接管（未实现时返回 false，走 Canvas 回退） */
  attachLive2D(model /* object */),// -> boolean
  /** 供调试/测试读取当前动画参数 */
  getDebugState(),                 // -> object（可序列化）
};

/** A 必须至少实现这 12 个动作 id */
export const ACTIONS = [
  'tap-head',      // 摸头：眯眼 + 蹭
  'tap-face',      // 戳脸：惊讶 + 鼓腮
  'tap-body',      // 戳身体：扭动 + 害羞
  'tap-hand',      // 牵手：抬手 + 开心
  'double-tap',    // 双击：跳一下 + 星星眼
  'long-press',    // 长按：靠过来 + 蹭手心
  'drag',          // 拖拽：身体晃 + 头发飘
  'drop',          // 落下：回弹 + 站定
  'idle-random',   // 随机小动作（打哈欠/看四周/整理头发）
  'greet',         // 打招呼
  'sleep',         // 睡觉（呼吸变慢）
  'wake',          // 醒来（伸懒腰）
];
```

**PetUI 要求**：60fps；参数弹簧插值（不使用 CSS 动画）；眨眼按泊松间隔 + 二次眨眼；呼吸正弦；头发/衣服下摆延迟跟随；眼神跟随鼠标并限制最大偏角；`prefers-reduced-motion` 时降低幅度；纯 Canvas 2D 绘制，**分层绘制顺序**：后发 → 身体 → 手臂 → 服饰 → 头 → 脸 → 眼 → 前发 → 特效。

## 5. Chat 模块 —— B 必须导出

`web/js/chat/index.js`
```js
export const Chat = {
  version: '1.0.0',
  init(opts = {}),
  /** 发送一条用户消息，返回 assistant 全文（失败抛 Error） */
  send(text /* string */),          // -> Promise<string>
  abort(),
  clear(),                          // 清空上下文
  getHistory(),                     // -> Array<{role,content,ts}>
  /** 供语音模块复用：把识别结果当用户输入 */
  // 直接调 send() 即可
};

export class DeepSeekClient {
  constructor({ apiKey, baseUrl, model, temperature, maxTokens, timeoutMs, fetchImpl })
  /** 流式；onDelta(deltaText, fullText)；返回 { text, usage, aborted } */
  async stream(messages, { onDelta, signal })
  /** 非流式 */
  async complete(messages)
}
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';
```

`web/js/persona/index.js`
```js
export const Persona = {
  version: '1.0.0',
  /** 生成 system prompt（纯函数，供单测） */
  buildSystemPrompt({ preset, userName, affection, mood, extraRules }), // -> string
  /** 语气后处理：去除"作为AI"式生硬表达、控制长度、补口头禅（纯函数） */
  polish(text, { preset, mood }),   // -> string
  /** 可选：把回复拆成"气泡句"数组，供桌宠逐句显示 */
  splitBubbles(text),               // -> string[]
  /** 可用预设列表 */
  listPresets(),                    // -> Array<{id,name,description}>
};
export const DEFAULT_PRESET = 'lively-companion';
```

**人设红线（写进代码注释与 README）**：`persona/` 里只放**原创的、类型化的性格描述与说话风格规则**（节奏、句长、口头禅类型、情绪表达方式），**不得**复制任何游戏/动画的台词原文、不得声称还原某个具体角色的官方设定。仓库提供 `presets/` 目录让用户自行导入自己的角色卡。

## 6. Voice 模块 —— C 必须导出

`web/js/voice/index.js`
```js
export const Voice = {
  version: '1.0.0',
  init(opts = {}),
  /** 朗读；返回 Promise<void>，中断时 reject 一个 name==='AbortError' 的 Error */
  speak(text /* string */, { rethrow } = {}),
  stop(),
  /** 开始/停止持续识别；结果通过 VOICE_STT_RESULT 事件抛出 */
  async startListening(),
  stopListening(),
  isSpeaking(),                     // -> boolean
  isListening(),                    // -> boolean
  /** TTS 提供方注册：内置 'browser'，可选 'http-openai'|'http-gptsovits'|'http-edge' */
  registerProvider(id, factory),
  listProviders(),                  // -> Array<{id,name,available}>
  /** 当前生效链路自检，返回 { ok, provider, detail } */
  async selfTest(),
};
export const DEFAULT_TTS_PROVIDER = 'browser';
```

`web/js/training/index.js`（**只做编排与校验，不内置任何权重**）
```js
export const Training = {
  version: '1.0.0',
  /** 校验一份数据集清单对象；返回 { ok, errors:[], warnings:[], stats:{} }（纯函数） */
  validateManifest(manifest),        // manifest = { name, language, license, consent, speakers, clips[] }
  /** 生成一份可用的清单模板（纯函数） */
  createManifestTemplate(opts = {}), // -> object
  /** 分析已上传音频的元信息（时长/采样率/声道/峰值），需 WebAudio */
  async probeAudio(file /* File */),  // -> { duration, sampleRate, channels, peakDb, ok }
  /** 通过外部训练后端提交任务；endpoint 为空则返回 { ok:false, reason:'no-endpoint' } */
  async submitJob({ endpoint, manifest, clips, options }),
  async pollJob({ endpoint, jobId }),
  /** 导出训练产物元数据（不含音频/权重） */
  exportRecipe(manifest, options),   // -> object
};
```

**数据规范**：`voice-training/SCHEMA.md` 由 C 编写；`voice-training/data/.gitkeep` 保留，`data/**` 全部 gitignore。

**命令行工具链**（`voice-training/scripts/`，同样由 C 拥有；纯 Node、零依赖、**不得联网**）：

```js
// make-manifest.mjs
export const EXIT = { OK: 0, ERRORS: 1, USAGE: 2, MISSING: 3, INTERNAL: 70 };
export const SCHEMA_VERSION = 1;
export function collectAudioFiles(dataDir, forcedSpeakerId = ''); // -> [{ abs, rel, ext, speakerId }]
export function probeFile(abs, ext);                              // -> { ok, duration, sampleRate, channels, sha256, bytes } | { ok:false, reason, message }
export function buildManifest({ dataDir, name, language, speaker, previous, outFile }); // -> { manifest, report }
export function manifestsInSync(a, b);                            // -> boolean（--check 用）
```

`validate-dataset.mjs` 提供 `--data`/`--manifest`/`--min-seconds`/`--max-seconds`/`--min-sample-rate`/`--strict-durations`/`--json`/`--quiet`，退出码同样是 `0/1/2/3/70`。

三条硬约束（改这两个脚本时必须守住）：

1. **幂等**：清单已存在时，`name`/`language`/`license`/`consent`/`speakers[].displayName`/`speakers[].consent`/`clips[].text`/`clips[].speaker`/`clips[].split`/`notes` 必须**原样保留**，只刷新由文件决定的字段。用户的手填授权说明不能被脚本冲掉。
2. **`isPlaceholder()` 是有意双份实现**：`voice-training/scripts/validate-dataset.mjs` 与 `web/js/training/index.js` 各有一份，判定必须一致（边界正则形态，可识别「来源：待填」这类**后缀**占位）。改一处必须同步另一处，`tests/toolchain.test.mjs` 会对两边同时下断言。
3. **训练后端 HTTP 契约**以 `voice-training/scripts/README.md` 第 4 节为准（提交/轮询的路径、请求体字段、`jobId|id|job_id` 三种响应键名、404/405 回落）。前端 `Training.submitJob/pollJob` 必须与该文档一致。

## 7. Core（Lead）供 A/B/C 使用

`web/js/core/events.js`：见 §3。

`web/js/core/settings.js`
```js
export const DEFAULTS = { /* 见文件，键名即 data-setting 值 */ };
export const Settings = {
  get(key, fallback), set(key, value), all(), reset(),
  /** 敏感值（apiKey）默认只存内存 + sessionStorage，永不写 localStorage */
  getSecret(key), setSecret(key, value),
  onChange(fn),   // -> unsubscribe
};
```

`web/js/core/store.js`
```js
export const Store = {
  get(key, fallback), set(key, value), remove(key),
  namespace(ns), // -> 隔离的 get/set
};
```

`web/js/core/dom.js`
```js
export const $ = (sel, root=document) => ...
export const $$ = (sel, root=document) => [...]
export function el(tag, props = {}, children = [])  // props: className/text/html/attrs/on
export function on(target, type, handler, opts)     // 返回 off()
export function toast(text, kind = 'info', ms = 2600)
export function formatTime(ts)
export function clamp(v, min, max)
export function escapeHtml(s)
```

`web/js/core/busy.js`（Lead）：面板开关、全局快捷键、气泡通道。

## 8. 统一错误与日志

- 所有对外失败都 `emit(AppEvents.CHAT_ERROR | TOAST)`，并在 `console.warn` 里带 `[aemeath:<模块>]` 前缀。
- 不允许 `alert()` / `confirm()`。不允许 `innerHTML` 拼接未转义的用户输入（用 `textContent`）。
- 不允许在代码中出现 `sk-` 开头的硬编码密钥。

## 9. 测试要求（D 负责框架，各自补测）

- ⚠️ **不要用 `node --test tests/`**：Node 22 下它会报 `Cannot find module '...\tests'`，必须用 `node --test tests/*.test.mjs`（平台无关；CI 也走这一条）。`tests/run-web-tests.mjs` 是带门槛的聚合入口，见 `tests/README.md`。
- 至少覆盖：`Persona.buildSystemPrompt/polish/splitBubbles`、`Training.validateManifest`、`DeepSeekClient` 请求体构造（注入 `fetchImpl` mock）、`Settings` 键集合与 `DEFAULTS` 一致性、`PetUI.getDebugState()` 的静态字段（用最小 DOM stub，若不可行则跳过并说明）。
