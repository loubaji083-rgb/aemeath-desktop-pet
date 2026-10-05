/**
 * 爱弥斯桌宠 · 主控（Lead 维护）
 *
 * 职责：
 *  1. 装配 core（设置/存储/事件/面板）
 *  2. 动态装配四大模块（pet / chat / voice / training），任一模块缺失都不影响其余功能
 *  3. 通用设置绑定器：任何 [data-setting] 控件自动双向同步
 *  4. chat / voice / train / settings 四个面板的交互
 *
 * 约定：所有对用户暴露的失败都必须可读、可定位，不允许静默失败。
 */

import { on, emit, AppEvents } from './core/events.js';
import { Settings, DEFAULTS } from './core/settings.js';
import { Store } from './core/store.js';
import { $, $$, el, toast, formatTime, reportError, initShell, Panels, Bubble, applyTheme } from './core/busy.js';

const VERSION = '1.0.0';
const REPO_URL = 'https://github.com/loubaji083-rgb/aemeath-desktop-pet';

/* ==========================================================================
   模块动态装配
   ========================================================================== */

const modules = {
  PetUI: null,
  Chat: null,
  Voice: null,
  Training: null,
  Persona: null,
};

/** 语气预设列表：优先 Chat 转发，其次 Persona，都没有就返回空数组 */
function listPresets() {
  const from = modules.Chat?.listPresets ?? modules.Persona?.listPresets;
  if (typeof from !== 'function') return [];
  try {
    const list = from.call(modules.Chat?.listPresets ? modules.Chat : modules.Persona);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('[aemeath:app] listPresets 调用失败', err);
    return [];
  }
}

/**
 * 动态加载一个模块。失败不抛出，只记录 + 提示，保证其余功能可用。
 * @param {string} name
 * @param {() => Promise<any>} loader
 * @param {string} exportName
 */
async function loadModule(name, loader, exportName) {
  try {
    const mod = await loader();
    const value = mod?.[exportName] ?? mod?.default?.[exportName] ?? null;
    if (!value) {
      console.warn(`[aemeath:app] 模块 ${name} 未导出 ${exportName}`);
      return null;
    }
    modules[exportName] = value;
    return value;
  } catch (err) {
    console.warn(`[aemeath:app] 模块 ${name} 加载失败`, err);
    return null;
  }
}

/* ==========================================================================
   通用设置绑定器
   ========================================================================== */

/**
 * 把 DOM 里所有 [data-setting] 控件与 Settings 双向绑定。
 * 支持：checkbox / range / number / select / text / url / password(text)
 */
function bindSettingsControls() {
  const controls = $$('[data-setting]');

  for (const node of controls) {
    const key = node.dataset.setting;
    if (!(key in DEFAULTS)) {
      console.warn(`[aemeath:app] 未知设置键，忽略控件: ${key}`);
      continue;
    }

    const isCheckbox = node.type === 'checkbox';
    const isNumber = node.type === 'number' || node.type === 'range';
    // data-scale：控件显示单位 ≠ 存储单位（例：超时输入框显示「秒」，存的是毫秒）
    // 存储值 = 控件值 × scale；控件值 = 存储值 ÷ scale
    const scale = Number(node.dataset.scale) > 0 ? Number(node.dataset.scale) : 1;

    // DOM -> Settings
    const eventName = isCheckbox || node.tagName === 'SELECT' || node.type === 'range' ? 'change' : 'input';
    const commit = () => {
      let value;
      if (isCheckbox) value = node.checked;
      else if (isNumber) value = Number(node.value) * scale;
      else value = node.value;
      Settings.set(key, value);
    };
    node.addEventListener(eventName, commit);
    // range 拖动时即时预览
    if (node.type === 'range') node.addEventListener('input', commit);

    // Settings -> DOM
    const sync = () => {
      const value = Settings.get(key);
      if (isCheckbox) node.checked = Boolean(value);
      else if (document.activeElement !== node) {
        node.value = String(isNumber && value != null ? Number(value) / scale : value ?? '');
      }
    };
    sync();
    on(AppEvents.SETTINGS_CHANGED, (e) => {
      if (e.key === key) sync();
    });
  }

  // 敏感值：只进 sessionStorage / 内存
  for (const node of $$('[data-secret]')) {
    const key = node.dataset.secret;
    node.value = Settings.getSecret(key, '');
    node.addEventListener('input', () => Settings.setSecret(key, node.value));
    node.addEventListener('blur', () => {
      const has = Boolean(node.value);
      toast(has ? '已保存到本次会话（关闭标签页即失效）' : '已清空该密钥', has ? 'ok' : 'info', 1800);
    });
  }
}

