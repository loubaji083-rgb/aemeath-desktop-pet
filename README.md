# 爱弥斯 · 桌面宠物（Aemeath Desktop Pet）

> 一个**零依赖、零构建**的开源桌面宠物：原创 Q 版动态形象 + 点击微交互 + DeepSeek 文字聊天 + 浏览器语音对话 + 你自己声音的训练工具链。
>
> **仅供个人娱乐与技术学习使用，禁止商用。使用前请务必阅读 [docs/RED-LINES.md](docs/RED-LINES.md)（使用红线）。**

---

## 这个项目是什么

爱弥斯是一个跑在浏览器里的桌面宠物小玩具：一个 Q 版的原创角色待在你的屏幕右下角，会呼吸、会眨眼、会跟着你的鼠标看，你戳她的头/脸/手/身体会有不同的反应，双击会长动作，拖着能换位置，长时间不理会自己发呆、打瞌睡。

她还能陪你说话：

- **文字聊天**：接你自己的 DeepSeek API Key，流式输出，逐字往外蹦。
- **语音对话**：说话 → 浏览器语音识别转文字 → 发给 DeepSeek → 回复用浏览器 TTS 念出来，念的时候嘴巴会跟着动。
- **声音训练工具链**：给你一套「用你自己的声音训练一个 TTS 声线」的流程骨架（数据集规范、校验脚本、清单生成、后端对接）。**仓库里不含任何预训练模型、声线或音频。**

## 这个项目不是什么

说清楚边界比说功能更重要：

| ❌ 不是 | 原因 |
|---|---|
| 不是某个游戏角色的官方/非官方移植 | 形象是 Canvas 程序化**原创绘制**（大头小身的 Q 版），人设提示词是**原创撰写**的「类型化语气引擎」，不含任何具体作品的立绘、Live2D 模型、台词原文或语音 |
| 不是一个声音克隆器 | 仓库不打包任何权重、任何声线、任何音频，也不提供一键克隆。训练那部分只给流程和校验工具 |
| 不是「已经训练好的爱弥斯声音」 | 你最初的设想是「用现成声线训一版声音」。这一步在**合规上做不到**：把真人（尤其声优）的声音拿去训练并公开发布，在中国受《民法典》第 1023 条保护、在日本受声优「声の権利」与事务所条款约束，也会违反平台 ToS。所以本项目把它改成了「**给你工具，你自己投喂你有权使用的声音**」 |
| 不是商业产品 | 见 `LICENSE`（非商业许可）与 `docs/RED-LINES.md` |

## 功能一览

| 模块 | 能力 | 实现方式 |
|---|---|---|
| 形象 | Q 版大头小身（约 2.6 头身），分层骨骼 + 弹簧插值、呼吸、眨眼、头发延迟跟随、口型同步 | `web/js/pet/` 纯 Canvas 2D 程序化绘制，**零图片素材** |
| 微交互 | 点头顶/点脸/点手/点身体、双击、长按、拖拽、落下、鼠标跟随、随机待机、打招呼、睡觉、唤醒，共 12 种动作 | `PetUI.trigger(action)`，动作可被冷却与降幅（`prefers-reduced-motion`） |
| 情绪 | 11 种 mood（idle/happy/shy/surprised/sad/angry/sleepy/excited/think/listen/speak） | `PetUI.setMood()`，事件驱动；合法清单见 `web/js/pet/moods.js` 的 `MOODS` |
| 聊天 | DeepSeek `/chat/completions`，SSE 流式，可中断，历史裁剪与本地持久化 | `web/js/chat/`，`fetch` + 手写 SSE 解析 |
| 人设 | 4 个原创预设（活泼陪伴 / 温柔治愈 / 俏皮吐槽 / 冷静可靠）+ 可自定义角色卡；有「去 AI 腔」后处理 | `web/js/persona/`，见 [docs/PERSONA.md](docs/PERSONA.md) |
| 语音出 | 浏览器 `speechSynthesis`（开箱即用）+ 3 种外部 HTTP TTS 适配器 | `web/js/voice/browser-tts.js`、`http-tts.js` |
| 语音入 | `SpeechRecognition` 连续/按住说话，中间结果实时显示 | `web/js/voice/stt.js` |
| 声音训练 | 数据集规范、WAV/FLAC 头解析校验、清单生成、后端提交/轮询、配方导出 | `voice-training/` + `web/js/training/` |

## 快速开始

