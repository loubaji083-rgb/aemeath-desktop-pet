/** 临时诊断：确认失败的那次 trigger 里 cooldowns['greet'] 到底是几。 */
import { installDomStub, makeCanvas } from '../tools/dom-stub.mjs';
installDomStub();
const pet = await import(new URL('../web/js/pet/index.js', import.meta.url).href);
const petMod = pet;
const PetUI = pet.PetUI ?? pet.default;

// 把 Rig 原型上的 cooldowns 访问拦住：只在 trigger 期间记录
let logging = false;
const logs = [];
// 通过 getDebugState 的 cooldowns 无法拿到内部对象；改为直接给 PetUI 打补丁不行 → 用 Proxy 拦 rig 不可达。
// 因此改为：在 trigger 前后各读一次 getDebugState().cooldowns['greet']，并额外读 rig 的内部计数不可得。
// 可得的替代证据：连续两次读 cooldowns，若第一次 >0 且第二次 ===0 而中间没有 update，说明 judge 发生在 drain 之后。
const ACTIONS = ['tap-head', 'tap-face', 'tap-body', 'tap-hand', 'double-tap', 'long-press', 'drag', 'drop', 'idle-random', 'greet', 'sleep', 'wake'];
for (const id of ACTIONS) {
  PetUI.unmount();
  PetUI.mount(makeCanvas(), { scale: 1 });
  for (let i = 0; i < 30; i += 1) PetUI.update(1 / 60);
  for (let i = 0; i < 200 && PetUI.getDebugState().playing.length; i += 1) PetUI.update(1 / 60);
  for (let guard = 0; guard < 6; guard += 1) {
    for (let i = 0; i < 800 && PetUI.getDebugState().playing.length; i += 1) PetUI.update(1 / 60);
    let drained = 0;
    while ((PetUI.getDebugState().cooldowns[id] ?? 0) > 0 && drained < 800) {
      PetUI.update(1 / 60);
      drained += 1;
    }
    const st = PetUI.getDebugState();
    if ((st.cooldowns[id] ?? 0) === 0 && st.playing.length === 0) break;
  }
  // 精确到「trigger 调用前一刻」与「调用后一刻」，中间不推帧
  const a = PetUI.getDebugState();
  const ok = await PetUI.trigger(id);
  const b = PetUI.getDebugState();
  if (id === 'greet' || ok !== true) {
    console.log(`[${id}] 前: cd=${a.cooldowns[id] ?? 0} playing=${JSON.stringify(a.playing)} total=${a.actionTotal} sleeping=${a.sleeping}`);
    console.log(`[${id}] ok=${ok}`);
    console.log(`[${id}] 后: cd=${b.cooldowns[id] ?? 0} playing=${JSON.stringify(b.playing)} total=${b.actionTotal}`);
  }
}
