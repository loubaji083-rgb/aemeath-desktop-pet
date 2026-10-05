#!/usr/bin/env node
/**
 * tests/pet.test.mjs —— PetUI 契约与运行时行为
 *
 * 契约依据：docs/CONTRACT.md §4（PetUI 的 11 个方法 + ACTIONS 恰好 12 个）与 §9。
 * 环境：pet/index.js 在导入期与 mount() 期都会碰文档环境，所以先装 tools/dom-stub.mjs。
 *
 * 覆盖点：
 *   1. API 面（11 个方法齐 + ACTIONS 恰好 12 个且 id 逐字一致）
 *   2. mount/update/unmount 生命周期，且 mount 幂等、unmount 后监听器归零（防泄漏）
 *   3. 12 个动作逐个真的能播放
 *   4. setMood/getMood（未知情绪忽略、回落上次合法值）
 *   5. hitTest 区域 → lookAt 视线 → setMouth 数值
 *   6. getDebugState() 静态字段与数值有限性
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installDomStub, makeCanvas } from '../tools/dom-stub.mjs';

installDomStub();

const pet = await import(new URL('../web/js/pet/index.js', import.meta.url).href);
const { PetUI, ACTIONS } = pet;

const CONTRACT_METHODS = [
  'mount',
  'update',
  'unmount',
  'trigger',
  'setMood',
  'getMood',
  'hitTest',
  'lookAt',
  'setMouth',
  'attachLive2D',
  'getDebugState',
];

const CONTRACT_ACTIONS = [
  'tap-head',
  'tap-face',
  'tap-body',
  'tap-hand',
  'double-tap',
  'long-press',
  'drag',
  'drop',
  'idle-random',
  'greet',
  'sleep',
  'wake',
];

/** 新建一个已挂载、且已推进若干帧的 PetUI 实例环境 */
function freshMounted(canvas = makeCanvas()) {
  const ok = PetUI.mount(canvas, { scale: 1 });
  assert.equal(ok, true, 'mount() 应返回 true');
  for (let i = 0; i < 30; i += 1) PetUI.update(1 / 60);
  return canvas;
}

function liveListenerCount() {
  const map = globalThis.__aemeathStubListeners ?? new Map();
  let n = 0;
  for (const set of map.values()) n += set.size;
  return n;
}

/* ------------------------------------------------------------------ */

test('PetUI 导出契约 §4：11 个方法齐全（缺一个就是 app.js 运行期 undefined is not a function）', () => {
  assert.ok(PetUI && typeof PetUI === 'object', 'pet/index.js 必须导出 PetUI 对象');
  for (const m of CONTRACT_METHODS) {
    assert.equal(typeof PetUI[m], 'function', `PetUI.${m} 必须是函数`);
  }
  assert.equal(typeof PetUI.version, 'string', 'PetUI.version 应当是字符串');
  assert.equal(pet.default, PetUI, '默认导出应当就是具名导出的 PetUI（同一个对象）');
});

test('ACTIONS 恰好 12 个动作，id 与契约 §4 逐字一致且无多余', () => {
  assert.ok(Array.isArray(ACTIONS), 'pet/index.js 必须导出 ACTIONS 数组');
  const ids = ACTIONS.map((a) => (typeof a === 'string' ? a : a?.id));
  assert.equal(ids.length, 12, `ACTIONS 必须恰好 12 个，实际 ${ids.length} 个`);
  assert.deepEqual([...ids].sort(), [...CONTRACT_ACTIONS].sort());
  assert.equal(new Set(ids).size, 12, '12 个动作 id 不能重复');
  // 契约只规定「恰好 12 个 id」；每一项可以是纯 id 字符串，也可以是 {id,...} 对象，两种都合法
  for (const a of ACTIONS) {
    const id = typeof a === 'string' ? a : a?.id;
    assert.ok(typeof id === 'string' && id.length > 0, `ACTIONS 每项必须有非空 id，实际 ${JSON.stringify(a)}`);
  }
});

