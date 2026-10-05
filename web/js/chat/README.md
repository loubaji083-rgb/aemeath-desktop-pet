# `web/js/chat/` —— DeepSeek 聊天客户端

零依赖、原生 ES Module、无构建步骤。只用 `fetch` + `AbortController` + `TextDecoder`。

```
chat/
├── index.js     # Chat：编排（配置/Key/历史/prompt/事件/语气后处理）
├── deepseek.js  # DeepSeekClient：HTTP + 流式拼装 + 错误归类（fetchImpl 可注入）
├── sse.js       # SSEParser：增量 SSE 解析（纯逻辑，可单测）
├── prompt.js    # buildMessages：system + 裁剪后的历史 + 当前输入（纯函数）
└── README.md
```

## 契约要点

```js
import { Chat, DeepSeekClient, DEFAULT_BASE_URL, DEFAULT_MODEL } from './js/chat/index.js';

Chat.init();                       // 幂等
const reply = await Chat.send('在吗');   // -> Promise<string>，失败抛 Error
Chat.abort();                      // 中断当前请求
Chat.clear();                      // 清空上下文
Chat.getHistory();                 // -> [{ role, content, ts }]
```

- **API Key 只从 `Settings.getSecret('chat.apiKey', '')` 取**，从不读 `localStorage`、
  从不硬编码、从不写进日志或错误信息。没有 Key 时 `send()` 会发出明确的中文错误
  （同时 `emit CHAT_ERROR` + toast）并抛错，不静默失败。
- 默认值跟随 `core/settings.js`：`baseUrl=https://api.deepseek.com`、`model=deepseek-chat`、
  `temperature=1.3`、`maxTokens=1024`、`timeoutMs=60000`、`stream=true`。

### 事件（对外）

| 事件 | 载荷 | 说明 |
|---|---|---|
| `CHAT_SEND` | `{ text }` | 用户消息已发出（含 Key 缺失等失败情况） |
| `CHAT_DELTA` | `{ text }` | **累计全文**（不是增量片段）。外壳可直接 `textContent = text` 覆盖渲染 |
| `CHAT_DONE` | `{ text, usage, aborted }` | `text` 是 `Persona.polish()` 之后的最终文本 |
| `CHAT_ERROR` | `{ message, detail }` | 由 `core/busy.js` 的 `reportError('chat', …)` 统一发出 |
| `PET_THINK` | `{ on }` | 生成开始/结束，驱动桌宠思考动画 |
| `PET_BUBBLE` | `{ text, ms }` | 回复完成后冒的第一句气泡（可用 `init({ bubble: false })` 关掉） |

> `PET_SPEAK_START/END` 由语音模块负责：C 侧可以订阅 `CHAT_DONE` 并在
> `Settings.get('chat.autoSpeak')` 为真时朗读 `CHAT_DONE.text`。

## SSE 解析为什么值得单独一个文件

兼容性都是实际会踩的坑，`sse.js` 逐条处理并有单测：

1. **分块跨包**：事件可能被 TCP 拆开，行尾只剩半个 `\r`；解析器把不完整的行留在缓冲里。
2. **换行**：`\n`、`\r\n`、落单的 `\r` 都当行终止符。
3. **`data:` 后的一个空格**属于分隔符要吃掉，再往后的空格是数据本身。
4. **多行 `data:`** 按规范用 `\n` 拼成同一个事件。
5. **`data: [DONE]`** 是结束哨兵，不是 JSON，不会拿去 `JSON.parse`。
6. **`:` 开头的心跳注释**直接忽略。
7. **没有尾随空行**时用 `flush()` 兜底派发。
8. **`reasoning_content`**（DeepSeek reasoner 的思考内容）单独累加，可经 `onReasoning` 透出，
   **绝不混进正文**。
9. 上游忽略 `stream:true` 直接回整段 JSON 时也能解析（自动兜底）。

## 上下文管理

- `chat.historyTurns`（默认 20 轮）→ 只保留最近 N 轮，裁剪后不会以孤立的 assistant 开头；
- 另有字符预算兜底（`prompt.js` 的 `DEFAULT_MAX_CHARS`），防止长会话把 token 拉爆；
- `chat.rememberHistory=false` 时**每次发送都不带历史**（无状态模式）；
- 内存里最多保留 200 条消息（`HISTORY_HARD_LIMIT`），外壳可用 `Chat.getHistory()` /
  `Chat.setHistory(list)` 与 `localStorage` 对接。

## 自测

```bash
# 需要 Node ≥ 20；本仓库没有 package.json 时用 --experimental-default-type=module 跑 ESM
node --experimental-default-type=module --test tests/
```

覆盖点（D 的测试套件里应包含）：

- `sse.js`：跨包拆分、CRLF、`data:` 后空格、多行 data、注释、`[DONE]`、`flush()`
- `deepseek.js`：`buildRequestBody` 字段、`Authorization` 来自构造参数、401/429 的中文提示、
  超时 → `code==='timeout'`、外部 `AbortSignal` → `{ aborted: true }` 且不抛错、
  `reasoning_content` 不进 `text`
- `prompt.js`：轮数裁剪、字符预算、system 唯一且在首位、当前输入在最后
- `persona`：`buildSystemPrompt / polish / splitBubbles / listPresets`（见 `../persona/README.md`）
