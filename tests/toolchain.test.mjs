/**
 * tests/toolchain.test.mjs —— 「声音训练工具链」端到端测试。
 *
 * 零第三方依赖 · 不联网 · 不依赖任何真实音频素材（WAV 由本文件内的 makeWav() 现场合成）。
 *
 * 被测对象（本文件只读它们，绝不修改）：
 *   - voice-training/scripts/make-manifest.mjs
 *       collectAudioFiles / probeFile / buildManifest / manifestsInSync / EXIT / SCHEMA_VERSION + CLI
 *   - voice-training/scripts/validate-dataset.mjs
 *       CLI 退出码契约、时长/采样率/查重规则、license 占位值红线
 *       （其内部 isPlaceholder() 未导出，只能经 CLI + --json 间接观察）
 *   - web/js/training/index.js
 *       validateManifest（其内部 isPlaceholder() 与 Node 侧是有意的双份实现，本文件做交叉验证）
 *
 * 隔离性：所有素材都写在 mkdtempSync(join(tmpdir(), 'aemeath-toolchain-')) 造的临时目录里，
 * after() 钩子递归删除。本文件不会往 voice-training/data/ 或 voice-training/manifests/ 写任何东西，
 * 也不会在仓库里留下测试产物。
 *
 * 已发现缺陷（见文件末尾带 { todo: 'DEFECT: ...' } 的那条测试）：
 *   make-manifest.mjs:291-293 生成的**全新骨架清单**，其 license 以「示例」开头但紧跟汉字「占」，
 *   而 validate-dataset.mjs:142 的边界正则要求占位词右侧也是非字母/数字字符，于是「示例占位：…」
 *   不命中 isPlaceholder() → 刚生成的骨架清单直接通过红线校验（exit 0）。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT as MAKE_EXIT,
  SCHEMA_VERSION,
  buildManifest,
  collectAudioFiles,
  manifestsInSync,
  probeFile,
} from '../voice-training/scripts/make-manifest.mjs';
import {
  EXIT as VALIDATE_EXIT,
  RULES,
  SCHEMA_VERSION as VALIDATE_SCHEMA_VERSION,
} from '../voice-training/scripts/validate-dataset.mjs';
import { validateManifest } from '../web/js/training/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAKE_SCRIPT = join(ROOT, 'voice-training', 'scripts', 'make-manifest.mjs');
const VALIDATE_SCRIPT = join(ROOT, 'voice-training', 'scripts', 'validate-dataset.mjs');

/** 造这份骨架清单时 make-manifest 用的 license 模板（用于交叉验证「共享盲点」）。 */
const SKELETON_LICENSE =
  '示例占位：请改写为真实授权说明，例如「说话人本人书面授权，仅用于本地个人非商业用途，不再分发」';
/** 一条真实的授权说明（不含量词占位值）。 */
const REAL_LICENSE = '由本人录制并授权，署名：张三；仅用于本地个人非商业用途的桌宠语音模型训练，不再分发';
const REAL_SCOPE = '仅用于本地个人桌宠语音模型训练，不再分发';

// ───────────────────────────── 临时目录与文件工具 ─────────────────────────────

const TEMP_DIRS = [];
let tmpSeq = 0;

/** 新建一个受管的临时目录（after() 里统一删除）。 */
function makeTmp() {
  tmpSeq += 1;
  const dir = mkdtempSync(join(tmpdir(), 'aemeath-toolchain-'));
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 在 dir 下按 'a/b/c.wav' 这种相对路径写文件（自动建父目录）。 */
function writeFileAt(dir, rel, buf) {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return abs;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 合成 16-bit PCM 的 WAV Buffer。
 * 频率不同 → 采样点不同 → 内容/ sha256 不同（用来构造「同大小但不同内容」的对照组）。
 * 数据块按 采样率 × 声道 × 2 字节/采样 精确给出，所以 probeFile 算出的时长就是 seconds。
 */
function makeWav({ seconds = 1, sampleRate = 16000, freq = 440, channels = 1 } = {}) {
  const bytesPerSample = 2; // 16-bit
  const frameCount = Math.round(seconds * sampleRate);
  const dataSize = frameCount * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16); // fmt 块长度
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byteRate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // blockAlign
  buf.writeUInt16LE(16, 34); // bitsPerSample
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < frameCount; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000);
    for (let c = 0; c < channels; c += 1) {
      buf.writeInt16LE(v, 44 + (i * channels + c) * bytesPerSample);
    }
  }
  return buf;
}

// ───────────────────────────── CLI 调用工具 ─────────────────────────────

/** 用真实的本地 node 起脚本（不联网、不装包）。 */
function runScript(script, args, extra = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
    ...extra,
  });
}

/** 跑脚本并尝试解析 stdout 上的 JSON（+ --json 时）。 */
function runJson(script, args) {
  const res = runScript(script, args);
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null; // 由调用方的断言暴露，而不是在这里抛
  }
  return { ...res, json };
}

function findClip(manifest, rel) {
  return manifest.clips.find((c) => c.file === rel);
}

function findSpeaker(manifest, id) {
  return manifest.speakers.find((s) => s.id === id);
}

/**
 * 造一个「除 license 外全部合格」的数据集：
 * 真实写盘的 WAV + 用 CLI 生成骨架 + 填真实 license/consent/每条 text。
 */
function makeFilledDataset() {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'speaker-a/one.wav', makeWav({ seconds: 5, freq: 440 }));
  writeFileAt(dataDir, 'speaker-a/two.wav', makeWav({ seconds: 5, freq: 550 }));

  const manifestPath = join(makeTmp(), 'dataset.manifest.json');
  const gen = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', manifestPath, '--name', 'e2e-dataset', '--quiet']);
  assert.equal(gen.status, MAKE_EXIT.OK, `生成骨架应 exit 0，stderr=${gen.stderr}`);

  const manifest = readJson(manifestPath);
  manifest.license = REAL_LICENSE;
  manifest.consent = {
    obtained: true,
    subject: 'speaker-a',
    form: 'written',
    date: '2024-05-01',
    scope: REAL_SCOPE,
    note: '只使用本人声音',
  };
  manifest.clips = manifest.clips.map((c, i) => ({ ...c, text: `第 ${i + 1} 条转写文本` }));
  writeJson(manifestPath, manifest);

  return { dataDir, manifestPath, manifest };
}

