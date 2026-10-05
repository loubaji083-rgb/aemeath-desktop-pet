# `web/js/persona/` —— 原创人格与说话风格引擎

这个目录负责「桌宠怎么说话」：把性格与说话习惯拆成**可配置的规则**，再拼成 system prompt；
回复回来之后再做一层语气后处理（`polish`），最后拆成桌宠头顶的「气泡句」。

零依赖、原生 ES Module、无构建步骤。

```
persona/
├── index.js      # Persona：buildSystemPrompt / polish / splitBubbles / listPresets（纯函数）
├── presets.js    # 内置 4 套**原创**预设 + 用户卡片规整/注册
├── presets/      # 放你自己的角色卡（JSON），见该目录下的 README
└── README.md     # 本文件
```

---

## 1. 权利与责任声明（请务必先读）

- 本仓库**不包含**任何游戏、动画、小说、影视作品的官方设定、台词原文、名句、歌词或角色语音素材。
- `presets.js` 里的 4 套预设是**原创的、类型化的人格模板**：描述的是「说话习惯的类型」（句长、节奏、
  口头禅的**种类**、情绪怎么表达、边界在哪），不是某个具体角色的设定；里面的示例短句全部为本项目原创，
  刻意写得通用、不指向任何作品。
- 本仓库的桌宠形象、语音链路同样是原创或调用用户自己的端点，不内置任何第三方素材。
- **你可以自行导入自己的角色卡**（见下面第 3 节），但：
  - 请只导入你**有权使用**的内容（自己创作的、已获授权的、或公共领域的）；
  - 不要导入或分发他人的作品设定、台词原文、配音音源；
  - 由导入行为产生的**权利与责任由使用者自负**，与本项目及贡献者无关；
  - 如果你要公开发布带自定义卡片的衍生版本，请先自行确认授权情况。

---

## 2. 内置预设

`chat.personaPreset` 的合法值：

| id | 名称 | 风格要点 |
|---|---|---|
| `lively-companion` | 活泼陪伴型 | 情绪外放、接话快、短句多、感叹号多（默认） |
| `gentle-caring` | 温柔治愈型 | 先接情绪再谈事、句子完整、少感叹号、给拒绝的余地 |
| `playful-teasing` | 俏皮吐槽型 | 先吐槽再补救、短促有反差，但落点是「我站你这边」 |
| `cool-reliable` | 冷静可靠型 | 先结论后理由、信息密度高、不编造不确定的事 |

代码里这样用：

```js
import { Persona, DEFAULT_PRESET } from './js/persona/index.js';

Persona.listPresets();
// -> [{ id: 'lively-companion', name: '活泼陪伴型', description: '…' }, …]

const sys = Persona.buildSystemPrompt({
  preset: 'gentle-caring',   // 也可以是下面第 3 节的卡片对象
  userName: '小林',
  affection: 45,             // 0~100，决定称呼与亲密度
  mood: 'happy',             // 契约 §4 的 Mood
  extraRules: ['回答尽量控制在两句话内'],
});

const clean = Persona.polish('作为一个AI，我建议你先休息。', { preset: 'gentle-caring', mood: 'happy' });
// -> '我建议你先休息～'

Persona.splitBubbles('诶——你回来啦！今天过得怎么样？');
// -> ['诶——你回来啦！', '今天过得怎么样？']
```

`buildSystemPrompt / polish / splitBubbles / listPresets` 都是**纯函数**（不读设置、不碰 DOM），
可以直接在 `node:test` 里测。

---

## 3. 导入你自己的角色卡

角色卡就是一个普通对象（或 JSON 文件），字段都有默认值，缺什么补什么：

```json
{
  "id": "my-card",
  "name": "我的角色卡",
  "description": "一句话说明，会显示在设置面板的预设列表里",
  "tone": "整体气质：……",
  "sentences": "句长规则：一句多少字、要不要长句……",
  "rhythm": "节奏：先说什么后说什么、停顿在哪里……",
  "catchphraseStyle": ["口头禅的**种类**，不要写具体作品原文"],
  "interjections": ["诶", "唔"],
  "address": {
    "default": "怎么称呼对方",
    "byAffection": [{ "min": 40, "text": "好感度到 40 之后的称呼方式" }]
  },
  "emotion": { "happy": "开心时怎么说话", "sad": "难过时怎么说话" },
  "examples": ["风格示意句（自己原创）"],
  "boundaries": ["这条卡片的额外边界"],
  "length": { "maxChars": 140, "bubbleMaxChars": 46 },
  "moodTail": { "happy": "～", "shy": "…" }
}
```

### 方式 A：运行时注册（最简单）

```js
import { Persona } from './js/persona/index.js';
import card from './js/persona/presets/my-card.local.json' with { type: 'json' };

Persona.registerPreset(card);              // -> 'my-card'
Persona.listPresets();                     // 列表里就多了一张
Persona.buildSystemPrompt({ preset: 'my-card', userName: '你' });
```

`registerPreset(card, { override: true })` 可以覆盖**同名内置**预设（默认不覆盖，避免误伤）。

> 原生 JSON import 需要较新的浏览器；老一点的环境可以用 `fetch()` 读文件后
> `Persona.registerPreset(await res.json())`，或者直接 import 一个导出对象的 `.js` 卡片。

### 方式 B：把卡片文件放进 `persona/presets/`

见 [`presets/README.md`](./presets/README.md)。把 `*.local.json` 放进去，在 `web/js/app.js`
里注册即可；建议在 `.gitignore` 里加上 `web/js/persona/presets/*.local.json`，避免把自己的
私人卡片推到公开仓库。

### 方式 C：直接传对象，不注册

```js
Persona.buildSystemPrompt({ preset: { id: 'tmp', name: '临时卡', tone: '……' }, userName: '你' });
```

对象会被 `normalizePreset()` 补齐所有缺失字段，不会因为少写一个键就崩。

---

## 4. 边界（写进每个 system prompt）

无论用哪张卡片，`index.js` 的 `GLOBAL_BOUNDARIES` 都会强制附加：

- 不声称自己来自某个具体作品、不复述任何作品的台词原文/名句/歌词；
- 不假装真人、不编造线下经历；
- 不输出违法、暴力、成人、自伤内容；专业问题只给一般性提醒并建议找专业人士；
- 不索取或复述用户隐私；
- 被问「你是不是 AI」时坦白是程序化角色，而不是硬演人类。

如果你想给自己的卡片加规则，用卡片里的 `boundaries`，别去掉全局那几条。
