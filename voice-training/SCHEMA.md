# 声音训练数据集规范（Schema v1）

> 这份文件定义**「你自己投喂声音」这条路怎么走**。读完你就能知道：
> 素材要录成什么样、目录怎么摆、清单（manifest）每个字段是什么意思、
> 工具链会替你检查什么、哪些字段是**碰都不能碰的红线**。
>
> 相关文件：[`scripts/README.md`](scripts/README.md)（工具用法）· [`../docs/RED-LINES.md`](../docs/RED-LINES.md)（使用红线，必读）
>
> **本仓库不含任何权重、声线、音频、预训练模型，也不提供一键克隆。**
> 工具链只做「校验 + 汇总 + 对接你自己的后端」。

---

## 0. 先明确边界（这一段比后面的字段表更重要）

| 能做 | 不能做 |
|---|---|
| 用**你自己的声音**录素材、训练一个只给自己用的桌宠声线 | 拿别人的声音（尤其声优、主播、公众人物）去训练 |
| 用你已取得**明确书面授权**的声音素材 | 把训练产物公开发布、分发、卖 |
| 训练好后在本机桌宠里用这个声线说话 | 用生成的语音冒充他人、或用于任何商业场景 |
| 用本仓库的校验工具检查你自己的数据集 | 用本仓库去下载/爬取任何第三方音频或权重 |

授权说明（`license`）与告知同意（`consent`）是**必填的红线字段**，工具链会硬性拒绝占位值。
详见 [`../docs/RED-LINES.md`](../docs/RED-LINES.md)。

---

## 1. 目录结构

```
voice-training/
├── SCHEMA.md                     ← 你正在读的文件
├── scripts/
│   ├── make-manifest.mjs         ← 扫描素材 → 生成/更新清单
│   ├── validate-dataset.mjs      ← 校验清单 + 音频文件头
│   └── lib/audio-probe.mjs       ← 只读文件头的 WAV/FLAC/MP3 解析
├── data/                         ← ★ 你的音频放这里（整目录已 gitignore，永不入库）
│   ├── speaker-a/
│   │   ├── 001.wav
│   │   ├── 002.wav
│   │   └── ...
│   └── speaker-b/                ← 多人可选；单人也建议放在一个子目录里
└── manifests/
    └── dataset.manifest.json     ← 清单（**可以入库**，它只是元数据）
```

两条硬规则：

1. **`voice-training/data/` 下的所有内容都不进仓库**（`.gitignore` 已排除）。音频是你的隐私资产。
2. **说话人 id 取子目录名**。`data/speaker-a/*.wav` → `speaker: "speaker-a"`；直接放在 `data/` 根目录的文件归为 `speaker-a`。也可以用 `--speaker <id>` 强制单说话人。

---

## 2. 音频规格

| 项 | 要求 | 说明 |
|---|---|---|
| 格式 | `.wav` / `.flac`（**推荐**） | `.mp3` / `.m4a` / `.ogg` / `.opus` / `.webm` 也能进清单，但工具只解析前三种的文件头，其余会标 `probeError` |
| 编码 | WAV 建议 16-bit PCM | 不要用压缩 WAV（ADPCM 等） |
| 采样率 | **≥ 16000 Hz**，目标 **22050 Hz** | 低于 16k 会被判错。22.05k 是多数 TTS 配方（GPT-SoVITS / Bert-VITS2 / VITS）的默认训练采样率 |
| 声道 | **单声道（mono）** | 立体声会被警告 —— 多数方案会丢掉右声道或产生相位问题 |
| 单条时长 | **3 ~ 15 秒**（默认；可调） | 太短学不到韵律，太长对齐容易断。默认下越界只**警告**，加 `--strict-durations` 变**错误** |
| 条数 | **≥ 10 条**（建议 50~200 条，总时长 5~30 分钟） | 少于 10 条会被警告。想效果像样，10 分钟起步 |
| 内容 | 一条一句，句子完整、边界干净 | 不要半句话起头/收尾 |
| 音质 | 低底噪、无混响、无背景音乐、无明显削波 | 手机在安静房间录就够用；别用带 BGM 的录屏 |

**转写文本（`text`）强烈建议填**：多数训练方案需要「音频 ↔ 文本」对齐；缺了会被警告
（`clip-text-missing`），有些方案会直接跑不起来。

---

## 3. 清单（manifest）字段

清单是一份 JSON。**你可以入库它**（它只是指向音频的元数据，不含音频本身）。
下面每个字段都标了「谁生成」。