/** 数值型设置旁的小输出标签（<output id="out-<key 用 - 连接>">） */
function bindOutputLabels() {
  const pairs = [
    ['out-voice-rate', 'voice.rate'],
    ['out-voice-pitch', 'voice.pitch'],
    ['out-voice-volume', 'voice.volume'],
    ['out-chat-temperature', 'chat.temperature'],
    ['out-pet-scale', 'pet.scale'],
    ['out-pet-bubbleMs', 'pet.bubbleMs'],
  ];
  const update = () => {
    for (const [id, key] of pairs) {
      const out = document.getElementById(id);
      if (out) out.textContent = String(Settings.get(key));
    }
  };
  update();
  on(AppEvents.SETTINGS_CHANGED, update);
}

/* ==========================================================================
   桌宠：拖拽 / 点击 / 动作
   ========================================================================== */

const PET_POS_KEY = 'pet.pos';

function initPetStage() {
  const stage = $('#pet-stage');
  const canvas = $('#aemeath-canvas');
  if (!stage || !canvas) return;

  // —— 位置恢复 ——
  const saved = Store.get(PET_POS_KEY, null);
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    applyPetPos(saved.left, saved.top);
  }

  const clampPos = (left, top) => {
    const w = stage.offsetWidth;
    const h = stage.offsetHeight;
    const maxLeft = Math.max(0, globalThis.innerWidth - w);
    const maxTop = Math.max(0, globalThis.innerHeight - h);
    return {
      left: Math.min(maxLeft, Math.max(0, left)),
      top: Math.min(maxTop, Math.max(0, top)),
    };
  };

  // —— 拖拽 ——
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = stage.getBoundingClientRect();
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    stage.setPointerCapture?.(e.pointerId);
    stage.classList.add('is-dragging');
  });

  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 4) {
      moved = true;
      // 手势事件由 PetUI 的手势层统一 emit（见 web/js/pet/index.js:218-236），
      // app.js 只负责"窗口位置"这一层，重复 emit 会让一次手势收到两遍同一事件。
    }
    if (!moved) return;
    const pos = clampPos(startLeft + dx, startTop + dy);
    applyPetPos(pos.left, pos.top);
    // 拖拽期间视线跟着指针（canvas 逻辑坐标，口径同 lookAt）
    const drect = stage.getBoundingClientRect();
    const dp = pointerToCanvas(e.clientX, e.clientY, drect);
    if (dp) modules.PetUI?.lookAt?.(dp.x, dp.y);
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('is-dragging');
    try {
      stage.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    if (moved) {
      const rect = stage.getBoundingClientRect();
      Store.set(PET_POS_KEY, { left: rect.left, top: rect.top });
      // 同样不在这里 emit PET_DRAG_END / trigger('drop')：PetUI 的手势层已经做过，
      // 而且它带 part 与坐标，信息更全。
    } else {
      // 没移动 = 点击：交给 PetUI 的 hitTest 判定部位
      const rect2 = stage.getBoundingClientRect();
      const cp = pointerToCanvas(e.clientX, e.clientY, rect2) ?? { x: 0, y: 0 };
      const x = cp.x;
      const y = cp.y;
      const part = modules.PetUI?.hitTest?.(x, y) ?? 'body';
      // PET_CLICK / PET_POKE 由 PetUI 的手势层 emit（带 part/坐标/count），此处不再重复。
      // app.js 只把点击映射成动作；冷却与去抖在 PetUI 的 Rig 内（constants.ACTION_COOLDOWN）。
      const action = { head: 'tap-head', face: 'tap-face', hand: 'tap-hand', body: 'tap-body' }[part] ?? 'tap-body';
      modules.PetUI?.trigger?.(action);
    }
  };

  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // 双击
  stage.addEventListener('dblclick', () => {
    modules.PetUI?.trigger?.('double-tap');
  });

  // 长按
  let pressTimer = null;
  stage.addEventListener('pointerdown', () => {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (!moved && dragging) {
        modules.PetUI?.trigger?.('long-press');
        showAffection();
      }
    }, 620);
  });
  const cancelPress = () => clearTimeout(pressTimer);
  stage.addEventListener('pointerup', cancelPress);
  stage.addEventListener('pointerleave', cancelPress);

  // 鼠标跟随：PetUI.lookAt 要的是 **canvas 逻辑坐标**（契约 §4），
  // 而 getBoundingClientRect 给的是 CSS 像素，所以必须换算，否则缩放/高 DPI 下会偏。
  globalThis.addEventListener('pointermove', (e) => {
    if (!Settings.get('pet.followCursor')) return;
    const p = pointerToCanvas(e.clientX, e.clientY, stage.getBoundingClientRect());
    if (p) modules.PetUI?.lookAt?.(p.x, p.y);
  });
}

