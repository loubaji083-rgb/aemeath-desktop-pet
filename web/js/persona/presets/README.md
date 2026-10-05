# `persona/presets/` —— 放你自己的角色卡

内置的 4 套预设写在 `../presets.js` 里，**都是原创的类型化风格模板**。
你想让桌宠用自己角色的说话方式，就把角色卡 JSON 放到这个目录。

## 命名约定

- `*.local.json` —— 你自己的私人卡片。**建议加进 `.gitignore`**（本仓库默认不追踪该模式，
  但如果你 fork 后改了 `.gitignore`，请自己确认一遍），避免把私人内容推到公开仓库。
- `example-card.json` —— 仓库自带的字段示例，内容是**完全原创的通用风格**，不对应任何作品角色。

## 字段说明

字段含义见 [`../README.md`](../README.md) 第 3 节。所有字段都可省略，会被
`normalizePreset()` 用默认值补齐。

## 怎么被加载

这个目录不会自动扫描（浏览器里的 `file://` 或静态服务器都无法可靠地列出目录内容）。
请在 `web/js/app.js` 里显式注册，例如：

```js
import { Persona } from './persona/index.js';
import myCard from './persona/presets/my-card.local.json' with { type: 'json' };

Persona.registerPreset(myCard);
```

或者在你自己的启动脚本里 `fetch()` 该 JSON 后注册。

## 再次提醒（权利与责任）

- 只能导入你**有权使用**的内容：自己创作的、已获授权的、或公共领域的；
- 不要导入或分发他人的作品设定、角色台词原文、配音音源、模型权重；
- 由导入行为产生的权利与责任**由使用者自负**，与本项目及贡献者无关。

本仓库自身不包含、也不再分发任何具体作品角色的官方设定或台词。