```json
{
  "schemaVersion": 1,
  "name": "my-voice-dataset",
  "language": "zh-CN",
  "license": "（必填）此处写真实授权说明",
  "consent": {
    "obtained": true,
    "subject": "speaker-a",
    "form": "written",
    "date": "2025-01-01",
    "scope": "仅用于本地个人桌宠语音模型训练，不再分发"
  },
  "speakers": [
    {
      "id": "speaker-a",
      "displayName": "我自己",
      "language": "zh-CN",
      "isSelf": true,
      "consent": {
        "obtained": true,
        "form": "written",
        "date": "2025-01-01",
        "scope": "仅用于本地个人桌宠语音模型训练，不再分发"
      }
    }
  ],
  "clips": [
    {
      "file": "speaker-a/001.wav",
      "speaker": "speaker-a",
      "duration": 4.2,
      "sampleRate": 22050,
      "channels": 1,
      "bitsPerSample": 16,
      "sha256": "…64 位十六进制…",
      "bytes": 185044,
      "text": "今天天气不错，我们出去走走吧。"
    }
  ],
  "notes": "自由备注"
}
```

### 3.1 顶层字段

| 字段 | 类型 | 谁生成 | 规则 |
|---|---|---|---|
| `schemaVersion` | number | 脚本 | 必须是 `1`；缺失只警告，填错直接判错 |
| `name` | string | **你**（脚本给默认值） | 非空。数据集名 |
| `language` | string | 你（默认 `zh-CN`） | 非空。BCP-47 风格标签 |
| `license` | string | **你（红线）** | 必须写明**素材来源 + 授权范围 + 授权人**。占位值（`待填`/`TODO`/`未知`/`示例`…以及「来源：待填」这类**后缀形态**）一律判错 |
| `consent` | object | **你（红线）** | 见下 |
| `speakers` | array | 脚本（你补 `displayName`） | 非空；`id` 不重复 |
| `clips` | array | **脚本** | 可为空（结构合法），但空清单不能训练 |
| `notes` | string | 任意 | 自由备注，不影响校验 |

### 3.2 `consent`（顶层告知同意）

| 字段 | 规则 |
|---|---|
| `obtained` | **必须为 `true`**，否则判错（`consent-not-obtained`） |
| `subject` | 授权对象（一般就是说话人 id） |
| `form` | 授权形式：`written` / `verbal-recorded` / `self` / `other`。缺失只警告，但**强烈建议填** |
| `date` | 授权日期，`YYYY-MM-DD` |
| `scope` | 授权范围。缺失只警告，但**强烈建议填**（例如「仅本地个人使用，不再分发」） |
| `note` | 自由备注 |

### 3.3 `speakers[]`

| 字段 | 规则 |
|---|---|
| `id` | 非空、唯一（大小写不敏感）。建议 `[A-Za-z0-9._-]`，因为它会被写进文件路径 |
| `displayName` | 展示名，随便填 |
| `language` | 该说话人语言 |
| `isSelf` | 是否本人声音 |
| `consent.obtained` | **若显式写了 `false`，直接判错**（`speaker-consent-not-obtained`） |

### 3.4 `clips[]`

| 字段 | 谁生成 | 规则 |
|---|---|---|
| `file` | 脚本 | **相对 `data/` 的相对路径**，用 `/` 分隔。绝对路径、`../` 越界一律判错 |
| `speaker` | 脚本（你可改） | 必须命中 `speakers[].id`，否则判错 |
| `duration` | 脚本 | 秒。越界按警告（`--strict-durations` 时按错误） |
| `sampleRate` | 脚本 | Hz。低于 `--min-sample-rate` 判错 |
| `channels` | 脚本 | `> 1` 警告（建议单声道） |
| `bitsPerSample` | 脚本（WAV 才有） | 位深 |
| `sha256` | 脚本 | 内容指纹。**查重靠它** —— 同内容出现两次会被判错（`audio-duplicate-content`） |
| `bytes` | 脚本 | 文件字节数 |
| `text` | **你** | 该条音频的转写。缺失警告 |
| `probeError` | 脚本 | 只读文件头解析失败的机器可读原因（`unsupported-format` / `invalid-header` / …） |

> **哪些字段是你手填的、跑脚本时不会被冲掉？**
> `name` · `language` · `license` · `consent` · `speakers[].displayName` · `speakers[].consent`
> · `clips[].text` · `clips[].speaker` · `clips[].split` · `notes`
> 其余由文件本身决定的字段（`duration`/`sampleRate`/`channels`/`sha256`/`bytes`…）每次都会被刷新。
> `make-manifest.mjs` 是**幂等**的：先跑一次生成骨架 → 手填授权 → 再跑一次刷新数据，你填的不会被覆盖。

---

## 4. 完整流程（照抄即可）

