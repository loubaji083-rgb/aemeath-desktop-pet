/**
 * tests/events.test.mjs —— 事件总线契约测试（docs/CONTRACT.md §3）
 *
 * 被测对象：web/js/core/events.js（Lead 提供，只读）。
 * 纯逻辑，无 DOM 依赖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  on,
  once,
  off,
  emit,
  AppEvents,
  listenerCount,
  clearAllListeners,
} from '../web/js/core/events.js';

test.afterEach(() => {
  clearAllListeners();
});

test('on() 订阅后 emit() 能收到 payload；返回的 disposer 能退订', () => {
  const seen = [];
  const dispose = on('t:a', (p) => seen.push(p));

  assert.equal(typeof dispose, 'function', 'on() 必须返回取消订阅函数');
  assert.equal(listenerCount('t:a'), 1);

  emit('t:a', { n: 1 });
  emit('t:a', { n: 2 });
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);

  dispose();
  assert.equal(listenerCount('t:a'), 0, 'disposer 调用后不应再持有订阅者');
  emit('t:a', { n: 3 });
  assert.equal(seen.length, 2, '退订后不应再收到事件');
});

test('off() 移除指定 handler；不传 handler 时清空该事件全部订阅', () => {
  const a = [];
  const b = [];
  const ha = (p) => a.push(p);
  const hb = (p) => b.push(p);

  on('t:b', ha);
  on('t:b', hb);
  assert.equal(listenerCount('t:b'), 2);

  off('t:b', ha);
  emit('t:b', 'x');
  assert.deepEqual(a, [], 'off(type, handler) 应精确移除该 handler');
  assert.deepEqual(b, ['x'], '其他 handler 不受影响');

  off('t:b');
  assert.equal(listenerCount('t:b'), 0, 'off(type) 无 handler 时应清空');
  emit('t:b', 'y');
  assert.deepEqual(b, ['x']);
});

test('once() 只触发一次，且返回值可退订（未触发时）', () => {
  let calls = 0;
  once('t:c', () => {
    calls += 1;
  });

  emit('t:c', 1);
  emit('t:c', 2);
  emit('t:c', 3);
  assert.equal(calls, 1, 'once 的 handler 只能执行一次');
  assert.equal(listenerCount('t:c'), 0, '触发后应自动退订');

  let never = 0;
  const dispose = once('t:c2', () => {
    never += 1;
  });
  assert.equal(typeof dispose, 'function');
  dispose();
  emit('t:c2', 1);
  assert.equal(never, 0, 'once 返回的 disposer 必须能在触发前取消');
});

test('emit() 无订阅者 / 未注册事件时静默返回，不抛错', () => {
  assert.doesNotThrow(() => emit('t:nobody', { a: 1 }));
  assert.doesNotThrow(() => emit('t:nobody'));
  assert.equal(listenerCount('t:nobody'), 0);
});

test('订阅者抛错不影响其他订阅者，也不影响 emit() 调用方', () => {
  const order = [];
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);

  try {
    on('t:d', () => order.push('first'));
    on('t:d', () => {
      order.push('boom');
      throw new Error('订阅者爆炸');
    });
    on('t:d', () => order.push('third'));

    assert.doesNotThrow(() => emit('t:d', null), '订阅者抛错不得冒泡出 emit()');
    assert.deepEqual(order, ['first', 'boom', 'third'], '后面的订阅者仍然必须被调用');
    assert.ok(
      warnings.some((w) => String(w[0]).includes('[aemeath:events]')),
      '异常应带 [aemeath:events] 前缀写 console.warn',
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('订阅者可以在自己的回调里 off 自己（emit 期间遍历快照）', () => {
  const seen = [];
  const off_ = on('t:e', (p) => {
    seen.push('a:' + p);
    off_();
  });
  on('t:e', (p) => seen.push('b:' + p));

  emit('t:e', 1);
  emit('t:e', 2);
  assert.deepEqual(seen, ['a:1', 'b:1', 'b:2'], '自注销不得中断本轮 emit 的其他订阅者');
});

test('on() / off() 对非法参数的行为符合实现约定', () => {
  assert.throws(() => on(123, () => {}), TypeError, '非字符串 type 应抛 TypeError');
  assert.throws(() => on('t:f', 'not-a-function'), TypeError, '非函数 handler 应抛 TypeError');
  assert.doesNotThrow(() => off('t:never-registered'), 'off 未知事件应安全返回');
  assert.doesNotThrow(() => off('t:g', () => {}), 'off 未知 handler 应安全返回');
});

test('AppEvents 常量表与 CONTRACT §3 完全一致（值唯一、字符串形态）', () => {
  const expected = {
    READY: 'app:ready',
    PET_CLICK: 'pet:click',
    PET_DRAG_START: 'pet:drag:start',
    PET_DRAG_END: 'pet:drag:end',
    PET_POKE: 'pet:poke',
    PET_MOOD: 'pet:mood',
    PET_BUBBLE: 'pet:bubble',
    PET_SPEAK_START: 'pet:speak:start',
    PET_SPEAK_END: 'pet:speak:end',
    PET_LISTEN_START: 'pet:listen:start',
    PET_LISTEN_END: 'pet:listen:end',
    PET_THINK: 'pet:think',
    CHAT_SEND: 'chat:send',
    CHAT_DELTA: 'chat:delta',
    CHAT_DONE: 'chat:done',
    CHAT_ERROR: 'chat:error',
    VOICE_TTS_START: 'voice:tts:start',
    VOICE_TTS_END: 'voice:tts:end',
    VOICE_STT_RESULT: 'voice:stt:result',
    VOICE_STATE: 'voice:state',
    PANEL_TOGGLE: 'panel:toggle',
    SETTINGS_CHANGED: 'settings:changed',
    TOAST: 'ui:toast',
  };

  assert.deepEqual(
    Object.keys(AppEvents).sort(),
    Object.keys(expected).sort(),
    'AppEvents 的键集合必须与契约一致（不多不少）',
  );
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(AppEvents[key], value, `AppEvents.${key} 的值必须与契约一致`);
  }

  const values = Object.values(AppEvents);
  assert.equal(new Set(values).size, values.length, '事件名不得重复');
  for (const v of values) {
    assert.match(v, /^[a-z]+:[a-z:]+$/, `事件名 "${v}" 不符合 <domain>:<action> 形态`);
  }
});
