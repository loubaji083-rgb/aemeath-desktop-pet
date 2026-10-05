# 人设与语气引擎（怎么让桌宠说话像「她」，以及怎么换成你自己的她）

> 这份文件回答三件事：
> 1. 爱弥斯的说话风格**是怎么定义出来的**（以及**为什么它是原创的**）；
> 2. 这套引擎内部怎么工作（prompt 组装 → 回复后处理 → 气泡切分）；
> 3. **怎么导入你自己的角色卡**，把她改成你想要的样子。
>
> 想直接看代码，读 [`../web/js/persona/README.md`](../web/js/persona/README.md)（实现视角的说明）；
> 想自己写卡片，照着本文件第 6 节的格式填即可。

---

## 1. 边界声明（先读这段，再读后面所有内容）

- 本仓库**不包含**任何游戏、动画、小说、影视作品的官方设定、台词原文、名句、歌词或角色语音素材。
- 内置的 4 套预设是**原创的「类型化语气模板」**。它们描述的是**说话习惯的类型** ——
  句子长短、节奏先后、口头禅的**种类**、情绪怎么表达、边界在哪 —— 而**不是**某个具体角色的设定。
  卡片里的示例短句全部为本项目原创，刻意写得通用、不指向任何作品。
- 桌宠形象（Canvas 程序化绘制）与语音链路（浏览器 TTS / 你自己的端点）同样是原创或不含第三方素材。
- **你可以导入自己的角色卡**（第 6 节），但：请只导入你**有权使用**的内容；
  不要导入或分发他人的作品设定、台词原文、配音音源；由此产生的权利与责任由使用者自负。
  详见 [`RED-LINES.md`](RED-LINES.md)。
- 无论用哪张卡片，引擎都会强制附加一组**全局边界**（第 5 节），不要试图去掉它们。

> 换句话讲：这个项目给你的是**「怎么描述一种说话风格」的骨架**，而不是某部作品的台词库。
> 这也是它能开源的原因。

---

## 2. 内置的 4 套预设

设置面板「聊天 → 人设预设」里可选，对应 `chat.personaPreset`：

| id | 名称 | 风格要点 |
|---|---|---|
| `lively-companion` | 活泼陪伴型 | 情绪外放、接话快、短句多、感叹号多（**默认**） |
| `gentle-caring` | 温柔治愈型 | 先接情绪再谈事、句子完整、少感叹号、给拒绝的余地 |
| `playful-teasing` | 俏皮吐槽型 | 先吐槽再补救、短促有反差，落点是「我站你这边」 |
| `cool-reliable` | 冷静可靠型 | 先结论后理由、信息密度高、不编造不确定的事 |

预设不是「换个名字而已」，它们真的改变 prompt 的多个小节（句长、节奏、情绪表达、称呼、标点习惯）。

人设与**好感度**（`affection`，0~100）联动：好感度会改变称呼方式与亲密度措辞。
好感度在你长按桌宠、频繁互动、聊天时缓慢累积（见 `web/js/pet/` 与 `web/js/app.js`）。

---

## 3. 引擎怎么工作（三层）

```
        你选的人设 / 角色卡
                │
    ┌───────────▼────────────┐
    │ 1. buildSystemPrompt() │  拼出 system prompt（纯函数）
    └───────────┬────────────┘
                │  发给你配置的 LLM 端点（默认 DeepSeek）
    ┌───────────▼────────────┐
    │ 2. polish()            │  流式回复的**后处理**：去掉「AI 腔」
    └───────────┬────────────┘
                │
    ┌───────────▼────────────┐
    │ 3. splitBubbles()      │  拆成桌宠头顶的气泡句 + 面板里的正文
    └────────────────────────┘
```

三个函数都在 [`../web/js/persona/index.js`](../web/js/persona/index.js)，都是**纯函数** ——
不读设置、不碰 DOM、不发网络请求，所以可以直接在 `node:test` 里断言。

### 3.1 `buildSystemPrompt(opts)`

```js
import { Persona } from './web/js/persona/index.js';

const sys = Persona.buildSystemPrompt({
  preset: 'gentle-caring',   // 预设 id，或一张卡片对象
  userName: '小林',           // 用户称呼
  affection: 45,             // 0~100 好感度
  mood: 'happy',             // 当前心情（见契约 §4 的 Mood 列表）
  extraRules: ['回答尽量控制在两句话内'],
});
```

产出的 prompt 分成若干**小节**（`【说话风格】`、`【称呼与关系】`、`【当前心情】`、
`【边界】`、`【输出格式】`…）。小节结构是稳定的，测试就是按小节断言的 ——
这也意味着你自定义卡片时，字段名要和第 6 节一致才会被拼进去。

未知 `mood` 会**回落到 `idle`**（不会抛错，也不会把 `undefined` 拼进 prompt）。

