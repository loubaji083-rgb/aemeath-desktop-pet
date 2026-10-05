/**
 * 消息数组构造（纯函数，无 DOM / 无 Settings 依赖，便于 node:test 直接测）。
 *
 * 为什么单独一个文件：上下文裁剪是最容易出错、也最值得单测的一块。
 * 规则：
 *  - system 永远在最前，且只有一个；
 *  - 历史按「轮」（user+assistant 成对）保留最近的 N 轮，不会从孤立的 assistant 开始；
 *  - 还有字符预算兜底，防止用户把 maxTokens 调大 + 超长历史一起爆掉；
 *  - 当前这句用户输入永远在最后，且不会被裁剪掉。
 */

/** 单条消息的字数预算兜底（中文按字算，粗估够用）。 */
export const DEFAULT_MAX_CHARS = 12000;

const VALID_ROLES = new Set(['system', 'user', 'assistant']);

/**
 * 规整单条消息；非法返回 null。
 * @param {{role?:string,content?:string}} msg
 */
export function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const role = String(msg.role ?? '').trim().toLowerCase();
  if (!VALID_ROLES.has(role)) return null;
  const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
  if (!content.trim()) return null;
  return { role, content };
}

/**
 * 过滤 + 规整历史。
 * @param {Array<{role:string,content:string}>} history
 * @returns {Array<{role:string,content:string}>}
 */
export function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const raw of history) {
    const msg = normalizeMessage(raw);
    if (msg) out.push(msg);
  }
  return out;
}

/**
 * 只保留最近 maxTurns 轮对话。
 * 一轮 = 一条 user 加它后面紧跟的 assistant（顺序不严格时按「遇到 user 就开新轮」处理）。
 * 裁剪结果不会以 assistant 开头。
 *
 * @param {Array<{role:string,content:string}>} history
 * @param {number} maxTurns
 */
export function trimHistory(history, maxTurns = 20) {
  const list = normalizeHistory(history);
  const turns = Number(maxTurns);
  if (!Number.isFinite(turns) || turns <= 0) return [];
  const sliced = list.slice(-Math.max(1, Math.floor(turns)) * 2);
  // 若首条是 assistant（说明 user 被切断），丢掉它，保证以 user 开头
  while (sliced.length && sliced[0].role === 'assistant') sliced.shift();
  return sliced;
}

/**
 * 字符预算裁剪：从最旧的一轮开始丢，直到总字数进预算。
 * 至少保留最后一轮（哪怕超预算），否则模型没有上下文可接。
 */
export function trimByChars(history, maxChars = DEFAULT_MAX_CHARS) {
  const list = normalizeHistory(history);
  const budget = Number(maxChars);
  if (!Number.isFinite(budget) || budget <= 0) return list;
  let total = list.reduce((n, m) => n + m.content.length, 0);
  let i = 0;
  while (total > budget && list.length - i > 2) {
    total -= list[i].content.length + list[i + 1].content.length;
    i += 2;
  }
  return list.slice(i);
}

/**
 * 合并连续同角色消息（部分兼容层对此敏感）。
 */
export function mergeConsecutive(messages) {
  const out = [];
  for (const msg of normalizeHistory(messages)) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) prev.content += `\n${msg.content}`;
    else out.push({ ...msg });
  }
  return out;
}

/**
 * 构造最终发给 /chat/completions 的消息数组。
 *
 * @param {object} opts
 * @param {string} [opts.systemPrompt]   system 内容；为空则不插入 system
 * @param {Array<{role:string,content:string}>} [opts.history] 既往历史（不含当前这句）
 * @param {string} [opts.userText]       当前用户输入
 * @param {number} [opts.maxTurns]       保留最近多少轮（settings: chat.historyTurns）
 * @param {number} [opts.maxChars]       字符预算
 * @param {boolean} [opts.merge]         是否合并连续同角色（默认 true）
 * @returns {Array<{role:'system'|'user'|'assistant',content:string}>}
 */
export function buildMessages({
  systemPrompt = '',
  history = [],
  userText = '',
  maxTurns = 20,
  maxChars = DEFAULT_MAX_CHARS,
  merge = true,
} = {}) {
  const out = [];
  const sys = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  if (sys) out.push({ role: 'system', content: sys });

  const kept = trimByChars(trimHistory(history, maxTurns), maxChars);
  out.push(...kept);
  // 合并连续同角色（system 与 user 不会合并），再做一次规整兜底
  const cleaned = normalizeHistory(merge ? mergeConsecutive(out) : out);

  const current = typeof userText === 'string' ? userText.trim() : '';
  if (current) {
    const last = cleaned[cleaned.length - 1];
    if (last && last.role === 'user') last.content += `\n${current}`;
    else cleaned.push({ role: 'user', content: current });
  }
  return cleaned;
}

export default buildMessages;