/**
 * 把刚生成的骨架清单的 license 换成真实授权说明（就地改写 manifestPath）。
 *
 * 为什么各条规则测试都要先做这一步：骨架的 license 是**故意**留的占位说明，
 * 不换掉的话 validate-dataset 每次都会报 license-missing，把真正被测的那条规则
 * （时长越界、采样率、重复内容…）淹没在无关错误里。
 */
function fillLicense(manifestPath) {
  const manifest = readJson(manifestPath);
  manifest.license = REAL_LICENSE;
  if (manifest.consent && typeof manifest.consent === 'object') {
    manifest.consent.obtained = true;
    manifest.consent.scope = REAL_SCOPE;
  }
  writeJson(manifestPath, manifest);
  return manifest;
}

/** 经 Node CLI 观察 validate-dataset 内部 isPlaceholder(license) 的结论。 */
function cliPlaceholderFlag(emptyDataDir, license) {
  const manifestPath = join(makeTmp(), 'license-probe.json');
  writeJson(manifestPath, {
    schemaVersion: VALIDATE_SCHEMA_VERSION,
    name: 'license-probe',
    language: 'zh-CN',
    license,
    consent: { obtained: true, form: 'written', scope: REAL_SCOPE },
    speakers: [{ id: 'speaker-a' }],
    clips: [],
  });
  const res = runJson(VALIDATE_SCRIPT, ['--data', emptyDataDir, '--manifest', manifestPath, '--json']);
  assert.ok(res.json, `validate-dataset --json 应输出可解析 JSON，stdout=${res.stdout} stderr=${res.stderr}`);
  return res.json.errors.some((e) => e.code === 'license-missing');
}

/** 经 web/js/training/index.js 的公开 validateManifest 观察同一结论（isPlaceholder 未导出）。 */
function webPlaceholderFlag(license) {
  const result = validateManifest({
    schemaVersion: 1,
    name: 'license-probe',
    language: 'zh-CN',
    license,
    consent: { obtained: true, form: 'written', scope: REAL_SCOPE },
    speakers: [{ id: 'speaker-a' }],
    clips: [],
  });
  return result.errors.some((e) => e.code === 'license-missing');
}

// ───────────────────────────── 1~3：合成素材与 probeFile ─────────────────────────────

test('makeWav 合成的 WAV 能被 probeFile 正确解析（时长/采样率/声道/位数/64 位 sha256/字节数）——防元信息口径漂移', () => {
  const dir = makeTmp();
  const buf = makeWav({ seconds: 1.5, sampleRate: 16000, freq: 440 });
  const abs = writeFileAt(dir, 'speaker-a/hello.wav', buf);

  assert.doesNotThrow(() => probeFile(abs, '.wav'), 'probeFile 对合法 WAV 不应抛异常');
  const probe = probeFile(abs, '.wav');

  assert.equal(probe.ok, true, `应解析成功，实际=${JSON.stringify(probe)}`);
  assert.equal(probe.duration, 1.5, '时长应精确等于 1.5s（data 字节数 / byteRate）');
  assert.equal(probe.sampleRate, 16000);
  assert.equal(probe.channels, 1);
  assert.equal(probe.bitsPerSample, 16);
  assert.equal(probe.bytes, buf.length, 'bytes 应是整文件字节数');
  assert.match(probe.sha256, /^[0-9a-f]{64}$/, 'sha256 必须是 64 位小写十六进制');
  assert.equal(
    probe.sha256,
    createHash('sha256').update(buf).digest('hex'),
    'sha256 必须是整文件内容的 sha256（查重靠它，不能只哈希文件头）',
  );
});

test('不同频率的 WAV 内容不同 → sha256 不同——防把「同样大小」误当成「同样内容」而漏查重', () => {
  const dir = makeTmp();
  const a = writeFileAt(dir, 'a.wav', makeWav({ seconds: 1, freq: 440 }));
  const b = writeFileAt(dir, 'b.wav', makeWav({ seconds: 1, freq: 660 }));

  const pa = probeFile(a, '.wav');
  const pb = probeFile(b, '.wav');

  assert.equal(pa.bytes, pb.bytes, '对照组前提：两个文件字节数相同');
  assert.notEqual(pa.sha256, pb.sha256, '字节数相同但内容不同，sha256 必须不同');
});

test('probeFile 对非音频 / 不存在 / 未实现格式返回 ok:false 且绝不抛异常——防一个坏文件让整条工具链崩掉', () => {
  const dir = makeTmp();
  const garbageWav = writeFileAt(dir, 'speaker-a/fake.wav', Buffer.from('这不是 WAV，只是一段随手写的文本。'.repeat(8), 'utf8'));
  const garbageOgg = writeFileAt(dir, 'speaker-a/fake.ogg', Buffer.from('not an ogg stream at all', 'utf8'));
  const missing = join(dir, 'speaker-a', 'missing.wav');

  assert.doesNotThrow(() => probeFile(garbageWav, '.wav'));
  const badWav = probeFile(garbageWav, '.wav');
  assert.equal(badWav.ok, false);
  assert.equal(badWav.reason, 'invalid-header');
  assert.equal(typeof badWav.message, 'string');
  assert.match(badWav.sha256, /^[0-9a-f]{64}$/, '即使解析失败也要给出 sha256，便于校验脚本报告被改过的文件');
  assert.equal(badWav.bytes, Buffer.byteLength('这不是 WAV，只是一段随手写的文本。'.repeat(8), 'utf8'));

  assert.doesNotThrow(() => probeFile(garbageOgg, '.ogg'));
  const badOgg = probeFile(garbageOgg, '.ogg');
  assert.equal(badOgg.ok, false);
  assert.equal(badOgg.reason, 'unsupported-format', '未实现头解析的格式要如实返回 unsupported-format，不假装能解析');

  assert.doesNotThrow(() => probeFile(missing, '.wav'));
  const gone = probeFile(missing, '.wav');
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, 'read-failed');
});

