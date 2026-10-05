# voice-training/scripts —— 工具链用法与后端契约

这个目录只放**纯 Node、零依赖**的脚本。它们合起来回答三个问题：

1. 我的手头素材**长什么样**？（`make-manifest.mjs` 扫描 + 只读文件头）
2. 它**够不够训练**？（`validate-dataset.mjs` 按规范校验）
3. 怎么把它交给**我自己的训练后端**？（本文件第 4 节的 HTTP 契约）

> **它们不做什么**：不联网、不下载模型/权重/音频、不转码、不裁剪、不训练、不做声音克隆、不写音频。
> 数据规范见 [`../SCHEMA.md`](../SCHEMA.md)。使用红线见 [`../../docs/RED-LINES.md`](../../docs/RED-LINES.md)。

用到的 Node 版本：**≥ 18**（仓库其它部分要求 `^22.19.0 || >=24.0.0`，见 `plugin/package.json`）。
两个脚本都只用 `node:fs` / `node:crypto` / `node:path` / `node:url`，没有第三方依赖。

---

## 1. `make-manifest.mjs` —— 扫描素材，生成/更新清单

```bash
node voice-training/scripts/make-manifest.mjs [选项]
```

| 选项 | 说明 |
|---|---|
| `--data <dir>` | 素材目录，默认 `voice-training/data` |
| `--out <file>` | 清单输出，默认 `voice-training/manifests/dataset.manifest.json` |
| `--name <name>` | 数据集名（**只在清单不存在时生效**；已有清单沿用里面的值） |
| `--language <tag>` | 语言标签，默认 `zh-CN` |
| `--speaker <id>` | 单说话人模式：`data/` 下所有音频都算这个 id |
| `--dry-run` | 只扫描报告，不写文件 |
| `--check` | 不写文件；清单与磁盘不一致 → 退出码 1（可放 CI） |
| `--json` | 以 JSON 打印摘要（机器可读） |
| `--quiet` | 只打印总结 |
| `--help`, `-h` | 帮助 |

退出码：`0` 成功 · `1` 有问题（`--check` 不一致 / 有文件头解析失败）· `2` 用法错误 · `3` 找不到数据目录 · `70` 内部错误。

**它替你做**：

- 递归找音频（`.wav .flac .mp3 .m4a .ogg .opus .webm`），跳过 `node_modules`/`.git`/`output` 等目录与隐藏目录；
- **说话人 id = 相对路径第一级目录名**；`data/` 根目录下的文件归 `speaker-a`；
- 只用**文件头**解析采样率/声道/时长/位深（WAV / FLAC / MP3 三种；其它格式标 `probeError`，不静默漏掉）；
- 算 `sha256`，并在报告里把**重复内容的文件分组**列出来（重复片段会污染训练集）；
- 输出稳定排序的清单（同一个磁盘状态跑两次，diff 为空）。

**幂等性是刻意设计的**（重要）：

> 清单已存在时，脚本会把它读回来，并**原样保留你手填过的字段** ——
> `name` / `language` / `license` / `consent` / `speakers[].displayName` / `speakers[].consent`
> / `clips[].text` / `clips[].speaker` / `clips[].split` / `notes`。
> 只刷新由文件本身决定的字段（`file` / `duration` / `sampleRate` / `channels` / `sha256` / `bytes` / `bitsPerSample`）。
>
> 所以正确顺序是：**先跑一次生成骨架 → 手填授权与转写 → 之后再跑任意次刷新数据**，你填的不会被冲掉。

---

## 2. `validate-dataset.mjs` —— 校验数据集

```bash
node voice-training/scripts/validate-dataset.mjs [选项]
```