```bash
# 1) 把录音放进 data/speaker-a/（3~15 秒/条，单声道，wav 或 flac）
mkdir -p voice-training/data/speaker-a

# 2) 生成清单骨架（--name 只在第一次生效）
node voice-training/scripts/make-manifest.mjs --name my-voice-dataset

# 3) 打开 voice-training/manifests/dataset.manifest.json
#    ★ 把 license 改成你的真实授权说明
#    ★ 填好 consent 与每个 clip 的 text（转写）
#    这一步不做，下一步一定会失败 —— 这是故意的。

# 4) 校验
node voice-training/scripts/validate-dataset.mjs

# 5) 想改动素材后只核对是否同步（可放 CI）
node voice-training/scripts/make-manifest.mjs --check
```

退出码：`0` 通过 · `1` 有错误 · `2` 用法错误 · `3` 找不到数据目录/清单 · `70` 内部错误。

### 常用选项

```bash
node voice-training/scripts/make-manifest.mjs \
  --data <dir>            # 素材目录（默认 voice-training/data）
  --out <file>            # 清单输出（默认 voice-training/manifests/dataset.manifest.json）
  --speaker <id>          # 单说话人模式：所有音频都算这个 id
  --dry-run               # 只报告不写盘
  --check                 # 不写盘；与磁盘不一致则退出码 1
  --json                  # 机器可读摘要

node voice-training/scripts/validate-dataset.mjs \
  --data <dir> --manifest <file> \
  --min-seconds 3 --max-seconds 15 --min-sample-rate 16000 \
  --strict-durations      # 时长越界按错误处理
  --json --quiet
```

---

## 5. 接上你自己的训练后端

本仓库**不训练**，只把校验过的数据集打包成请求发给**你自己部署**的 HTTP 端点。

- 端点契约（提交 / 轮询的路径、请求体、响应字段）见 [`scripts/README.md`](scripts/README.md)。
- 在插件的「🎓 训练」面板里填端点地址 → 选清单 → 「提交训练任务」。
- 提交的是**元数据 + 片段清单**（`file` / `duration` / `sampleRate` / `text`…），
  **默认不上传音频二进制**；要上传也由你的后端自己拉本地目录。
- 训练产物（权重）落在你机器上，**不要提交到仓库**（`.gitignore` 已排除常见权重后缀）。

可对接的开源方案（各自许可不同，本项目不背书、不打包）：GPT-SoVITS、Bert-VITS2、VITS / VITS2、StyleTTS2 等。
选之前先读它们的许可，确认你打算做的用途被允许。

---

## 6. 工具链会替你检查什么（对照表）

| 检查 | 代码 | 级别 |
|---|---|---|
| 缺 `schemaVersion` | `schema-version-missing` | 警告 |
| `schemaVersion` 不是 1 | `schema-version-unsupported` | 错误 |
| 缺/占位 `license` | `license-missing` | **错误** |
| 缺 `consent` / `obtained !== true` | `consent-missing` / `consent-not-obtained` | **错误** |
| `speakers` 非数组/为空/id 重复 | `speakers-not-array` / `speakers-empty` / `speaker-id-duplicate` | 错误 |
| `clips` 为空 | `clips-empty` | 错误（结构合法但没数据） |
| 文件不存在 / 路径越界 / 绝对路径 | `file-not-found` / `file-outside-data` / `clip-file-absolute` | 错误 |
| 内容重复（同 sha256） | `audio-duplicate-content` | 错误 |
| 采样率低于门槛 | `audio-sample-rate-low` | 错误 |
| 时长越界 | `audio-duration-out-of-range` | 警告（`--strict-durations` 时错误） |
| 缺转写文本 | `clip-text-missing` | 警告 |
| 条数少于 10 | `clips-few` | 警告 |
| 文件头解析不了 | `clip-probe-failed` | 警告（清单里会写 `probeError`） |

（上表是给人看的摘要；机器可读的完整清单以 `--json` 输出为准。）

---

## 7. FAQ

**Q：我能直接把别人的歌/动画语音切了当素材吗？**
不能。这就是红线。你说不清「授权人是谁、授权范围是什么」的素材，就不要用。

**Q：我自己的声音，还需要填 `license` 吗？**
需要。写一句「说话人本人录制并授权，仅用于本地个人非商业用途，不再分发」即可 —— 它是给你自己留的证据链。

**Q：为什么强制单声道？我用手机录的是立体声。**
多数方案只取一个声道或直接报错。用 `ffmpeg -i in.wav -ac 1 -ar 22050 out.wav` 转一下。

**Q：清单能入库吗？音频呢？**
清单能（只是元数据）；**音频不能**（`voice-training/data/**` 已被 gitignore）。别人拿到你的清单也拿不到音频。

**Q：`--check` 有什么用？**
在 CI 或提交前确认「清单和磁盘一致」，防止你换了素材却忘了重跑 `make-manifest.mjs`。

**Q：工具会联网吗？会下载模型吗？**
不会。`make-manifest.mjs` 与 `validate-dataset.mjs` 都不联网、不下载、不转码、不写音频，只读文件与文件头。