test('mount 幂等：重复 mount 不叠加监听器，unmount 后监听器归零（防内存泄漏）', () => {
  PetUI.unmount();
  const before = liveListenerCount();
  const canvas = makeCanvas();
  PetUI.mount(canvas, { scale: 1 });
  const afterFirst = liveListenerCount();
  assert.ok(afterFirst > before, 'mount() 应当注册 window 级监听器（pointer/resize）');

  PetUI.mount(canvas, { scale: 1 });
  const afterSecond = liveListenerCount();
  assert.equal(afterSecond, afterFirst, '重复 mount 不得叠加监听器（必须先释放旧的）');
  assert.equal(PetUI.getDebugState().mounted, true);

  PetUI.unmount();
  assert.equal(liveListenerCount(), before, 'unmount() 之后监听器数量必须回到基线（不允许泄漏）');
  assert.equal(PetUI.getDebugState().mounted, false, 'unmount 后 mounted 必须为 false');
});

test('update() 推进内部时间并保持数值有限；毫秒误传有兼容层', () => {
  freshMounted();
  const t0 = PetUI.getDebugState().time;
  for (let i = 0; i < 60; i += 1) PetUI.update(1 / 60);
  const t1 = PetUI.getDebugState().time;
  assert.ok(t1 > t0, `update(1/60) 应推进 time（${t0} → ${t1}）`);
  assert.ok(Math.abs(t1 - (t0 + 1)) < 0.35, `60 帧 1/60 应约推进 1 秒，实际 ${(t1 - t0).toFixed(3)}`);

  // 误传毫秒（16.7）不应把时间推进到天荒地老
  const before = PetUI.getDebugState().time;
  for (let i = 0; i < 30; i += 1) PetUI.update(16.7);
  const after = PetUI.getDebugState().time;
  assert.ok(Number.isFinite(after), 'time 必须保持有限');
  assert.ok(after - before <= 1.5, `毫秒误传应被兼容成秒级（实际推进 ${(after - before).toFixed(3)}s）`);

  // 惰性/异常入参不得污染 state
  for (const bad of [0, -1, NaN, undefined]) PetUI.update(bad);
  for (const [k, v] of Object.entries(PetUI.getDebugState().params)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `update() 之后参数 ${k} 变成非有限值：${v}`);
  }
});