// ───────────────────────────── 4~7：collectAudioFiles ─────────────────────────────

test('collectAudioFiles 按第一级目录名取说话人 id、data 根下归 speaker-a，并跳过隐藏/排除目录与非音频文件', () => {
  const dataDir = makeTmp();
  const wav = (freq) => makeWav({ seconds: 0.1, freq });

  writeFileAt(dataDir, 'root-a.wav', wav(440)); // 根目录 → speaker-a
  writeFileAt(dataDir, 'spk-a/one.wav', wav(441));
  writeFileAt(dataDir, 'spk-a/two.wav', wav(442));
  writeFileAt(dataDir, 'spk-a/zz-last.wav', wav(443));
  writeFileAt(dataDir, 'spk-a/notes.txt', Buffer.from('不是音频', 'utf8')); // 非音频，不收
  writeFileAt(dataDir, 'spk-b/three.wav', wav(444));
  writeFileAt(dataDir, 'spk-a/UPPER.WAV', wav(445)); // 扩展名大小写不敏感
  // 以下全部应被跳过
  writeFileAt(dataDir, '.hidden/secret.wav', wav(446));
  writeFileAt(dataDir, '.git/g.wav', wav(447));
  writeFileAt(dataDir, 'tmp/tmp.wav', wav(448));
  writeFileAt(dataDir, 'node_modules/nm.wav', wav(449));
  writeFileAt(dataDir, 'outputs/out.wav', wav(450));
  writeFileAt(dataDir, 'cache/c.wav', wav(451));

  const found = collectAudioFiles(dataDir);
  const byRel = new Map(found.map((f) => [f.rel, f]));

  assert.deepEqual(
    [...byRel.keys()].sort(),
    ['root-a.wav', 'spk-a/UPPER.WAV', 'spk-a/one.wav', 'spk-a/two.wav', 'spk-a/zz-last.wav', 'spk-b/three.wav'],
    '只收音频扩展名，且跳过隐藏目录与 node_modules/tmp/outputs/cache/.git',
  );
  assert.equal(byRel.get('root-a.wav').speakerId, 'speaker-a', 'data/ 根下的文件归 speaker-a');
  assert.equal(byRel.get('spk-a/one.wav').speakerId, 'spk-a', '说话人 id 取相对路径第一级目录名');
  assert.equal(byRel.get('spk-b/three.wav').speakerId, 'spk-b');
  assert.equal(byRel.get('spk-a/UPPER.WAV').ext, '.wav', 'ext 应归一化为小写');
  assert.ok(byRel.get('spk-a/UPPER.WAV').abs.startsWith(dataDir), 'abs 应是绝对路径');
  assert.equal(found.some((f) => f.rel.endsWith('.txt')), false, '.txt 等非音频不得进清单');
});

test('collectAudioFiles 结果按 rel 稳定排序——防目录枚举顺序让清单 diff 乱跳', () => {
  const dataDir = makeTmp();
  for (const [rel, freq] of [
    ['spk-b/z.wav', 460],
    ['spk-a/m.wav', 461],
    ['spk-a/a.wav', 462],
    ['zz-root.wav', 463],
    ['spk-c/q.wav', 464],
  ]) {
    writeFileAt(dataDir, rel, makeWav({ seconds: 0.1, freq }));
  }

  const first = collectAudioFiles(dataDir).map((f) => f.rel);
  const second = collectAudioFiles(dataDir).map((f) => f.rel);

  assert.deepEqual(first, [...first].sort(), 'rel 必须按字典序升序');
  assert.deepEqual(first, ['spk-a/a.wav', 'spk-a/m.wav', 'spk-b/z.wav', 'spk-c/q.wav', 'zz-root.wav']);
  assert.deepEqual(second, first, '两次调用必须完全一致（稳定排序，不随目录枚举顺序变化）');
});

test('collectAudioFiles 递归深度上限为 6——防掉进异常深的目录树', () => {
  const dataDir = makeTmp();
  const okPath = 'd1/d2/d3/d4/d5/d6/ok.wav'; // 6 层目录，应被收取
  const tooDeep = 'd1/d2/d3/d4/d5/d6/d7/too-deep.wav'; // 第 7 层，应被跳过
  writeFileAt(dataDir, okPath, makeWav({ seconds: 0.1, freq: 470 }));
  writeFileAt(dataDir, tooDeep, makeWav({ seconds: 0.1, freq: 471 }));

  const rels = collectAudioFiles(dataDir).map((f) => f.rel);
  assert.deepEqual(rels, [okPath], '深度上限 6：第 6 层目录中的文件要收，第 7 层要跳过');
});

test('collectAudioFiles 的 forcedSpeakerId 覆盖所有文件的说话人 id——单说话人模式不得漏改', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'root.wav', makeWav({ seconds: 0.1, freq: 480 }));
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 0.1, freq: 481 }));
  writeFileAt(dataDir, 'spk-b/b.wav', makeWav({ seconds: 0.1, freq: 482 }));

  const found = collectAudioFiles(dataDir, 'spk-forced');
  assert.equal(found.length, 3);
  assert.deepEqual([...new Set(found.map((f) => f.speakerId))], ['spk-forced']);
});

// ───────────────────────────── 8~10：buildManifest ─────────────────────────────