/**
 * CSS 像素 → canvas 逻辑坐标（契约 §4：原点左上，0..CANVAS_W / 0..CANVAS_H）。
 *
 * **必须用 `canvas.clientWidth/clientHeight`，不能用 `canvas.width/height`。**
 * `web/js/pet/index.js` 的 `syncBackingStore()` 会把后备缓冲设成
 * `360 × devicePixelRatio × 480 × devicePixelRatio`，所以 `canvas.width` 在高 DPI 下
 * 是逻辑宽度的 dpr 倍；用它换算会让传给 `hitTest`/`lookAt` 的坐标整体放大 dpr 倍
 * （dpr=2 时点脸心得到 (360,300) 而不是 (180,150)，所有点击都落到画布外）。
 * `clientWidth` 是布局像素，与 dpr 无关，也与宿主对 `#pet-stage` 的 scale transform 无关。
 *
 * @param {number} clientX
 * @param {number} clientY
 * @param {DOMRect} rect 承载 canvas 的元素（或 canvas 自身）的 getBoundingClientRect()
 * @returns {{x:number,y:number}|null} 无法换算（元素未布局）时返回 null
 */
function pointerToCanvas(clientX, clientY, rect) {
  const canvas = $('#aemeath-canvas');
  const rectW = (rect && rect.width) || 0;
  const rectH = (rect && rect.height) || 0;
  if (!canvas || !rectW || !rectH) return null;
  const w = canvas.clientWidth || rectW;
  const h = canvas.clientHeight || rectH;
  return {
    x: ((clientX - rect.left) / rectW) * w,
    y: ((clientY - rect.top) / rectH) * h,
  };
}

function applyPetPos(left, top) {
  const stage = $('#pet-stage');
  if (!stage) return;
  stage.style.left = `${left}px`;
  stage.style.top = `${top}px`;
  stage.style.right = 'auto';
  stage.style.bottom = 'auto';
}

function showAffection() {
  const n = Number(Settings.get('pet.affection') ?? 0) + 1;
  Settings.set('pet.affection', n);
  const lines = [
    '诶嘿嘿……再摸一下也可以哦。',
    '唔——被摸头了。',
    '你今天心情不错嘛。',
    '好啦好啦，我记住这份温柔了。',
  ];
  Bubble.say(lines[n % lines.length]);
}

/* ==========================================================================
   聊天面板
   ========================================================================== */

const HISTORY_KEY = 'chat.history';
let streamingEl = null;
let streamingText = '';
let chatBusy = false;

function appendMessage(role, text, ts = Date.now()) {
  const box = $('#chat-messages');
  if (!box) return null;
  const isUser = role === 'user';
  const isSystem = role === 'system';
  const isError = role === 'error';

  const cls = `msg msg-${isUser ? 'user' : isError ? 'error' : isSystem ? 'system' : 'assistant'}`;
  const node = el('div', { className: cls });

  if (!isUser) {
    node.append(el('div', { className: 'msg-avatar', text: isError ? '!' : isSystem ? 'i' : '爱' }));
  }
  const body = el('div', { className: 'msg-body', text });
  node.append(body);
  if (!isSystem && !isError) node.append(el('span', { className: 'msg-time', text: formatTime(ts) }));

  if (isUser) node.append(el('div', { className: 'msg-avatar', text: '你' }));

  box.append(node);
  box.scrollTop = box.scrollHeight;
  return body;
}

function setChatStatus(text, kind = 'idle') {
  const chip = $('#chat-status');
  if (!chip) return;
  chip.textContent = text;
  chip.className = `chip chip-${kind}`;
}

function loadHistory() {
  const box = $('#chat-messages');
  if (!box) return;
  const history = Settings.get('chat.rememberHistory') ? Store.get(HISTORY_KEY, null) : null;
  if (Array.isArray(history) && history.length > 0) {
    for (const m of history) {
      if (m && (m.role === 'user' || m.role === 'assistant')) appendMessage(m.role, m.content, m.ts);
    }
    appendMessage('system', `已恢复 ${history.length} 条历史消息。`);
  } else {
    appendMessage('system', '嗨，我是小爱。点我、拖我、或者直接跟我说话都可以～');
  }
}

function persistHistory() {
  if (!Settings.get('chat.rememberHistory')) return;
  const turns = Math.max(0, Number(Settings.get('chat.historyTurns')) || 0);
  const history = modules.Chat?.getHistory?.() ?? [];
  const sliced = turns > 0 ? history.slice(-turns * 2) : history;
  Store.set(HISTORY_KEY, sliced.map((m) => ({ role: m.role, content: m.content, ts: m.ts })));
}