test('12 个动作逐个可播放（每次都在干净状态下触发）；播放中重复触发应被拒', async () => {
  /**
   * 为什么每个动作都**重新挂载**，而不是在一个会话里连播 12 个：
   * index.js:358-368 有「随机待机小动作」调度器——`idleTimer += dt*1000`，
   * 累计超过 `idleNext`（TIMING.idleActionMinMs=9000 起）就自动 `trigger('idle-random')`。
   * 一个会话里连播 12 个动作，每轮排空 200 帧（3.33s），到第 4 轮左右累计就跨过 9s，
   * 调度器会在**我正要触发 idle-random 的那一刻**先替它出手，于是我的 trigger 返回 false。
   * 这是测试的时序假设错了，不是实现有问题（实测每 6 次全量跑就有 1~2 次红）。
   * 挂载会重置 idleTimer，所以「每个动作前重新挂载」既是干净状态、又天然确定性。
   */
  const results = [];
  let acceptedTotal = 0;
  for (const id of CONTRACT_ACTIONS) {
    PetUI.unmount();
    PetUI.mount(makeCanvas(), { scale: 1 });

    /*
     * 把 pet 推到一个**确定干净**的状态：既没有动作在播，目标动作也没有冷却残留。
     *
     * 为什么必须真的读状态、而不是推固定帧数：
     *   - 动作冷却（`rig.cooldowns`，constants.ACTION_COOLDOWN：greet 2600ms、
     *     idle-random 5200ms）是 **Rig 实例状态**，`unmount()` 不清它；
     *   - `mount()` 自带一次入场 greet（index.js:608 `rig.trigger('greet',{force:true})`），
     *     立刻把 greet 打进 2600ms 冷却 —— 所以「刚挂载」根本不等于「greet 可播」；
     *   - 待机调度器（index.js:358-368）每 ~9s 会自己 `trigger('idle-random')`，
     *     一插手就把 idle-random 打进 5200ms 冷却。
     * 这三条叠加，就是本用例历史上偶发红（报 `greet` 或 `idle-random`）的全部原因。
     *
     * 注意：`update(dt)` 的 dt 是**秒**（契约 §4），传 1/60 推一帧。上限 3000 帧 ≈ 50s，
     * 远大于最长冷却；正常几秒内就退出。判定用 `>=`，避免浮点残留 1e-13 卡住循环。
     */
    const settled = () => {
      const st = PetUI.getDebugState();
      return st.playing.length === 0 && (st.cooldowns[id] ?? 0) <= 0;
    };
    for (let i = 0; i < 3000 && !settled(); i += 1) PetUI.update(1 / 60);

    const before = PetUI.getDebugState();
    const totalStart = before.actionTotal;
    const ok = await PetUI.trigger(id);
    acceptedTotal += PetUI.getDebugState().actionTotal - totalStart;
    if (ok !== true) {
      results.push({
        id,
        ok,
        cooldownLeft: before.cooldowns[id] ?? 0,
        sleeping: before.sleeping,
        playing: before.playing,
        actions: before.actions,
      });
    }
  }
  const failed = results.filter((r) => r.ok !== true);
  assert.deepEqual(
    failed,
    [],
    `这些动作没能播放：${failed
      .map(
        (r) =>
          `${r.id}（冷却剩 ${r.cooldownLeft}ms / sleeping=${r.sleeping} / 正在播 ${JSON.stringify(
            r.playing,
          )} / 已计数 ${JSON.stringify(r.actions)}）`,
      )
      .join('; ')}`,
  );
  // actionTotal 真的在计次（不是每次都返回 true 却什么都没做）。
  // 每次挂载可能自带一次 greet（实测 0 或 1），所以只要求「被接受的动作数 == 12 次触发至少 12 次计数」。
  assert.ok(
    acceptedTotal >= CONTRACT_ACTIONS.length,
    `成功触发的次数应被计入 actionTotal，实际累计增量 ${acceptedTotal}（期望 >= ${CONTRACT_ACTIONS.length}）`,
  );

  // 播放中重复触发同一动作必须被拒（否则会叠加/抖动）。
  // 关键：两次 trigger 之间**一帧都不推**。long-press 的 dur=4600ms 且 loop:true，
  // 只要不推进时间它就一定还在播；一旦推了 200 帧（3.33s）就有可能排空，断言就变成猜时序。
  // 唯一需要推帧的地方是「挂载期自带的那次 greet」——只有它确实在播时才推（避免盲推跨过 9s 让调度器插手）。
  PetUI.unmount();
  PetUI.mount(makeCanvas(), { scale: 1 });
  for (let i = 0; i < 30; i += 1) PetUI.update(1 / 60);
  for (let guard = 0; guard < 400 && PetUI.getDebugState().playing; guard += 1) PetUI.update(1 / 60);
  const firstTrigger = PetUI.trigger('long-press');
  const secondTrigger = PetUI.trigger('long-press');
  assert.equal(await firstTrigger, true, '空闲状态下 long-press 应能播放');
  assert.equal(await secondTrigger, false, '同一动作在播放中重复触发应返回 false');

  // 非法动作 id 必须被拒，且不得计入 actionTotal
  const totalBefore = PetUI.getDebugState().actionTotal;
  for (const bogus of ['nope', '', null, undefined, 123]) {
    assert.equal(await PetUI.trigger(bogus), false, `非法动作 ${JSON.stringify(bogus)} 必须返回 false`);
  }
  assert.equal(PetUI.getDebugState().actionTotal, totalBefore, '非法动作不得计入 actionTotal');
});