test('buildManifest 生成 schemaVersion=1 的清单与正确统计——防清单结构与 report 口径漂移', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'root.wav', makeWav({ seconds: 5, freq: 440 }));
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 5, freq: 441 }));
  writeFileAt(dataDir, 'spk-a/b.wav', makeWav({ seconds: 5, freq: 442 }));
  writeFileAt(dataDir, 'spk-a/readme.txt', Buffer.from('说明文本', 'utf8'));

  const { manifest, report } = buildManifest({ dataDir, name: '我的数据集', language: 'zh-CN' });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.name, '我的数据集', '首次生成时 --name 必须落到清单上');
  assert.equal(manifest.language, 'zh-CN');
  assert.equal(typeof manifest.license, 'string');
  assert.ok(manifest.license.length > 0, 'license 必须给出（占位）模板，不能被留空');
  assert.equal(typeof manifest.notes, 'string');

  assert.equal(manifest.clips.length, 3, '.txt 不得被收进 clips');
  assert.deepEqual(
    manifest.clips.map((c) => c.file),
    ['root.wav', 'spk-a/a.wav', 'spk-a/b.wav'],
  );
  for (const clip of manifest.clips) {
    assert.equal(clip.duration, 5);
    assert.equal(clip.sampleRate, 16000);
    assert.equal(clip.channels, 1);
    assert.equal(clip.bitsPerSample, 16);
    assert.match(clip.sha256, /^[0-9a-f]{64}$/);
    assert.ok(clip.bytes > 44);
  }
  assert.equal(findClip(manifest, 'root.wav').speaker, 'speaker-a');
  assert.equal(findClip(manifest, 'spk-a/a.wav').speaker, 'spk-a');

  assert.deepEqual(manifest.speakers.map((s) => s.id), ['speaker-a', 'spk-a'], 'speakers 按 clips 出现顺序去重');
  assert.equal(report.fileCount, 3);
  assert.equal(report.clipCount, 3);
  assert.deepEqual(report.speakerIds, ['speaker-a', 'spk-a']);
  assert.equal(report.totalDurationSec, 15);
  assert.deepEqual(report.probeFailures, []);
  assert.deepEqual(report.duplicateGroups, []);
  assert.equal(report.keptFields, null, '没有 previous 时不应谎报「保留了手填字段」');
});

test('buildManifest 用 sha256 识别同内容重复（duplicateGroups）——防重复片段污染训练集而无人知晓', () => {
  const dataDir = makeTmp();
  const same = makeWav({ seconds: 4, freq: 500 });
  writeFileAt(dataDir, 'spk-a/orig.wav', same);
  writeFileAt(dataDir, 'spk-b/copy.wav', Buffer.from(same)); // 完全相同的字节
  writeFileAt(dataDir, 'spk-a/other.wav', makeWav({ seconds: 4, freq: 501 }));

  const { manifest, report } = buildManifest({ dataDir });

  assert.equal(manifest.clips.length, 3);
  assert.equal(report.duplicateGroups.length, 1, '只有一组重复内容');
  const group = report.duplicateGroups[0];
  assert.deepEqual(group.files, ['spk-a/orig.wav', 'spk-b/copy.wav']);
  assert.equal(group.sha256, findClip(manifest, 'spk-a/orig.wav').sha256);
  assert.equal(group.sha256, findClip(manifest, 'spk-b/copy.wav').sha256);
  assert.ok(manifest.clips.every((c) => c.probeError === undefined), '合法 WAV 不应带 probeError');
});

test('buildManifest 把无法解析的文件也写进清单并标 probeError——防静默漏掉一个坏文件', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'spk-a/good.wav', makeWav({ seconds: 4, freq: 510 }));
  writeFileAt(dataDir, 'spk-a/bad.ogg', Buffer.from('二进制垃圾，不是 ogg', 'utf8'));

  const { manifest, report } = buildManifest({ dataDir });

  assert.equal(manifest.clips.length, 2, '解析失败的文件也必须出现在 clips 里');
  const bad = findClip(manifest, 'spk-a/bad.ogg');
  assert.ok(bad, '坏文件条目必须存在');
  assert.equal(bad.probeError, 'unsupported-format');
  assert.match(bad.sha256, /^[0-9a-f]{64}$/);
  assert.equal(bad.bytes, Buffer.byteLength('二进制垃圾，不是 ogg', 'utf8'));
  assert.equal(bad.duration, undefined, '解析失败不得伪造 duration');

  assert.equal(report.probeFailures.length, 1);
  assert.equal(report.probeFailures[0].file, 'spk-a/bad.ogg');
  assert.equal(report.probeFailures[0].reason, 'unsupported-format');
});

// ───────────────────────────── 11~13：幂等与收敛 ─────────────────────────────

test('幂等（进程内）：previous 的手填字段被保留、由文件决定的字段被刷新——防重跑冲掉用户手写的授权与转写', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 5, freq: 520 }));
  writeFileAt(dataDir, 'spk-a/b.wav', makeWav({ seconds: 4, freq: 521 }));

  const first = buildManifest({ dataDir, name: 'ds-1', language: 'zh-CN' }).manifest;
  assert.equal(findClip(first, 'spk-a/a.wav').duration, 5);

  // 模拟「用户在清单里手填」
  first.license = REAL_LICENSE;
  first.consent = { obtained: true, subject: 'spk-a', form: 'written', date: '2024-05-01', scope: REAL_SCOPE };
  first.notes = '这是我的备注，不要动';
  findClip(first, 'spk-a/a.wav').text = '你好，世界。';
  findClip(first, 'spk-a/a.wav').split = 'train';
  findSpeaker(first, 'spk-a').displayName = '张三';
  findSpeaker(first, 'spk-a').consent = { obtained: true, form: 'written', date: '2024-05-01' };

  // 文件本身变了（时长 5s → 7s），由文件决定的字段必须刷新
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 7, freq: 520 }));

  const { manifest: second, report } = buildManifest({ dataDir, previous: first });

  assert.equal(second.license, REAL_LICENSE, '手填 license 必须保留');
  assert.deepEqual(second.consent, first.consent, '手填 consent 必须保留');
  assert.equal(second.notes, '这是我的备注，不要动', '手填 notes 必须保留');
  assert.equal(second.name, 'ds-1', 'previous.name 优先于本次 --name');
  assert.equal(findClip(second, 'spk-a/a.wav').text, '你好，世界。', '手填 clips[].text 必须保留');
  assert.equal(findClip(second, 'spk-a/a.wav').split, 'train', '手填 clips[].split 必须保留');
  assert.equal(findSpeaker(second, 'spk-a').displayName, '张三', '手填 speakers[].displayName 必须保留');
  assert.deepEqual(findSpeaker(second, 'spk-a').consent, { obtained: true, form: 'written', date: '2024-05-01' });

  const refreshed = findClip(second, 'spk-a/a.wav');
  assert.equal(refreshed.duration, 7, '时长由文件决定，必须刷新');
  assert.notEqual(refreshed.sha256, findClip(first, 'spk-a/a.wav').sha256, '内容变了 sha256 必须刷新');
  assert.equal(refreshed.bytes, 44 + 7 * 16000 * 2);

  assert.deepEqual(report.keptFields, {
    name: true,
    license: true,
    consent: true,
    speakerDisplayNames: true,
  });
});

