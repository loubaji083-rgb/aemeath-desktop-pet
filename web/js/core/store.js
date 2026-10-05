/**
 * 通用键值存储（带命名空间），用于聊天历史、好感度、训练草稿等非设置类数据。
 * 全局键前缀：aemeath.kv.
 */

const NS = 'aemeath.kv.';
const mem = new Map();

function ls() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key) {
  const s = ls();
  if (!s) return mem.has(key) ? mem.get(key) : null;
  try {
    return s.getItem(NS + key);
  } catch {
    return null;
  }
}

function write(key, value) {
  const s = ls();
  if (!s) {
    mem.set(key, value);
    return;
  }
  try {
    s.setItem(NS + key, value);
  } catch (err) {
    console.warn('[aemeath:store] 写入失败，降级到内存', err);
    mem.set(key, value);
  }
}

function del(key) {
  const s = ls();
  if (s) {
    try {
      s.removeItem(NS + key);
    } catch {
      /* ignore */
    }
  }
  mem.delete(key);
}

export const Store = {
  /** @returns {any} 解析失败或不存在时返回 fallback */
  get(key, fallback = null) {
    const raw = read(key);
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  set(key, value) {
    try {
      write(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn('[aemeath:store] 序列化失败', err);
      return false;
    }
  },

  remove(key) {
    del(key);
  },

  keys(prefix = '') {
    const out = new Set();
    for (const k of mem.keys()) if (k.startsWith(prefix)) out.add(k);
    const s = ls();
    if (s) {
      try {
        for (let i = 0; i < s.length; i += 1) {
          const full = s.key(i);
          if (full && full.startsWith(NS)) {
            const bare = full.slice(NS.length);
            if (bare.startsWith(prefix)) out.add(bare);
          }
        }
      } catch {
        /* ignore */
      }
    }
    return [...out];
  },

  /** 隔离命名空间：返回同一套 get/set/remove，但键自动加前缀 */
  namespace(prefix) {
    const p = `${prefix}${prefix.endsWith('.') ? '' : '.'}`;
    return {
      get: (key, fallback) => Store.get(p + key, fallback),
      set: (key, value) => Store.set(p + key, value),
      remove: (key) => Store.remove(p + key),
      keys: () => Store.keys(p).map((k) => k.slice(p.length)),
    };
  },

  /** 清空本应用的所有 KV（不影响设置） */
  clearNamespace() {
    for (const k of this.keys()) del(k);
    mem.clear();
  },
};

export default Store;