async function sendChat(text) {
  const t = String(text ?? '').trim();
  if (!t || chatBusy) return;
  const input = $('#chat-input');
  if (input) input.value = '';

  appendMessage('user', t);
  emit(AppEvents.CHAT_SEND, { text: t });

  if (!modules.Chat) {
    appendMessage('error', '聊天模块未加载，无法发送。请确认 web/js/chat/index.js 存在。');
    setChatStatus('模块缺失', 'error');
    return;
  }

  chatBusy = true;
  $('#chat-send')?.setAttribute('disabled', 'disabled');
  $('#chat-abort')?.classList.remove('hidden');
  setChatStatus('生成中', 'busy');
  $('#chat-typing')?.classList.remove('hidden');
  emit(AppEvents.PET_THINK, { on: true });
  modules.PetUI?.setMood?.('think');

  streamingText = '';
  streamingEl = appendMessage('assistant', '');

  try {
    const full = await modules.Chat.send(t);
    if (streamingEl) streamingEl.textContent = full || streamingText;
    persistHistory();
    setChatStatus('已连接', 'ok');
    if (Settings.get('chat.autoSpeak')) speakText(full || streamingText);
  } catch (err) {
    const msg = reportError('chat', err);
    if (streamingEl && !streamingText) streamingEl.closest('.msg')?.remove();
    if (streamingText) {
      persistHistory();
    }
    appendMessage('error', msg);
    setChatStatus('出错', 'error');
  } finally {
    chatBusy = false;
    streamingEl = null;
    $('#chat-send')?.removeAttribute('disabled');
    $('#chat-abort')?.classList.add('hidden');
    $('#chat-typing')?.classList.add('hidden');
    emit(AppEvents.PET_THINK, { on: false });
    modules.PetUI?.setMood?.('idle');
  }
}

function initChatPanel() {
  const input = $('#chat-input');
  const send = $('#chat-send');
  const clear = $('#chat-clear');
  const abort = $('#chat-abort');
  const mic = $('#chat-mic');
  const speakToggle = $('#chat-speak-toggle');

  send?.addEventListener('click', () => sendChat(input?.value));
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat(input.value);
    }
  });
  input?.addEventListener('input', () => {
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    }
  });

  clear?.addEventListener('click', () => {
    modules.Chat?.clear?.();
    Store.remove(HISTORY_KEY);
    const box = $('#chat-messages');
    if (box) box.replaceChildren();
    appendMessage('system', '对话已清空，我们重新开始吧。');
    setChatStatus('未连接', 'idle');
  });

  abort?.addEventListener('click', () => modules.Chat?.abort?.());

  speakToggle?.addEventListener('click', () => {
    const next = !(Settings.get('chat.autoSpeak') === true);
    Settings.set('chat.autoSpeak', next);
    speakToggle.classList.toggle('is-on', next);
    speakToggle.setAttribute('aria-pressed', String(next));
    toast(next ? '已开启自动朗读' : '已关闭自动朗读', 'info', 1600);
  });
  speakToggle?.classList.toggle('is-on', Settings.get('chat.autoSpeak') === true);
  speakToggle?.setAttribute('aria-pressed', String(Settings.get('chat.autoSpeak') === true));

  mic?.addEventListener('click', async () => {
    if (!modules.Voice) {
      toast('语音模块未加载', 'warn');
      return;
    }
    if (modules.Voice.isListening?.()) {
      modules.Voice.stopListening?.();
      mic.classList.remove('is-on');
    } else {
      mic.classList.add('is-on');
      await modules.Voice.startListening?.();
    }
  });

  // 流式增量
  on(AppEvents.CHAT_DELTA, ({ text }) => {
    streamingText = text ?? '';
    if (streamingEl) {
      streamingEl.textContent = streamingText;
      const box = $('#chat-messages');
      if (box) box.scrollTop = box.scrollHeight;
    }
  });

  // 语音识别结果直接进输入框 / 直接发送
  on(AppEvents.VOICE_STT_RESULT, ({ text, final }) => {
    const box = $('#voice-transcript');
    if (box) {
      if (final) {
        box.textContent = text;
      } else {
        box.innerHTML = '';
        box.append(el('span', { className: 'transcript-interim', text }));
      }
    }
    if (final) {
      toast(`听到：${text}`, 'info', 2200);
      sendChat(text);
    }
  });

  on(AppEvents.CHAT_ERROR, ({ message }) => {
    setChatStatus('出错', 'error');
    console.warn('[aemeath:app] chat error:', message);
  });

  on(AppEvents.VOICE_STATE, (s) => {
    $('#chat-mic')?.classList.toggle('is-on', Boolean(s.listening));
  });

  // 状态提示
  updateChatHint();
  on(AppEvents.SETTINGS_CHANGED, (e) => {
    if (e.key.startsWith('chat.') || e.key.startsWith('voice.')) updateChatHint();
  });
}