test('CLI 端到端幂等：先生成骨架 → 手填 → 再跑，手填内容不被冲掉而时长被刷新——防「重跑一次手填全没了」', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 5, freq: 530 }));
  writeFileAt(dataDir, 'spk-a/b.wav', makeWav({ seconds: 4, freq: 531 }));
  const outFile = join(makeTmp(), 'dataset.manifest.json');

  const first = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', outFile, '--name', 'my-voice', '--quiet']);
  assert.equal(first.status, MAKE_EXIT.OK, `首次生成应 exit 0，stderr=${first.stderr}`);
  assert.ok(existsSync(outFile), '首次生成必须写出清单');

  const skeleton = readJson(outFile);
  assert.equal(skeleton.name, 'my-voice');
  assert.deepEqual(
    skeleton.clips.map((c) => c.file),
    ['spk-a/a.wav', 'spk-a/b.wav'],
  );
  assert.equal(findClip(skeleton, 'spk-a/a.wav').text, undefined, '骨架不该凭空给出转写文本');

  // 手填（模拟用户用编辑器改清单）
  skeleton.license = REAL_LICENSE;
  skeleton.consent = { obtained: true, subject: 'spk-a', form: 'written', date: '2024-05-01', scope: REAL_SCOPE };
  findClip(skeleton, 'spk-a/a.wav').text = '第一句转写';
  findSpeaker(skeleton, 'spk-a').displayName = '张三';
  writeJson(outFile, skeleton);

  // 素材变了，再跑一次
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 6, freq: 530 }));
  const second = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', outFile, '--quiet']);
  assert.equal(second.status, MAKE_EXIT.OK, `重跑应 exit 0，stderr=${second.stderr}`);

  const after = readJson(outFile);
  assert.equal(after.license, REAL_LICENSE, '重跑不得冲掉手填 license（这是红线字段）');
  assert.deepEqual(after.consent, skeleton.consent, '重跑不得冲掉手填 consent');
  assert.equal(findClip(after, 'spk-a/a.wav').text, '第一句转写', '重跑不得冲掉手填转写文本');
  assert.equal(findSpeaker(after, 'spk-a').displayName, '张三', '重跑不得冲掉手填说话人名');
  assert.equal(findClip(after, 'spk-a/a.wav').duration, 6, '时长必须刷新为最新值');
  assert.equal(after.name, 'my-voice');
});

test('收敛：删掉音频后重跑，clips 与 speakers 同步减少——防清单里留下幽灵条目', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 4, freq: 540 }));
  const doomed = writeFileAt(dataDir, 'spk-b/b.wav', makeWav({ seconds: 4, freq: 541 }));

  const first = buildManifest({ dataDir }).manifest;
  assert.equal(first.clips.length, 2);
  assert.deepEqual(first.speakers.map((s) => s.id), ['spk-a', 'spk-b']);

  unlinkSync(doomed);
  const second = buildManifest({ dataDir, previous: first }).manifest;

  assert.equal(second.clips.length, 1, '被删文件的条目必须消失');
  assert.equal(second.clips.some((c) => c.file === 'spk-b/b.wav'), false);
  assert.deepEqual(second.speakers.map((s) => s.id), ['spk-a'], '没有片段的说话人不得留在 speakers 里');
});

// ───────────────────────────── 14：manifestsInSync ─────────────────────────────

test('manifestsInSync：内容一致为 true，sha256 变化为 false，条数变化为 false——--check 的判据本身要准', () => {
  const make = (file, sha, sr = 16000, ch = 1) => ({ clips: [{ file, sha256: sha, sampleRate: sr, channels: ch }] });
  const a = { clips: [{ file: 'a.wav', sha256: 'x', sampleRate: 16000, channels: 1 }, { file: 'b.wav', sha256: 'y', sampleRate: 16000, channels: 1 }] };
  const b = { clips: [{ file: 'b.wav', sha256: 'y', sampleRate: 16000, channels: 1 }, { file: 'a.wav', sha256: 'x', sampleRate: 16000, channels: 1 }] };

  assert.equal(manifestsInSync(a, a), true, '同一份清单必须一致');
  assert.equal(manifestsInSync(a, b), true, '条目顺序不同但内容相同应算一致（内部按 file 排序）');
  assert.equal(manifestsInSync(make('a.wav', 'x'), make('a.wav', 'z')), false, 'sha256 变了必须算不一致');
  assert.equal(manifestsInSync(make('a.wav', 'x', 16000), make('a.wav', 'x', 44100)), false, '采样率变了必须算不一致');
  assert.equal(manifestsInSync(make('a.wav', 'x', 16000, 1), make('a.wav', 'x', 16000, 2)), false, '声道数变了必须算不一致');
  assert.equal(manifestsInSync(a, make('a.wav', 'x')), false, '条目数量变了必须算不一致');
  assert.equal(manifestsInSync({ clips: [] }, { clips: [] }), true);
  assert.equal(manifestsInSync(null, { clips: [] }), true, '缺清单等价于空 clips（--check 里由「清单不存在」单独处理）');
  assert.equal(manifestsInSync(null, a), false);
});

// ───────────────────────────── 15：退出码常量契约 ─────────────────────────────