**唯一前置要求：Node.js ≥ 18**（只用来起一个本地静态服务器；运行时本身零依赖）。

```bash
git clone <你的仓库地址> aemeath-desktop-pet
cd aemeath-desktop-pet
node tools/serve.mjs
```

然后浏览器打开终端里打印的地址（默认 **http://127.0.0.1:18340/**）。

> ⚠️ **不能直接双击 `web/index.html`**。本项目用原生 ES Module，`file://` 协议下浏览器会以 CORS 为由拒绝加载模块，页面会白屏。必须走 `http://`。

详细图文步骤、每一项设置的作用、常见问题，见 **[docs/USAGE.md](docs/USAGE.md)**。

### 让它能聊天（1 分钟）

1. 打开左侧工具栏的 **⚙️ 设置**（或按 `Ctrl+4`）。
2. 「DeepSeek 接入」里填入你的 API Key（[在这里申请](https://platform.deepseek.com/)）。
3. 点「测试连接」，看到 `✅ xxx ms` 就成功了。
4. 按 `Ctrl+1` 回到聊天面板，开始对话。

> 🔐 API Key **只保存在 `sessionStorage`**：关掉标签页就失效，不写 `localStorage`、不进导出文件、不硬编码。刷新页面需要重填，这是故意的。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+1` / `2` / `3` / `4` | 打开/关闭 聊天 / 语音 / 训练 / 设置 面板 |
| `Ctrl+.` | 关闭全部面板 |
| `Esc` | 关闭全部面板 |
| 拖拽桌宠 | 移动位置（自动记住） |

## 目录结构

```
aemeath-desktop-pet/
├── web/                        # 前端主体（零依赖、原生 ES Module）
│   ├── index.html              # 唯一入口
│   ├── css/
│   │   ├── app.css             # 外壳：面板、主题、气泡、Toast
│   │   └── pet.css             # 桌宠画布层
│   └── js/
│       ├── app.js              # 主控：装配、设置绑定、面板交互
│       ├── core/               # 事件总线、设置与密钥、存储、DOM 工具、面板
│       ├── pet/                # 原创 Q 版角色：骨骼、绘制、互动、情绪
│       ├── chat/               # DeepSeek 客户端 + SSE 流式解析
│       ├── persona/            # 原创语气引擎 + 预设
│       ├── voice/              # TTS（浏览器/HTTP）+ STT
│       └── training/           # 声音训练工具链的前端对接层
├── voice-training/             # 声音训练：规范、校验脚本、清单模板
│   ├── SCHEMA.md               # 数据集规范（必读）
│   ├── scripts/                # 纯 Node 校验/生成脚本（无依赖）
│   └── data/                   # ← 你的素材放这里，已被 .gitignore
├── tools/                      # 静态服务器 + 自检脚本
├── tests/                      # node:test 单元测试
├── docs/
│   ├── USAGE.md                # 使用说明（安装、配置、排错）
│   ├── RED-LINES.md            # ⚠️ 使用红线（必读）
│   ├── PERSONA.md              # 语气引擎说明 + 怎么导入你自己的角色卡
│   └── CONTRACT.md             # 内部接口契约（改代码前看这个）
└── plugin/                     # DSH 插件封装（可选）
```

## 跑测试

```bash
node --test tests/*.test.mjs
```

零依赖，纯 `node:test`，不需要 `npm install`。测试覆盖事件总线语义、设置与敏感值隔离、DeepSeek 请求构造与 SSE 分块解析、语气引擎纯函数、桌宠动作与渲染几何、训练清单校验与工具链幂等性、模块导出契约。

> ⚠️ 用 `tests/*.test.mjs` 而**不是** `node --test tests/` —— Node 22 下后者会报 `Cannot find module`。

除了单元测试，仓库还有几层**自检**（CI 里也跑，见 `.github/workflows/ci.yml`）：

```bash
node tools/selfcheck-http.mjs       # 静态服务器能起来、资源都能 200
node tools/selfcheck-modules.mjs    # 模块图能加载、导出契约成立
node tools/selfcheck-dom.mjs        # index.html 与 JS 的选择器 / 设置键一致
node tools/smoke-app-import.mjs     # web/js/app.js 整条模块图可链接（顶层无副作用）
node tools/smoke-pet-frame.mjs      # 形象几何自检：包围盒在画布内、脸部有绘制、命中区自洽
node tests/run-web-tests.mjs        # 聚合入口（四关，带通过数门槛）
```

**像素级复核**（可选，需要 Pillow）：把某一帧的真实 Canvas 指令流回放成 PNG，用来「真的看一眼」形象对不对 ——

```bash
node tools/dump-pet-frame.mjs --mood idle
python tools/rasterize-canvas.py tools/samples/frame-idle.json tools/samples/frame-idle.png --scale 2
```

`tools/samples/` 里已经放了一份基准样本（`frame-idle.json` / `frame-idle.png`），改渲染后可以对照。

想把多个情绪并排看，用对照表工具（每一格务必用**同一个 `--scale`**，否则格子大小会不一致）：

```bash
for m in idle happy shy surprised sad angry; do
  node tools/dump-pet-frame.mjs --mood $m --out /tmp/frame-$m.json
  python tools/rasterize-canvas.py /tmp/frame-$m.json /tmp/frame-$m.png --scale 1
done
python tools/contact-sheet.py tools/samples/contact-sheet.png idle,happy,shy,surprised,sad,angry --dir /tmp
```

> 注意：`tools/rasterize-canvas.py` 用**非零环绕规则**（和浏览器一致）填充路径，而不是 PIL `ImageDraw.polygon()` 的偶奇规则 —— 两者对**自相交**路径结果不同（本项目踩过：`capsule()` 曾两段弧扫同一侧，浏览器里也只填出半个宽度）。改这个文件时别把 `fill_nonzero()` 换回去。

## 自己动手做一版声音（简版）

完整流程见 `voice-training/SCHEMA.md` 与 `voice-training/scripts/README.md`。

```bash
# 1. 把你的录音（wav/flac，单声道，≥16kHz，3–15 秒/条，低底噪）放进
#    voice-training/data/
# 2. 生成清单模板
node voice-training/scripts/make-manifest.mjs
# 3. 校验（时长、采样率、重复文件哈希、授权字段是否填全）
node voice-training/scripts/validate-dataset.mjs
# 4. 按 scripts/README.md 部署你自己的训练后端，然后在插件的「训练」面板填端点地址提交
```

**再说一次**：只能用**你自己的声音**，或你已取得**明确书面授权**的声音素材。详见 `docs/RED-LINES.md`。

## 隐私

| 数据 | 存在哪 | 会不会离开你的机器 |
|---|---|---|
| API Key | 浏览器 `sessionStorage`（关标签页即失效） | 只作为 `Authorization` 头发给你配置的 LLM 端点 |
| 对话内容 | `localStorage`（可一键清空/关闭记忆） | 发给 DeepSeek；本项目不代理、不中转、不留存 |
| 桌宠位置 / 你的偏好 | `localStorage` | 不会 |
| 训练音频 | 你自己的磁盘 `voice-training/data/` | 只会发给你自己配置的训练后端 |

「设置 → 数据与隐私」里有：一键导出（**不含密钥**）、清空聊天记录、恢复默认设置。

## 作为 DSH 插件使用（可选）

`plugin/` 是对 [DSH](https://github.com/) 的薄封装，用来在 DSH 内打开这个桌宠。安装与限制见 `plugin/README.md`。

主干（`web/` + `tools/`）完全不依赖 DSH，删掉 `plugin/` 也能独立运行。

## 开发说明

- 改代码前请先读 `docs/CONTRACT.md`（接口契约）与 `web/js/core/events.js`（事件表）。
- 零运行时依赖是硬约束：**不要引入 npm 包**，不要加构建步骤。
- 自检脚本：
  ```bash
  node tools/selfcheck-dom.mjs   # 校验 index.html 与 JS 的选择器/设置键契约
  node --test tests/*.test.mjs   # 单元测试
  ```

## 免责声明

本项目**仅供个人娱乐与技术学习**，禁止商用。它与任何游戏、动画、公司、声优**没有隶属或合作关系**，也不包含任何第三方作品素材。

**最重要的三条：**

1. 不要拿你没有权利的真人声音（尤其声优、主播、公众人物）去训练或发布。
2. 不要把生成的语音用于冒充他人。
3. 不要提交训练数据或密钥到仓库。

完整红线见 **[docs/RED-LINES.md](docs/RED-LINES.md)**。使用本项目即表示你已阅读并同意其中全部条款。

## 许可

见 [LICENSE](LICENSE)（非商业许可）。第三方训练后端（GPT-SoVITS、Bert-VITS2 等）各有自己的许可，本项目不为其背书。