function updateChatHint() {
  const hint = $('#chat-hint');
  if (!hint) return;
  const hasKey = Boolean(Settings.getSecret('chat.apiKey', ''));
  if (!hasKey) {
    hint.textContent = '尚未填写 API Key：打开「设置 → DeepSeek 接入」填入后即可聊天。';
  } else {
    hint.textContent = `模型 ${Settings.get('chat.model')} · 温度 ${Settings.get('chat.temperature')} · 密钥仅本次会话有效`;
  }
}

function speakText(text) {
  if (!modules.Voice) return;
  modules.Voice.speak?.(text)?.catch?.((err) => {
    if (err?.name !== 'AbortError') console.warn('[aemeath:app] TTS 失败', err);
  });
}

/* ==========================================================================
   语音面板
   ========================================================================== */

function initVoicePanel() {
  const ptt = $('#voice-ptt');
  const toggle = $('#voice-toggle-listen');
  const stop = $('#voice-stop');
  const selftest = $('#voice-selftest');
  const out = $('#voice-selftest-out');
  const orb = $('#voice-orb');
  const label = $('#voice-state-label');
  const detail = $('#voice-state-detail');

  const setState = (speaking, listening) => {
    orb?.classList.toggle('is-speaking', speaking);
    orb?.classList.toggle('is-listening', listening);
    if (label) label.textContent = speaking ? '正在说话' : listening ? '正在聆听' : '待机';
    if (detail) {
      detail.textContent = speaking
        ? '小爱正在朗读回复…'
        : listening
          ? '说吧，我在听～'
          : '点下面的按钮开始说话';
    }
  };

  on(AppEvents.VOICE_STATE, ({ speaking, listening }) => setState(Boolean(speaking), Boolean(listening)));

  const startPTT = async () => {
    if (!modules.Voice) return toast('语音模块未加载', 'warn');
    ptt?.classList.add('is-on');
    ptt && (ptt.textContent = '正在听…（松开结束）');
    await modules.Voice.startListening?.();
  };
  const endPTT = () => {
    ptt?.classList.remove('is-on');
    if (ptt) ptt.textContent = '按住说话';
    modules.Voice?.stopListening?.();
  };

  ptt?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startPTT();
  });
  ptt?.addEventListener('pointerup', endPTT);
  ptt?.addEventListener('pointerleave', endPTT);

  toggle?.addEventListener('click', async () => {
    if (!modules.Voice) return toast('语音模块未加载', 'warn');
    if (modules.Voice.isListening?.()) {
      modules.Voice.stopListening?.();
      toggle.textContent = '开始连续聆听';
    } else {
      await modules.Voice.startListening?.();
      toggle.textContent = '停止聆听';
    }
  });

  stop?.addEventListener('click', () => modules.Voice?.stop?.());

  selftest?.addEventListener('click', async () => {
    if (!modules.Voice) return toast('语音模块未加载', 'warn');
    out?.classList.remove('hidden');
    if (out) out.textContent = '自检中…';
    try {
      const result = await modules.Voice.selfTest?.();
      if (out) out.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      if (out) out.textContent = `自检失败：${err?.message ?? err}`;
    }
  });

  // 浏览器音色列表
  const voiceSelect = $('#voice-browser-voice');
  const fillVoices = () => {
    if (!voiceSelect || !globalThis.speechSynthesis) return;
    const voices = globalThis.speechSynthesis.getVoices?.() ?? [];
    const current = Settings.get('voice.browserVoiceURI');
    voiceSelect.replaceChildren(el('option', { text: '自动选择（推荐）', attrs: { value: '' } }));
    for (const v of voices) {
      if (!v.lang) continue;
      voiceSelect.append(el('option', { text: `${v.name} (${v.lang})`, attrs: { value: v.voiceURI } }));
    }
    voiceSelect.value = current || '';
  };
  fillVoices();
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', fillVoices);

  setState(false, false);
}

/* ==========================================================================
   训练面板
   ========================================================================== */