test('退出码契约：两个脚本的 EXIT 都是 {0,1,2,3,70}、SCHEMA_VERSION 都是 1——防 CI 只看退出码时口径漂移', () => {
  assert.deepEqual(MAKE_EXIT, { OK: 0, ERRORS: 1, USAGE: 2, MISSING: 3, INTERNAL: 70 });
  assert.deepEqual(VALIDATE_EXIT, { OK: 0, ERRORS: 1, USAGE: 2, MISSING: 3, INTERNAL: 70 });
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(VALIDATE_SCHEMA_VERSION, 1);
  assert.ok(RULES.placeholderValues.includes('待填'), '占位词表必须包含「待填」');
  assert.ok(RULES.placeholderValues.includes('示例'), '占位词表必须包含「示例」');
  assert.equal(RULES.minSampleRate, 16000);
});

// ───────────────────────────── 16~18：make-manifest CLI ─────────────────────────────

test('make-manifest CLI：--help=0 / 未知选项=2 / 缺参数值=2 / 数据目录缺失=3——防 CI 误把用法错误当成功', () => {
  const help = runScript(MAKE_SCRIPT, ['--help']);
  assert.equal(help.status, MAKE_EXIT.OK);
  assert.match(help.stdout, /用法/);
  assert.match(help.stdout, /--check/);

  const unknown = runScript(MAKE_SCRIPT, ['--nope']);
  assert.equal(unknown.status, MAKE_EXIT.USAGE);
  assert.match(unknown.stderr, /未知选项/);

  const missingValue = runScript(MAKE_SCRIPT, ['--data']);
  assert.equal(missingValue.status, MAKE_EXIT.USAGE);
  assert.match(missingValue.stderr, /缺少参数值/);

  const noDir = join(makeTmp(), 'does-not-exist');
  const missing = runScript(MAKE_SCRIPT, ['--data', noDir, '--out', join(makeTmp(), 'x.json'), '--quiet']);
  assert.equal(missing.status, MAKE_EXIT.MISSING, '数据目录不存在必须 exit 3');
  assert.match(missing.stderr, /找不到素材目录/);
  assert.equal(existsSync(join(noDir, 'x.json')), false);
});

test('make-manifest CLI --json：摘要字段可直接被脚本消费——防流水线靠解析人类可读文本', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 5, freq: 550 }));
  const outFile = join(makeTmp(), 'm.json');

  const res = runJson(MAKE_SCRIPT, ['--data', dataDir, '--out', outFile, '--json']);
  assert.equal(res.status, MAKE_EXIT.OK, `stderr=${res.stderr}`);
  assert.ok(res.json, `--json 必须输出可解析 JSON，stdout=${res.stdout}`);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.summary.fileCount, 1);
  assert.equal(res.json.summary.clipCount, 1);
  assert.equal(res.json.summary.totalDurationSec, 5);
  assert.ok(existsSync(outFile), '--json 不影响写清单');
});

test('make-manifest CLI --check：一致 exit 0，音频内容被改后 exit 1，且失败时也不得改写清单——防清单与磁盘悄悄漂移', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 5, freq: 560 }));
  writeFileAt(dataDir, 'spk-a/b.wav', makeWav({ seconds: 5, freq: 561 }));
  const outFile = join(makeTmp(), 'dataset.manifest.json');

  const gen = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', outFile, '--quiet']);
  assert.equal(gen.status, MAKE_EXIT.OK, `首次生成应 exit 0，stderr=${gen.stderr}`);
  const before = readFileSync(outFile, 'utf8');

  const synced = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', outFile, '--check']);
  assert.equal(synced.status, MAKE_EXIT.OK, `一致时 --check 应 exit 0，stderr=${synced.stderr}`);
  assert.match(synced.stdout, /一致/);
  assert.equal(readFileSync(outFile, 'utf8'), before, '--check 是只读校验，不得改写清单');

  // 时长/采样率/声道都不变，只有内容（sha256）变 —— 专测 --check 真的比了哈希
  writeFileAt(dataDir, 'spk-a/a.wav', makeWav({ seconds: 5, freq: 999 }));
  const drifted = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', outFile, '--check']);
  assert.equal(drifted.status, MAKE_EXIT.ERRORS, '内容漂移必须 exit 1');
  assert.match(drifted.stderr, /不一致/);
  assert.equal(readFileSync(outFile, 'utf8'), before, '--check 失败时同样不得改写清单');

  const missingOut = join(makeTmp(), 'nope.json');
  const missing = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', missingOut, '--check', '--quiet']);
  assert.equal(missing.status, MAKE_EXIT.ERRORS, '清单不存在时 --check 必须 exit 1，不能假装一致');
  assert.match(missing.stderr, /清单不存在/);

  const dryOut = join(makeTmp(), 'dry.json');
  const dry = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', dryOut, '--dry-run', '--quiet']);
  assert.equal(dry.status, MAKE_EXIT.OK);
  assert.equal(existsSync(dryOut), false, '--dry-run 不得写文件');
});

// ───────────────────────────── 19~21：validate-dataset CLI 与红线 ─────────────────────────────

