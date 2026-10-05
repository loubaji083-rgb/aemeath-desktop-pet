/**
 * settings fallback 语义回归测试（Lead 维护）。
 *
 * 背景：integration-dev 在 task-4 里报出 web/js/core/settings.js 的真实缺陷——
 * 旧实现写的是 `getSecret(key, fallback ?? defaultFor(key))`，而 `??` 无法区分
 * 「调用方没传 fallback」和「调用方传了非 nullish 的 fallback」，于是
 * `Settings.get('chat.apiKey', '__MISSING__')` 会返回哨兵值而不是空串。
 * 一旦有调用方拿别的键的默认值当兜底，兜底字符串就会被当成用户真实 Key 用出去。
 *
 * 现在统一用 NO_FALLBACK 哨兵。这个文件把语义钉死，防止再次退化。
 *
 * 运行：node --test tests/lead-settings.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Settings, DEFAULTS } from '../web/js/core/settings.js';

const SENTINEL = '__MISSING__';
const SECRETS = ['voice.ttsApiKey', 'chat.apiKey', 'train.apiKey'];

test('敏感键未被 set 时：不传 fallback → 空串；传了 fallback 也不返回它（防哨兵泄漏）', () => {
  for (const key of SECRETS) {
    Settings.clearSecret(key);
    assert.equal(Settings.get(key), '', `${key} 无 fallback 应返回空串`);
    assert.equal(
      Settings.get(key, SENTINEL),
      '',
      `${key} 即使显式传了 fallback，未配置时也必须给空串而不是哨兵`,
    );
    assert.equal(Settings.getSecret(key), '', `${key} getSecret 默认应为空串`);
  }
});

test('敏感键 set 之后可被 get/Settings.all 一致读到，clear 之后回到空串', () => {
  const key = 'chat.apiKey';
  Settings.set(key, 'sk-lead-test');
  try {
    assert.equal(Settings.get(key), 'sk-lead-test');
    assert.equal(Settings.getSecret(key), 'sk-lead-test');
    assert.equal(Settings.get(key, SENTINEL), 'sk-lead-test', '有值时 fallback 不该生效');    assert.ok(!Object.prototype.hasOwnProperty.call(Settings.all(), key), '敏感键不得出现在 all() 里');
  } finally {
    Settings.clearSecret(key);
  }
  assert.equal(Settings.get(key), '');
  assert.equal(Settings.get(key, SENTINEL), '', 'clear 后仍是空串，不能把哨兵当 Key');
});

test('三个敏感键的键名与 isSecret 判定一致，且都不在 DEFAULTS 里', () => {
  for (const key of SECRETS) {
    assert.equal(Settings.isSecret(key), true, `${key} 应为敏感键`);
    assert.ok(!Object.prototype.hasOwnProperty.call(DEFAULTS, key), `${key} 不得出现在 DEFAULTS`);
  }
  assert.equal(Settings.isSecret('chat.apiKey'), true);
  assert.equal(Settings.isSecret('voice.ttsEndpoint'), false);
});

test('普通键：已知键一律给「真实设置」，调用方的哨兵 fallback 绝不泄漏', () => {
  // 没有保存过值 → 默认值
  assert.equal(Settings.get('pet.scale'), DEFAULTS['pet.scale']);
  // 已知键即使显式传 fallback，也必须给默认值——而不是把 '__MISSING__' 当结果
  assert.equal(Settings.get('pet.scale', SENTINEL), DEFAULTS['pet.scale']);
  assert.equal(Settings.get('voice.ttsEndpoint'), '');
  assert.equal(Settings.get('voice.ttsEndpoint', SENTINEL), '');

  Settings.set('pet.bubbleMs', 1234);
  try {
    assert.equal(Settings.get('pet.bubbleMs'), 1234);
    assert.equal(Settings.get('pet.bubbleMs', SENTINEL), 1234, '有值就返回保存值');
  } finally {
    Settings.reset('pet.bubbleMs');
  }
  assert.equal(Settings.get('pet.bubbleMs'), DEFAULTS['pet.bubbleMs'], 'reset 后回到默认值');

  // 遍历所有已登记键：任何一个都不允许把哨兵当结果返回（这正是旧版静默失败的形态）
  for (const key of Object.keys(DEFAULTS)) {
    assert.notEqual(Settings.get(key, SENTINEL), SENTINEL, `${key} 不得返回调用方哨兵`);
  }
  for (const key of SECRETS) {
    Settings.clearSecret(key);
    assert.notEqual(Settings.get(key, SENTINEL), SENTINEL, `${key} 不得返回调用方哨兵`);
  }
});

test('未知键：仍返回调用方 fallback、不抛错（写权限仍被拒绝）', () => {
  assert.equal(Settings.get('chat.definitelyNotAKey', 'FB'), 'FB');
  assert.equal(Settings.set('chat.definitelyNotAKey', 'x'), false);
});

test('显式传 undefined 与不传 fallback 同义：都回落默认值，不会把 undefined 当兜底值用出去', () => {
  const key = 'chat.apiKey';
  Settings.clearSecret(key);
  assert.equal(Settings.get(key), '');
  assert.equal(Settings.get(key, undefined), '', 'undefined 视同「没传」');
  assert.equal(Settings.get('pet.scale', undefined), DEFAULTS['pet.scale']);

  // set() 内部也走 coerce()：脏值必须回落到 DEFAULTS，而不是把 undefined 写进存储
  Settings.set('chat.maxTokens', 'not-a-number');
  try {
    assert.equal(Settings.get('chat.maxTokens'), DEFAULTS['chat.maxTokens']);
  } finally {
    Settings.reset('chat.maxTokens');
  }
});