| 选项 | 说明 |
|---|---|
| `--data <dir>` | 数据目录，默认 `voice-training/data` |
| `--manifest <file>` | 清单文件；默认依次尝试 `voice-training/manifests/dataset.manifest.json`、`<data>/manifest.json` |
| `--min-seconds <n>` / `--max-seconds <n>` | 单条时长区间，默认 3 / 15 |
| `--min-sample-rate <n>` | 最低采样率，默认 16000 |
| `--strict-durations` | 时长越界按**错误**处理（默认只警告） |
| `--json` | JSON 输出（便于接入 CI） |
| `--quiet` | 只输出总结 |
| `--help`, `-h` | 帮助 |

退出码同样是 `0 / 1 / 2 / 3 / 70`。

**两层校验**：先做清单结构校验（字段、授权、说话人、路径），再逐条打开音频文件做**文件头 ↔ 清单声明的一致性**核对，并查 `sha256` 重复。
完整的检查项对照表在 [`../SCHEMA.md`](../SCHEMA.md) 第 6 节。

`license` 与 `consent` 是**红线字段**：占位值（`待填` / `TODO` / `未知` / `示例`…，
以及「来源：待填」这类**后缀形态**）一律判为错误。这是故意的，别绕过它。

> ⚠️ 这个校验器的 `isPlaceholder()` 与 `web/js/training/index.js` 里的同名逻辑是**有意的双份实现**
> （一个跑在 Node CLI，一个跑在浏览器）。**改一处必须同步改另一处**，
> 否则会出现「CLI 说通过、插件说拒绝」这种最让人抓狂的不一致。
> `tests/toolchain.test.mjs` 会对两边同时下断言。

---

## 3. 一次完整流程（含失败与修复）

```bash
# 0) 把素材放好
mkdir -p voice-training/data/speaker-a
#    → 放入 001.wav ... （3~15s，单声道，≥16kHz，低底噪）

# 1) 生成骨架
node voice-training/scripts/make-manifest.mjs --name my-voice-dataset
#    ✅ 已写出清单：voice-training/manifests/dataset.manifest.json

# 2) 现在就去校验 —— 它会拒绝你（license 还是占位值）
node voice-training/scripts/validate-dataset.mjs
#    —— 错误 ——
#      [license-missing] license: 缺少有效的素材授权说明 license：必须写明素材来源、授权范围与授权人（不接受占位值）
#    exit 1

# 3) 编辑清单：填 license、consent、每条 clip 的 text
#    ★ 只能用编辑器/read/write 工具改；Windows 上不要用 PowerShell
#      Get-Content -Raw / Set-Content 写含中文的 JSON（会按 GBK 解码 → 乱码 → 不可逆）

# 4) 再跑（素材有变动也无所谓，它会刷新 metadata 并保留你的手填字段）
node voice-training/scripts/make-manifest.mjs --quiet
node voice-training/scripts/validate-dataset.mjs
#    ✅ 通过    exit 0

# 5) 之后每次换素材，先核对一致性
node voice-training/scripts/make-manifest.mjs --check
```

---

## 4. 训练后端 HTTP 契约（你来实现服务端）

插件「🎓 训练」面板**不训练**任何东西，它只是把你的数据集元信息 POST 给一个**你自己部署**的端点。
下面是从 `web/js/training/index.js` 的 `submitJob()` / `pollJob()` 反推出来的**准确契约**。

### 4.1 提交任务

```
POST <train.endpoint>
Content-Type: application/json
```

请求体（`submitJob` 组装，见 `web/js/training/index.js:603-614`）：

```json
{
  "schemaVersion": 1,
  "kind": "aemeath-voice-training-job",
  "manifest": {
    "schemaVersion": 1,
    "name": "my-voice-dataset",
    "language": "zh-CN",
    "license": "…",
    "consent": { "obtained": true, "subject": "speaker-a", "form": "written", "scope": "…" },
    "speakers": [ { "id": "speaker-a", "displayName": "…", "language": "zh-CN", "isSelf": true, "consent": {…} } ],
    "notes": "…",
    "clips": [
      {
        "file": "speaker-a/001.wav",
        "speaker": "speaker-a",
        "text": "今天天气不错，我们出去走走吧。",
        "duration": 4.2,
        "sampleRate": 22050,
        "channels": 1,
        "sha256": "…64 位十六进制…"
      }
    ]
  },
  "clips": [ /* 与 manifest.clips 相同形状（stripClip 归一化后的） */ ],
  "options": { /* 训练超参，原样透传 */ },
  "client": {
    "name": "aemeath-desktop-pet",
    "version": "1.0.0",
    "note": "仅提交元数据，不含任何音频二进制；音频是否上传由用户在自己的训练后端决定"
  }
}
```

