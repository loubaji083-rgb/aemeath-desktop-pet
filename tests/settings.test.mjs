/**
 * tests/settings.test.mjs —— 设置与敏感值测试（docs/CONTRACT.md §7）
 *
 * 被测对象：web/js/core/settings.js（Lead 提供，只读）。
 *
 * 说明（重要，避免误判为「假通过」）：
 * Node 下没有 localStorage / sessionStorage，settings.js 会走**内存兜底**分支
 * （`localStorageOk === false`）。因此本文件测试的是「内存兜底 + 键集合约束 + 敏感键隔离」，
 * 而不是浏览器持久化本身。存储可用性由 `Settings.storageInfo()` 断言，不做假通过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Settings, DEFAULTS, NS_PREFS, NS_SECRET } from '../web/js/core/settings.js';
import { on, AppEvents, clearAllListeners } from '../web/js/core/events.js';

test.afterEach(() => {
  Settings.reset();
  clearAllListeners();
});

test('DEFAULTS 键集合非空、键名带域前缀、且全部被 Settings.get() 接受', () => {
  const keys = Object.keys(DEFAULTS);
  assert.ok(keys.length >= 30, `DEFAULTS 应至少覆盖 30 个设置项，实际 ${keys.length}`);
  assert.equal(new Set(keys).size, keys.length, 'DEFAULTS 键不得重复');

  for (const key of keys) {
    assert.match(key, /^[a-z]+\.[A-Za-z0-9_]+$/, `设置键 "${key}" 应为 <domain>.<name> 形态`);
    assert.notEqual(
      Settings.get(key, '__MISSING__'),
      '__MISSING__',
      `DEFAULTS 中的键 "${key}" 必须能被 Settings.get() 识别`,
    );
  }

  // 敏感键也必须能被 get() 识别（见文件末尾的「已知缺陷」测试：当前 chat.apiKey /
  // train.apiKey 既不在 DEFAULTS 也不在 get() 的白名单里，会导致 get() 静默返回 fallback）。
  for (const secretKey of Settings.storageInfo().secretKeys) {
    assert.notEqual(
      Settings.get(secretKey, '__MISSING__'),
      '__MISSING__',
      `敏感键 "${secretKey}" 必须能被 Settings.get() 识别（否则调用方会静默拿到空值）`,
    );
  }

  // 契约 §2 提到的四个面板 data-setting 靠 DEFAULTS 驱动，抽查关键域存在
  for (const domain of ['pet.', 'chat.', 'voice.', 'train.', 'ui.']) {
    assert.ok(keys.some((k) => k.startsWith(domain)), `DEFAULTS 必须包含 "${domain}" 域的设置项`);
  }
});

test('Settings.get() 在无持久化存储时回落到 DEFAULTS（内存兜底），且 storageInfo 如实上报', () => {
  const info = Settings.storageInfo();
  assert.equal(typeof info.localStorageOk, 'boolean');
  assert.equal(typeof info.sessionStorageOk, 'boolean');
  assert.equal(typeof globalThis.localStorage, 'undefined', 'Node 下不应存在 localStorage（前提校验）');
  assert.equal(info.localStorageOk, false, 'Node 下 localStorageOk 应为 false');

  assert.equal(Settings.get('chat.model'), DEFAULTS['chat.model']);
  assert.equal(Settings.get('chat.temperature'), DEFAULTS['chat.temperature']);
  assert.equal(Settings.get('pet.showBubble'), DEFAULTS['pet.showBubble']);
  assert.equal(Settings.get('chat.unknownKey', 'FB'), 'FB', '未知键应返回 fallback');
});

test('Settings.set()/get() 往返：类型按 DEFAULTS 强制（number/boolean/string），脏值被拒绝', () => {
  assert.equal(Settings.set('chat.temperature', '0.7'), true, 'set 已知键应返回 true');
  assert.strictEqual(Settings.get('chat.temperature'), 0.7, '字符串 "0.7" 应被强制为 number 0.7');

  Settings.set('chat.maxTokens', 'not-a-number');
  assert.strictEqual(
    Settings.get('chat.maxTokens'),
    DEFAULTS['chat.maxTokens'],
    'NaN 类脏值应回落到默认值',
  );

  Settings.set('pet.showBubble', 'false');
  assert.strictEqual(Settings.get('pet.showBubble'), false, '布尔键应正确解析 "false"');
  Settings.set('pet.showBubble', true);
  assert.strictEqual(Settings.get('pet.showBubble'), true);

  Settings.set('ui.theme', 'dark');
  assert.strictEqual(Settings.get('ui.theme'), 'dark');
  assert.equal(typeof Settings.get('ui.theme'), 'string');

  assert.equal(Settings.set('nope.notAKnownKey', 1), false, '未知键必须被拒绝');
});

test('Settings.all() 返回完整键集合，且不含敏感键', () => {
  const all = Settings.all();
  assert.deepEqual(
    Object.keys(all).sort(),
    Object.keys(DEFAULTS).sort(),
    'all() 的键集合必须与 DEFAULTS 一致',
  );

  // 契约 §7：apiKey 类走 getSecret，绝不进 all()
  for (const secretKey of ['chat.apiKey', 'voice.ttsApiKey', 'train.apiKey']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(all, secretKey),
      false,
      `敏感键 ${secretKey} 不得出现在 all() 中`,
    );
  }
  assert.equal(all['voice.ttsProvider'], DEFAULTS['voice.ttsProvider']);
});

test('敏感键：isSecret 判定正确；set 走 getSecret；不写入偏好命名空间；可 clearSecret', () => {
  assert.equal(Settings.isSecret('chat.apiKey'), true);
  assert.equal(Settings.isSecret('voice.ttsApiKey'), true);
  assert.equal(Settings.isSecret('train.apiKey'), true);
  assert.equal(Settings.isSecret('chat.model'), false, '普通键不得被误判为敏感键');

  const secret = 'sk-unit-test-NOT-A-REAL-KEY';
  Settings.set('chat.apiKey', secret);
  assert.strictEqual(Settings.get('chat.apiKey'), secret, 'set 敏感键应等价于 setSecret');
  assert.strictEqual(Settings.getSecret('chat.apiKey'), secret);

  Settings.clearSecret('chat.apiKey');
  assert.strictEqual(Settings.getSecret('chat.apiKey', ''), '', 'clearSecret 后应为空');

  // 内存兜底路径下也不得把密钥泄漏进偏好表
  const prefsDump = JSON.stringify(Settings.all());
  assert.equal(prefsDump.includes(secret), false, 'all() 不得泄漏密钥内容');
  assert.equal(NS_PREFS, 'aemeath.prefs.');
  assert.equal(NS_SECRET, 'aemeath.secret.');
});

test('Settings.onChange() 收到 { key, value, all }，同时 emit SETTINGS_CHANGED；退订生效', () => {
  const viaCallback = [];
  const viaEvent = [];
  const unsubscribe = Settings.onChange((e) => viaCallback.push(e));
  const offEvent = on(AppEvents.SETTINGS_CHANGED, (e) => viaEvent.push(e));

  Settings.set('chat.model', 'deepseek-reasoner');

  assert.equal(viaCallback.length, 1, 'onChange 回调应被调用一次');
  assert.equal(viaCallback[0].key, 'chat.model');
  assert.equal(viaCallback[0].value, 'deepseek-reasoner');
  assert.ok(viaCallback[0].all && typeof viaCallback[0].all === 'object', 'onChange 应带上 all 快照');
  assert.equal(viaCallback[0].all['chat.model'], 'deepseek-reasoner');

  assert.equal(viaEvent.length, 1, '应同步 emit settings:changed');
  assert.equal(viaEvent[0].key, 'chat.model');

  unsubscribe();
  offEvent();
  Settings.set('chat.model', 'deepseek-chat');
  assert.equal(viaCallback.length, 1, '退订后 onChange 不应再触发');
  assert.equal(viaEvent.length, 1, 'off() 后事件不应再触发');
});

test('Settings.reset() 恢复全部默认值（含此前被改过的键）', () => {
  Settings.set('ui.theme', 'dark');
  Settings.set('voice.rate', 2);
  assert.equal(Settings.get('ui.theme'), 'dark');

  Settings.reset();
  assert.equal(Settings.get('ui.theme'), DEFAULTS['ui.theme']);
  assert.equal(Settings.get('voice.rate'), DEFAULTS['voice.rate']);
});

test('Settings 暴露契约 §7 要求的全部方法', () => {
  for (const method of ['get', 'set', 'all', 'reset', 'getSecret', 'setSecret', 'onChange']) {
    assert.equal(typeof Settings[method], 'function', `Settings.${method} 必须是函数`);
  }
});