test('setMood/getMood：未知情绪被忽略并 warn，getMood 回落到上次合法值', async () => {
  freshMounted();
  // 合法心情清单**从 moods.js 读**，不要凭印象写（我曾写 'curious'，真实表里叫 'surprised'）
  const moodsMod = await import(new URL('../web/js/pet/moods.js', import.meta.url).href);
  const raw = moodsMod.MOODS ?? Object.keys(moodsMod.MOOD_TABLE ?? {});
  const moodIds = raw.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  assert.ok(moodIds.length >= 5, `moods.js 应导出可枚举的心情清单，实际 ${moodIds.length} 个`);

  PetUI.setMood('happy');
  assert.equal(PetUI.getMood(), 'happy');
  for (const m of moodIds) {
    PetUI.setMood(m);
    assert.equal(PetUI.getMood(), m, `setMood('${m}') 之后 getMood() 应返回同一值`);
  }
  PetUI.setMood(moodIds.includes('sleepy') ? 'sleepy' : moodIds[0]);
  const last = PetUI.getMood();
  // 未知情绪：忽略，保留上一次合法值
  PetUI.setMood('nope');
  assert.equal(PetUI.getMood(), last, '未知情绪应被忽略，getMood 保留上次合法值');
  PetUI.setMood(undefined);
  assert.equal(PetUI.getMood(), last, 'undefined 同样不得改变情绪');
});

test('hitTest：画布内的头/身区域能命中，画布外与空白处返回 none', () => {
  freshMounted();
  const face = PetUI.hitTest(180, 120);
  assert.ok(typeof face === 'string' && face !== 'none', `头部位置应命中某区域，实际 ${face}`);
  assert.equal(PetUI.hitTest(180, 300), 'body', '画布中部应命中 body');
  // 越界点一律 none（不能因为算错几何而误判成「点到了宠物」）
  for (const [x, y] of [
    [-1, -1],
    [180, -100],
    [400, 300],
    [9999, 9999],
  ]) {
    assert.equal(PetUI.hitTest(x, y), 'none', `(${x}, ${y}) 在画布外，应为 none`);
  }
  // 非数字入参不得抛错
  for (const bad of [NaN, null, undefined, '10']) {
    assert.equal(typeof PetUI.hitTest(bad, bad), 'string', `hitTest(${String(bad)}) 应返回区域名而不是抛错`);
  }
});

test('lookAt() 真的改变视线参数，且数值有界', () => {
  freshMounted();
  PetUI.lookAt(180, 240);
  for (let i = 0; i < 30; i += 1) PetUI.update(1 / 60);
  const center = PetUI.getDebugState().params;

  PetUI.lookAt(360, 0);
  for (let i = 0; i < 30; i += 1) PetUI.update(1 / 60);
  const right = PetUI.getDebugState().params;

  assert.ok(
    Math.abs(right.gazeX - center.gazeX) > 0.05 || Math.abs(right.gazeY - center.gazeY) > 0.05,
    `lookAt 到右上角后视线应明显偏离中心（center=(${center.gazeX.toFixed(3)},${center.gazeY.toFixed(3)}) right=(${right.gazeX.toFixed(3)},${right.gazeY.toFixed(3)})）`,
  );
  assert.ok(right.gazeX > 0, `看向右侧时 gazeX 应为正，实际 ${right.gazeX}`);
  for (const k of ['gazeX', 'gazeY']) {
    assert.ok(Number.isFinite(right[k]), `${k} 必须是有限数`);
    assert.ok(Math.abs(right[k]) <= 1.5, `${k} 应在合理范围内，实际 ${right[k]}`);
  }
});