- `stripClip()` 只保留 `file` / `speaker` / `text` / `duration` / `sampleRate` / `channels` / `sha256` 七个字段（`web/js/training/index.js:526-537`）。
- **`kind` 可以用来做服务端校验**：不认识的 `kind` 直接 400。
- 成功响应（HTTP 2xx）应返回 JSON，任务 id 允许三种键名任一：
  `{ "jobId": "..." }` 或 `{ "id": "..." }` 或 `{ "job_id": "..." }`。
- 失败响应返回非 2xx；`message` 或 `error` 会被读出来展示给用户。

**顺序是硬性的**：客户端会先跑 `validateManifest()`，**清单不合法根本不会发请求**，
直接返回 `{ ok:false, reason:'invalid-manifest', errors:[…] }`。没配端点则返回 `no-endpoint`。
超时默认 30s（`AbortController`）。

### 4.2 轮询状态

```
GET <train.queueEndpoint 或 train.endpoint>/<jobId>      ← 先试这条
GET <train.queueEndpoint 或 train.endpoint>?jobId=<jobId> ← 404/405 时再试这条
```

响应 JSON 可以被识别的字段：

| 语义 | 接受的键 |
|---|---|
| 状态 | `state` 或 `status`（字符串，未知时为 `"unknown"`） |
| 进度 | `progress`（数字；非数字 → `null`） |

其余字段原样放进 `data` 返回给调用方，你可以自由扩展（`logs`、`outputUrl`、`eta`…）。
HTTP 404 / 405 会被当作「这个 URL 形态不对」自动回落到第二种形态；其它非 2xx 直接报错。
超时默认 15s。

### 4.3 音频怎么进你的后端？

**本项目默认不上传音频。** 因为训练素材是隐私资产，而路径本来就在用户自己机器上。
给你的后端两条路：

1. **本机模式**（推荐）：后端与仓库同机，直接按 `manifest.clips[].file` 相对 `voice-training/data/` 读取；
2. **上传模式**：你在自己的后端里另做一个上传接口，由用户自己决定传不传 —— 这不在本仓库的代码路径里。

---

## 5. 常见问题

**Q：为什么 `make-manifest` 说 `exit 1` 但清单还是写出来了？**
因为有几个文件的**文件头解析失败**（`probeError`）。写出来是为了让你在清单里看到具体哪几条坏了；
它会同时把失败原因打到 stdout。修好那些文件再跑一次即可。

**Q：能自动转码/裁剪吗？**
不能，也不想做。转码需要 ffmpeg（非零依赖），裁剪会改变时长语义。
自己用 ffmpeg 处理好再放进 `data/`：`ffmpeg -i in.m4a -ac 1 -ar 22050 out.wav`。

**Q：`--check` 放 CI 合适吗？**
合适 —— 但它需要素材目录存在。CI 里通常没有音频，此时返回 `3`（找不到目录）。
所以要么把 `--check` 放在你本地的 pre-commit，要么在 CI 里先准备好（脱敏的）素材。

**Q：我可以只用 Firefox/Safari 吗？**
工具链只依赖 Node，跟浏览器无关。浏览器侧的语音功能限制见 [`../../docs/USAGE.md`](../../docs/USAGE.md)。

**Q：清单里的 `sha256` 能泄露什么？**
它只是内容指纹。相同内容会被查出重复；无法从指纹反推音频。
不过既然 `data/` 本来就 gitignore，把清单入库不会连带你不想公开的东西。