function initTrainPanel() {
  const ack = $('#train-ack');
  const files = $('#train-files');
  const resultBox = $('#train-probe-result');
  const validateBtn = $('#train-validate');
  const submitBtn = $('#train-submit');
  const out = $('#train-out');
  const templateBtn = $('#train-template');
  const schemaBtn = $('#train-schema');

  let lastManifest = null;

  ack?.addEventListener('change', () => {
    if (ack.checked) toast('已确认素材权利归属，谢谢配合。', 'ok', 2200);
  });

  files?.addEventListener('change', async () => {
    if (!resultBox) return;
    const list = [...(files.files ?? [])];
    if (list.length === 0) {
      resultBox.textContent = '';
      return;
    }
    if (!modules.Training) {
      resultBox.textContent = '训练模块未加载（web/js/training/index.js 缺失）。';
      return;
    }
    resultBox.textContent = `正在探测 ${list.length} 个文件…`;
    const rows = [];
    for (const f of list) {
      try {
        const info = await modules.Training.probeAudio(f);
        const ok = info?.ok !== false;
        rows.push(
          el('div', { className: 'probe-row' }, [
            el('span', { text: f.name }),
            el('span', {
              className: ok ? 'probe-ok' : 'probe-bad',
              text: `${Number(info?.duration ?? 0).toFixed(2)}s · ${info?.sampleRate ?? '?'}Hz · ${
                info?.channels ?? '?'
              }ch · 峰值 ${info?.peakDb ?? '?'}dB`,
            }),
          ]),
        );
      } catch (err) {
        rows.push(el('div', { className: 'probe-row' }, [el('span', { text: f.name }), el('span', { className: 'probe-bad', text: `失败：${err?.message ?? err}` })]));
      }
    }
    resultBox.replaceChildren(...rows);

    lastManifest = modules.Training.createManifestTemplate?.({
      name: 'my-voice-dataset',
      language: Settings.get('voice.sttLang'),
      clipNames: list.map((f) => f.name),
    });
  });

  validateBtn?.addEventListener('click', () => {
    if (!modules.Training) return toast('训练模块未加载', 'warn');
    out?.classList.remove('hidden');
    const manifest = lastManifest ?? modules.Training.createManifestTemplate?.({ name: 'my-voice-dataset' });
    const res = modules.Training.validateManifest(manifest);
    if (out) {
      out.textContent = [
        `ok: ${res.ok}`,
        `errors(${res.errors?.length ?? 0}):`,
        ...(res.errors ?? []).map((e) => `  - ${typeof e === 'string' ? e : JSON.stringify(e)}`),
        `warnings(${res.warnings?.length ?? 0}):`,
        ...(res.warnings ?? []).map((w) => `  - ${typeof w === 'string' ? w : JSON.stringify(w)}`),
        `stats: ${JSON.stringify(res.stats ?? {})}`,
      ].join('\n');
    }
    toast(res.ok ? '清单校验通过' : '清单校验未通过，请查看详情', res.ok ? 'ok' : 'warn');
  });

  submitBtn?.addEventListener('click', async () => {
    if (!modules.Training) return toast('训练模块未加载', 'warn');
    if (!Settings.get('train.acknowledgeOwnership')) {
      toast('请先勾选素材权利确认', 'warn', 3000);
      return;
    }
    const endpoint = Settings.get('train.endpoint');
    if (!endpoint) {
      toast('请先填写训练后端端点（本插件不自带训练算力）', 'warn', 3400);
      return;
    }
    out?.classList.remove('hidden');
    if (out) out.textContent = '提交中…';
    try {
      const res = await modules.Training.submitJob({
        endpoint,
        manifest: lastManifest,
        clips: [...(files?.files ?? [])],
        options: { sampleRate: Settings.get('train.targetSampleRate') },
      });
      if (out) out.textContent = JSON.stringify(res, null, 2);
      toast(res?.ok ? '训练任务已提交' : '提交未成功，详见面板输出', res?.ok ? 'ok' : 'warn');
    } catch (err) {
      if (out) out.textContent = `提交失败：${err?.message ?? err}`;
      toast('提交失败', 'error');
    }
  });

  templateBtn?.addEventListener('click', () => {
    if (!modules.Training) return toast('训练模块未加载', 'warn');
    const manifest = modules.Training.createManifestTemplate?.({ name: 'my-voice-dataset' });
    downloadText('manifest.template.json', JSON.stringify(manifest, null, 2));
  });

  schemaBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('../voice-training/SCHEMA.md');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const w = globalThis.open('', '_blank');
      if (w) {
        w.document.title = '声音数据规范';
        const pre = w.document.createElement('pre');
        pre.style.cssText = 'white-space:pre-wrap;font-family:monospace;padding:16px;line-height:1.6';
        pre.textContent = text;
        w.document.body.append(pre);
      } else {
        toast('浏览器拦截了新窗口', 'warn');
      }
    } catch (err) {
      toast(`无法读取 SCHEMA.md：${err?.message ?? err}（请通过本地静态服务器访问）`, 'error', 4200);
    }
  });
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: filename } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ==========================================================================
   设置面板
   ========================================================================== */