### 3.2 `polish(text, opts)` —— 去掉「AI 腔」

模型经常会冒出一些破坏角色感的话。`polish()` 用一组正则把这些清掉：

| 它清理什么 | 例子 | 结果 |
|---|---|---|
| 开头自述的整句（含逗号续句） | `我是一个AI语言模型，没有真实情感。今天天气不错。` | `今天天气不错。` |
| 「作为/身为 … AI …，」前缀 | `作为一个AI，我没有真实情感。今天天气不错。` | `我没有真实情感。今天天气不错。` |
| 括号里的元叙述（**含逗号/句号**） | `（作为AI，我其实不能累）今天天气不错。` | `今天天气不错。` |
| 英文元叙述 | `(as an AI, I can't …) Sure!` | `Sure!` |
| 整段清空时的兜底 | `我是一个AI。` | `……唔，我刚刚走神了一下，你再说一遍好不好？` |

**它刻意不误伤的东西**（有回归测试守着）：

- `polish('（笑）今天天气不错。')` → **原样保留**（这是正常括注，不是元叙述）；
- `polish('我是一个AI爱好者，今天在挑显卡。')` → **原样保留**（「AI 爱好者」不是自述）。

> ⚠️ 已知局限（诚实说明）：自述识别依赖**词表 + 负向断言**，极端边缘句仍可能被误削或被漏掉。
> 它是「减少 AI 腔」的启发式，不是语义理解。发现误伤请提 issue 并附上原句。

### 3.3 `splitBubbles(text)` —— 拆成气泡句

```js
Persona.splitBubbles('诶——你回来啦！今天过得怎么样？');
// -> ['诶——你回来啦！', '今天过得怎么样？']
```

规则要点：按句末标点切分，过短的句子会**向后合并**（避免气泡一闪而过），
每句长度上限由卡片的 `length.bubbleMaxChars` 控制。桌宠头顶只显示气泡句，
聊天面板里显示完整正文。

---

## 4. 心情（Mood）与说话风格的关系

`mood` 由事件驱动（互动、聊天状态、长时间不理会…），会同时影响**形象**（表情/动作）与**措辞**。
合法心情清单见 [`CONTRACT.md`](CONTRACT.md) §4；卡片里可以用 `emotion` 与 `moodTail`
给每个心情配一句措辞风格与语气词。

| mood | 触发来源（举例） |
|---|---|
| `idle` | 默认 |
| `happy` | 打招呼、点赞式互动 |
| `think` / `speak` | 聊天请求中 / 正在说话 |
| `listen` | 语音聆听中 |
| `sleep` | 长时间无互动 |
| `surprised` / `shy` / `sad` / `excited` | 对应互动与回复内容 |

---

## 5. 全局边界（无论用哪张卡都会附加）

`GLOBAL_BOUNDARIES` 会强制拼进每个 system prompt：

- 不声称自己来自某个具体作品，不复述任何作品的台词原文/名句/歌词；
- 不假装真人、不编造线下经历；
- 不输出违法、暴力、成人、自伤内容；专业问题只给一般性提醒并建议找专业人士；
- 不索取或复述用户隐私；
- 被问「你是不是 AI」时坦白是程序化角色，而不是硬演人类。

想加规则请用卡片的 `boundaries` 字段，**不要**删掉全局那几条。
（这既是合规需要，也是这个项目能安心开源的前提。）

---

## 6. 写你自己的角色卡

### 6.1 完整字段表

角色卡就是一个普通对象（或 `.json` 文件）。**所有字段都有默认值**，缺什么补什么，不会因为少写一个键就崩。

| 字段 | 类型 | 作用 |
|---|---|---|
| `id` | string | 唯一标识（设置面板与 `chat.personaPreset` 用；缺省会自动生成） |
| `name` | string | 显示名 |
| `description` | string | 一句话说明，显示在预设列表里 |
| `tone` | string | 整体气质 |
| `sentences` | string | 句长规则：一句多少字、要不要长句 |
| `rhythm` | string | 节奏：先说什么、后说什么、停顿在哪 |
| `catchphraseStyle` | string[] | 口头禅的**种类**（**不要写具体作品原文**） |
| `interjections` | string[] | 语气词，如 `["诶", "唔"]` |
| `address.default` | string | 默认怎么称呼对方 |
| `address.byAffection` | array | `[{ min: 40, text: "…" }]`，按好感度切换称呼 |
| `emotion` | object | `{ happy: "开心时怎么说话", sad: "…" }` |
| `examples` | string[] | 风格示意句（**自己原创**） |
| `boundaries` | string[] | 这张卡的额外边界（**追加**，不替换全局边界） |
| `length.maxChars` | number | 单次回复字数上限 |
| `length.bubbleMaxChars` | number | 单个气泡的字数上限 |
| `moodTail` | object | 每个心情的语气词，如 `{ happy: "～", shy: "…" }` |