test('setMouth()：0..1 内被平滑逼近，越界值收敛到边界，非法值保持当前值不变', () => {
  freshMounted();
  PetUI.setMouth(0);
  for (let i = 0; i < 120; i += 1) PetUI.update(1 / 60);
  const closed = PetUI.getDebugState().params.mouthOpen;
  assert.ok(closed < 0.1, `setMouth(0) 稳定后应基本闭合，实际 ${closed}`);

  // 平滑逼近：60 帧内应单调上升且留在 [0,1]
  PetUI.setMouth(1);
  let prev = closed;
  let max = closed;
  for (let i = 0; i < 60; i += 1) {
    PetUI.update(1 / 60);
    const v = PetUI.getDebugState().params.mouthOpen;
    // 允许极小抖动：闭嘴/呼吸动画会在平滑值上叠一点振荡
    assert.ok(v >= prev - 0.02, `mouthOpen 在向 1 逼近时不应持续回退（${prev} → ${v}）`);
    assert.ok(v >= 0 && v <= 1, `mouthOpen 越界：${v}`);
    prev = v;
    max = Math.max(max, v);
  }
  assert.ok(max > closed + 0.2, `setMouth(1) 持续 1 秒后 mouthOpen 应明显张开（${closed} → ${max}）`);

  // 越界与非法值：不得把状态弄成 NaN 或越界
  for (const bad of [99, -5, NaN, '0.7', null, undefined]) {
    PetUI.setMouth(bad);
    for (let i = 0; i < 10; i += 1) PetUI.update(1 / 60);
    const v = PetUI.getDebugState().params.mouthOpen;
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `setMouth(${String(bad)}) 之后 mouthOpen=${v} 越界或非有限`);
  }
});

test('getDebugState() 提供契约 §9 要求的静态字段，且所有数值参数有限', () => {
  freshMounted();
  const st = PetUI.getDebugState();
  for (const key of ['version', 'mounted', 'mood', 'actions', 'actionTotal', 'playing', 'fps', 'scale', 'size', 'params']) {
    assert.ok(key in st, `getDebugState() 缺少字段 ${key}`);
  }
  assert.equal(typeof st.version, 'string');
  assert.equal(typeof st.mounted, 'boolean');
  assert.equal(typeof st.fps, 'number');
  assert.ok(st.size && typeof st.size.w === 'number' && typeof st.size.h === 'number', 'size 应含 w/h');
  assert.ok(Array.isArray(st.playing), 'playing 应为数组');
  assert.ok(st.params && typeof st.params === 'object', 'params 应为对象');

  // snapshot 语义：改返回值不应改内部状态
  const snapshot = PetUI.getDebugState();
  const fpsBefore = snapshot.fps;
  snapshot.fps = -12345;
  assert.equal(PetUI.getDebugState().fps, fpsBefore, 'getDebugState() 必须是快照，不能把内部状态暴露出去');

  // 全部数值参数有限（NaN 会被 canvas 静默忽略 → 画面残缺，浏览器不报错）
  let numericCount = 0;
  for (const [k, v] of Object.entries(st.params)) {
    if (typeof v === 'number') {
      numericCount += 1;
      assert.ok(Number.isFinite(v), `params.${k} = ${v} 不是有限数`);
    } else if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) {
        if (typeof item === 'number') assert.ok(Number.isFinite(item), `params.${k}[${i}] = ${item} 不是有限数`);
      }
    }
  }
  assert.ok(numericCount >= 10, `params 里的数值字段应成规模，实际只数到 ${numericCount} 个`);
});

test('unmount 后继续 update/trigger 不得抛错（app.js 可能来不及取消定时器）', async () => {
  freshMounted();
  PetUI.unmount();
  assert.doesNotThrow(() => PetUI.update(1 / 60));
  await assert.doesNotReject(async () => PetUI.trigger('greet'));
  assert.equal(PetUI.getDebugState().mounted, false);
  // 重新挂载仍可用（页面切回来）——先把上一次的队列跑空，避免「已在播放中」被拒
  freshMounted();
  assert.equal(PetUI.getDebugState().mounted, true);
  await PetUI.trigger('wake');
  for (let i = 0; i < 200; i += 1) PetUI.update(1 / 60);
  assert.equal(await PetUI.trigger('greet'), true, '重新挂载后动作应能再次播放');
  PetUI.unmount();
});