function initSettingsPanel() {
  const testBtn = $('#chat-test-conn');
  const testOut = $('#chat-test-out');

  testBtn?.addEventListener('click', async () => {
    testOut?.classList.remove('hidden');
    const key = Settings.getSecret('chat.apiKey', '');
    if (!key) {
      if (testOut) testOut.textContent = '请先填写 API Key。';
      return;
    }
    if (testOut) testOut.textContent = '请求中…';
    const base = String(Settings.get('chat.baseUrl') || 'https://api.deepseek.com').replace(/\/+$/, '');
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: Settings.get('chat.model'),
          messages: [{ role: 'user', content: '只回复两个字：在的' }],
          stream: false,
          max_tokens: 16,
        }),
      });
      const ms = Math.round(performance.now() - t0);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (testOut) testOut.textContent = `HTTP ${res.status} in ${ms}ms\n${JSON.stringify(data, null, 2)}`;
        toast('连接失败，请看详情', 'error');
        return;
      }
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (testOut) {
        testOut.textContent = `✅ ${ms}ms · ${data?.model ?? Settings.get('chat.model')}\n回复：${content}\n用量：${JSON.stringify(
          data?.usage ?? {},
        )}`;
      }
      toast('连接成功', 'ok');
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      if (testOut) testOut.textContent = `❌ ${ms}ms\n${err?.message ?? err}\n\n常见原因：网络不通、被浏览器 CORS/混合内容拦截、Key 失效。`;
      toast('连接异常', 'error');
    }
  });

  // 人格预设下拉
  const presetSelect = $('#chat-persona-preset');
  const desc = $('#persona-desc');

  const fillPresets = () => {
    if (!presetSelect) return;
    const presets = listPresets();
    if (presets.length === 0) return;
    presetSelect.replaceChildren();
    for (const p of presets) {
      presetSelect.append(el('option', { text: p.name, attrs: { value: p.id } }));
    }
    presetSelect.value = Settings.get('chat.personaPreset');
    updateDesc();
  };
  const updateDesc = () => {
    if (!desc) return;
    const presets = listPresets();
    const p = presets.find((x) => x.id === Settings.get('chat.personaPreset'));
    desc.textContent = p?.description ?? '（预设说明未加载）';
  };
  presetSelect?.addEventListener('change', updateDesc);
  on(AppEvents.SETTINGS_CHANGED, (e) => {
    if (e.key === 'chat.personaPreset') updateDesc();
  });

  // 桌宠按钮
  $('#pet-reset-pos')?.addEventListener('click', () => {
    Store.remove(PET_POS_KEY);
    const stage = $('#pet-stage');
    if (stage) {
      stage.style.left = '';
      stage.style.top = '';
      stage.style.right = '18px';
      stage.style.bottom = '0';
    }
    toast('桌宠位置已重置', 'ok');
  });

  $('#pet-test-actions')?.addEventListener('click', async () => {
    const ACTIONS = modules.PetUI?.__actions;
    if (!ACTIONS) return toast('桌宠模块未加载', 'warn');
    for (const a of ACTIONS) {
      await modules.PetUI.trigger(a);
      await new Promise((r) => setTimeout(r, 900));
    }
  });

  // 数据与隐私
  $('#data-export')?.addEventListener('click', () => {
    const payload = {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      settings: Settings.all(),
      history: Store.get(HISTORY_KEY, []),
      note: '不含任何 API Key / Token（敏感值只存 sessionStorage，不参与导出）',
    };
    const out = $('#data-out');
    if (out) {
      out.classList.remove('hidden');
      out.textContent = JSON.stringify(payload, null, 2).slice(0, 2000);
    }
    downloadText('aemeath-settings-export.json', JSON.stringify(payload, null, 2));
    toast('已导出（不含密钥）', 'ok');
  });

  $('#data-clear-chat')?.addEventListener('click', () => {
    Store.remove(HISTORY_KEY);
    modules.Chat?.clear?.();
    const box = $('#chat-messages');
    box?.replaceChildren();
    toast('聊天记录已清空', 'ok');
  });

  $('#data-reset')?.addEventListener('click', () => {
    Settings.reset();
    toast('已恢复默认设置（密钥未动）', 'ok');
  });

  // 关于
  const link = $('#about-link');
  if (link) link.href = REPO_URL;
  const ver = $('#about-version');
  if (ver) ver.textContent = VERSION;

  fillPresets();
  // 预设模块可能晚于首次渲染加载完成，稍后重试一次
  setTimeout(fillPresets, 600);
}

/* ==========================================================================
   启动
   ========================================================================== */