test('validate-dataset CLI：--help=0 / 数据目录缺失=3 / 清单缺失=3 / 非法阈值=2——防缺输入被当成「校验通过」', () => {
  const help = runScript(VALIDATE_SCRIPT, ['--help']);
  assert.equal(help.status, VALIDATE_EXIT.OK);
  assert.match(help.stdout, /校验/);

  const noDir = join(makeTmp(), 'no-such-data');
  const missingData = runScript(VALIDATE_SCRIPT, ['--data', noDir]);
  assert.equal(missingData.status, VALIDATE_EXIT.MISSING);
  assert.match(missingData.stderr, /数据目录不存在/);

  const dataDir = makeTmp();
  const missingManifest = runScript(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', join(makeTmp(), 'nope.json')]);
  assert.equal(missingManifest.status, VALIDATE_EXIT.MISSING);
  assert.match(missingManifest.stderr, /清单文件不存在/);

  const badMin = runScript(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', join(makeTmp(), 'nope.json'), '--min-seconds', '0']);
  assert.equal(badMin.status, VALIDATE_EXIT.USAGE, '--min-seconds 0 是用法错误');
  const nanMin = runScript(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', join(makeTmp(), 'nope.json'), '--min-seconds', 'abc']);
  assert.equal(nanMin.status, VALIDATE_EXIT.USAGE, '非数值阈值是用法错误');
  const unknownFlag = runScript(VALIDATE_SCRIPT, ['--wat']);
  assert.equal(unknownFlag.status, VALIDATE_EXIT.USAGE);
});

test('validate-dataset CLI：手填真实授权 + consent + 每条 clips[].text → exit 0 且 errors 为空', () => {
  const { dataDir, manifestPath } = makeFilledDataset();

  const res = runJson(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', manifestPath, '--json']);
  assert.equal(res.status, VALIDATE_EXIT.OK, `应通过；errors=${JSON.stringify(res.json?.errors)}`);
  assert.ok(res.json, `--json 必须输出可解析 JSON，stdout=${res.stdout}`);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.errors, [], '合格清单不得有任何错误');
  const warningCodes = res.json.warnings.map((w) => w.code);
  assert.equal(warningCodes.includes('clip-text-missing'), false, '已补齐 text 就不该再报缺转写');
  assert.equal(res.json.stats.clips, 2);
  assert.equal(res.json.stats.totalDurationSec, 10);
});

test('回归哨兵：license="来源：待填" 必须被拒（exit 1，错误码 license-missing）——防「后缀形态占位」绕过授权红线', () => {
  // 为什么专门盯这一条：早先 isPlaceholder 只判 `s === 占位词` 与 `startsWith(占位词 + '：')`，
  // 于是用户写「来源：待填」这种更自然的**后缀形态**时判不出来，授权红线形同虚设。
  const { dataDir, manifestPath } = makeFilledDataset();
  const manifest = readJson(manifestPath);
  manifest.license = '来源：待填';
  writeJson(manifestPath, manifest);

  const res = runJson(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', manifestPath, '--json']);
  assert.equal(res.status, VALIDATE_EXIT.ERRORS, `「来源：待填」必须 exit 1；warnings=${JSON.stringify(res.json?.warnings)}`);
  assert.ok(res.json, `--json 必须输出可解析 JSON，stdout=${res.stdout}`);
  assert.equal(res.json.ok, false);
  assert.ok(
    res.json.errors.some((e) => e.code === 'license-missing' && e.field === 'license'),
    `必须报 license-missing/license，实际=${JSON.stringify(res.json.errors)}`,
  );
});

test('回归哨兵：license 里的「无 / 未知 / TODO / 示例」等占位形态必须被拒——防占位值白名单被悄悄放宽', () => {
  const { dataDir, manifestPath } = makeFilledDataset();
  const base = readJson(manifestPath);

  for (const license of ['待填', '未知', '无', 'TODO', '来源：示例', 'placeholder']) {
    const manifest = { ...base, license };
    writeJson(manifestPath, manifest);
    const res = runJson(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', manifestPath, '--json']);
    assert.equal(res.status, VALIDATE_EXIT.ERRORS, `license="${license}" 必须被拒（exit 1）`);
    assert.ok(
      res.json.errors.some((e) => e.code === 'license-missing'),
      `license="${license}" 必须报 license-missing，实际=${JSON.stringify(res.json.errors)}`,
    );
  }
});

test('交叉验证：Node CLI 与 web/js/training/index.js 对同一组 license 字符串的占位判定必须一致——防双份实现漂移', () => {
  // validate-dataset.mjs 的 isPlaceholder 没有导出，web 侧的同名函数也没导出：
  // 因此两边都通过**公开出口**间接观察 —— CLI 走 `--json` 看错误码 license-missing，
  // web 走导出的 validateManifest() 看同一个错误码。两者在同一份最小清单上比较。
  const emptyData = makeTmp();
  const cases = [
    { value: '来源：待填', placeholder: true },
    { value: '由本人录制并授权，署名：张三', placeholder: false },
    { value: '来自无版权素材库的录音', placeholder: false },
    { value: '无', placeholder: true },
    { value: '待填', placeholder: true },
    { value: '来源：TODO', placeholder: true },
    { value: 'todo list', placeholder: true },
    { value: '没有版权', placeholder: false },
    { value: REAL_LICENSE, placeholder: false },
  ];

  for (const { value, placeholder } of cases) {
    const cli = cliPlaceholderFlag(emptyData, value);
    const web = webPlaceholderFlag(value);
    assert.equal(cli, web, `两边对「${value}」判定不一致：CLI=${cli} / web=${web}（双份实现已漂移）`);
    assert.equal(cli, placeholder, `「${value}」应为 placeholder=${placeholder}`);
  }
});

test('交叉验证补充：全新骨架 license 在两边一致地判为占位（曾经的同一处盲点，已修）', () => {
  const emptyData = makeTmp();
  const cli = cliPlaceholderFlag(emptyData, SKELETON_LICENSE);
  const web = webPlaceholderFlag(SKELETON_LICENSE);

  // '示例占位：…' 里「示例」右侧紧跟汉字「占」，旧的边界正则两侧都要非字母/数字，因此两边都漏判。
  // 修法（两边同步）：「占位标签 + 冒号 + 正文」形态额外查冒号左边的标签。
  assert.equal(cli, web, `骨架 license 在两边的判定不一致：CLI=${cli} / web=${web}（双份实现已漂移）`);
  assert.equal(cli, true, '骨架 license 必须被判为占位值');
});

// ───────────────────────────── 22~23：validate-dataset 规则实测 ─────────────────────────────

test('时长越界默认只警告（exit 0），加 --strict-durations 才按错误（exit 1）——防「默认严格」把正常数据卡死或「默认放行」漏掉坏数据', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'spk-a/short.wav', makeWav({ seconds: 2, freq: 570 })); // < 默认下限 3s
  writeFileAt(dataDir, 'spk-a/long.wav', makeWav({ seconds: 20, freq: 571 })); // > 默认上限 15s
  const manifestPath = join(makeTmp(), 'dataset.manifest.json');
  const gen = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', manifestPath, '--quiet']);
  assert.equal(gen.status, MAKE_EXIT.OK, `stderr=${gen.stderr}`);
  fillLicense(manifestPath); // 先把红线字段填实，才能单测时长规则本身

  const lenient = runJson(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', manifestPath, '--json']);
  assert.equal(lenient.status, VALIDATE_EXIT.OK, `默认应放行（只警告）；errors=${JSON.stringify(lenient.json?.errors)}`);
  assert.deepEqual(lenient.json.errors, []);
  const lenientCodes = lenient.json.warnings.map((w) => w.code);
  assert.ok(lenientCodes.includes('clip-duration-out-of-range'), '结构校验应给出时长越界警告');
  assert.ok(lenientCodes.includes('audio-duration-out-of-range'), '文件级校验应给出实际时长越界警告');

  const strict = runJson(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', manifestPath, '--json', '--strict-durations']);
  assert.equal(strict.status, VALIDATE_EXIT.ERRORS, '--strict-durations 必须 exit 1');
  const strictCodes = strict.json.errors.map((e) => e.code);
  assert.ok(strictCodes.includes('clip-duration-out-of-range'), `实际=${JSON.stringify(strict.json.errors)}`);
  assert.ok(strictCodes.includes('audio-duration-out-of-range'), `实际=${JSON.stringify(strict.json.errors)}`);

  const widened = runJson(VALIDATE_SCRIPT, [
    '--data', dataDir, '--manifest', manifestPath, '--json', '--min-seconds', '1', '--max-seconds', '30',
  ]);
  assert.equal(widened.status, VALIDATE_EXIT.OK);
  const widenedCodes = widened.json.warnings.map((w) => w.code);
  assert.equal(widenedCodes.includes('clip-duration-out-of-range'), false, '放宽阈值后不该再报越界');
  assert.equal(widenedCodes.includes('audio-duration-out-of-range'), false);
});

test('文件级红线：实际采样率低于下限、多条音频内容重复 → 错误（exit 1）——防坏数据静默入训', () => {
  const dataDir = makeTmp();
  const same = makeWav({ seconds: 5, freq: 580 });
  writeFileAt(dataDir, 'spk-a/dup1.wav', same);
  writeFileAt(dataDir, 'spk-a/dup2.wav', Buffer.from(same)); // 与 dup1 内容完全相同
  writeFileAt(dataDir, 'spk-a/low.wav', makeWav({ seconds: 5, sampleRate: 8000, freq: 581 }));

  const manifestPath = join(makeTmp(), 'dataset.manifest.json');
  const gen = runJson(MAKE_SCRIPT, ['--data', dataDir, '--out', manifestPath, '--json']);
  assert.equal(gen.status, MAKE_EXIT.OK, `生成骨架应 exit 0，stderr=${gen.stderr}`);
  assert.deepEqual(gen.json.summary.probeFailures, [], '这些文件都能解析头，不该有 probeFailures');
  assert.equal(gen.json.summary.duplicateGroups.length, 1, 'make-manifest 也该自己报出重复组');
  fillLicense(manifestPath); // 采样率/重复内容才是本条的考点，先把 license 填实

  const res = runJson(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', manifestPath, '--json']);
  assert.equal(res.status, VALIDATE_EXIT.ERRORS, `必须 exit 1；warnings=${JSON.stringify(res.json?.warnings)}`);
  const codes = res.json.errors.map((e) => e.code);
  assert.ok(codes.includes('audio-duplicate-content'), `应检出内容重复，实际=${JSON.stringify(res.json.errors)}`);
  assert.ok(codes.includes('audio-sample-rate-too-low'), `应检出实际采样率过低，实际=${JSON.stringify(res.json.errors)}`);
  assert.ok(codes.includes('clip-sample-rate-too-low'), '清单里声明的 8000Hz 也应被判错');
  assert.equal(findClip(readJson(manifestPath), 'spk-a/low.wav').sampleRate, 8000, '清单必须如实记录 8000Hz');
});

// ─────────────── 24：工具链自己生成的骨架必须被红线拦住（曾经的 DEFECT，已修） ───────────────
//
// 历史：make-manifest 生成的新骨架 license 是「示例占位：请改写为…」，
// 而旧版 isPlaceholder() 的边界正则 `(^|[^\p{L}\p{N}])示例([^\p{L}\p{N}]|$)` 要求占位词**右侧**
// 也是非字母/数字 —— '示例' 后面紧跟着汉字 '占'，于是判不出来，工具链自己生成的清单直接通过红线校验（exit 0）。
// 修法：追加「占位标签 + 冒号 + 正文」形态 —— 只查冒号左边的标签是否以占位词开头（且标签足够短）。
// 这条断言就是那个回归的哨兵：**工具链生成的骨架绝不能通过它自己的红线校验**。

test('工具链生成的骨架 license 是占位值（「示例占位：…」）→ validate-dataset 必须 exit 1', () => {
  const dataDir = makeTmp();
  writeFileAt(dataDir, 'speaker-a/a.wav', makeWav({ seconds: 5, freq: 590 }));
  const outFile = join(makeTmp(), 'dataset.manifest.json');

  const gen = runScript(MAKE_SCRIPT, ['--data', dataDir, '--out', outFile, '--quiet']);
  assert.equal(gen.status, MAKE_EXIT.OK, `生成骨架应 exit 0，stderr=${gen.stderr}`);

  const skeletonLicense = readJson(outFile).license;
  assert.match(skeletonLicense, /示例/, '骨架 license 确实是「示例占位：…」模板');

  const res = runJson(VALIDATE_SCRIPT, ['--data', dataDir, '--manifest', outFile, '--json']);
  assert.equal(
    res.status,
    VALIDATE_EXIT.ERRORS,
    `骨架 license「${skeletonLicense}」应被判为占位值并 exit 1，实际 exit=${res.status}；` +
      `errors=${JSON.stringify(res.json?.errors)}`,
  );
  const codes = (res.json?.errors ?? []).map((e) => e.code);
  assert.ok(codes.includes('license-missing'), `错误码里应含 license-missing，实际 ${JSON.stringify(codes)}`);
});
