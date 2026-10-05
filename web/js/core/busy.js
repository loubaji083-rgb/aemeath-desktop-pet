/**
 * 面板开关、全局快捷键、桌宠气泡、错误统一出口。
 */

import { emit, on, AppEvents } from './events.js';
import { $, $$, el } from './dom.js';

const openPanels = new Set();

const PANELS = ['chat', 'voice', 'train', 'settings'];

function panelEl(id) {
  return document.getElementById(`panel-${id}`);
}

function dockBtn(id) {
  return document.querySelector(`.dock-btn[data-panel="${id}"]`);
}

export const Panels = {
  ids: PANELS,

  isOpen(id) {
    return openPanels.has(id);
  },

  open(id) {
    if (!PANELS.includes(id)) return;
    for (const other of PANELS) {
      if (other !== id) this.close(other);
    }
    openPanels.add(id);
    panelEl(id)?.classList.remove('hidden');
    panelEl(id)?.setAttribute('aria-hidden', 'false');
    dockBtn(id)?.classList.add('is-active');
    dockBtn(id)?.setAttribute('aria-pressed', 'true');
    emit(AppEvents.PANEL_TOGGLE, { panel: id, open: true });
  },

  close(id) {
    openPanels.delete(id);
    panelEl(id)?.classList.add('hidden');
    panelEl(id)?.setAttribute('aria-hidden', 'true');
    dockBtn(id)?.classList.remove('is-active');
    dockBtn(id)?.setAttribute('aria-pressed', 'false');
    emit(AppEvents.PANEL_TOGGLE, { panel: id, open: false });
  },

  toggle(id) {
    if (this.isOpen(id)) this.close(id);
    else this.open(id);
  },

  closeAll() {
    for (const id of PANELS) this.close(id);
  },

  init() {
    for (const btn of $$('.dock-btn')) {
      const id = btn.dataset.panel;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => this.toggle(id));
    }
    for (const id of PANELS) {
      panelEl(id)?.classList.add('hidden');
      panelEl(id)?.setAttribute('aria-hidden', 'true');
    }
    // Esc 关闭最上面板
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openPanels.size > 0) this.closeAll();
    });
    // 面板里的关闭按钮
    for (const btn of $$('[data-panel-close]')) {
      btn.addEventListener('click', () => this.close(btn.dataset.panelClose));
    }
  },
};

/**
 * 桌宠头顶气泡。实际渲染由 PetUI 订阅 PET_BUBBLE 完成；
 * 这里提供统一的发送入口 + 无 PetUI 时的 DOM 兜底。
 */
export const Bubble = {
  hasPetUi: false,

  say(text, ms = 4200) {
    const t = String(text ?? '').trim();
    if (!t) return;
    emit(AppEvents.PET_BUBBLE, { text: t, ms });
    if (this.hasPetUi) return;
    const node = $('#pet-reminder');
    if (!node) return;
    node.textContent = t;
    node.classList.remove('hidden');
    clearTimeout(this._t);
    this._t = setTimeout(() => node.classList.add('hidden'), ms);
  },
};

/** 统一错误出口：所有模块的失败都应经此上报 */
export function reportError(scope, err, userText) {
  const message = userText || (err && err.message) || '未知错误';
  console.warn(`[aemeath:${scope}]`, err);
  emit(AppEvents.CHAT_ERROR, { message, detail: String(err?.stack || err || '') });
  emit(AppEvents.TOAST, { text: `[${scope}] ${message}`, kind: 'error', ms: 4200 });
  return message;
}

/** 应用级初始化：面板 + 键盘快捷键 */
export function initShell() {
  Panels.init();

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const map = { 1: 'chat', 2: 'voice', 3: 'train', 4: 'settings' };
    const id = map[e.key];
    if (id) {
      e.preventDefault();
      Panels.toggle(id);
    }
    if (e.key === '.') {
      e.preventDefault();
      Panels.closeAll();
    }
  });
}

/** 主题应用 */
export function applyTheme(mode) {
  const root = document.documentElement;
  let actual = mode;
  if (mode === 'auto') {
    actual = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.dataset.theme = actual;
  document.body.dataset.theme = actual;
  return actual;
}

/**
 * 重新导出 DOM 小工具。
 *
 * **为什么必须在这里 re-export（而不是让调用方各自去 import dom.js）**：
 * `web/js/app.js:16` 是从**本模块**一次性取这一组的：
 *   `import { $, $$, el, toast, formatTime, reportError, initShell, Panels, Bubble, applyTheme } from './core/busy.js';`
 * 而本文件原先只 `export { on };`。ES Module 的链接是**在求值前**做的静态检查，
 * 缺任何一个命名导出，浏览器和 Node 都会直接抛
 *   `SyntaxError: The requested module './core/busy.js' does not provide an export named '$'`
 * 整个模块图加载失败 → **页面全白**（不是某个功能降级）。
 * 这个 bug 在 2026-02 的真实运行里出现过一次，靠 tools/selfcheck-modules.mjs 抓出来。
 * 因此这里显式补齐，别再删。
 */
export { $, $$, el, on, formatTime, toast } from './dom.js';