async function boot() {
  initShell();
  applyTheme(Settings.get('ui.theme'));
  Settings.prune();
  bindSettingsControls();
  bindOutputLabels();

  on(AppEvents.SETTINGS_CHANGED, (e) => {
    if (e.key === 'ui.theme') applyTheme(e.value);
    if (e.key === 'ui.compact') document.body.classList.toggle('ae-compact', Boolean(e.value));
    if (e.key === 'pet.scale') applyPetScale(e.value);
  });
  document.body.classList.toggle('ae-compact', Boolean(Settings.get('ui.compact')));
  applyPetScale(Settings.get('pet.scale'));

  // —— 并行加载四大模块 ——
  const [, , , ] = await Promise.all([
    loadModule('pet', () => import('./pet/index.js'), 'PetUI'),
    loadModule('chat', () => import('./chat/index.js'), 'Chat'),
    loadModule('voice', () => import('./voice/index.js'), 'Voice'),
    loadModule('training', () => import('./training/index.js'), 'Training'),
  ]);

  // persona 只用于预设下拉，可选
  await loadModule('persona', () => import('./persona/index.js'), 'Persona');

  // —— 桌宠 ——
  const canvas = $('#aemeath-canvas');
  if (modules.PetUI && canvas) {
    Bubble.hasPetUi = true;
    try {
      modules.PetUI.mount(canvas, { scale: Number(Settings.get('pet.scale')) || 1 });
      modules.PetUI.setMood?.(Settings.get('pet.mood') || 'idle');
      startRenderLoop();
    } catch (err) {
      Bubble.hasPetUi = false;
      console.warn('[aemeath:app] PetUI 挂载失败，回退到 DOM 气泡', err);
      toast('桌宠渲染初始化失败，已回退为简易模式', 'warn', 4000);
    }
  } else {
    Bubble.hasPetUi = false;
    console.warn('[aemeath:app] PetUI 不可用');
  }

  // —— 聊天 / 语音 / 训练 ——
  modules.Chat?.init?.({});
  modules.Voice?.init?.({
    onMouth: (v) => modules.PetUI?.setMouth?.(v),
    getText: () => streamingText,
  });

  initPetStage();
  initChatPanel();
  initVoicePanel();
  initTrainPanel();
  initSettingsPanel();

  // —— 桌宠与语音联动 ——
  on(AppEvents.PET_SPEAK_START, () => modules.PetUI?.setMood?.('speak'));
  on(AppEvents.VOICE_TTS_START, () => {
    modules.PetUI?.setMood?.('speak');
    emit(AppEvents.PET_SPEAK_START, { text: '' });
    vibrate(12);
  });
  on(AppEvents.VOICE_TTS_END, () => {
    modules.PetUI?.setMood?.('idle');
    modules.PetUI?.setMouth?.(0);
    emit(AppEvents.PET_SPEAK_END, {});
  });
  on(AppEvents.VOICE_STT_RESULT, ({ final }) => {
    if (final) modules.PetUI?.setMood?.('happy');
  });

  // 模块缺失的显式提示（不静默失败）
  const missing = Object.entries(modules)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    const list = missing.join(' / ');
    console.warn(`[aemeath:app] 以下模块未加载：${list}`);
    const hint = $('#chat-hint');
    if (hint) hint.textContent = `提示：模块未加载 → ${list}`;
  }

  setChatStatus(missing.includes('Chat') ? '模块缺失' : '未连接', missing.includes('Chat') ? 'error' : 'idle');

  const dbg = $('#about-debug');
  if (dbg) {
    dbg.textContent = `模块状态：${Object.entries(modules)
      .map(([k, v]) => `${k}=${v ? '✓' : '✗'}`)
      .join(' ')} · storage ${JSON.stringify(Settings.storageInfo())}`;
  }

  emit(AppEvents.READY, { version: VERSION, modules: Object.keys(modules).filter((k) => modules[k]) });
  console.info(
    `%c爱弥斯桌宠 v${VERSION}`,
    'color:#ff8ec4;font-weight:bold',
    '仅供个人娱乐使用 · 禁止商用 · 不含任何第三方作品素材',
  );
}

function applyPetScale(scale) {
  const stage = $('#pet-stage');
  if (!stage) return;
  const s = Number(scale) || 1;
  stage.style.transform = `scale(${s})`;
  stage.style.transformOrigin = 'bottom right';
}

function startRenderLoop() {
  let last = performance.now();
  let badFrames = 0;
  const tick = (now) => {
    // 契约 §4：PetUI.update(dt) 的 dt 单位是**秒**（不是毫秒）。
    // 这里必须换算，否则 Rig 的 0~0.1s 截断会把每帧都当成超慢帧，动作几乎不动。
    const dtMs = Math.min(64, now - last);
    last = now;
    try {
      modules.PetUI.update(dtMs / 1000);
      badFrames = 0;
    } catch (err) {
      if (badFrames === 0) console.warn('[aemeath:app] 渲染异常（同帧内不再重复刷屏）', err);
      badFrames += 1;
      if (badFrames === 12) console.warn('[aemeath:app] 渲染连续异常 12 帧，桌宠可能停摆');
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function vibrate(ms) {
  try {
    globalThis.navigator?.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}

// 启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
