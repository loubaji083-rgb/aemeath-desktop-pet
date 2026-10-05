/**
 * DOM 小工具 + Toast。禁止用 innerHTML 拼接未转义输入，统一走 textContent。
 */

import { emit, AppEvents } from './events.js';

/**
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {HTMLElement|null}
 */
export function $(sel, root = globalThis.document) {
  return root ? root.querySelector(sel) : null;
}

/**
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {HTMLElement[]}
 */
export function $$(sel, root = globalThis.document) {
  return root ? [...root.querySelectorAll(sel)] : [];
}

/**
 * 创建元素。
 * @param {string} tag
 * @param {object} [props] { className, text, html(仅内部可信模板), attrs, style, dataset, on }
 * @param {(Node|string)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  const { className, text, attrs, style, dataset, on: handlers, id } = props;

  if (id) node.id = id;
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  if (style) Object.assign(node.style, style);
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) node.dataset[k] = String(v);
  }
  if (handlers) {
    for (const [type, fn] of Object.entries(handlers)) node.addEventListener(type, fn);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * 绑定事件，返回解绑函数。
 * @returns {() => void}
 */
export function on(target, type, handler, opts) {
  if (!target) return () => {};
  target.addEventListener(type, handler, opts);
  return () => target.removeEventListener(type, handler, opts);
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts ?? Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastRoot = null;

function ensureToastRoot() {
  if (toastRoot && toastRoot.isConnected) return toastRoot;
  toastRoot = $('#toast-root') ?? null;
  if (!toastRoot) {
    toastRoot = el('div', { id: 'toast-root', className: 'toast-root' });
    document.body.append(toastRoot);
  }
  return toastRoot;
}

/**
 * 轻提示。
 * @param {string} text
 * @param {'info'|'ok'|'warn'|'error'} [kind]
 * @param {number} [ms]
 */
export function toast(text, kind = 'info', ms = 2600) {
  const root = ensureToastRoot();
  const node = el('div', { className: `toast toast-${kind}`, text });
  root.append(node);
  emit(AppEvents.TOAST, { text, kind, ms });
  const timer = setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 260);
  }, Math.max(600, ms));
  node.addEventListener('click', () => {
    clearTimeout(timer);
    node.remove();
  });
  return node;
}

/** 防抖 */
export function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** 节流（RAF 对齐） */
export function throttleRaf(fn) {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}