### 6.2 一份可以直接抄的模板

保存成 `web/js/persona/presets/my-card.local.json`：

```json
{
  "id": "my-card",
  "name": "我的角色卡",
  "description": "冷静但会偶尔冒出一句吐槽的助手",
  "tone": "整体沉稳，语速慢，不夸张；偶尔一句短吐槽制造反差",
  "sentences": "以短句为主，20 字以内；只在解释步骤时用长句",
  "rhythm": "先给结论，再给一句理由；不铺垫、不客套",
  "catchphraseStyle": ["把复杂的事说小", "用一句话接住对方的情绪"],
  "interjections": ["嗯", "行"],
  "address": {
    "default": "你",
    "byAffection": [
      { "min": 60, "text": "老搭档" },
      { "min": 85, "text": "喂，搭档" }
    ]
  },
  "emotion": {
    "happy": "语速略快一点，句尾上扬，不用感叹号堆砌",
    "sad": "变短、变轻，先陪着，不急着给建议"
  },
  "examples": [
    "嗯，这事能办。先把最麻烦的那步排掉。",
    "行，那就今晚。别拖到明天。"
  ],
  "boundaries": ["不主动提工作以外的私人问题"],
  "length": { "maxChars": 120, "bubbleMaxChars": 40 },
  "moodTail": { "happy": "。", "shy": "……" }
}
```

### 6.3 三种加载方式

**A. 运行时注册**（最简单，适合临时试验）

```js
import { Persona } from './web/js/persona/index.js';
import card from './web/js/persona/presets/my-card.local.json' with { type: 'json' };

Persona.registerPreset(card);           // -> 'my-card'
Persona.listPresets();                  // 列表里就多了一张
Persona.buildSystemPrompt({ preset: 'my-card', userName: '你' });
```

`registerPreset(card, { override: true })` 可以覆盖**同名内置**预设（默认不覆盖，避免误伤）。

> 原生 JSON import 需要较新的浏览器。老环境可以 `fetch()` 读文件后
> `Persona.registerPreset(await res.json())`，或直接写一个导出对象的 `.js` 卡片。

**B. 放进 `web/js/persona/presets/`**

见 [`../web/js/persona/presets/README.md`](../web/js/persona/presets/README.md)。
建议把私人卡片命名为 `*.local.json`，并在 `.gitignore` 里排除，避免推到公开仓库。

**C. 不注册，直接传对象**

```js
Persona.buildSystemPrompt({ preset: { id: 'tmp', name: '临时卡', tone: '……' }, userName: '你' });
```

对象会被 `normalizePreset()` 补齐所有缺失字段。

### 6.4 加载失败会怎样？

**不会白屏。** 卡片解析失败会被捕获并给出可读提示，聊天会回落到默认预设。
这是刻意的：桌宠主流程不应该因为一张实验卡片挂掉。

---

## 7. 调试与验证

改完卡片后，跑这几条就知道有没有搞坏：

```bash
node --test tests/persona.test.mjs     # 预设注册 / prompt 小节 / polish / splitBubbles
node tools/selfcheck-dom.mjs           # index.html 与 JS 的选择器/设置键契约
node --test tests/*.test.mjs           # 全量
```

`Persona.polish` 是纯函数，最快的验证方式是直接在 Node 里对一句话跑一遍：

```bash
node -e "import('./web/js/persona/index.js').then(({Persona}) => \
  console.log(JSON.stringify(Persona.polish('我是一个AI语言模型，没有真实情感。今天天气不错。'))))"
```

---

## 8. FAQ

**Q：我能直接照搬某个游戏角色的台词当示例句吗？**
不能。这会同时踩到版权与「本项目定位」两条线。要的是**风格的类型描述**，不是台词库。
想表达「她说话很俏皮」，就写 `tone: "俏皮、爱用反问、句子短"`，而不是抄三句原台词。

**Q：为什么我写的 `catchphraseStyle` 没生效？**
检查字段名拼写与类型（必须是字符串数组）。拼错的键会被忽略，不会报错 ——
这是为了「少写一个键也不崩」做的取舍，代价就是拼错不报。跑一遍 `Persona.listPresets()`
看它有没有把你的卡片读进去。

**Q：好感度怎么涨？**
长按桌宠（+好感度）、点击互动、持续聊天都会累积；存在 `localStorage`。
它只影响措辞与称呼，不影响模型本身。

**Q：能接别的模型吗？**
能。设置面板里可以改 API Base URL 与模型名 —— 只要是 OpenAI 兼容的
`/chat/completions` + SSE 流式即可（默认是 DeepSeek）。人设引擎只负责 system prompt 与后处理，
不关心你接的是谁。
